"""Pixel-art dancing cat generator for God's Noisey BoyZ (v2).

Each cat is a small rig (pelvis, torso, head, two-bone arms, IK legs, tail)
posed by keyframes. Keyframes are interpolated with a looping Catmull-Rom
spline, then every frame is rasterized onto a 64x80 pixel grid with
three-tone shading, inner/outer outlines and cast shadows.

Output (tools/cats/out/):
  sprites/<id>.png      sprite sheet: 16 dance frames + 8 idle frames
  gifs/<id>_dance.gif   8x preview
  gifs/<id>_idle.gif
  lineup.gif            all five dancing
  cats.json             manifest the app reads

Run:  python3 tools/cats/make_cats.py
"""
import json
import math
import os

from PIL import Image

W, H = 64, 80
GROUND = 74
CX = 32
DANCE_FRAMES, DANCE_FPS = 16, 12
IDLE_FRAMES, IDLE_FPS = 8, 5
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
TO_LIGHT = (-0.6, -0.8)  # light comes from the upper left


def hexc(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


def rot(x, y, deg):
    r = math.radians(deg)
    c, s = math.cos(r), math.sin(r)
    return x * c - y * s, x * s + y * c


def tone_of(nx, ny):
    d = nx * TO_LIGHT[0] + ny * TO_LIGHT[1]
    if d > 0.5:
        return "h"
    if d < -0.25:
        return "s"
    return "m"


# ------------------------------------------------------------------ primitives
# A primitive is f(px, py) -> (key, tone) | None. `color` may be a constant key
# or a function(s, t) -> key using the primitive's local coordinates.
def _key(color, s, t):
    return color(s, t) if callable(color) else color


def ellipse(cx, cy, rx, ry, color, ang=0.0, jag=0.0, shade=True):
    def f(px, py):
        lx, ly = rot(px - cx, py - cy, -ang)
        a = math.atan2(ly / ry, lx / rx)
        k = 1 + jag * math.sin(7 * a) if jag else 1
        u, v = lx / (rx * k), ly / (ry * k)
        if u * u + v * v <= 1:
            nx, ny = rot(u, v, ang)
            return _key(color, lx, ly), (tone_of(nx, ny) if shade else "m")
    return f


def blob(parts, color, shade=True):
    """Union of ellipses shaded as one form: each pixel takes its tone from the
    ellipse it sits deepest inside, so overlaps don't leave seam lines."""
    def f(px, py):
        best = None
        for cx, cy, rx, ry, ang, jag in parts:
            lx, ly = rot(px - cx, py - cy, -ang)
            k = 1 + jag * math.sin(7 * math.atan2(ly / ry, lx / rx)) if jag else 1
            u, v = lx / (rx * k), ly / (ry * k)
            d = u * u + v * v
            if d <= 1 and (best is None or d < best[0]):
                best = (d, u, v, ang, lx, ly)
        if best:
            _, u, v, ang, lx, ly = best
            nx, ny = rot(u, v, ang)
            return _key(color, lx, ly), (tone_of(nx, ny) if shade else "m")
    return f


def chain(points, r, color, shade=True):
    """Thick polyline. r may be a function(s, total). color gets (s, t)."""
    segs, acc = [], 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        L = math.hypot(x1 - x0, y1 - y0) or 1e-6
        segs.append((x0, y0, x1, y1, L, acc))
        acc += L
    total = acc

    def f(px, py):
        best = None
        for x0, y0, x1, y1, L, a in segs:
            dx, dy = x1 - x0, y1 - y0
            t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / (L * L)))
            qx, qy = x0 + t * dx, y0 + t * dy
            ox, oy = px - qx, py - qy
            s = a + t * L
            rr = r(s, total) if callable(r) else r
            d2 = ox * ox + oy * oy
            if d2 <= rr * rr and (best is None or d2 < best[0]):
                best = (d2, s, ox / rr, oy / rr, (ox * -dy + oy * dx) / L)
        if best:
            _, s, nx, ny, side = best
            return _key(color, s, side), (tone_of(nx, ny) if shade else "m")
    return f


def poly(pts, color, shade=True):
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    size = max(math.hypot(p[0] - cx, p[1] - cy) for p in pts)

    def f(px, py):
        inside = False
        n = len(pts)
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if (y0 > py) != (y1 > py) and px < x0 + (py - y0) * (x1 - x0) / (y1 - y0):
                inside = not inside
        if inside:
            return _key(color, px - cx, py - cy), (tone_of((px - cx) / size, (py - cy) / size) if shade else "m")
    return f


def pix(points, color):
    s = {(int(round(x - 0.5)), int(round(y - 0.5))) for x, y in points}

    def f(px, py):
        if (int(px), int(py)) in s:
            return color, "m"
    return f


def bezier(p0, p1, p2, n=12):
    out = []
    for i in range(n + 1):
        t = i / n
        out.append(((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]))
    return out


# ------------------------------------------------------------------ canvas
NEIGH = ((1, 0), (-1, 0), (0, 1), (0, -1))
NO_HIGHLIGHT = {"belly", "paw"}  # white areas read flat; only fur gets the top-left highlight


class Canvas:
    def __init__(self):
        self.key = [[None] * W for _ in range(H)]
        self.tone = [["m"] * W for _ in range(H)]
        self.grp = [[-1] * W for _ in range(H)]
        self.n = 0

    def group(self, prims, inner=True, cast=False):
        gid = self.n
        self.n += 1
        mask = set()
        for prim in prims:
            for y in range(H):
                for x in range(W):
                    r = prim(x + 0.5, y + 0.5)
                    if r is not None:
                        self.key[y][x], self.tone[y][x] = r
                        self.grp[y][x] = gid
                        mask.add((x, y))
        if cast:  # soft shadow onto whatever is just below / right of this part
            for x, y in mask:
                for dx, dy in ((0, 1), (1, 1), (0, 2)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in mask \
                            and self.key[ny][nx] not in (None, "ol") and self.grp[ny][nx] >= 0:
                        self.tone[ny][nx] = "s"
        if inner:
            for x, y in mask:
                for dx, dy in NEIGH:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in mask \
                            and self.key[ny][nx] not in (None, "ol"):
                        self.key[ny][nx] = "ol"
                        self.grp[ny][nx] = -2
        return mask

    def render(self, pal, shadow_x):
        out = [row[:] for row in self.key]
        for y in range(H):
            for x in range(W):
                if self.key[y][x] is None and any(
                        0 <= x + dx < W and 0 <= y + dy < H and self.key[y + dy][x + dx] is not None
                        for dx, dy in NEIGH):
                    out[y][x] = "ol"
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        px = img.load()
        for y in range(H):
            for x in range(W):
                k = out[y][x]
                if k is None:
                    if ((x + 0.5 - shadow_x) / 17) ** 2 + ((y + 0.5 - (GROUND + 1.5)) / 2.6) ** 2 <= 1:
                        px[x, y] = pal["shadow"]
                    continue
                t = self.tone[y][x] if self.key[y][x] == k else "m"
                if t == "h" and k in NO_HIGHLIGHT:
                    t = "m"
                full = k + "_" + t if t != "m" else k
                px[x, y] = pal.get(full, pal[k])
        return img


# ------------------------------------------------------------------ rig
REST = dict(
    px=0.0, py=0.0, lean=0.0, tilt=0.0, hx=0.0, hy=0.0,
    la=12.0, lf=4.0, ra=12.0, rf=4.0,          # arm angles: 0 down, 90 out, 180 up, 270 across chest
    lfx=-8.0, llift=0.0, rfx=8.0, rlift=0.0,   # feet: x offset from center, lift off the ground
    tail=0.0, eyes="happy", mouth="smile",
)
ANGLES = {"la", "lf", "ra", "rf"}


def arm_points(shoulder, upper, fore, side):
    """side = -1 for the cat's left (screen left), +1 for right."""
    def d(theta):
        r = math.radians(theta)
        return side * math.sin(r), math.cos(r)
    ux, uy = d(upper)
    fx, fy = d(fore)
    elbow = (shoulder[0] + ux * 9.5, shoulder[1] + uy * 9.5)
    paw = (elbow[0] + fx * 8.5, elbow[1] + fy * 8.5)
    return elbow, paw


def leg_points(hip, foot, side, l1=11.0, l2=11.0):
    dx, dy = foot[0] - hip[0], foot[1] - hip[1]
    dist = math.hypot(dx, dy)
    dist_c = min(dist, l1 + l2 - 0.01)
    a = (l1 * l1 - l2 * l2 + dist_c * dist_c) / (2 * dist_c)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    ex, ey = dx / dist, dy / dist
    mx, my = hip[0] + ex * a, hip[1] + ey * a
    k1 = (mx - ey * h, my + ex * h)
    k2 = (mx + ey * h, my - ex * h)
    knee = min(k1, k2) if side < 0 else max(k1, k2)  # knees bow outward
    if dist > l1 + l2:
        foot = (hip[0] + ex * (l1 + l2), hip[1] + ey * (l1 + l2))
    return knee, foot


def draw_cat(pose, cat):
    pal, pat = cat["pal"], cat["pattern"]
    p = dict(REST, **pose)
    cv = Canvas()
    P = lambda part, base: (lambda s, t: pat(part, s, t, base))

    lean = p["lean"]
    pel = (CX + p["px"], 52.5 + p["py"])
    W_ = lambda x, y: (pel[0] + rot(x, y, lean)[0], pel[1] + rot(x, y, lean)[1])

    # ---- tail
    base = W_(8, -3)
    sw = p["tail"]
    ctrl = (base[0] + 11 + 2 * math.sin(math.radians(sw)), base[1] + 2)
    tipx, tipy = rot(9, -15, sw)
    tip = (base[0] + 6 + tipx, base[1] + tipy)
    cv.group([chain(bezier(base, ctrl, tip), lambda s, T: 2.5 - 0.9 * s / T, P("tail", "body"))])

    # ---- legs (IK) and feet
    for side, fx, lift, name in ((-1, p["lfx"], p["llift"], "leg0"), (1, p["rfx"], p["rlift"], "leg1")):
        hip = W_(side * 5.0, 0)
        foot = (CX + fx, GROUND - 2.2 - lift)
        knee, foot = leg_points(hip, foot, side)
        cv.group([chain([hip, knee, foot], lambda s_, T: 3.7 - 0.6 * s_ / T, P(name, "body"))])
        cv.group([ellipse(foot[0] + side * 1.6, foot[1] + 0.3, 4.4, 2.5, P("foot", "paw")),
                  pix([(foot[0] + side * 1.6 + o, foot[1] + 1.4) for o in (-1.5, 1.5)], "toe")])

    # ---- torso: belly + chest, fluffy blaze
    lo, up = W_(0, -7), W_(0, -18)
    b1, b2 = W_(0.6, -9), W_(0.2, -19)
    cv.group([
        blob([(lo[0], lo[1], 10, 11.5, lean, 0), (up[0], up[1], 8.2, 8.5, lean, 0)], P("torso", "body")),
        blob([(b1[0], b1[1], 5.6, 9.5, lean, 0.07), (b2[0], b2[1], 4.6, 6.5, lean, 0.1)], P("blaze", "belly")),
    ], cast=True)

    # ---- arms and paws
    for side, ua, fa, name in ((-1, p["la"], p["lf"], "arm0"), (1, p["ra"], p["rf"], "arm1")):
        sh = W_(side * 7, -21)
        elbow, paw = arm_points(sh, ua, fa, side)
        cv.group([chain([sh, elbow, paw], 2.6, P(name, "body"))], cast=True)
        cv.group([ellipse(paw[0], paw[1], 3.1, 3.1, P("paw", "paw")),
                  pix([(paw[0] - 1, paw[1] + 2.2), (paw[0] + 1, paw[1] + 2.2)], "toe")])

    # ---- head
    hang = lean * 0.6 + p["tilt"]
    hc = W_(p["hx"], -31 + p["hy"])
    hc = (hc[0] + p["hx"] * 0.3, hc[1])
    Hp = lambda x, y: (hc[0] + rot(x, y, hang)[0], hc[1] + rot(x, y, hang)[1])
    head_prims = [
        poly([Hp(-10.5, -2), Hp(-9.5, -15.5), Hp(-2.5, -7.5)], P("ear0", "body")),
        poly([Hp(10.5, -2), Hp(9.5, -15.5), Hp(2.5, -7.5)], P("ear1", "body")),
        poly([Hp(-8.6, -4.5), Hp(-8.6, -12.2), Hp(-4.6, -7.6)], "pink", shade=False),
        poly([Hp(8.6, -4.5), Hp(8.6, -12.2), Hp(4.6, -7.6)], "pink", shade=False),
        ellipse(hc[0], hc[1], 11.2, 8.8, P("head", "body"), ang=hang),
        poly([Hp(-10.2, 1), Hp(-13, 5.2), Hp(-7.5, 6.5)], P("cheek0", "body")),
        poly([Hp(10.2, 1), Hp(13, 5.2), Hp(7.5, 6.5)], P("cheek1", "body")),
        ellipse(*Hp(-0.5, 4.2), 5.8, 3.6, P("muzzle", "belly"), ang=hang),
    ]
    cv.group(head_prims, cast=True)

    # ---- face
    F = lambda pts: [Hp(x + 0.5, y + 0.5) for x, y in pts]
    face = []
    if p["eyes"] == "happy":
        face += [pix(F([(-7, 0), (-6, -1), (-5, -1), (-4, 0)]), "ol"),
                 pix(F([(3, 0), (4, -1), (5, -1), (6, 0)]), "ol")]
    elif p["eyes"] == "blink":
        face += [pix(F([(-7, 0), (-6, 0), (-5, 0), (-4, 0), (3, 0), (4, 0), (5, 0), (6, 0)]), "ol")]
    else:  # open
        face += [pix(F([(-6, -1), (-5, -1), (-6, 0), (-5, 0), (-6, 1), (-5, 1),
                        (4, -1), (5, -1), (4, 0), (5, 0), (4, 1), (5, 1)]), "ol"),
                 pix(F([(-6, -1), (4, -1)]), "glint_eye")]
    face += [pix(F([(-9, 2), (-8, 2), (7, 2), (8, 2)]), "blush"),
             pix(F([(-1, 2), (0, 2)]), "nose")]
    if p["mouth"] == "open":
        face += [pix(F([(-2, 4), (1, 4), (-1, 4), (0, 4), (-1, 5), (0, 5)]), "ol"),
                 pix(F([(-1, 5), (0, 5)]), "tongue")]
    else:
        face += [pix(F([(-2, 4), (-1, 5), (0, 5), (1, 4)]), "ol"), pix(F([(-1, 3), (0, 3)]), "ol")]
    cv.group(face, inner=False)

    acc = cat.get("accessory")
    if acc:
        acc(cv, Hp, W_, hang, lean)
    return cv.render(pal, CX + p["px"] * 0.6)


# ------------------------------------------------------------------ accessories
def collar(cv, Hp, W_, hang, lean):
    cv.group([chain([W_(-6.5, -22.5), W_(0, -21), W_(6.5, -22.5)], 1.3, "acc")])
    cv.group([ellipse(*W_(0, -18.8), 1.9, 1.9, "acc2")])


def headphones(cv, Hp, W_, hang, lean):
    band = [Hp(-11.8, 0), Hp(-11, -6.5), Hp(-6, -10.6), Hp(0, -11.4), Hp(6, -10.6), Hp(11, -6.5), Hp(11.8, 0)]
    cv.group([chain(band, 1.1, "acc2")])
    cv.group([ellipse(*Hp(-12, 1.2), 2.9, 4.0, "acc", ang=hang)])
    cv.group([ellipse(*Hp(12, 1.2), 2.9, 4.0, "acc", ang=hang)])


def shades(cv, Hp, W_, hang, lean):
    cv.group([
        ellipse(*Hp(-5.2, -0.2), 3.6, 2.5, "lens", ang=hang, shade=False),
        ellipse(*Hp(4.4, -0.2), 3.6, 2.5, "lens", ang=hang, shade=False),
        chain([Hp(-9, -1.6), Hp(8.4, -1.6)], 0.7, "lens", shade=False),
    ], inner=False)
    cv.group([pix([Hp(-6.5, -1), Hp(-5.5, -1.6), Hp(3, -1), Hp(4, -1.6)], "glint")], inner=False)
    cv.group([chain([W_(-5.5, -22.5), W_(0, -17.5), W_(5.5, -22.5)], 0.7, "acc2", shade=False),
              ellipse(*W_(0, -16), 1.8, 2.0, "acc2")], inner=False)


def bow(cv, Hp, W_, hang, lean):
    c = Hp(-7.5, -9)
    cv.group([
        poly([c, Hp(-12.5, -12.5), Hp(-12.5, -5.5)], "acc"),
        poly([c, Hp(-2.5, -12.5), Hp(-2.5, -5.5)], "acc"),
    ])
    cv.group([ellipse(c[0], c[1], 1.6, 1.6, "acc2")])


def bandana(cv, Hp, W_, hang, lean):
    def dots(s, t):
        return "acc2" if (int(s + 40) % 4 == 0 and int(t + 40) % 4 == 1) else "acc"
    cv.group([poly([W_(-9, -23.5), W_(9, -23.5), W_(0.3, -13.5)], dots)])


# ------------------------------------------------------------------ fur patterns
def plain(part, s, t, base):
    return base


def tabby(part, s, t, base):
    if base != "body":
        return base
    if part == "torso" and int(t + 60) % 5 == 0 and abs(s) > 4:
        return "stripe"
    if part == "head" and t < -4.5 and int(s + 60) % 3 == 0 and abs(s) < 5:
        return "stripe"
    if part.startswith(("arm", "leg")) and int(s) % 6 == 3 and t > -1.2:
        return "stripe"
    if part == "tail" and int(s) % 4 == 1:
        return "stripe"
    return base


def calico(part, s, t, base):
    if base != "body":
        return base
    if part in ("tail", "ear1", "cheek1"):
        return "patch2"
    if part in ("ear0", "cheek0"):
        return "patch1"
    if part == "head":
        if s < -1 and t < 2:
            return "patch1"
        if s > 4 and t < -2:
            return "patch2"
    if part == "torso":
        if (s + 4) ** 2 + (t + 3) ** 2 < 22:
            return "patch1"
        if (s - 5) ** 2 + (t - 4) ** 2 < 14:
            return "patch2"
    if part == "arm1" and s > 6:
        return "patch1"
    if part == "leg0" and s < 7:
        return "patch1"
    return base


def siamese(part, s, t, base):
    if part in ("paw", "foot", "ear0", "ear1", "tail"):
        return "point"
    if part.startswith("leg") and s > 9:
        return "point"
    if part.startswith("arm") and s > 9:
        return "point"
    if part == "muzzle":
        return "point_l"
    return base


def with_tip(pattern, key, start=0.7):
    """Recolor the end of the tail; s is distance along the tail (~22px long)."""
    def f(part, s, t, base):
        if part == "tail" and s > 22 * start:
            return key
        return pattern(part, s, t, base)
    return f


# ------------------------------------------------------------------ dances
# Keyframes are partial poses; the loop is interpolated with Catmull-Rom.
DANCES = {
    "swing": {  # arms swing across the body, step side to side, fist pump overhead
        "name": "Swing step",
        "keys": [
            dict(px=-3, py=1, lean=-7, tilt=-8, la=120, lf=150, ra=300, rf=285, lfx=-10, rfx=6, rlift=1.5, tail=-15, mouth="open"),
            dict(px=0, py=4, lean=0, tilt=0, la=25, lf=340, ra=25, rf=20, lfx=-8, rfx=8, tail=0),
            dict(px=3, py=1, lean=7, tilt=8, la=300, lf=285, ra=120, rf=150, lfx=-6, llift=1.5, rfx=10, tail=15, mouth="open"),
            dict(px=0, py=4, lean=0, tilt=0, la=25, lf=20, ra=25, rf=340, lfx=-8, rfx=8, tail=0),
            dict(px=-2, py=0, lean=-4, tilt=-6, la=160, lf=180, ra=40, rf=215, lfx=-9, rfx=8, rlift=1, tail=-10, mouth="open"),
            dict(px=0, py=4, lean=0, la=60, lf=40, ra=30, rf=330, lfx=-8, rfx=8),
            dict(px=2, py=0, lean=4, tilt=6, la=40, lf=215, ra=160, rf=180, lfx=-8, llift=1, rfx=9, tail=10, mouth="open"),
            dict(px=0, py=4, lean=0, la=30, lf=330, ra=60, rf=40, lfx=-8, rfx=8),
        ],
    },
    "shuffle": {  # deep squat, sway, feet shuffle in and out, elbows pumping
        "name": "Side shuffle",
        "keys": [
            dict(px=-4, py=5, lean=-5, tilt=-5, la=75, lf=150, ra=60, rf=40, lfx=-12, rfx=6, rlift=3, tail=-20),
            dict(px=-1, py=3, lean=-2, la=60, lf=110, ra=70, rf=110, lfx=-11, rfx=11, tail=-5),
            dict(px=4, py=5, lean=5, tilt=5, la=60, lf=40, ra=75, rf=150, lfx=-6, llift=3, rfx=12, tail=20, mouth="open"),
            dict(px=1, py=3, lean=2, la=70, lf=110, ra=60, rf=110, lfx=-11, rfx=11, tail=5),
        ],
    },
    "kneeup": {  # alternating high knees with finger-point thrusts
        "name": "Knee-up groove",
        "keys": [
            dict(px=2, py=1, lean=6, tilt=8, la=30, lf=210, ra=95, rf=88, lfx=-3, llift=10, rfx=7, tail=15, mouth="open"),
            dict(px=0, py=3, lean=0, tilt=0, la=40, lf=150, ra=40, rf=150, lfx=-7, rfx=7, tail=0),
            dict(px=-2, py=1, lean=-6, tilt=-8, la=95, lf=88, ra=30, rf=210, lfx=-7, rfx=3, rlift=10, tail=-15, mouth="open"),
            dict(px=0, py=3, lean=0, tilt=0, la=40, lf=150, ra=40, rf=150, lfx=-7, rfx=7, tail=0),
        ],
    },
    "elbows": {  # planted feet, knees pop, elbows out, hands dangling, shoulders bounce
        "name": "Elbow bounce",
        "keys": [
            dict(px=-2.5, py=3, lean=-3, tilt=-4, hy=1, la=62, lf=345, ra=55, rf=350, lfx=-10, rfx=10, tail=-12),
            dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=78, lf=330, ra=78, rf=30, lfx=-10, rfx=10, tail=0, mouth="open"),
            dict(px=2.5, py=3, lean=3, tilt=4, hy=1, la=55, lf=350, ra=62, rf=345, lfx=-10, rfx=10, tail=12),
            dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=78, lf=30, ra=78, rf=330, lfx=-10, rfx=10, tail=0, mouth="open"),
        ],
    },
    "stomp": {  # wide stance, alternating side kicks, loose low arm swings, a stomp
        "name": "Party stomp",
        "keys": [
            dict(px=2, py=2, lean=7, tilt=6, la=50, lf=20, ra=320, rf=300, lfx=-17, llift=5, rfx=7, tail=18, mouth="open"),
            dict(px=0, py=5, lean=0, la=20, lf=350, ra=20, rf=10, lfx=-9, rfx=9),
            dict(px=-2, py=2, lean=-7, tilt=-6, la=320, lf=300, ra=50, rf=20, lfx=-7, rfx=17, rlift=5, tail=-18, mouth="open"),
            dict(px=0, py=5, lean=0, la=20, lf=10, ra=20, rf=350, lfx=-9, rfx=9),
            dict(px=0, py=-1, lean=0, tilt=0, hy=-1, la=140, lf=165, ra=140, rf=165, lfx=-11, rfx=11, tail=0, mouth="open"),
            dict(px=0, py=6, lean=0, la=40, lf=60, ra=40, rf=60, lfx=-11, rfx=11),
        ],
    },
}

IDLE_KEYS = [
    dict(px=-0.6, py=0, tilt=-3, la=10, lf=2, ra=12, rf=6, tail=-10, eyes="open"),
    dict(px=0, py=1, tilt=0, la=12, lf=4, ra=12, rf=4, tail=0, eyes="open"),
    dict(px=0.6, py=0, tilt=3, la=12, lf=6, ra=10, rf=2, tail=10, eyes="open"),
    dict(px=0, py=1, tilt=0, la=12, lf=4, ra=12, rf=4, tail=0, eyes="open"),
]


def _unwrap(vals, ref):
    out = []
    for v in vals:
        while v - ref > 180:
            v -= 360
        while v - ref < -180:
            v += 360
        out.append(v)
    return out


def interp(keys, n):
    """Loop through keyframes with a Catmull-Rom spline; returns n poses."""
    keys = [dict(REST, **k) for k in keys]
    m = len(keys)
    frames = []
    for i in range(n):
        u = i * m / n
        seg = int(u)
        t = u - seg
        k0, k1, k2, k3 = (keys[(seg + j) % m] for j in (-1, 0, 1, 2))
        pose = {}
        for name in REST:
            if isinstance(REST[name], str):
                pose[name] = k1[name] if t < 0.5 else k2[name]
                continue
            v = [k0[name], k1[name], k2[name], k3[name]]
            if name in ANGLES:
                v = _unwrap(v, v[1])
            p0, p1, p2, p3 = v
            pose[name] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t
                                + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3)
        frames.append(pose)
    return frames


def idle_frames():
    frames = interp(IDLE_KEYS, IDLE_FRAMES)
    frames[5]["eyes"] = "blink"
    return frames


# ------------------------------------------------------------------ the five cats
COMMON = {
    "pink": hexc("#f2a2a8"), "blush": hexc("#f58a96"), "nose": hexc("#e25c74"),
    "tongue": hexc("#f27f92"), "glint_eye": hexc("#ffffff"),
    "shadow": (44, 34, 66, 120),
}


def palette(ol, toe, **groups):
    pal = dict(COMMON, ol=hexc(ol), toe=hexc(toe))
    for key, (b, l, s) in groups.items():
        pal[key] = hexc(b)
        pal[key + "_h"] = hexc(l)
        pal[key + "_s"] = hexc(s)
    return pal


CATS = [
    {
        "id": "biscuit", "name": "Biscuit", "blurb": "Classic cream with a red collar and bell", "dance": "swing",
        "pattern": with_tip(plain, "tip"), "accessory": collar,
        "pal": dict(palette("#2a181c", "#d8a68b",
                            body=("#f5cd97", "#fde3b8", "#dc9a68"), belly=("#fff6ea", "#ffffff", "#ecd5bf"),
                            paw=("#fff6ea", "#ffffff", "#e8cdb6"), tip=("#e09b6a", "#efb382", "#bd7448"),
                            acc=("#d63c43", "#ee5a5f", "#a42a32"), acc2=("#f6c44e", "#ffe08a", "#c9932b"))),
    },
    {
        "id": "smokey", "name": "Smokey", "blurb": "Gray tabby in red headphones", "dance": "shuffle",
        "pattern": tabby, "accessory": headphones,
        "pal": dict(palette("#1b1d25", "#9aa1ad",
                            body=("#a2aab7", "#c1c8d3", "#767e8c"), stripe=("#646c7b", "#737b8a", "#4c5361"),
                            belly=("#eef0f3", "#ffffff", "#cdd2da"), paw=("#eef0f3", "#ffffff", "#cdd2da"),
                            acc=("#e2475a", "#f2697a", "#ad3242"), acc2=("#33333e", "#4a4a58", "#24242c"))),
    },
    {
        "id": "midnight", "name": "Midnight", "blurb": "Tuxedo cat in shades and a gold chain", "dance": "kneeup",
        "pattern": plain, "accessory": shades,
        "pal": dict(palette("#0e0a13", "#b9b1a6",
                            body=("#433a53", "#5a5070", "#2b2537"), belly=("#f4f1ea", "#ffffff", "#d4cdc0"),
                            paw=("#f4f1ea", "#ffffff", "#d4cdc0"), acc2=("#f6c44e", "#ffe08a", "#c9932b")),
                    lens=hexc("#08060b"), glint=hexc("#8fdcff")),
    },
    {
        "id": "pepper", "name": "Pepper", "blurb": "Calico with a pink bow", "dance": "elbows",
        "pattern": calico, "accessory": bow,
        "pal": dict(palette("#231a1c", "#cbbcaa",
                            body=("#faf4ea", "#ffffff", "#ddd1c0"), patch1=("#f09d4b", "#f8b872", "#c47731"),
                            patch2=("#3b3238", "#504550", "#28222a"), belly=("#fffdf8", "#ffffff", "#e6dccd"),
                            paw=("#fffdf8", "#ffffff", "#e2d8c9"), acc=("#ff7db4", "#ffa3cb", "#d6578f"),
                            acc2=("#ffd0e5", "#ffe6f1", "#e8a6c4"))),
    },
    {
        "id": "mochi", "name": "Mochi", "blurb": "Siamese in a blue polka-dot bandana", "dance": "stomp",
        "pattern": siamese, "accessory": bandana,
        "pal": dict(palette("#1f150f", "#2c1e15",
                            body=("#f3e4c9", "#fdf3e1", "#d5bd97"), point=("#5c4030", "#765443", "#422d20"),
                            point_l=("#8e6c53", "#a5846a", "#735540"), belly=("#fbf3e3", "#ffffff", "#e5d4b9"),
                            paw=("#5c4030", "#765443", "#422d20"), acc=("#3f80d8", "#5f9cec", "#2d5fa8"),
                            acc2=("#eaf2ff", "#ffffff", "#c6d6ef"))),
    },
]


# ------------------------------------------------------------------ export
def upscale(img, k):
    return img.resize((img.width * k, img.height * k), Image.NEAREST)


def save_gif(frames, path, ms, bg):
    out = []
    for f in frames:
        base = Image.new("RGBA", f.size, bg)
        base.alpha_composite(f)
        out.append(base.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=255))
    out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0, disposal=2, optimize=False)


def main():
    sprites = os.path.join(OUT, "sprites")
    gifs = os.path.join(OUT, "gifs")
    os.makedirs(sprites, exist_ok=True)
    os.makedirs(gifs, exist_ok=True)
    total = DANCE_FRAMES + IDLE_FRAMES
    manifest = {
        "frameWidth": W, "frameHeight": H, "frames": total,
        "animations": {
            "dance": {"start": 0, "count": DANCE_FRAMES, "fps": DANCE_FPS},
            "idle": {"start": DANCE_FRAMES, "count": IDLE_FRAMES, "fps": IDLE_FPS},
        },
        "cats": [],
    }
    lineup_frames = []
    idle_poses = idle_frames()
    for cat in CATS:
        dance = DANCES[cat["dance"]]
        frames = [draw_cat(p, cat) for p in interp(dance["keys"], DANCE_FRAMES)]
        frames += [draw_cat(p, cat) for p in idle_poses]
        sheet = Image.new("RGBA", (W * total, H), (0, 0, 0, 0))
        for i, f in enumerate(frames):
            sheet.paste(f, (i * W, 0))
        sheet.save(os.path.join(sprites, f"{cat['id']}.png"))
        big = [upscale(f, 6) for f in frames]
        save_gif(big[:DANCE_FRAMES], os.path.join(gifs, f"{cat['id']}_dance.gif"), round(1000 / DANCE_FPS), (255, 255, 255, 255))
        save_gif(big[DANCE_FRAMES:], os.path.join(gifs, f"{cat['id']}_idle.gif"), round(1000 / IDLE_FPS), (255, 255, 255, 255))
        lineup_frames.append(frames[:DANCE_FRAMES])
        manifest["cats"].append({"id": cat["id"], "name": cat["name"], "blurb": cat["blurb"], "dance": dance["name"]})
    with open(os.path.join(OUT, "cats.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    k, pad = 4, 4
    bg = hexc("#1e1830")
    lw = (W * len(CATS) + pad * (len(CATS) + 1)) * k
    lh = (H + pad * 2) * k
    line = []
    for fi in range(DANCE_FRAMES):
        canvas = Image.new("RGBA", (lw, lh), bg)
        for ci, frames in enumerate(lineup_frames):
            canvas.alpha_composite(upscale(frames[fi], k), ((pad + ci * (W + pad)) * k, pad * k))
        line.append(canvas)
    save_gif(line, os.path.join(OUT, "lineup.gif"), round(1000 / DANCE_FPS), bg)
    line[0].convert("RGB").save(os.path.join(OUT, "lineup.png"))


if __name__ == "__main__":
    main()
