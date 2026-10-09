"""Pixel-art dancing cat generator for God's Noisey BoyZ (v3).

Each cat is a small rig (pelvis, torso, head, two-bone arms, IK legs, tail)
posed by keyframes. Keyframes are interpolated with a looping Catmull-Rom
spline, then every frame is rasterized onto a 64x88 pixel grid with
three-tone shading, inner/outer outlines and cast shadows.

Moves are written once against the skeleton, as seen from the front. The
same poses are drawn from three views: front, side (facing right; the app
mirrors it for facing left) and back (the pose mirrored, as you'd see it
from behind). Every cat can do every move; each has a signature move the
app's dance director favours.

Output (tools/cats/out/):
  sprites/<id>.png        atlas: one block of rows per view, COLS frames wide
  cats.json               manifest the app reads (frames, clips, views, cats)
  gifs/<id>_moves.gif     every clip side by side, front view, 4x
  gifs/<id>_turn.gif      one move while turning through all four facings
  lineup.gif              all five cats doing their signature move

Copy sprites/*.png and cats.json into public/cats/ to use them in the room.

Run:  python tools/cats/make_cats.py [cat-id ...]
"""
import json
import math
import os
import sys

from PIL import Image

W, H = 64, 88
GROUND = 82                      # y of the floor line
PELVIS_Y = GROUND - 21.5         # pelvis height when standing
CX = 32
COLS = 32                        # atlas width in frames
VIEWS = ("front", "side", "back")
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
# A primitive is f(px, py) -> (key, tone) | None, with f.bbox = (x0, y0, x1, y1)
# so the canvas only tests pixels near it. `color` may be a constant key or a
# function(s, t) -> key using the primitive's local coordinates.
def _key(color, s, t):
    return color(s, t) if callable(color) else color


def _bb(f, x0, y0, x1, y1):
    f.bbox = (x0, y0, x1, y1)
    return f


def ellipse(cx, cy, rx, ry, color, ang=0.0, jag=0.0, shade=True):
    def f(px, py):
        lx, ly = rot(px - cx, py - cy, -ang)
        a = math.atan2(ly / ry, lx / rx)
        k = 1 + jag * math.sin(7 * a) if jag else 1
        u, v = lx / (rx * k), ly / (ry * k)
        if u * u + v * v <= 1:
            nx, ny = rot(u, v, ang)
            return _key(color, lx, ly), (tone_of(nx, ny) if shade else "m")
    r = max(rx, ry) * (1 + jag) + 1
    return _bb(f, cx - r, cy - r, cx + r, cy + r)


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
    rs = [(cx, cy, max(rx, ry) * (1 + jag) + 1) for cx, cy, rx, ry, _, jag in parts]
    return _bb(f, min(c - r for c, _, r in rs), min(c - r for _, c, r in rs),
               max(c + r for c, _, r in rs), max(c + r for _, c, r in rs))


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
    rmax = (max(r(s, total) for s in (0, total / 2, total)) if callable(r) else r) + 1
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    return _bb(f, min(xs) - rmax, min(ys) - rmax, max(xs) + rmax, max(ys) + rmax)


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
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return _bb(f, min(xs) - 1, min(ys) - 1, max(xs) + 1, max(ys) + 1)


def pix(points, color):
    s = {(int(round(x - 0.5)), int(round(y - 0.5))) for x, y in points}

    def f(px, py):
        if (int(px), int(py)) in s:
            return color, "m"
    xs, ys = [p[0] for p in s], [p[1] for p in s]
    return _bb(f, min(xs) - 1, min(ys) - 1, max(xs) + 2, max(ys) + 2)


def far(prim):
    """The far-side copy of a limb: same shape, always in shadow."""
    def f(px, py):
        r = prim(px, py)
        return (r[0], "s") if r else None
    return _bb(f, *prim.bbox)


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
            x0, y0, x1, y1 = prim.bbox
            for y in range(max(0, int(y0)), min(H, int(y1) + 2)):
                for x in range(max(0, int(x0)), min(W, int(x1) + 2)):
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

    def render(self, pal, shadow_x, shadow_k=1.0):
        out = [row[:] for row in self.key]
        for y in range(H):
            for x in range(W):
                if self.key[y][x] is None and any(
                        0 <= x + dx < W and 0 <= y + dy < H and self.key[y + dy][x + dx] is not None
                        for dx, dy in NEIGH):
                    out[y][x] = "ol"
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        px = img.load()
        sw, sh = 17 * shadow_k, 2.6 * (0.6 + 0.4 * shadow_k)
        for y in range(H):
            for x in range(W):
                k = out[y][x]
                if k is None:
                    if ((x + 0.5 - shadow_x) / sw) ** 2 + ((y + 0.5 - (GROUND + 1.5)) / sh) ** 2 <= 1:
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
    # Specials, filled in per frame from the beat (see clip_poses):
    swing=0.0,   # extra tail swing in degrees (cats)
    glow=0.0,    # 0..1 how lit the lights are (robots: antenna tips, eyes, visors, thrusters)
    ext=0.0,     # 0..1 how far antennas are extended (robots)
)
ANGLES = {"la", "lf", "ra", "rf"}


def mirrored(p):
    """The same pose seen from behind: left and right trade places."""
    q = dict(p)
    for a, b in (("la", "ra"), ("lf", "rf"), ("llift", "rlift")):
        q[a], q[b] = p[b], p[a]
    q["lfx"], q["rfx"] = -p["rfx"], -p["lfx"]
    for k in ("px", "lean", "tilt", "hx", "tail"):
        q[k] = -p[k]
    return q


def arm_points(shoulder, upper, fore, side, l1=9.5, l2=8.5):
    """side = -1 for the screen-left arm, +1 for the screen-right arm."""
    def d(theta):
        r = math.radians(theta)
        return side * math.sin(r), math.cos(r)
    ux, uy = d(upper)
    fx, fy = d(fore)
    elbow = (shoulder[0] + ux * l1, shoulder[1] + uy * l1)
    paw = (elbow[0] + fx * l2, elbow[1] + fy * l2)
    return elbow, paw


def side_arm_points(shoulder, upper, fore, l1=9.5, l2=8.5):
    """Profile view: sideways reach is foreshortened into a short forward reach."""
    def d(theta):
        r = math.radians(theta)
        return 0.5 * abs(math.sin(r)), math.cos(r)
    ux, uy = d(upper)
    fx, fy = d(fore)
    elbow = (shoulder[0] + ux * l1, shoulder[1] + uy * l1)
    paw = (elbow[0] + fx * l2, elbow[1] + fy * l2)
    return elbow, paw


def leg_points(hip, foot, bend, l1=11.0, l2=11.0):
    """Two-bone IK. bend picks the knee: -1 bows left, +1 bows right."""
    dx, dy = foot[0] - hip[0], foot[1] - hip[1]
    dist = math.hypot(dx, dy) or 1e-6
    dist_c = min(dist, l1 + l2 - 0.01)
    a = (l1 * l1 - l2 * l2 + dist_c * dist_c) / (2 * dist_c)
    h = math.sqrt(max(0.0, l1 * l1 - a * a))
    ex, ey = dx / dist, dy / dist
    mx, my = hip[0] + ex * a, hip[1] + ey * a
    k1 = (mx - ey * h, my + ex * h)
    k2 = (mx + ey * h, my - ex * h)
    knee = min(k1, k2) if bend < 0 else max(k1, k2)
    if dist > l1 + l2:
        foot = (hip[0] + ex * (l1 + l2), hip[1] + ey * (l1 + l2))
    return knee, foot


def body_frame(p, scale_x=1.0, pitch=None):
    """Pelvis position and a local->screen transform for the torso."""
    lean = p["lean"] if pitch is None else pitch
    pel = (CX + p["px"] * scale_x, PELVIS_Y + p["py"])

    def W_(x, y):
        rx, ry = rot(x, y, lean)
        return pel[0] + rx, pel[1] + ry
    return pel, lean, W_


def head_frame(hc, hang):
    return lambda x, y: (hc[0] + rot(x, y, hang)[0], hc[1] + rot(x, y, hang)[1])


def shadow_k(p):
    lift = min(p["llift"], p["rlift"])
    return max(0.55, 1 - max(0.0, lift - 1) / 14)


# ---- front
def draw_front(p, cat, back=False):
    pal, pat = cat["pal"], cat["pattern"]
    cv = Canvas()
    P = lambda part, base: (lambda s, t: pat(part, s, t, base))
    pel, lean, W_ = body_frame(p)

    def tail():
        if back:  # from behind it starts mid-back, low, and curls out to the side in front of the body
            base = W_(1.5, -1)
            sw = p["tail"] + p["swing"]
            ctrl = (base[0] + 13 + 2 * math.sin(math.radians(sw)), base[1] + 3)
            tipx, tipy = rot(7, -15, sw)
            tip = (base[0] + 10 + tipx, base[1] - 1 + tipy)
        else:
            base = W_(8, -3)
            sw = p["tail"] + p["swing"]
            ctrl = (base[0] + 11 + 2 * math.sin(math.radians(sw)), base[1] + 2)
            tipx, tipy = rot(9, -15, sw)
            tip = (base[0] + 6 + tipx, base[1] + tipy)
        cv.group([chain(bezier(base, ctrl, tip), lambda s, T: 2.5 - 0.9 * s / T, P("tail", "body"))])

    def arms():
        for side, ua, fa, name in ((-1, p["la"], p["lf"], "arm0"), (1, p["ra"], p["rf"], "arm1")):
            sh = W_(side * 7, -21)
            elbow, paw = arm_points(sh, ua, fa, side)
            cv.group([chain([sh, elbow, paw], 2.6, P(name, "body"))], cast=not back)
            prims = [ellipse(paw[0], paw[1], 3.1, 3.1, P("paw", "paw"))]
            if not back:
                prims.append(pix([(paw[0] - 1, paw[1] + 2.2), (paw[0] + 1, paw[1] + 2.2)], "toe"))
            cv.group(prims)

    if not back:
        tail()
    # ---- legs (IK) and feet
    for side, fx, lift, name in ((-1, p["lfx"], p["llift"], "leg0"), (1, p["rfx"], p["rlift"], "leg1")):
        hip = W_(side * 5.0, 0)
        foot = (CX + fx, GROUND - 2.2 - lift)
        knee, foot = leg_points(hip, foot, side)
        cv.group([chain([hip, knee, foot], lambda s_, T: 3.7 - 0.6 * s_ / T, P(name, "body"))])
        prims = [ellipse(foot[0] + side * 1.6, foot[1] + 0.3, 4.4, 2.5, P("foot", "paw"))]
        if not back:
            prims.append(pix([(foot[0] + side * 1.6 + o, foot[1] + 1.4) for o in (-1.5, 1.5)], "toe"))
        cv.group(prims)

    if back:  # arms that cross the chest disappear behind the body
        arms()
    # ---- torso: belly + chest, fluffy blaze (front only)
    lo, up = W_(0, -7), W_(0, -18)
    torso = [blob([(lo[0], lo[1], 10, 11.5, lean, 0), (up[0], up[1], 8.2, 8.5, lean, 0)], P("torso", "body"))]
    if not back:
        b1, b2 = W_(0.6, -9), W_(0.2, -19)
        torso.append(blob([(b1[0], b1[1], 5.6, 9.5, lean, 0.07), (b2[0], b2[1], 4.6, 6.5, lean, 0.1)], P("blaze", "belly")))
    cv.group(torso, cast=True)
    if back:
        tail()
    else:
        arms()

    # ---- head
    hang = lean * 0.6 + p["tilt"]
    hc = W_(p["hx"], -31 + p["hy"])
    hc = (hc[0] + p["hx"] * 0.3, hc[1])
    Hp = head_frame(hc, hang)
    head_prims = [
        poly([Hp(-10.5, -2), Hp(-9.5, -15.5), Hp(-2.5, -7.5)], P("ear0", "body")),
        poly([Hp(10.5, -2), Hp(9.5, -15.5), Hp(2.5, -7.5)], P("ear1", "body")),
    ]
    if not back:
        head_prims += [
            poly([Hp(-8.6, -4.5), Hp(-8.6, -12.2), Hp(-4.6, -7.6)], "pink", shade=False),
            poly([Hp(8.6, -4.5), Hp(8.6, -12.2), Hp(4.6, -7.6)], "pink", shade=False),
        ]
    head_prims += [
        ellipse(hc[0], hc[1], 11.2, 8.8, P("backhead" if back else "head", "body"), ang=hang),
        poly([Hp(-10.2, 1), Hp(-13, 5.2), Hp(-7.5, 6.5)], P("cheek0", "body")),
        poly([Hp(10.2, 1), Hp(13, 5.2), Hp(7.5, 6.5)], P("cheek1", "body")),
    ]
    if not back:
        head_prims.append(ellipse(*Hp(-0.5, 4.2), 5.8, 3.6, P("muzzle", "belly"), ang=hang))
    cv.group(head_prims, cast=True)

    if not back:
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
        acc(cv, "back" if back else "front", Hp, W_, hang)
    return cv.render(pal, CX + p["px"] * 0.6, shadow_k(p))


# ---- side (facing screen right)
def draw_side(p, cat):
    pal, pat = cat["pal"], cat["pattern"]
    cv = Canvas()
    P = lambda part, base: (lambda s, t: pat(part, s, t, base))
    # Sideways sway reads as a gentle rock in profile; bounce stays as is.
    pel, pitch, W_ = body_frame(p, scale_x=0.4, pitch=p["lean"] * 0.3)

    # ---- tail, behind everything
    base = W_(-7.5, -3)
    sw = p["tail"] + p["swing"]
    ctrl = (base[0] - 10 + 2 * math.sin(math.radians(sw)), base[1] + 1)
    tipx, tipy = rot(-7, -15, sw * 0.6)
    tip = (base[0] - 5 + tipx, base[1] + tipy)
    cv.group([chain(bezier(base, ctrl, tip), lambda s, T: 2.5 - 0.9 * s / T, P("tail", "body"))])

    # ---- legs: lifting a foot brings the knee forward; a wide stance becomes a stride
    def leg(fx, lift, s, name, shade_far):
        hip = W_(s * 1.2, 0)
        stride = s * (abs(fx) - 8) * 0.45 + s * 1.5
        foot = (CX + p["px"] * 0.4 + stride + lift * 0.55, GROUND - 2.2 - lift)
        knee, foot = leg_points(hip, foot, +1)
        limb = chain([hip, knee, foot], lambda s_, T: 3.7 - 0.6 * s_ / T, P(name, "body"))
        paw = ellipse(foot[0] + 2.2, foot[1] + 0.3, 4.9, 2.4, P("foot", "paw"))
        if shade_far:
            cv.group([far(limb)])
            cv.group([far(paw)])
        else:
            cv.group([limb])
            cv.group([paw, pix([(foot[0] + 5.2, foot[1] + 1.3)], "toe")])
    leg(p["lfx"], p["llift"], -1, "leg0", True)

    # ---- far arm, behind the body
    def arm(ua, fa, sh, name, shade_far):
        elbow, paw = side_arm_points(sh, ua, fa)
        limb = chain([sh, elbow, paw], 2.6, P(name, "body"))
        pawp = ellipse(paw[0], paw[1], 3.0, 3.0, P("paw", "paw"))
        if shade_far:
            cv.group([far(limb)])
            cv.group([far(pawp)])
        else:
            cv.group([limb], cast=True)
            cv.group([pawp])
    arm(p["la"], p["lf"], W_(-1.5, -21.5), "arm0", True)
    leg(p["rfx"], p["rlift"], 1, "leg1", False)

    # ---- torso with the belly blaze along the front edge
    lo, up = W_(0, -7), W_(1, -18)
    b1, b2 = W_(4.6, -9), W_(4.4, -19)
    cv.group([
        blob([(lo[0], lo[1], 8.6, 11.5, pitch, 0), (up[0], up[1], 7.0, 8.5, pitch, 0)], P("torso", "body")),
        blob([(b1[0], b1[1], 3.6, 9.0, pitch, 0.07), (b2[0], b2[1], 3.0, 6.0, pitch, 0.1)], P("blaze", "belly")),
    ], cast=True)
    arm(p["ra"], p["rf"], W_(2, -21), "arm1", False)

    # ---- head in profile
    hang = pitch * 0.6 + p["tilt"] * 0.5
    hc = W_(2 + p["hx"] * 0.3, -31 + p["hy"])
    Hp = head_frame(hc, hang)
    cv.group([poly([Hp(-8.5, -3), Hp(-8, -14.5), Hp(-2.5, -7.5)], P("ear0", "body"))])  # far ear
    cv.group([
        poly([Hp(-4.5, -5), Hp(-2, -16), Hp(3.5, -7.5)], P("ear1", "body")),
        poly([Hp(-3.2, -6.5), Hp(-1.9, -13), Hp(1.8, -7.8)], "pink", shade=False),
        ellipse(hc[0], hc[1], 9.8, 8.8, P("head", "body"), ang=hang),
        poly([Hp(-6, 1.5), Hp(-11, 6), Hp(-3.5, 7)], P("cheek0", "body")),
        ellipse(*Hp(7.4, 3.6), 4.6, 3.4, P("muzzle", "belly"), ang=hang),
    ], cast=True)
    F = lambda pts: [Hp(x + 0.5, y + 0.5) for x, y in pts]
    face = []
    if p["eyes"] == "happy":
        face.append(pix(F([(3, 0), (4, -1), (5, -1), (6, 0)]), "ol"))
    elif p["eyes"] == "blink":
        face.append(pix(F([(3, 0), (4, 0), (5, 0), (6, 0)]), "ol"))
    else:
        face += [pix(F([(4, -1), (5, -1), (4, 0), (5, 0), (4, 1), (5, 1)]), "ol"), pix(F([(4, -1)]), "glint_eye")]
    face += [pix(F([(2, 2), (3, 2)]), "blush"), pix(F([(11, 2)]), "nose")]
    if p["mouth"] == "open":
        face += [pix(F([(8, 5), (9, 5), (10, 5), (9, 6)]), "ol"), pix(F([(9, 5)]), "tongue")]
    else:
        face.append(pix(F([(8, 5), (9, 6), (10, 5)]), "ol"))
    cv.group(face, inner=False)

    acc = cat.get("accessory")
    if acc:
        acc(cv, "side", Hp, W_, hang)
    return cv.render(pal, CX + p["px"] * 0.3, shadow_k(p))


def draw_cat(pose, cat, view="front"):
    p = dict(REST, **pose)
    if cat.get("bot"):
        return draw_robot(p, cat["bot"], view)
    if view == "side":
        return draw_side(p, cat)
    if view == "back":
        return draw_front(mirrored(p), cat, back=True)
    return draw_front(p, cat)


# ------------------------------------------------------------------ accessories
# Each takes (canvas, view, head->screen, body->screen, head angle).
def collar(cv, view, Hp, W_, hang):
    if view == "side":
        cv.group([chain([W_(-4.5, -23), W_(0, -22), W_(4.8, -21.5)], 1.3, "acc")])
        cv.group([ellipse(*W_(5.2, -19.6), 1.9, 1.9, "acc2")])
        return
    dip = -21 if view == "front" else -22.8
    cv.group([chain([W_(-6.5, -22.5), W_(0, dip), W_(6.5, -22.5)], 1.3, "acc")])
    if view == "front":
        cv.group([ellipse(*W_(0, -18.8), 1.9, 1.9, "acc2")])


def headphones(cv, view, Hp, W_, hang):
    if view == "side":
        band = [Hp(-3, 0), Hp(-3.5, -6), Hp(-1.5, -10.4), Hp(2.5, -11)]
        cv.group([chain(band, 1.1, "acc2")])
        cv.group([ellipse(*Hp(-2.5, 1.2), 3.6, 4.4, "acc", ang=hang)])
        return
    band = [Hp(-11.8, 0), Hp(-11, -6.5), Hp(-6, -10.6), Hp(0, -11.4), Hp(6, -10.6), Hp(11, -6.5), Hp(11.8, 0)]
    cv.group([chain(band, 1.1, "acc2")])
    cv.group([ellipse(*Hp(-12, 1.2), 2.9, 4.0, "acc", ang=hang)])
    cv.group([ellipse(*Hp(12, 1.2), 2.9, 4.0, "acc", ang=hang)])


def shades(cv, view, Hp, W_, hang):
    if view == "side":
        cv.group([ellipse(*Hp(4.8, -0.2), 3.0, 2.5, "lens", ang=hang, shade=False),
                  chain([Hp(1.5, -1.6), Hp(-5.5, -1.2)], 0.6, "lens", shade=False)], inner=False)
        cv.group([pix([Hp(4, -1), Hp(5, -1.6)], "glint")], inner=False)
        cv.group([chain([W_(-3, -23), W_(2.5, -17.5), W_(4.5, -21.5)], 0.7, "acc2", shade=False),
                  ellipse(*W_(3, -16), 1.8, 2.0, "acc2")], inner=False)
        return
    if view == "back":  # just the arms of the glasses and the chain at the nape
        cv.group([chain([Hp(-11.5, -1.6), Hp(-9, -1.2)], 0.6, "lens", shade=False),
                  chain([Hp(9, -1.2), Hp(11.5, -1.6)], 0.6, "lens", shade=False)], inner=False)
        cv.group([chain([W_(-5.5, -22.5), W_(0, -21.5), W_(5.5, -22.5)], 0.7, "acc2", shade=False)], inner=False)
        return
    cv.group([
        ellipse(*Hp(-5.2, -0.2), 3.6, 2.5, "lens", ang=hang, shade=False),
        ellipse(*Hp(4.4, -0.2), 3.6, 2.5, "lens", ang=hang, shade=False),
        chain([Hp(-9, -1.6), Hp(8.4, -1.6)], 0.7, "lens", shade=False),
    ], inner=False)
    cv.group([pix([Hp(-6.5, -1), Hp(-5.5, -1.6), Hp(3, -1), Hp(4, -1.6)], "glint")], inner=False)
    cv.group([chain([W_(-5.5, -22.5), W_(0, -17.5), W_(5.5, -22.5)], 0.7, "acc2", shade=False),
              ellipse(*W_(0, -16), 1.8, 2.0, "acc2")], inner=False)


def bow(cv, view, Hp, W_, hang):
    x = {"front": -7.5, "back": 7.5, "side": -2.5}[view]
    c = Hp(x, -9 if view != "side" else -10.5)
    cv.group([
        poly([c, Hp(x - 5, -12.5), Hp(x - 5, -5.5)], "acc"),
        poly([c, Hp(x + 5, -12.5), Hp(x + 5, -5.5)], "acc"),
    ])
    cv.group([ellipse(c[0], c[1], 1.6, 1.6, "acc2")])


def bandana(cv, view, Hp, W_, hang):
    def dots(s, t):
        return "acc2" if (int(s + 40) % 4 == 0 and int(t + 40) % 4 == 1) else "acc"
    if view == "side":
        cv.group([poly([W_(-3, -23.5), W_(6.2, -23.5), W_(5.6, -14.5)], dots)])
    elif view == "back":
        cv.group([chain([W_(-8, -23), W_(0, -23.6), W_(8, -23)], 1.4, "acc")])
        cv.group([ellipse(*W_(0, -22.6), 2.2, 1.8, "acc"),
                  poly([W_(-0.5, -22), W_(-3.5, -16.5), W_(-1, -17)], "acc"),
                  poly([W_(0.5, -22), W_(3.5, -16.5), W_(1, -17)], "acc")])
    else:
        cv.group([poly([W_(-9, -23.5), W_(9, -23.5), W_(0.3, -13.5)], dots)])


def _dome(Hp, cx, top, rx, ry, n=10):
    """Half-ellipse cap over the head (a beanie shell)."""
    return [Hp(cx + rx * math.cos(math.pi * i / n), top - ry * math.sin(math.pi * i / n)) for i in range(n + 1)]


def beanie(cv, view, Hp, W_, hang):
    def ribs(s, t):
        return "acc_s" if int(s + 40) % 3 == 0 else "acc"
    if view == "side":
        cv.group([poly(_dome(Hp, -1, -6.5, 9.6, 7.5), ribs)])
        cv.group([chain([Hp(-10.4, -6.3), Hp(8.6, -6.3)], 1.4, "acc2")])
        cv.group([ellipse(*Hp(-2, -14.6), 2.4, 2.4, "acc2")])
        return
    cv.group([poly(_dome(Hp, 0, -6.5, 10.4, 7.5), ribs)])
    cv.group([chain([Hp(-10.8, -6.3), Hp(10.8, -6.3)], 1.5, "acc2")])
    cv.group([ellipse(*Hp(0, -14.8), 2.5, 2.5, "acc2")])


def party_hat(cv, view, Hp, W_, hang):
    def stripes(s, t):
        return "acc2" if int(t + s * 0.4 + 40) % 4 == 0 else "acc"
    x = {"front": 2.5, "back": -2.5, "side": -1}[view]
    cv.group([poly([Hp(x - 5.2, -7), Hp(x + 5.2, -7), Hp(x + 1.5, -19.5)], stripes)])
    cv.group([ellipse(*Hp(x + 1.5, -19.5), 1.9, 1.9, "acc2")])


def flower(cv, view, Hp, W_, hang):
    x = {"front": 7.5, "back": -7.5, "side": -1.5}[view]
    c = Hp(x, -9 if view != "side" else -10.5)
    petals = [ellipse(c[0] + 2.6 * math.cos(a), c[1] + 2.6 * math.sin(a), 1.9, 1.9, "acc")
              for a in (math.radians(d) for d in range(-90, 270, 72))]
    cv.group(petals)
    cv.group([ellipse(c[0], c[1], 1.5, 1.5, "acc2")])


def bowtie(cv, view, Hp, W_, hang):
    if view == "back":
        cv.group([chain([W_(-6.5, -22.5), W_(0, -23.2), W_(6.5, -22.5)], 0.8, "acc", shade=False)], inner=False)
        return
    cx = 0 if view == "front" else 5.3
    w = 4.4 if view == "front" else 2.2
    c = W_(cx, -21.5)
    cv.group([poly([c, W_(cx - w, -24), W_(cx - w, -19)], "acc"),
              poly([c, W_(cx + w, -24), W_(cx + w, -19)], "acc")])
    cv.group([ellipse(c[0], c[1], 1.3, 1.3, "acc2")])


def scarf(cv, view, Hp, W_, hang):
    def knit(s, t):
        return "acc2" if int(s + 40) % 5 == 0 else "acc"
    if view == "side":
        cv.group([chain([W_(-4.8, -23.5), W_(0, -22.2), W_(5, -22)], 2.4, knit)])
        cv.group([poly([W_(-4, -22), W_(-8.5, -14), W_(-5, -13.5), W_(-1.5, -21)], knit)])
        return
    cv.group([chain([W_(-7.2, -23.4), W_(0, -21.6 if view == "front" else -23.4), W_(7.2, -23.4)], 2.4, knit)])
    tail_x = 4 if view == "front" else -4
    cv.group([poly([W_(tail_x - 2.2, -22), W_(tail_x - 2.8, -11.5), W_(tail_x + 1.8, -11.8), W_(tail_x + 2.4, -22)], knit)])


# ------------------------------------------------------------------ robots
# Robots ride the same skeleton and moves as the cats, with metal body kits.
# Their special is light: antenna tips, eyes, visors and thrusters pulse with
# the beat (pose "glow"), and antennas pump up and down (pose "ext").
def rbox(F, x0, y0, x1, y1, color, cut=1.5, shade=True):
    """A box with chamfered corners, in whatever frame F maps (body, head or screen)."""
    pts = [(x0 + cut, y0), (x1 - cut, y0), (x1, y0 + cut), (x1, y1 - cut),
           (x1 - cut, y1), (x0 + cut, y1), (x0, y1 - cut), (x0, y0 + cut)]
    return poly([F(x, y) for x, y in pts], color, shade)


def lamp(g):
    return "lamp_on" if g > 0.6 else "lamp_dim" if g > 0.25 else "lamp_off"


def eye_key(g):
    return "eye_on" if g > 0.6 else "eye"


def antenna(cv, F, x, y, ang, length, glow, r=0.65, bulb=1.7):
    rad = math.radians(ang)
    base, tip = F(x, y), F(x + length * math.sin(rad), y - length * math.cos(rad))
    cv.group([chain([base, tip], r, "metal2", shade=False)])
    cv.group([ellipse(tip[0], tip[1], bulb, bulb, lamp(glow), shade=False)])


# ---- heads: (canvas, head->screen, view, pose, bot)
def head_crt(cv, Hp, view, p, bot):
    """Boxy: a CRT head with a dark screen, two red eyes and twin antennas."""
    g, up = p["glow"], 4 + 5 * p["ext"]
    if view == "side":
        for x in (-3, 2):
            antenna(cv, Hp, x, -10, -8, up, g)
        cv.group([rbox(Hp, -8, -10, 9, 9, "metal", cut=3)], cast=True)
        cv.group([rbox(Hp, 7, -6.5, 10, 6.5, "dark", cut=1, shade=False)])
        cv.group([ellipse(*Hp(-1, 0), 2.6, 2.6, "metal2")])
        return
    for x in (-6, 7):
        antenna(cv, Hp, x, -10, -6 if x < 0 else 6, up, g)
    cv.group([rbox(Hp, -12, -10, 12, 9, "metal", cut=3)], cast=True)
    cv.group([rbox(Hp, -14, -3, -11, 3, "metal2", cut=1)])  # side knob
    if view == "back":
        cv.group([pix([Hp(x, y) for x in (-6, -3, 0, 3, 6) for y in (-4, 0, 4)], "metal2")], inner=False)
        return
    cv.group([rbox(Hp, -8, -6.5, 10, 6.5, "dark", cut=2, shade=False)])
    ek = eye_key(g)
    if p["eyes"] == "blink":
        cv.group([pix([Hp(x, 0.5) for x in (-3, -2, -1, 0, 4, 5, 6, 7)], ek)], inner=False)
    else:
        cv.group([ellipse(*Hp(-1.5, 0), 2.3, 2.3, ek, shade=False), ellipse(*Hp(5.5, 0), 2.3, 2.3, ek, shade=False)], inner=False)


def head_tv(cv, Hp, view, p, bot):
    """Pixel: a chunky TV head whose screen shows a pixel smiley."""
    g, up = p["glow"], 3 + 5 * p["ext"]
    if view == "side":
        antenna(cv, Hp, 1, -11, 12, up, g)
        cv.group([rbox(Hp, -9, -11, 9, 10, "acc", cut=2.5)], cast=True)
        cv.group([rbox(Hp, 8, -8, 11, 8, "screen", cut=1, shade=False)])
        cv.group([rbox(Hp, -3, -3, 1, 3, "dark", cut=1)])
        return
    antenna(cv, Hp, 5, -11, 15, up, g)
    cv.group([rbox(Hp, -13, -11, 13, 10, "acc", cut=2.5)], cast=True)
    cv.group([rbox(Hp, -16, -3.5, -13, 3.5, "dark", cut=1)])  # knob on the side
    if view == "back":
        cv.group([pix([Hp(x, y) for x in (-7, -4, -1, 2, 5, 8) for y in (-5, -1, 3)], "acc_s")], inner=False)
        return
    cv.group([rbox(Hp, -10, -8, 11, 8, "screen", cut=1.5, shade=False)])
    face = "face_on" if g > 0.6 else "face"
    if p["eyes"] == "blink":
        eyes = [(-5, -1), (-4, -1), (4, -1), (5, -1)]
    else:
        eyes = [(-5, -2), (-4, -2), (-5, -1), (-4, -1), (4, -2), (5, -2), (4, -1), (5, -1)]
    if p["mouth"] == "open":
        mouth = [(-4, 2), (4, 2)] + [(x, 3) for x in range(-3, 4)] + [(x, 4) for x in range(-2, 3)]
    else:
        mouth = [(-4, 2), (4, 2)] + [(x, 3) for x in range(-3, 4)]
    cv.group([pix([Hp(x + 0.5, y + 0.5) for x, y in eyes + mouth], face)], inner=False)


def head_dome(cv, Hp, view, p, bot):
    """Tidy: a maid bot's dome head, frilly headband and bulb 'ear' antennas."""
    g, up = p["glow"], 2.5 + 3.5 * p["ext"]
    if view == "side":
        antenna(cv, Hp, -1, -6, -25, up + 1, g, bulb=2.0)
        cv.group([ellipse(*Hp(0, 0), 9.2, 8.6, "metal", ang=0)], cast=True)
        cv.group([chain([Hp(-6, -6.5), Hp(-1, -8.3), Hp(4, -7.2)], 1.5, "acc")])
        cv.group([rbox(Hp, 2, -2.5, 9.6, 2.5, "dark", cut=1, shade=False)])
        cv.group([ellipse(*Hp(6.5, 0), 1.6, 1.6, lamp(g), shade=False)], inner=False)
        return
    for s in (-1, 1):
        antenna(cv, Hp, s * 9.5, -2, s * 60, up, g, bulb=2.0)
    cv.group([ellipse(*Hp(0, 0), 10, 8.6, "metal")], cast=True)
    cv.group([chain([Hp(-7.5, -5.5), Hp(0, -8.4), Hp(7.5, -5.5)], 1.6, "acc")])
    cv.group([pix([Hp(x, -9.6) for x in (-4, -1, 2, 5)], "acc")], inner=False)  # frill
    if view == "back":
        return
    cv.group([rbox(Hp, -8, -2.5, 8, 2.5, "dark", cut=1, shade=False)])
    if p["eyes"] == "blink":
        cv.group([pix([Hp(x, 0.5) for x in (-5, -4, -3, 3, 4, 5)], lamp(g))], inner=False)
    else:
        cv.group([ellipse(*Hp(-3.8, 0), 1.7, 1.7, lamp(g), shade=False),
                  ellipse(*Hp(3.8, 0), 1.7, 1.7, lamp(g), shade=False)], inner=False)
    if p["mouth"] == "open":
        cv.group([rbox(Hp, -2, 4, 2, 6.2, "dark", cut=0.6, shade=False)], inner=False)
    else:
        cv.group([pix([Hp(x, 5) for x in (-2, -1, 0, 1)], "dark")], inner=False)


def head_skull(cv, Hp, view, p, bot):
    """Endo: a chrome endoskeleton skull with red eyes that flare on the beat."""
    g = p["glow"]
    ek = eye_key(g)
    if view == "side":
        cv.group([ellipse(*Hp(-0.5, -2), 8.8, 8, "metal"), rbox(Hp, 0, 1, 8, 8, "metal", cut=2)], cast=True)
        cv.group([ellipse(*Hp(5, -0.5), 2.2, 1.8, "dark", shade=False)], inner=False)
        cv.group([pix([Hp(5.5, -0.5)], ek), pix([Hp(x, 5.5) for x in (3, 5, 7)], "dark")], inner=False)
        cv.group([chain([Hp(-3, 3), Hp(-4, 9)], 1.2, "metal2")])
        return
    cv.group([ellipse(*Hp(0, -2), 8.6, 8, "metal"), rbox(Hp, -6, 1, 6, 8.5, "metal", cut=2.5)], cast=True)
    if view == "back":
        cv.group([pix([Hp(x, -6 + abs(x) * 0.3) for x in range(-4, 5)], "metal2")], inner=False)
        return
    cv.group([ellipse(*Hp(-3.3, -0.5), 2.4, 1.9, "dark", shade=False),
              ellipse(*Hp(3.3, -0.5), 2.4, 1.9, "dark", shade=False),
              poly([Hp(-1, 2), Hp(1, 2), Hp(0, 3.6)], "dark", shade=False)], inner=False)
    eyes = [(-4, -1), (-3, -1), (3, -1), (4, -1)] if g > 0.6 else [(-3, -1), (3, -1)]
    if p["eyes"] != "blink":
        cv.group([pix([Hp(x + 0.5, y + 0.5) for x, y in eyes], ek)], inner=False)
    cv.group([pix([Hp(x, 6) for x in (-4, -2, 0, 2, 4)], "dark")], inner=False)


def head_bullet(cv, Hp, view, p, bot):
    """Jet: a rounded flight helmet with a visor that lights up, and a fin antenna."""
    g = p["glow"]
    fin = 3 + 4 * p["ext"]
    if view == "side":
        cv.group([poly([Hp(-4, -6), Hp(-1, -6.5), Hp(-5, -7 - fin)], "metal2")])
        cv.group([ellipse(*Hp(-5, -7 - fin), 1.5, 1.5, lamp(g), shade=False)])
        cv.group([ellipse(*Hp(0, 0), 8.6, 7.6, "metal")], cast=True)
        cv.group([rbox(Hp, 2, -2.5, 9, 2.5, lamp(g), cut=1.2, shade=False)])
        return
    cv.group([poly([Hp(-1.5, -6.5), Hp(1.5, -6.5), Hp(0, -7.5 - fin)], "metal2")])
    cv.group([ellipse(*Hp(0, -7.5 - fin), 1.5, 1.5, lamp(g), shade=False)])
    cv.group([ellipse(*Hp(0, 0), 9, 7.6, "metal")], cast=True)
    if view == "back":
        cv.group([pix([Hp(x, 3) for x in (-4, -2, 0, 2, 4)], "metal2")], inner=False)
        return
    cv.group([rbox(Hp, -7.5, -2.6, 7.5, 2.6, lamp(g), cut=1.2, shade=False)])
    cv.group([pix([Hp(-5, -1.5), Hp(-4, -1.5)], "glint")], inner=False)


# ---- torsos: (canvas, body->screen, view, pose, bot)
def torso_box(cv, W_, view, p, bot):
    w = 6.5 if view == "side" else 9
    cv.group([rbox(W_, -w + 2, -3, w - 2, 2, "metal2", cut=1)])
    cv.group([rbox(W_, -w, -26, w, -2, "metal", cut=2.5)], cast=True)
    if view == "front":
        cv.group([rbox(W_, -4.5, -20, 4.5, -10, "dark", cut=1, shade=False)])
        cv.group([pix([W_(-2.5, -16.5), W_(0, -16.5), W_(2.5, -16.5)], lamp(p["glow"])),
                  pix([W_(x, -13) for x in (-3, -2, -1, 0)], "metal2")], inner=False)
    elif view == "back":
        cv.group([pix([W_(x, y) for x in (-5, -2, 1, 4) for y in (-20, -16, -12, -8)], "metal2")], inner=False)
    else:
        cv.group([rbox(W_, 4, -19, 6.5, -11, "dark", cut=0.8, shade=False)])


def torso_small(cv, W_, view, p, bot):
    w = 4.5 if view == "side" else 6
    cv.group([rbox(W_, -w, -14, w, 0, "acc", cut=1.5)], cast=True)
    if view == "front":
        cv.group([rbox(W_, -3.5, -10, 3.5, -3, "acc_h", cut=0.8, shade=False)])
    elif view == "side":
        cv.group([rbox(W_, 1.5, -10, 4.5, -3, "acc_h", cut=0.8, shade=False)])


def torso_barrel(cv, W_, view, p, bot):
    side = view == "side"
    lo, up = W_(0, -8), W_(0.5 if side else 0, -18)
    cv.group([blob([(lo[0], lo[1], 7.5 if side else 9.5, 9, 0, 0), (up[0], up[1], 6.5 if side else 7.8, 7.5, 0, 0)], "metal")], cast=True)
    if view == "front":
        cv.group([poly([W_(-5.5, -15), W_(5.5, -15), W_(8, -1), W_(-8, -1)], "acc")])
        cv.group([pix([W_(x, 0) for x in range(-7, 8, 2)], "acc2")], inner=False)  # frilly hem
        cv.group([chain([W_(-6, -15), W_(-7, -23)], 0.7, "acc", shade=False),
                  chain([W_(6, -15), W_(7, -23)], 0.7, "acc", shade=False)], inner=False)
    elif view == "back":
        cv.group([chain([W_(-8.5, -12), W_(8.5, -12)], 1.0, "acc", shade=False)])
        c = W_(0, -12)
        cv.group([poly([c, W_(-5, -15.5), W_(-5, -8.5)], "acc"), poly([c, W_(5, -15.5), W_(5, -8.5)], "acc")])
    else:
        cv.group([poly([W_(3, -15), W_(6, -15), W_(8, -1), W_(4, -1)], "acc")])


def torso_capsule(cv, W_, view, p, bot):
    side = view == "side"
    lo, up = W_(0, -7), W_(0, -17)
    cv.group([blob([(lo[0], lo[1], 6.5 if side else 8, 8, 0, 0), (up[0], up[1], 6.5 if side else 7.8, 8, 0, 0)], "metal")], cast=True)
    cv.group([chain([W_(-7.5 if not side else -6, -11), W_(7.5 if not side else 6, -11)], 0.9, "acc", shade=False)])
    if view == "front":
        cv.group([ellipse(*W_(0, -17), 3.2, 3.2, "dark", shade=False)])
        cv.group([ellipse(*W_(0, -17), 1.9, 1.9, lamp(p["glow"]), shade=False)], inner=False)
    elif view == "back":
        cv.group([rbox(W_, -5, -21, -1.5, -13, "metal2", cut=1), rbox(W_, 1.5, -21, 5, -13, "metal2", cut=1)])


def torso_ribs(cv, W_, view, p, bot):
    side = view == "side"
    cv.group([rbox(W_, -6 if not side else -4, -3, 6 if not side else 4, 2, "metal", cut=1.5)])
    cv.group([chain([W_(0, -1), W_(0, -26)], 1.6, "metal2")])
    ribs = []
    for y in (-23, -20, -17, -14):
        if side:
            ribs.append(chain([W_(-0.5, y), W_(4.5, y + 1.5), W_(5, y + 3.5)], 0.9, "metal"))
        else:
            ribs.append(chain([W_(-1, y), W_(-6.8, y + 1.5), W_(-5.8, y + 3.4)], 0.9, "metal"))
            ribs.append(chain([W_(1, y), W_(6.8, y + 1.5), W_(5.8, y + 3.4)], 0.9, "metal"))
    cv.group(ribs)
    cv.group([chain([W_(-8 if not side else -3, -25), W_(8 if not side else 3, -25)], 1.4, "metal")])


def _unit(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L = math.hypot(dx, dy) or 1.0
    return dx / L, dy / L


def draw_robot(p, bot, view):
    """Robots and other non-cat avatars: a head, a torso, arms (with optional
    things in their hands) and legs, a wheel, a thruster, tentacles or nothing
    at all (floating), all posed by the shared skeleton and moves."""
    side, back = view == "side", view == "back"
    if back:
        p = mirrored(p)
    cv = Canvas()
    fl = bot.get("float", 0)
    py = max(p["py"], -5) if fl else p["py"]
    lean = p["lean"] * 0.3 if side else p["lean"] * bot.get("stiff", 0.7)
    pel = (CX + p["px"] * (0.4 if side else 1.0), GROUND - bot["hip"] - fl + py)

    def W_(x, y):
        rx, ry = rot(x, y, lean)
        return pel[0] + rx, pel[1] + ry
    sx, sy = bot["shoulder"]
    a1, a2 = bot["arm"]
    ar = bot["arm_r"]
    arm_c = bot.get("arm_c", "metal")
    joint_c = lamp(p["glow"]) if bot.get("joint_lamp") else bot.get("joint_c", "metal2")

    def limb_group(prims, extra, is_far, cast=True):
        if is_far:
            cv.group([far(q) for q in prims])
            if extra:
                cv.group([far(q) for q in extra])
        else:
            cv.group(prims, cast=cast)
            if extra:
                cv.group(extra)

    def foot_prims(foot, s):
        kind = bot.get("foot", "shoe")
        fw = bot.get("foot_w", 4.5)
        fc = bot.get("foot_c", "metal2")
        if kind == "talon":  # three thin claws
            d = 1 if side else s
            return [chain([foot, (foot[0] + d * 4.5 + o, foot[1] + 2.2)], 0.7, fc, shade=False) for o in (-3.5, 0, 2.5)]
        if kind == "nub":
            return [ellipse(foot[0] + (1 if side else s * 0.6), foot[1] + 0.8, fw, 1.8, fc)]
        fx0 = foot[0] + (2 if side else s * 1.2)
        return [rbox(lambda x, y: (x, y), fx0 - fw, foot[1] - 1.8, fx0 + fw, foot[1] + 2.2, fc, cut=1.2)]

    def legs(which):
        l1, l2 = bot["leg"]
        lr = bot["leg_r"]
        for fx, lift, s, is_far in which:
            if side:
                hip = W_(s * 1.0, 0)
                stride = s * (abs(fx) - 8) * 0.4 + s * 1.5
                foot = (pel[0] + stride + lift * 0.5, GROUND - 2.4 - lift)
                knee, foot = leg_points(hip, foot, +1, l1, l2)
            else:
                hip = W_(s * bot["hip_w"], 0)
                foot = (CX + fx * bot.get("stance", 1.0), GROUND - 2.4 - lift)
                knee, foot = leg_points(hip, foot, s, l1, l2)
            extra = foot_prims(foot, s)
            if bot.get("knees", True):
                extra = [ellipse(knee[0], knee[1], lr + 0.4, lr + 0.4, bot.get("knee_c", joint_c))] + extra
            limb_group([chain([hip, knee, foot], lr, bot.get("leg_c", "metal"))], extra, is_far)

    def wheel():
        top, bot_w, bot_y = bot["skirt"]
        cv.group([poly([W_(-top, -2), W_(top, -2), W_(bot_w, bot_y), W_(-bot_w, bot_y)], "metal2")])
        c = W_(0, bot_y + 3)
        cv.group([ellipse(c[0], c[1], 4.5, 4.5, "dark")])
        cv.group([ellipse(c[0], c[1], 1.5, 1.5, "metal2", shade=False)], inner=False)

    def jet():
        y0 = bot["nozzle"]
        cv.group([rbox(W_, -3.5, y0, 3.5, y0 + 4, "metal2", cut=1)])
        L = 6 + 7 * p["glow"] + 2 * p["ext"]
        cv.group([poly([W_(-3, y0 + 4), W_(3, y0 + 4), W_(0, y0 + 4 + L)], "flame", shade=False)], inner=False)
        cv.group([poly([W_(-1.6, y0 + 4), W_(1.6, y0 + 4), W_(0, y0 + 4 + L * 0.6)], "flame2", shade=False)], inner=False)

    def tentacles():
        # Curling legs under the body; the left pair lifts with the left foot, the right pair with the right.
        xs = (-3, 3) if side else (-8, -3, 3, 8)
        for x in xs:
            lift = p["llift"] if x < 0 else p["rlift"]
            s = -1 if x < 0 else 1
            root = W_(x, bot["tent_y"])
            tip = (root[0] + s * (5 + abs(x) * 0.4), GROUND - 1.5 - lift * 0.8)
            mid = (root[0] + s * 1.5 + p["px"] * 0.3, (root[1] + tip[1]) / 2 + 1)
            curl = (tip[0] - s * 2.5, tip[1] - 2.5)
            limb = chain(bezier(root, mid, tip, 8) + [curl], lambda t, T: 2.3 - 1.1 * t / T, "acc")
            limb_group([limb], None, side and x < 0)

    def hand_prims(elbow, hand, s):
        kind = bot.get("hand_kind", "ball")
        hc = bot.get("hand", "metal2")
        d = _unit(elbow, hand)
        n = (-d[1], d[0])
        if kind == "fist":
            return [ellipse(hand[0] + d[0], hand[1] + d[1], ar + 2.2, ar + 2.2, hc)]
        if kind == "claw":
            return [ellipse(hand[0], hand[1], ar + 0.6, ar + 0.6, hc)] + [
                chain([hand, (hand[0] + d[0] * 3.5 + n[0] * o, hand[1] + d[1] * 3.5 + n[1] * o)], 0.8, hc, shade=False) for o in (-2, 2)]
        if kind == "branch":  # coral fingers
            return [chain([hand, (hand[0] + d[0] * 4 + n[0] * o, hand[1] + d[1] * 4 + n[1] * o)], 0.8, hc, shade=False) for o in (-2.5, 0, 2.5)]
        if kind == "wing":  # a feathered wingtip
            return [poly([(hand[0] + n[0] * 2.4, hand[1] + n[1] * 2.4), (hand[0] - n[0] * 2.4, hand[1] - n[1] * 2.4),
                          (hand[0] + d[0] * 6, hand[1] + d[1] * 6)], hc)]
        if kind == "none":
            return []
        return [ellipse(hand[0], hand[1], ar + 0.9, ar + 0.9, hc)]

    def arms(which):
        held = bot.get("held", {})
        for ua, fa, s, is_far in which:
            if side:
                sh = W_(-1.5 if is_far else 1.5, sy)
                elbow, hand = side_arm_points(sh, ua, fa, a1, a2)
            else:
                sh = W_(s * sx, sy)
                elbow, hand = arm_points(sh, ua, fa, s, a1, a2)
            prims = [chain([sh, elbow, hand], ar, arm_c)]
            extra = hand_prims(elbow, hand, s)
            if bot.get("joints", True):
                prims.append(ellipse(sh[0], sh[1], ar + 0.9, ar + 0.9, joint_c))
                extra = [ellipse(elbow[0], elbow[1], ar * 0.8, ar * 0.8, joint_c)] + extra
            # What's in this hand. The skeleton's right arm is screen-right from
            # the front; mirrored() swaps the arms for the back view, so swap back.
            key = "R" if s > 0 else "L"
            if back:
                key = "L" if key == "R" else "R"
            item = held.get(key)
            item_prims = item(elbow, hand, _unit(elbow, hand), p) if item else None
            if item_prims and is_far:
                cv.group([far(q) for q in item_prims])
            limb_group(prims, extra, is_far, cast=not back)
            if item_prims and not is_far:
                cv.group(item_prims)

    L_ARM, R_ARM = (p["la"], p["lf"], -1), (p["ra"], p["rf"], 1)
    if bot.get("behind"):
        bot["behind"](cv, W_, view, p, bot)
    if bot.get("tail") and not back:
        bot["tail"](cv, W_, view, p, bot)
    if side:
        arms([(*L_ARM, True)])
    move = bot["move"]
    if move == "legs":
        if side:
            legs([(p["lfx"], p["llift"], -1, True), (p["rfx"], p["rlift"], 1, False)])
        else:
            legs([(p["lfx"], p["llift"], -1, False), (p["rfx"], p["rlift"], 1, False)])
    elif move == "wheel":
        wheel()
    elif move == "jet":
        jet()
    elif move == "tentacles":
        tentacles()
    # "float": nothing under the body; the torso draws its own hem
    if back:
        arms([(*L_ARM, False), (*R_ARM, False)])
    bot["torso"](cv, W_, view, p, bot)
    if bot.get("tail") and back:
        bot["tail"](cv, W_, view, p, bot)
    if side:
        arms([(*R_ARM, False)])
    elif not back:
        arms([(*L_ARM, False), (*R_ARM, False)])

    hang = lean * 0.6 + p["tilt"] * (0.5 if side else 0.8)
    hc = W_(p["hx"] * 0.3 + (1 if side else 0), bot["neck"] + p["hy"])
    if bot.get("neck_r"):
        cv.group([chain([W_(0, sy - 1), hc], bot["neck_r"], bot.get("neck_c", "metal2"))])
    bot["head"](cv, head_frame(hc, hang), view, p, bot)
    if bot.get("front"):
        bot["front"](cv, W_, view, p, bot)
    return cv.render(bot["pal"], CX + p["px"] * 0.6, shadow_k(p) * (0.55 if fl else 1.0))


# ------------------------------------------------------------------ Slay the Spire 2 cast (fan art)
# Characters and enemies from Slay the Spire 2 by Mega Crit, drawn as fan art
# on the shared skeleton. Their specials glow on the beat like the robots'.
def _at(o, d, k, n=(0, 0), j=0):
    """Point o + d*k + n*j."""
    return (o[0] + d[0] * k + n[0] * j, o[1] + d[1] * k + n[1] * j)


# ---- things in hands: (elbow, hand, direction of the forearm, pose) -> primitives
def held_sword(elbow, hand, d, p):
    n = (-d[1], d[0])
    base, tip = _at(hand, d, 2.5), _at(hand, d, 17)
    prims = [
        poly([_at(base, n, 0, n, 1.9), _at(tip, n, 0, n, 0.7), _at(tip, d, 1.6), _at(base, n, 0, n, -1.7)], "blade"),
        chain([_at(base, d, 0, n, 3.3), _at(base, d, 0, n, -3.3)], 0.9, "metal2"),
        ellipse(*_at(hand, d, -2.6), 1.2, 1.2, "metal2"),
    ]
    if p["glow"] > 0.6:  # a glint runs down the blade on the beat
        prims.append(pix([_at(hand, d, 9), _at(hand, d, 10)], "glint"))
    return prims


def held_dagger(elbow, hand, d, p):
    return [chain([_at(hand, d, 1.5), _at(hand, d, 8.5)], lambda t, T: 1.5 - 0.9 * t / T, lamp(p["glow"]), shade=False)]


def held_scythe(elbow, hand, d, p):
    n = (-d[1], d[0])
    top = _at(hand, d, 13)
    return [
        chain([_at(hand, d, -9), top], 0.8, "wood"),
        chain([top, _at(top, d, 1.5, n, 4.5), _at(top, d, -1.2, n, 9.5)], lambda t, T: 1.7 - 1.2 * t / T, "blade"),
    ]


def held_hook(elbow, hand, d, p):
    n = (-d[1], d[0])
    top = _at(hand, d, 10)
    return [
        chain([_at(hand, d, -5), top], 0.75, "acc2"),
        chain([top, _at(top, d, 2.6, n, 2), _at(top, d, 0.5, n, 4.2), _at(top, d, -2, n, 3.6)], 0.8, "acc2"),
    ]


def held_axe(elbow, hand, d, p):
    n = (-d[1], d[0])
    tip = _at(hand, d, 5.5)
    blades = [poly([_at(tip, d, 0, n, sg * 1), _at(tip, d, 3.4, n, sg * 6), _at(tip, d, 0, n, sg * 7.2), _at(tip, d, -3.4, n, sg * 6)], "blade")
              for sg in (1, -1)]
    return [chain([hand, tip], 1.1, "metal2")] + blades


# ---- Ironclad: gold armour, red-eyed helm, grey beard, a big sword
def torso_ironclad(cv, W_, view, p, bot):
    w = 6.5 if view == "side" else 8.5
    cv.group([rbox(W_, -w, -25, w, -1, "acc2", cut=2.5)], cast=True)
    plate = {"front": (-6, 6), "back": (-6.5, 6.5), "side": (-1, 6)}[view]
    cv.group([rbox(W_, plate[0], -23, plate[1], -10, "metal", cut=2)])
    cv.group([chain([W_(-w, -3.5), W_(w, -3.5)], 1.3, "metal2")])


def head_ironclad(cv, Hp, view, p, bot):
    ek = eye_key(p["glow"])
    if view == "side":
        cv.group([ellipse(*Hp(0, -1), 7.6, 8, "metal")], cast=True)
        cv.group([chain([Hp(-6, -5), Hp(-1, -9.6), Hp(5, -7.5)], 1.2, "metal2")])
        cv.group([rbox(Hp, 1.5, -1.8, 8, 1, "dark", cut=0.6, shade=False)])
        cv.group([pix([Hp(5.5, -0.5)], ek)], inner=False)
        cv.group([poly([Hp(1.5, 3), Hp(7.5, 2.5), Hp(5, 9.5), Hp(1, 7.5)], "beard")])
        return
    cv.group([ellipse(*Hp(0, -1), 8, 8.2, "metal")], cast=True)
    cv.group([chain([Hp(0, -9.6), Hp(0, -3)], 1.3, "metal2")])
    if view == "back":
        return
    cv.group([rbox(Hp, -6, -1.8, 6, 1.2, "dark", cut=0.6, shade=False)])
    cv.group([pix([Hp(2, -0.5), Hp(3, -0.5)], ek)], inner=False)
    cv.group([poly([Hp(-5, 2.2), Hp(5, 2.2), Hp(3.6, 9), Hp(0, 10.8), Hp(-3.6, 9)], "beard")])


# ---- Silent: green cloak, antlered skull mask, bandages, twin glowing daggers
def torso_silent(cv, W_, view, p, bot):
    if view == "back":
        cv.group([poly([W_(-9, -26), W_(9, -26), W_(13, 4), W_(0, 6.5), W_(-13, 4)], "acc")], cast=True)
        return
    if view == "side":
        cv.group([poly([W_(-2, -26), W_(3, -26), W_(1, 4), W_(-12, 5)], "acc")])
        cv.group([rbox(W_, -1, -24, 5, -6, "metal", cut=1.5)], cast=True)
        return
    cv.group([rbox(W_, -5, -24, 5, -6, "metal", cut=1.5)], cast=True)
    # The cloak wraps around, leaving a narrow gap down the front.
    cv.group([poly([W_(-9, -25.5), W_(-0.6, -25.5), W_(-1.8, 3.5), W_(-13, 4.5)], "acc"),
              poly([W_(0.6, -25.5), W_(9, -25.5), W_(13, 4.5), W_(1.8, 3.5)], "acc")])


def head_silent(cv, Hp, view, p, bot):
    ek = eye_key(p["glow"])
    sides = (1,) if view == "side" else (-1, 1)
    for s in sides:  # antlers rise out of the hood
        x0 = -1 if view == "side" else s * 4
        cv.group([chain([Hp(x0, -6), Hp(x0 + s * 3.5, -12), Hp(x0 + s * 5.5, -16)], 1.0, "antler"),
                  chain([Hp(x0 + s * 2.6, -10.5), Hp(x0 + s * 6, -11)], 0.8, "antler")])
    if view == "side":
        cv.group([ellipse(*Hp(-1, -1), 8, 8.8, "acc")], cast=True)
        cv.group([ellipse(*Hp(3.5, 1), 4, 5.2, "bone"), rbox(Hp, 5, 2.5, 10, 6.5, "bone", cut=1.5)])
        cv.group([ellipse(*Hp(4.5, 0), 1.3, 1.3, "dark", shade=False)], inner=False)
        cv.group([pix([Hp(4.5, 0)], ek)], inner=False)
        return
    cv.group([ellipse(*Hp(0, -1), 8.6, 9, "acc")], cast=True)
    if view == "back":
        return
    cv.group([ellipse(*Hp(0, 1.5), 5.2, 5.5, "bone"), rbox(Hp, -2.6, 3.5, 2.6, 8, "bone", cut=1.2)])
    cv.group([ellipse(*Hp(-2.2, 0.6), 1.4, 1.4, "dark", shade=False), ellipse(*Hp(2.2, 0.6), 1.4, 1.4, "dark", shade=False)], inner=False)
    cv.group([pix([Hp(-2.2, 0.6), Hp(2.2, 0.6)], ek)], inner=False)


# ---- Regent: a little star-crowned king riding a stone throne on tentacles
def _throne(cv, W_, view):
    if view == "side":
        cv.group([poly([W_(-6, 7), W_(5, 7), W_(5, -34), W_(0, -47), W_(-6, -38)], "metal")], cast=True)
    else:
        cv.group([poly([W_(-10, 7), W_(10, 7), W_(10, -35), W_(3, -48), W_(-6, -45), W_(-10, -37)], "metal")], cast=True)
        if view == "front":
            cv.group([poly([W_(-6.5, -14), W_(6.5, -14), W_(6.5, -33), W_(1.5, -41), W_(-6.5, -36)], "dark")])


def behind_regent(cv, W_, view, p, bot):
    if view != "back":
        _throne(cv, W_, view)


def torso_regent(cv, W_, view, p, bot):
    if view == "back":  # from behind, the throne hides the king (and his arms)
        _throne(cv, W_, view)
        return
    x = 2 if view == "side" else 0
    cv.group([ellipse(*W_(x, -22), 6 if view == "side" else 7, 5, "acc2")], cast=True)
    cv.group([chain([W_(x - 4, -26), W_(x, -24), W_(x + 4, -26)], 1.1, "acc")])


def head_regent(cv, Hp, view, p, bot):
    if view == "back":
        return
    pts = []
    for i in range(12):
        a = math.pi * 2 * i / 12 - math.pi / 2
        r = 7.5 if i % 2 == 0 else 3.6
        pts.append(Hp(r * math.cos(a) * (0.75 if view == "side" else 1), r * math.sin(a)))
    cv.group([poly(pts, "acc")], cast=True)
    ex = 1.5 if view == "side" else 0
    cv.group([ellipse(*Hp(ex, 0.8), 2.8, 3, "dark", shade=False)])
    cv.group([ellipse(*Hp(ex, 0.5), 1.3, 1.3, lamp(p["glow"]), shade=False)], inner=False)


# ---- Necrobinder: a floating lich with blue flame hair, a scythe, and Osty the hand
def torso_necro(cv, W_, view, p, bot):
    w = 0.7 if view == "side" else 1.0
    cv.group([poly([W_(-7 * w, -26), W_(-9.5 * w, -36), W_(-3 * w, -26)], "acc"),
              poly([W_(7 * w, -26), W_(9.5 * w, -36), W_(3 * w, -26)], "acc")])  # high collar
    hem = [W_(10 * w, 10), W_(7 * w, 14), W_(4 * w, 11), W_(1 * w, 15), W_(-2 * w, 11), W_(-5 * w, 14), W_(-9 * w, 10)]
    cv.group([ellipse(*W_(-2, 16), 1.4, 1.1, "metal"), ellipse(*W_(2.2, 15), 1.4, 1.1, "metal")])  # dangling bony feet
    cv.group([poly([W_(-6 * w, -26), W_(6 * w, -26)] + hem, "acc")], cast=True)
    if view == "front":
        cv.group([poly([W_(-2.5, -25), W_(2.5, -25), W_(0.8, -7), W_(-0.8, -7)], "acc2")])
        cv.group([pix([W_(-1, y) for y in (-21, -17, -13)] + [W_(1, y) for y in (-21, -17, -13)], "metal")], inner=False)


def head_necro(cv, Hp, view, p, bot):
    g = p["glow"]
    flick = 4 * g + 2 * p["ext"]
    xs = (-1, 1) if view == "side" else (-5, 5)
    cv.group([poly([Hp(xs[0], -2), Hp(-3, -11 - flick), Hp(-1, -6), Hp(1, -13 - flick), Hp(3, -6),
                    Hp(5, -10 - flick * 0.8), Hp(xs[1] + 1, -2)], "flame", shade=False)], inner=False)
    cv.group([poly([Hp(-2, -3), Hp(0, -9 - flick * 0.7), Hp(2, -3)], "flame2", shade=False)], inner=False)
    sx = 1.5 if view == "side" else 0
    cv.group([ellipse(*Hp(sx, 0), 5 if view == "side" else 5.5, 6, "metal"), rbox(Hp, sx - 3, 3, sx + 3, 6.5, "metal", cut=1)], cast=True)
    if view == "back":
        return
    eyes = [(3.5, 0)] if view == "side" else [(-2, 0), (2, 0)]
    cv.group([ellipse(*Hp(x, y), 1.4, 1.5, "dark", shade=False) for x, y in eyes], inner=False)
    cv.group([pix([Hp(x, 5) for x in (sx - 2, sx, sx + 2)], "dark")], inner=False)


def front_necro(cv, W_, view, p, bot):
    """Osty, the Necrobinder's trusty left hand, bobbing beside her."""
    x = {"front": -14, "back": 14, "side": -9}[view]
    c = W_(x, -16 + 2 * math.sin(math.pi * 2 * p["ext"]))
    fingers = [chain([(c[0] + o, c[1] - 1), (c[0] + o * 1.3, c[1] - 4.5)], 0.6, "metal", shade=False) for o in (-1.6, -0.5, 0.6, 1.7)]
    prims = [ellipse(c[0], c[1], 2.5, 2, "metal")] + fingers
    cv.group([far(q) for q in prims] if view == "side" else prims)


# ---- Defect: a gold automaton with a crown of a head holding one big blue orb
def torso_defect(cv, W_, view, p, bot):
    if view == "back":
        cv.group([rbox(W_, -8, -25, 8, -4, "metal", cut=2.5)], cast=True)
        cv.group([poly([W_(-11, -27), W_(11, -27), W_(12, -3), W_(-12, -3)], "acc")])
        return
    if view == "side":
        cv.group([poly([W_(-1, -27), W_(4, -27), W_(-3, -6), W_(-10, -8)], "acc")])
        cv.group([rbox(W_, -5, -25, 6, -4, "metal", cut=2.5)], cast=True)
        cv.group([ellipse(*W_(4.5, -15), 2, 3, lamp(p["glow"]), shade=False)], inner=False)
        return
    cv.group([rbox(W_, -8, -25, 8, -4, "metal", cut=2.5)], cast=True)
    cv.group([ellipse(*W_(0, -15), 4.2, 4.2, "dark", shade=False)])
    cv.group([ellipse(*W_(0, -15), 2.7, 2.7, lamp(p["glow"]), shade=False)], inner=False)
    cv.group([poly([W_(-11.5, -27), W_(-2, -27.5), W_(-7, -15), W_(-13, -18)], "acc"),
              poly([W_(11.5, -27), W_(2, -27.5), W_(7, -15), W_(13, -18)], "acc")])


def head_defect(cv, Hp, view, p, bot):
    w = 0.65 if view == "side" else 1.0
    cv.group([poly([Hp(-9 * w, 4), Hp(9 * w, 4), Hp(10 * w, -4), Hp(6 * w, -2), Hp(4 * w, -9), Hp(0, -5),
                    Hp(-4 * w, -9), Hp(-6 * w, -2), Hp(-10 * w, -4)], "metal")], cast=True)
    if view == "back":
        return
    ox = 3 if view == "side" else 0
    cv.group([ellipse(*Hp(ox, 0), 4.6 * w + 0.4, 4.6, "dark", shade=False)])
    cv.group([ellipse(*Hp(ox, 0), 3.4 * w + 0.3, 3.4, lamp(p["glow"]), shade=False)], inner=False)
    cv.group([pix([Hp(ox - 1, -1.5)], "glint")], inner=False)


# ---- Byrdonis: a lanky green bird with a hooked pink beak and a long swinging tail
def torso_byrd(cv, W_, view, p, bot):
    w = 0.8 if view == "side" else 1.0
    lo, up = W_(0, -9), W_(0.5 if view == "side" else 0, -17)
    cv.group([blob([(lo[0], lo[1], 8.5 * w, 9.5, 0, 0.12), (up[0], up[1], 7 * w, 7, 0, 0.12)], "acc")], cast=True)


def tail_byrd(cv, W_, view, p, bot):
    sw = p["tail"] + p["swing"]
    if view == "side":
        base = W_(-6, -6)
        ctrl = (base[0] - 9, base[1] + 3 + 2 * math.sin(math.radians(sw)))
        tx, ty = rot(-9, -6, sw * 0.5)
        tip = (base[0] - 8 + tx, base[1] + ty)
    else:
        base = W_(1.5 if view == "back" else 6, -4)
        ctrl = (base[0] + 12 + 2 * math.sin(math.radians(sw)), base[1] + 4)
        tx, ty = rot(8, -12, sw)
        tip = (base[0] + 9 + tx, base[1] + ty)
    cv.group([chain(bezier(base, ctrl, tip), lambda s, T: 2.4 - 1.0 * s / T, "acc")])
    cv.group([poly([(tip[0] - 2.5, tip[1] - 1), (tip[0] + 2.5, tip[1] - 1), (tip[0] + 1, tip[1] - 6.5), (tip[0] - 1, tip[1] - 6.5)], "acc2")])


def head_byrd(cv, Hp, view, p, bot):
    cv.group([poly([Hp(-1.8, -5), Hp(0, -10), Hp(1.8, -5)], "acc2")])  # crest
    cv.group([ellipse(*Hp(0, 0), 6 if view == "side" else 6.6, 5.8, "acc")], cast=True)
    if view == "back":
        return
    if view == "side":
        cv.group([poly([Hp(4, -1.5), Hp(10.5, -0.5), Hp(12, 3.6), Hp(10, 2.8), Hp(4.5, 2.8)], "beak")])
        cv.group([pix([Hp(2.5, -1.5)], "eye")], inner=False)
        return
    # Head-on, the hooked beak is a short wide wedge with its hook curling down.
    cv.group([poly([Hp(-3.4, 0.6), Hp(3.4, 0.6), Hp(1.2, 4.6), Hp(0, 6.2), Hp(-1.2, 4.6)], "beak")])
    cv.group([pix([Hp(0, 5), Hp(0, 5.8)], "beak_s")], inner=False)
    cv.group([pix([Hp(-3, -1.6), Hp(3, -1.6)], "eye")], inner=False)


# ---- Skulking Colony: a walking reef of coral and barnacles with a coral spire for a head
def torso_colony(cv, W_, view, p, bot):
    w = 0.75 if view == "side" else 1.0
    lo, up = W_(0, -8), W_(0, -18)
    cv.group([blob([(lo[0], lo[1], 8 * w, 9, 0, 0.15), (up[0], up[1], 7.5 * w, 7.5, 0, 0.15)], "acc")], cast=True)
    spots = [(-6, -22, 3), (6, -21, 2.6), (-3, -12, 2), (4, -8, 1.8)] if view != "side" else [(-2, -21, 2.6), (3, -12, 2)]
    cv.group([ellipse(*W_(x * w, y), r, r, "acc2") for x, y, r in spots])
    if view != "back":  # the barnacles glow on the beat
        cv.group([pix([W_(x * w, y) for x, y, _ in spots], lamp(p["glow"]))], inner=False)


def head_colony(cv, Hp, view, p, bot):
    w = 0.8 if view == "side" else 1.0
    cv.group([rbox(Hp, -2 * w, -16, 2 * w, -6, "bone", cut=1)])
    cv.group([ellipse(*Hp(0, -16), 2.6 * w, 1.5, "bone")])
    cv.group([ellipse(*Hp(0, -6), 3.8 * w, 4, "acc", jag=0.2), ellipse(*Hp(0, 0), 4.8 * w, 4.2, "acc", jag=0.2)], cast=True)


# ---- Cultist (the original): shaggy blue feathers, a bird-skull mask, a hooked staff in each hand
def _feathers(s, t):
    return "acc_s" if int(s * 0.9 + t * 0.4 + 40) % 5 == 0 else "acc"


def torso_cultist(cv, W_, view, p, bot):
    w = 0.75 if view == "side" else 1.0
    lo, up = W_(0, -10), W_(0, -21)
    cv.group([blob([(lo[0], lo[1], 10 * w, 12, 0, 0.16), (up[0], up[1], 8 * w, 7, 0, 0.16)], _feathers)], cast=True)


def head_cultist(cv, Hp, view, p, bot):
    cv.group([ellipse(*Hp(0, 1), 8 if view != "side" else 7, 7, _feathers, jag=0.16)])
    if view == "back":
        cv.group([ellipse(*Hp(0, -1), 5.5, 5.5, "bone")])
        return
    if view == "side":
        cv.group([ellipse(*Hp(1.5, -1), 5, 5.5, "bone"), poly([Hp(3, 0), Hp(4.5, 3), Hp(11.5, 7.5), Hp(10, 8.5), Hp(3, 4.5)], "bone")])
        cv.group([ellipse(*Hp(3, -1), 1.4, 1.5, "dark", shade=False)], inner=False)
        return
    cv.group([ellipse(*Hp(0, -1), 5.5, 5.5, "bone"), poly([Hp(-2.3, 2), Hp(2.3, 2), Hp(0.6, 10.5), Hp(-0.6, 10.5)], "bone")])
    cv.group([ellipse(*Hp(-2.2, -1), 1.5, 1.6, "dark", shade=False), ellipse(*Hp(2.2, -1), 1.5, 1.6, "dark", shade=False)], inner=False)


# ---- Punch Construct: a beige blocky automaton with a teal visor and huge fists
def torso_punch(cv, W_, view, p, bot):
    w = 7 if view == "side" else 10
    cv.group([rbox(W_, -w, -26, w, -4, "metal", cut=3)], cast=True)
    if view == "front":
        cv.group([ellipse(*W_(0, -15), 5, 5, "dark")])
        cv.group([pix([W_(x, y) for x, y in ((-2, -18), (2, -18), (3, -15), (2, -12), (-2, -12), (-3, -15))], "metal2")], inner=False)
    elif view == "back":
        cv.group([pix([W_(x, y) for x in (-5, 0, 5) for y in (-20, -14, -8)], "metal2")], inner=False)


def head_punch(cv, Hp, view, p, bot):
    w = 0.8 if view == "side" else 1.0
    for s in ((1,) if view == "side" else (-1, 1)):
        x0 = -1 if view == "side" else s * 5
        cv.group([poly([Hp(x0, -3), Hp(x0 + s * 3, -9.5), Hp(x0 - s * 2, -4.5)], "metal")])
    cv.group([rbox(Hp, -5 * w, -4.5, 5 * w, 4.5, "metal", cut=1.5)], cast=True)
    if view == "back":
        return
    x0, x1 = (1, 5) if view == "side" else (-4, 4)
    cv.group([rbox(Hp, x0, -1.6, x1, 1.6, lamp(p["glow"]), cut=0.6, shade=False)])


# ---- Axebot: a round rusty robot with an anvil head, glowing joints and an axe for a hand
def torso_axebot(cv, W_, view, p, bot):
    w = 0.8 if view == "side" else 1.0
    cv.group([ellipse(*W_(0, -11), 11 * w, 11.5, "metal")], cast=True)
    cv.group([chain([W_(-10 * w, -7.5), W_(10 * w, -7.5)], 1.0, lamp(p["glow"]), shade=False)])
    if view == "front":
        cv.group([ellipse(*W_(0, -15), 2.6, 2.6, "metal2")])


def head_axebot(cv, Hp, view, p, bot):
    w = 0.75 if view == "side" else 1.0
    cv.group([poly([Hp(-9 * w, -4), Hp(9 * w + (3 if view == "side" else 0), -4), Hp(6 * w, 0.5), Hp(3 * w, 0.5),
                    Hp(3 * w, 4.5), Hp(-3 * w, 4.5), Hp(-3 * w, 0.5), Hp(-6 * w, 0.5)], "dark")], cast=True)
    if view != "back":
        cv.group([pix([Hp(-1 if view != "side" else 1.5, 2), Hp(1 if view != "side" else 2.5, 2)], lamp(p["glow"]))], inner=False)


# ------------------------------------------------------------------ fur patterns
def plain(part, s, t, base):
    return base


def tabby(part, s, t, base):
    if base != "body":
        return base
    if part == "torso" and int(t + 60) % 5 == 0 and abs(s) > 4:
        return "stripe"
    if part in ("head", "backhead") and t < -4.5 and int(s + 60) % 3 == 0 and abs(s) < 5:
        return "stripe"
    if part == "backhead" and t < 2 and int(s + 60) % 3 == 0 and abs(s) < 4:
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
    if part in ("head", "backhead"):
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
    if part == "backhead" and t > 3:
        return "point_l"
    return base


def spotted(part, s, t, base):
    """Bengal-style rosettes on the body and limbs, rings on the tail."""
    if base != "body":
        return base
    if part == "torso" and (s * 0.45 + 7.3) % 4 < 1.5 and (t * 0.45 + 3.1) % 3.6 < 1.6:
        return "spot"
    if part in ("head", "backhead") and t < -4 and (s * 0.5 + 9) % 3.4 < 1.1:
        return "spot"
    if part.startswith(("arm", "leg")) and int(s) % 5 == 2 and t > -0.5:
        return "spot"
    if part == "tail" and int(s) % 5 == 3:
        return "spot"
    return base


def with_tip(pattern, key, start=0.7):
    """Recolor the end of the tail; s is distance along the tail (~22px long)."""
    def f(part, s, t, base):
        if part == "tail" and s > 22 * start:
            return key
        return pattern(part, s, t, base)
    return f


# ------------------------------------------------------------------ clips
# Keyframes are partial poses seen from the front; each loop is interpolated
# with Catmull-Rom. "move" clips are what the director strings together while
# a cat dances; the rest are reactions and resting states.
CLIPS = {
    # ---- dance moves (16 frames, 12 fps: 1.33 s per loop)
    "swing": {"name": "Swing step", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-3, py=1, lean=-7, tilt=-8, la=120, lf=150, ra=300, rf=285, lfx=-10, rfx=6, rlift=1.5, tail=-15, mouth="open"),
        dict(px=0, py=4, lean=0, tilt=0, la=25, lf=340, ra=25, rf=20, lfx=-8, rfx=8, tail=0),
        dict(px=3, py=1, lean=7, tilt=8, la=300, lf=285, ra=120, rf=150, lfx=-6, llift=1.5, rfx=10, tail=15, mouth="open"),
        dict(px=0, py=4, lean=0, tilt=0, la=25, lf=20, ra=25, rf=340, lfx=-8, rfx=8, tail=0),
        dict(px=-2, py=0, lean=-4, tilt=-6, la=160, lf=180, ra=40, rf=215, lfx=-9, rfx=8, rlift=1, tail=-10, mouth="open"),
        dict(px=0, py=4, lean=0, la=60, lf=40, ra=30, rf=330, lfx=-8, rfx=8),
        dict(px=2, py=0, lean=4, tilt=6, la=40, lf=215, ra=160, rf=180, lfx=-8, llift=1, rfx=9, tail=10, mouth="open"),
        dict(px=0, py=4, lean=0, la=30, lf=330, ra=60, rf=40, lfx=-8, rfx=8),
    ]},
    "shuffle": {"name": "Side shuffle", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-4, py=5, lean=-5, tilt=-5, la=75, lf=150, ra=60, rf=40, lfx=-12, rfx=6, rlift=3, tail=-20),
        dict(px=-1, py=3, lean=-2, la=60, lf=110, ra=70, rf=110, lfx=-11, rfx=11, tail=-5),
        dict(px=4, py=5, lean=5, tilt=5, la=60, lf=40, ra=75, rf=150, lfx=-6, llift=3, rfx=12, tail=20, mouth="open"),
        dict(px=1, py=3, lean=2, la=70, lf=110, ra=60, rf=110, lfx=-11, rfx=11, tail=5),
    ]},
    "kneeup": {"name": "Knee-up groove", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=2, py=1, lean=6, tilt=8, la=30, lf=210, ra=95, rf=88, lfx=-3, llift=10, rfx=7, tail=15, mouth="open"),
        dict(px=0, py=3, lean=0, tilt=0, la=40, lf=150, ra=40, rf=150, lfx=-7, rfx=7, tail=0),
        dict(px=-2, py=1, lean=-6, tilt=-8, la=95, lf=88, ra=30, rf=210, lfx=-7, rfx=3, rlift=10, tail=-15, mouth="open"),
        dict(px=0, py=3, lean=0, tilt=0, la=40, lf=150, ra=40, rf=150, lfx=-7, rfx=7, tail=0),
    ]},
    "elbows": {"name": "Elbow bounce", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-2.5, py=3, lean=-3, tilt=-4, hy=1, la=62, lf=345, ra=55, rf=350, lfx=-10, rfx=10, tail=-12),
        dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=78, lf=330, ra=78, rf=30, lfx=-10, rfx=10, tail=0, mouth="open"),
        dict(px=2.5, py=3, lean=3, tilt=4, hy=1, la=55, lf=350, ra=62, rf=345, lfx=-10, rfx=10, tail=12),
        dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=78, lf=30, ra=78, rf=330, lfx=-10, rfx=10, tail=0, mouth="open"),
    ]},
    "stomp": {"name": "Party stomp", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=2, py=2, lean=7, tilt=6, la=50, lf=20, ra=320, rf=300, lfx=-17, llift=5, rfx=7, tail=18, mouth="open"),
        dict(px=0, py=5, lean=0, la=20, lf=350, ra=20, rf=10, lfx=-9, rfx=9),
        dict(px=-2, py=2, lean=-7, tilt=-6, la=320, lf=300, ra=50, rf=20, lfx=-7, rfx=17, rlift=5, tail=-18, mouth="open"),
        dict(px=0, py=5, lean=0, la=20, lf=10, ra=20, rf=350, lfx=-9, rfx=9),
        dict(px=0, py=-1, lean=0, tilt=0, hy=-1, la=140, lf=165, ra=140, rf=165, lfx=-11, rfx=11, tail=0, mouth="open"),
        dict(px=0, py=6, lean=0, la=40, lf=60, ra=40, rf=60, lfx=-11, rfx=11),
    ]},
    "twist": {"name": "The twist", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-3, py=4, lean=-4, tilt=-6, la=55, lf=250, ra=55, rf=115, lfx=-8, rfx=5, rlift=1.5, tail=-16, mouth="open"),
        dict(px=0, py=5, lean=0, tilt=0, la=50, lf=170, ra=50, rf=170, lfx=-8, rfx=8, tail=0),
        dict(px=3, py=4, lean=4, tilt=6, la=55, lf=115, ra=55, rf=250, lfx=-5, llift=1.5, rfx=8, tail=16, mouth="open"),
        dict(px=0, py=5, lean=0, tilt=0, la=50, lf=170, ra=50, rf=170, lfx=-8, rfx=8, tail=0),
    ]},
    "disco": {"name": "Disco point", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=2, py=0, lean=6, tilt=10, hy=-1, la=40, lf=300, ra=158, rf=160, lfx=-9, rfx=10, tail=12, eyes="open", mouth="open"),
        dict(px=-1, py=4, lean=-3, tilt=-4, la=40, lf=300, ra=255, rf=225, lfx=-10, rfx=8, rlift=1.5, tail=-6),
        dict(px=2, py=0, lean=6, tilt=10, hy=-1, la=40, lf=300, ra=158, rf=160, lfx=-9, rfx=10, tail=12, eyes="open", mouth="open"),
        dict(px=-1, py=4, lean=-3, tilt=-4, la=40, lf=300, ra=255, rf=225, lfx=-10, rfx=8, rlift=1.5, tail=-6),
        dict(px=-2, py=0, lean=-6, tilt=-10, hy=-1, la=158, lf=160, ra=40, rf=300, lfx=-10, rfx=9, tail=-12, eyes="open", mouth="open"),
        dict(px=1, py=4, lean=3, tilt=4, la=255, lf=225, ra=40, rf=300, lfx=-8, llift=1.5, rfx=10, tail=6),
        dict(px=-2, py=0, lean=-6, tilt=-10, hy=-1, la=158, lf=160, ra=40, rf=300, lfx=-10, rfx=9, tail=-12, eyes="open", mouth="open"),
        dict(px=1, py=4, lean=3, tilt=4, la=255, lf=225, ra=40, rf=300, lfx=-8, llift=1.5, rfx=10, tail=6),
    ]},
    "roof": {"name": "Raise the roof", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-1, py=4, lean=-2, tilt=-3, la=100, lf=168, ra=100, rf=168, lfx=-10, rfx=10, tail=-10),
        dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=125, lf=195, ra=125, rf=195, lfx=-10, rfx=10, tail=0, mouth="open"),
        dict(px=1, py=4, lean=2, tilt=3, la=100, lf=168, ra=100, rf=168, lfx=-10, rfx=10, tail=10),
        dict(px=0, py=0, lean=0, tilt=0, hy=-1, la=125, lf=195, ra=125, rf=195, lfx=-10, rfx=10, tail=0, mouth="open"),
    ]},
    "wave": {"name": "Hands in the air", "kind": "move", "frames": 16, "fps": 12, "keys": [
        dict(px=-3, py=1, lean=-8, tilt=-8, la=150, lf=140, ra=140, rf=195, lfx=-9, rfx=8, tail=-18, mouth="open"),
        dict(px=0, py=3, lean=0, tilt=0, la=145, lf=158, ra=145, rf=158, lfx=-8, rfx=8, tail=0),
        dict(px=3, py=1, lean=8, tilt=8, la=140, lf=195, ra=150, rf=140, lfx=-8, rfx=9, tail=18, mouth="open"),
        dict(px=0, py=3, lean=0, tilt=0, la=145, lf=158, ra=145, rf=158, lfx=-8, rfx=8, tail=0),
    ]},
    "robot": {"name": "The robot", "kind": "move", "frames": 16, "fps": 12, "keys": [
        # Each pose is doubled so it holds, then snaps to the next: staccato.
        dict(px=-1, py=2, tilt=-8, la=90, lf=180, ra=12, rf=12, lfx=-9, rfx=9, tail=-12, eyes="open"),
        dict(px=-1, py=2, tilt=-8, la=90, lf=180, ra=12, rf=12, lfx=-9, rfx=9, tail=-12, eyes="open"),
        dict(px=1, py=2, tilt=8, la=12, lf=12, ra=90, rf=180, lfx=-9, rfx=9, tail=12, eyes="open"),
        dict(px=1, py=2, tilt=8, la=12, lf=12, ra=90, rf=180, lfx=-9, rfx=9, tail=12, eyes="open"),
        dict(px=0, py=0, hy=-1, la=90, lf=90, ra=90, rf=90, lfx=-9, rfx=9, tail=0, mouth="open"),
        dict(px=0, py=0, hy=-1, la=90, lf=90, ra=90, rf=90, lfx=-9, rfx=9, tail=0, mouth="open"),
        dict(px=0, py=4, la=45, lf=290, ra=45, rf=290, lfx=-10, rfx=10, tail=0),
        dict(px=0, py=4, la=45, lf=290, ra=45, rf=290, lfx=-10, rfx=10, tail=0),
    ]},
    # ---- DJ booth moves (the director gives these to whoever is playing)
    "scratch": {"name": "Scratch", "kind": "dj", "frames": 16, "fps": 12, "keys": [
        # one paw on the record working it back and forth, the other holding the headphones to the ear
        dict(px=1, py=3, lean=3, tilt=8, hy=1, la=150, lf=215, ra=35, rf=318, lfx=-9, rfx=9, tail=8),
        dict(px=0, py=1, lean=1, tilt=4, la=150, lf=215, ra=35, rf=348, lfx=-9, rfx=9, tail=-4, mouth="open"),
        dict(px=1, py=3, lean=3, tilt=8, hy=1, la=150, lf=215, ra=35, rf=318, lfx=-9, rfx=9, tail=8),
        dict(px=0, py=1, lean=1, tilt=4, la=150, lf=215, ra=35, rf=348, lfx=-9, rfx=9, tail=-4, mouth="open"),
    ]},
    "fistpump": {"name": "Fist pump", "kind": "dj", "frames": 16, "fps": 12, "keys": [
        dict(px=0, py=0, lean=2, tilt=4, hy=-1, la=32, lf=330, ra=165, rf=175, lfx=-9, rfx=9, tail=10, mouth="open"),
        dict(px=0, py=4, lean=1, tilt=0, hy=1, la=32, lf=330, ra=115, rf=95, lfx=-9, rfx=9, tail=-6),
        dict(px=0, py=0, lean=2, tilt=4, hy=-1, la=32, lf=330, ra=165, rf=175, lfx=-9, rfx=9, tail=10, mouth="open"),
        dict(px=0, py=4, lean=1, tilt=0, hy=1, la=32, lf=330, ra=115, rf=95, lfx=-9, rfx=9, tail=-6),
    ]},
    "handsup": {"name": "Hands up", "kind": "dj", "frames": 16, "fps": 12, "keys": [
        # a slow build to the top of the bar, then the loop snaps back down: the drop
        dict(px=0, py=4, la=40, lf=20, ra=40, rf=20, lfx=-10, rfx=10, tail=0),
        dict(px=0, py=2, la=100, lf=140, ra=100, rf=140, lfx=-10, rfx=10, tail=6),
        dict(px=0, py=0, hy=-1, la=140, lf=160, ra=140, rf=160, lfx=-10, rfx=10, tail=12, mouth="open"),
        dict(px=0, py=-1, hy=-1, la=150, lf=168, ra=150, rf=168, lfx=-10, rfx=10, tail=16, mouth="open", eyes="open"),
    ]},
    # ---- reactions
    "boo": {"name": "Boo", "kind": "react", "frames": 8, "fps": 10, "keys": [
        # thumbs down, shaking the head
        dict(px=-1, py=2, lean=-3, tilt=-12, la=82, lf=4, ra=82, rf=4, tail=-6, eyes="open", mouth="open"),
        dict(px=0, py=3, tilt=0, la=88, lf=12, ra=88, rf=12, tail=0, eyes="open"),
        dict(px=1, py=2, lean=3, tilt=12, la=82, lf=4, ra=82, rf=4, tail=6, eyes="open", mouth="open"),
        dict(px=0, py=3, tilt=0, la=88, lf=12, ra=88, rf=12, tail=0, eyes="open"),
    ]},
    "cheer": {"name": "Cheer", "kind": "react", "frames": 8, "fps": 12, "keys": [
        dict(px=0, py=-1, la=140, lf=150, ra=140, rf=150, lfx=-9, rfx=9, tail=-10, mouth="open"),
        dict(px=-1, py=2, lean=-3, la=150, lf=185, ra=130, rf=140, lfx=-9, rfx=9, rlift=2, tail=0, mouth="open"),
        dict(px=0, py=-1, la=140, lf=150, ra=140, rf=150, lfx=-9, rfx=9, tail=10, mouth="open"),
        dict(px=1, py=2, lean=3, la=130, lf=140, ra=150, rf=185, lfx=-9, llift=2, rfx=9, tail=0, mouth="open"),
    ]},
    "jump": {"name": "Jump", "kind": "react", "frames": 8, "fps": 12, "keys": [
        dict(py=6, la=25, lf=15, ra=25, rf=15, lfx=-9, rfx=9, tail=-8),
        dict(py=-4, la=135, lf=150, ra=135, rf=150, lfx=-8, rfx=8, llift=4, rlift=4, tail=10, mouth="open"),
        dict(py=-9, la=145, lf=150, ra=145, rf=150, lfx=-8, rfx=8, llift=8, rlift=8, tail=16, mouth="open"),
        dict(py=-3, la=120, lf=140, ra=120, rf=140, lfx=-9, rfx=9, llift=3, rlift=3, tail=4, mouth="open"),
    ]},
    "clap": {"name": "Clap", "kind": "react", "frames": 8, "fps": 10, "keys": [
        dict(px=-1, py=1, la=35, lf=292, ra=35, rf=292, tail=-8, mouth="open"),
        dict(px=0, py=2, la=45, lf=335, ra=45, rf=335, tail=0),
        dict(px=1, py=1, la=35, lf=292, ra=35, rf=292, tail=8, mouth="open"),
        dict(px=0, py=2, la=45, lf=335, ra=45, rf=335, tail=0),
    ]},
    # ---- resting
    "bob": {"name": "Head bob", "kind": "rest", "frames": 8, "fps": 8, "keys": [
        dict(px=-0.5, py=0, tilt=-4, hy=0, la=14, lf=6, ra=12, rf=4, tail=-10),
        dict(px=0, py=2, tilt=0, hy=1, la=12, lf=4, ra=12, rf=4, tail=0),
        dict(px=0.5, py=0, tilt=4, hy=0, la=12, lf=4, ra=14, rf=6, tail=10),
        dict(px=0, py=2, tilt=0, hy=1, la=12, lf=4, ra=12, rf=4, tail=0),
    ]},
    "idle": {"name": "Idle", "kind": "rest", "frames": 8, "fps": 5, "blink": 5, "keys": [
        dict(px=-0.6, py=0, tilt=-3, la=10, lf=2, ra=12, rf=6, tail=-10, eyes="open"),
        dict(px=0, py=1, tilt=0, la=12, lf=4, ra=12, rf=4, tail=0, eyes="open"),
        dict(px=0.6, py=0, tilt=3, la=12, lf=6, ra=10, rf=2, tail=10, eyes="open"),
        dict(px=0, py=1, tilt=0, la=12, lf=4, ra=12, rf=4, tail=0, eyes="open"),
    ]},
}


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


def clip_poses(clip):
    poses = interp(clip["keys"], clip["frames"])
    if "blink" in clip:
        poses[clip["blink"]]["eyes"] = "blink"
    # Specials ride the beat: each avatar type shows them its own way (cats
    # swing their tails, robots pulse their lights and pump their antennas).
    n = len(poses)
    for i, p in enumerate(poses):
        ph = i / n
        if clip["kind"] in ("move", "dj"):  # a beat every 4 frames, two tail swings a loop
            p["swing"] = 30 * math.sin(2 * math.pi * 2 * ph)
            p["glow"] = max(0.0, 1 - (i % 4) / 2.5)
            p["ext"] = 0.5 - 0.5 * math.cos(2 * math.pi * 2 * ph)
        elif clip["kind"] == "react":   # all lights on, antennas up, tail going wild
            p["swing"] = 36 * math.sin(2 * math.pi * 2 * ph)
            p["glow"] = 1.0 if i % 2 == 0 else 0.7
            p["ext"] = 1.0
        else:                           # resting: a lazy tail, lights low
            p["swing"] = 8 * math.sin(2 * math.pi * ph)
            p["glow"] = 0.15
            p["ext"] = 0.0
    return poses


# ------------------------------------------------------------------ tweens
# Every clip can ease out to a shared "ready" stance and back in from it, so the
# director can change moves (and turn around) without snapping: the last loop
# ends on frame 0, OUT eases to the stance, IN eases from it into the next clip.
HUB = dict(py=2, la=18, lf=8, ra=18, rf=8, lfx=-9, rfx=9, tail=0, swing=0, glow=0.2, ext=0)
TWEEN_OUT = (1 / 3, 2 / 3)       # fractions of the way from the clip's frame 0 to the stance
TWEEN_IN = (0.0, 1 / 3, 2 / 3)   # fractions of the way from the stance to the clip's frame 0
TWEEN_FPS = 12


def blend(a, b, t):
    """Eased blend of two poses (smoothstep), taking the short way round for angles."""
    e = t * t * (3 - 2 * t)
    out = {}
    for name in REST:
        if isinstance(REST[name], str):
            out[name] = a[name] if e < 0.5 else b[name]
            continue
        va, vb = a[name], b[name]
        if name in ANGLES:
            vb = _unwrap([vb], va)[0]
        out[name] = va + (vb - va) * e
    return out


def tween_poses(clip):
    first = clip_poses(clip)[0]
    hub = dict(REST, **HUB)
    return ([blend(first, hub, t) for t in TWEEN_OUT],
            [blend(hub, first, t) for t in TWEEN_IN])


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
        "id": "biscuit", "name": "Biscuit", "blurb": "Classic cream with a red collar and bell", "signature": "swing",
        "pattern": with_tip(plain, "tip"), "accessory": collar,
        "pal": dict(palette("#2a181c", "#d8a68b",
                            body=("#f5cd97", "#fde3b8", "#dc9a68"), belly=("#fff6ea", "#ffffff", "#ecd5bf"),
                            paw=("#fff6ea", "#ffffff", "#e8cdb6"), tip=("#e09b6a", "#efb382", "#bd7448"),
                            acc=("#d63c43", "#ee5a5f", "#a42a32"), acc2=("#f6c44e", "#ffe08a", "#c9932b"))),
    },
    {
        "id": "smokey", "name": "Smokey", "blurb": "Gray tabby in red headphones", "signature": "shuffle",
        "pattern": tabby, "accessory": headphones,
        "pal": dict(palette("#1b1d25", "#9aa1ad",
                            body=("#a2aab7", "#c1c8d3", "#767e8c"), stripe=("#646c7b", "#737b8a", "#4c5361"),
                            belly=("#eef0f3", "#ffffff", "#cdd2da"), paw=("#eef0f3", "#ffffff", "#cdd2da"),
                            acc=("#e2475a", "#f2697a", "#ad3242"), acc2=("#33333e", "#4a4a58", "#24242c"))),
    },
    {
        "id": "midnight", "name": "Midnight", "blurb": "Tuxedo cat in shades and a gold chain", "signature": "kneeup",
        "pattern": plain, "accessory": shades,
        "pal": dict(palette("#0e0a13", "#b9b1a6",
                            body=("#433a53", "#5a5070", "#2b2537"), belly=("#f4f1ea", "#ffffff", "#d4cdc0"),
                            paw=("#f4f1ea", "#ffffff", "#d4cdc0"), acc2=("#f6c44e", "#ffe08a", "#c9932b")),
                    lens=hexc("#08060b"), glint=hexc("#8fdcff")),
    },
    {
        "id": "pepper", "name": "Pepper", "blurb": "Calico with a pink bow", "signature": "elbows",
        "pattern": calico, "accessory": bow,
        "pal": dict(palette("#231a1c", "#cbbcaa",
                            body=("#faf4ea", "#ffffff", "#ddd1c0"), patch1=("#f09d4b", "#f8b872", "#c47731"),
                            patch2=("#3b3238", "#504550", "#28222a"), belly=("#fffdf8", "#ffffff", "#e6dccd"),
                            paw=("#fffdf8", "#ffffff", "#e2d8c9"), acc=("#ff7db4", "#ffa3cb", "#d6578f"),
                            acc2=("#ffd0e5", "#ffe6f1", "#e8a6c4"))),
    },
    {
        "id": "mochi", "name": "Mochi", "blurb": "Siamese in a blue polka-dot bandana", "signature": "stomp",
        "pattern": siamese, "accessory": bandana,
        "pal": dict(palette("#1f150f", "#2c1e15",
                            body=("#f3e4c9", "#fdf3e1", "#d5bd97"), point=("#5c4030", "#765443", "#422d20"),
                            point_l=("#8e6c53", "#a5846a", "#735540"), belly=("#fbf3e3", "#ffffff", "#e5d4b9"),
                            paw=("#5c4030", "#765443", "#422d20"), acc=("#3f80d8", "#5f9cec", "#2d5fa8"),
                            acc2=("#eaf2ff", "#ffffff", "#c6d6ef"))),
    },
    {
        "id": "ginger", "name": "Ginger", "blurb": "Orange tabby in a cozy striped scarf", "signature": "twist",
        "pattern": tabby, "accessory": scarf,
        "pal": dict(palette("#2a140c", "#d99a72",
                            body=("#f0a050", "#fbbd74", "#cc7a34"), stripe=("#c8692a", "#d97d3c", "#a4531e"),
                            belly=("#fff3e2", "#ffffff", "#ecd2b4"), paw=("#fff3e2", "#ffffff", "#ecd2b4"),
                            acc=("#3a6fd0", "#5a8ce6", "#2a52a0"), acc2=("#f2f4fa", "#ffffff", "#c9cfdf"))),
    },
    {
        "id": "snowball", "name": "Snowball", "blurb": "Fluffy white cat with a daisy behind the ear", "signature": "wave",
        "pattern": plain, "accessory": flower,
        "pal": dict(palette("#2b2533", "#e4c9cf",
                            body=("#f7f5f8", "#ffffff", "#d8d3de"), belly=("#ffffff", "#ffffff", "#e6e2ea"),
                            paw=("#ffffff", "#ffffff", "#e6e2ea"), acc=("#ff8fbf", "#ffb3d4", "#e0679e"),
                            acc2=("#f6c44e", "#ffe08a", "#c9932b"))),
    },
    {
        "id": "ash", "name": "Ash", "blurb": "Blue-gray gentleman in a red bow tie", "signature": "disco",
        "pattern": plain, "accessory": bowtie,
        "pal": dict(palette("#14171f", "#8c96a8",
                            body=("#7c8aa3", "#97a5bd", "#5b677e"), belly=("#a9b5c9", "#c2ccdc", "#8794ab"),
                            paw=("#a9b5c9", "#c2ccdc", "#8794ab"), acc=("#d63c43", "#ee5a5f", "#a42a32"),
                            acc2=("#8e2028", "#a8303a", "#6c161c"))),
    },
    {
        "id": "tortie", "name": "Tortie", "blurb": "Tortoiseshell in a mustard beanie", "signature": "roof",
        "pattern": calico, "accessory": beanie,
        "pal": dict(palette("#1a110d", "#7a5a48",
                            body=("#4a3428", "#5e4434", "#33231b"), patch1=("#d9823b", "#eb9c56", "#b0652a"),
                            patch2=("#2a1d17", "#3a2a22", "#1d140f"), belly=("#e8c49a", "#f5d8b4", "#c9a27a"),
                            paw=("#3a2a22", "#4c382d", "#281c16"), acc=("#e0a82e", "#f2c24f", "#b38220"),
                            acc2=("#fff1cf", "#ffffff", "#e6d2a3"))),
    },
    {
        "id": "bengal", "name": "Bengal", "blurb": "Spotted wild one in a party hat", "signature": "stomp",
        "pattern": with_tip(spotted, "spot", 0.8), "accessory": party_hat,
        "pal": dict(palette("#24150b", "#c9935f",
                            body=("#e6b062", "#f3c983", "#c28a43"), spot=("#6b3f1d", "#80502b", "#4f2c13"),
                            belly=("#fbecd0", "#ffffff", "#e7d0aa"), paw=("#fbecd0", "#ffffff", "#e7d0aa"),
                            acc=("#7b4fd6", "#9a72ea", "#5c37ab"), acc2=("#ffe36e", "#fff2a8", "#d9b93e"))),
    },
    {
        "id": "cocoa", "name": "Cocoa", "blurb": "Chocolate cat in cool shades", "signature": "elbows",
        "pattern": plain, "accessory": shades,
        "pal": dict(palette("#1a0f0b", "#a67b62",
                            body=("#7a4e36", "#93644a", "#5a3726"), belly=("#c79a78", "#dcb394", "#a87d5d"),
                            paw=("#c79a78", "#dcb394", "#a87d5d"), acc2=("#e9eef5", "#ffffff", "#b8c2cf")),
                    lens=hexc("#120c10"), glint=hexc("#ffb3d1")),
    },
]


def robot_pal(ol, flats, **groups):
    return dict(palette(ol, "#000000", **groups), **{k: hexc(v) for k, v in flats.items()})


ROBOTS = [
    {
        "id": "boxy", "name": "Boxy", "blurb": "CRT-headed bot with red eyes and twin antennas", "signature": "robot",
        "bot": dict(move="legs", hip=21.5, hip_w=4.5, leg=(10.5, 10.5), leg_r=2.8, foot_w=4.5,
                    shoulder=(10.5, -23), arm=(8.5, 8), arm_r=2.3, neck=-32, neck_r=2.0,
                    head=head_crt, torso=torso_box,
                    pal=robot_pal("#1c1b19", dict(eye="#d8432c", eye_on="#ff7650", lamp_off="#55534d",
                                                  lamp_dim="#c99a35", lamp_on="#ffe066", glint="#ffffff"),
                                  metal=("#c9c7b9", "#e4e2d6", "#9b998d"), metal2=("#7e7c73", "#96948b", "#5e5c55"),
                                  dark=("#26262c", "#34343c", "#1a1a1f"))),
    },
    {
        "id": "pixel", "name": "Pixel", "blurb": "Little TV-head with a smiley on the screen", "signature": "kneeup",
        "bot": dict(move="legs", hip=12, hip_w=3, leg=(6, 6), leg_r=2.4, foot_w=3, stance=0.55,
                    shoulder=(6.5, -11), arm=(5, 4.5), arm_r=1.8, neck=-24,
                    head=head_tv, torso=torso_small,
                    pal=robot_pal("#1a160f", dict(screen="#2f6b5e", face="#e9dc77", face_on="#fff7a8",
                                                  lamp_off="#5c5340", lamp_dim="#e0c45a", lamp_on="#fff3a0"),
                                  acc=("#bca57c", "#d6c196", "#97815b"), metal=("#9d8762", "#b49e78", "#7a6646"),
                                  metal2=("#6f5e42", "#83704f", "#54462f"), dark=("#3b3527", "#4a4332", "#2b261c"))),
    },
    {
        "id": "tidy", "name": "Tidy", "blurb": "Retro maid bot on a wheel, with bulb antennas", "signature": "twist",
        "bot": dict(move="wheel", hip=21, skirt=(8, 6, 12), shoulder=(8.5, -21), arm=(8.5, 7.5), arm_r=2.1,
                    neck=-31, neck_r=1.8, head=head_dome, torso=torso_barrel,
                    pal=robot_pal("#13201f", dict(lamp_off="#6b3b3f", lamp_dim="#c8484f", lamp_on="#ff6f6f"),
                                  metal=("#5fb3b5", "#84cfcf", "#3f8a8e"), metal2=("#3c6b73", "#4d808a", "#2c5158"),
                                  dark=("#1d2b33", "#283942", "#141e24"), acc=("#f6f5f1", "#ffffff", "#d6d4cc"),
                                  acc2=("#cfcdd6", "#e2e0e8", "#aeacb6"))),
    },
    {
        "id": "jet", "name": "Jet", "blurb": "Hovers on a thruster that flares on the beat", "signature": "wave",
        "bot": dict(move="jet", float=7, hip=18, nozzle=0, shoulder=(8.5, -20), arm=(8.5, 8), arm_r=2.2,
                    neck=-30, head=head_bullet, torso=torso_capsule,
                    pal=robot_pal("#151924", dict(lamp_off="#264653", lamp_dim="#3fa7c4", lamp_on="#8ff3ff",
                                                  flame="#ff8f2e", flame2="#fff1a6", glint="#ffffff"),
                                  metal=("#dfe3ea", "#f5f7fa", "#a9b0bd"), metal2=("#6c7586", "#828c9e", "#515969"),
                                  dark=("#1c2130", "#262c3e", "#141824"), acc=("#e2483d", "#f26a5f", "#b23229"))),
    },
    {
        "id": "endo", "name": "Endo", "blurb": "Chrome endoskeleton whose red eyes flare", "signature": "robot",
        "bot": dict(move="legs", hip=21.5, hip_w=3.5, leg=(11, 11), leg_r=1.6, foot_w=4, shoulder=(8.5, -24),
                    arm=(9.5, 8.5), arm_r=1.4, neck=-33, neck_r=1.3, stiff=0.5, head=head_skull, torso=torso_ribs,
                    pal=robot_pal("#0b0b0e", dict(eye="#c81e28", eye_on="#ff4a4a", lamp_off="#4a1a1d",
                                                  lamp_dim="#c81e28", lamp_on="#ff4a4a", glint="#ffffff"),
                                  metal=("#b7bec7", "#e8edf2", "#7c848f"), metal2=("#59606a", "#6f7782", "#40464e"),
                                  dark=("#121216", "#1c1c22", "#0b0b0e"))),
    },
]
CATS += ROBOTS

# Slay the Spire 2 cast (fan art of Mega Crit's characters and enemies).
LAMP_RED = dict(eye="#e0302a", eye_on="#ff8a5c")
SPIRE = [
    {
        "id": "ironclad", "name": "Ironclad", "blurb": "Gold-armoured soldier with a red-eyed helm and a huge sword", "signature": "stomp",
        "bot": dict(move="legs", hip=21.5, hip_w=4.5, leg=(10.5, 10.5), leg_r=2.8, leg_c="acc", knee_c="metal", foot_c="metal",
                    shoulder=(9, -22), arm=(8.5, 8), arm_r=2.3, arm_c="acc2", joint_c="metal", hand="metal",
                    neck=-31, head=head_ironclad, torso=torso_ironclad, held={"R": held_sword},
                    pal=robot_pal("#1a1214", dict(LAMP_RED, glint="#ffffff"),
                                  metal=("#d8a548", "#f2cd7c", "#a2742c"), metal2=("#8f6428", "#a9772f", "#6c4a1c"),
                                  acc=("#7a2b28", "#963a34", "#561c1a"), acc2=("#3a3135", "#4b4046", "#29222a"),
                                  dark=("#1c1618", "#2a2226", "#120d0f"), beard=("#b4b0a8", "#d2cec6", "#8e8a82"),
                                  blade=("#d6dce2", "#ffffff", "#9aa4ae"))),
    },
    {
        "id": "silent", "name": "Silent", "blurb": "Hooded huntress in an antlered skull mask, with twin glowing daggers", "signature": "shuffle",
        "bot": dict(move="legs", hip=21.5, hip_w=3.5, leg=(10.5, 10.5), leg_r=2.0, leg_c="metal", knees=False, foot="nub", foot_c="metal",
                    foot_w=2.6, shoulder=(7, -22), arm=(8.5, 8), arm_r=1.8, arm_c="metal", joints=False, hand="metal",
                    neck=-31, head=head_silent, torso=torso_silent, held={"L": held_dagger, "R": held_dagger},
                    pal=robot_pal("#171a16", dict(eye="#7fd37f", eye_on="#d4ffa8", lamp_off="#2f6f78", lamp_dim="#5fd0d8", lamp_on="#c4fcff"),
                                  acc=("#4c9a78", "#6ab894", "#356c54"), metal=("#e6dcc2", "#fbf3df", "#bfb398"),
                                  metal2=("#a89a7a", "#bcae8c", "#867a5e"), bone=("#efe8d8", "#ffffff", "#c8bfa8"),
                                  antler=("#c7a46a", "#ddbd86", "#9c7c46"), dark=("#1d1a18", "#2a2622", "#141210"))),
    },
    {
        "id": "regent", "name": "Regent", "blurb": "Star-crowned heir riding a stone throne on tentacles", "signature": "disco",
        "bot": dict(move="tentacles", hip=21, tent_y=6, shoulder=(6, -25), arm=(5, 4.5), arm_r=1.6, arm_c="acc2", joints=False,
                    hand="acc", neck=-32, head=head_regent, torso=torso_regent, behind=behind_regent,
                    pal=robot_pal("#141218", dict(lamp_off="#6b5a1e", lamp_dim="#e0b030", lamp_on="#fff06a"),
                                  metal=("#4b4752", "#625d6b", "#36323c"), metal2=("#2f2c34", "#3c3842", "#221f26"),
                                  acc=("#d9722a", "#f08f45", "#a9531a"), acc2=("#3d55b2", "#5873cf", "#2b3d83"),
                                  dark=("#16141a", "#201d25", "#0f0d12"))),
    },
    {
        "id": "necrobinder", "name": "Necrobinder", "blurb": "Floating lich with blue flame hair, a scythe and Osty the hand", "signature": "wave",
        "bot": dict(move="float", float=6, hip=18, shoulder=(6.5, -23), arm=(8, 7.5), arm_r=1.1, arm_c="metal", joints=False,
                    hand="metal", neck=-32, head=head_necro, torso=torso_necro, front=front_necro, held={"R": held_scythe},
                    pal=robot_pal("#140c16", dict(flame="#3f7cff", flame2="#c4e4ff"),
                                  acc=("#a9336f", "#c94f8e", "#7b2251"), acc2=("#4b1d4d", "#5e2961", "#36123a"),
                                  metal=("#e8e3d4", "#ffffff", "#bdb4a0"), dark=("#1a1220", "#24182c", "#120c16"),
                                  blade=("#c9d1da", "#f2f6fa", "#8f99a5"), wood=("#3a3036", "#4b4046", "#2a2226"))),
    },
    {
        "id": "defect", "name": "Defect", "blurb": "Gold automaton with a teal cloak and one big blue orb", "signature": "robot",
        "bot": dict(move="legs", hip=21, hip_w=5, leg=(10, 10.5), leg_r=3.2, foot_w=5, shoulder=(9.5, -23), arm=(8.5, 8),
                    arm_r=2.6, hand_kind="claw", hand="metal", neck=-33, neck_r=2.2, neck_c="dark",
                    head=head_defect, torso=torso_defect,
                    pal=robot_pal("#1a1610", dict(lamp_off="#1d3a66", lamp_dim="#3f9fe0", lamp_on="#aaeeff", glint="#ffffff"),
                                  metal=("#dcb35a", "#f4d68e", "#a8812f"), metal2=("#9c7631", "#b88d3d", "#77592a"),
                                  acc=("#2c8a9b", "#48aabb", "#1f6676"), dark=("#2f2f39", "#3f3f4b", "#20202a"))),
    },
    {
        "id": "byrdonis", "name": "Byrdonis", "blurb": "Lanky green bird with a hooked beak and a swinging tail", "signature": "kneeup",
        "bot": dict(move="legs", hip=24, hip_w=3, leg=(12, 12.5), leg_r=1.4, leg_c="metal", knees=False, foot="talon", foot_c="dark",
                    shoulder=(6.5, -18), arm=(5.5, 5.5), arm_r=2.2, arm_c="acc", joints=False, hand_kind="wing", hand="acc",
                    neck=-35, neck_r=2.6, neck_c="acc", head=head_byrd, torso=torso_byrd, tail=tail_byrd,
                    pal=robot_pal("#152010", dict(eye="#141414"),
                                  acc=("#74c444", "#98df6a", "#4f9430"), acc2=("#b9ee8c", "#d8ffb4", "#8cc066"),
                                  metal=("#8a9578", "#a3ad90", "#69725a"), beak=("#e2687a", "#f48c9c", "#b44a5c"),
                                  dark=("#1e1e1e", "#2c2c2c", "#121212"))),
    },
    {
        "id": "colony", "name": "Skulking Colony", "blurb": "A walking reef of coral and glowing barnacles", "signature": "elbows",
        "bot": dict(move="legs", hip=22, hip_w=4, leg=(11, 11.5), leg_r=1.9, leg_c="metal", knees=False, foot="talon", foot_c="metal",
                    shoulder=(7, -22), arm=(10, 10), arm_r=1.9, arm_c="metal", joints=False, hand_kind="branch", hand="metal",
                    neck=-31, neck_r=2.0, neck_c="acc", head=head_colony, torso=torso_colony,
                    pal=robot_pal("#1a1214", dict(lamp_off="#4a3a70", lamp_dim="#9a80e0", lamp_on="#e6d8ff"),
                                  acc=("#a6442f", "#c45f44", "#78301f"), metal=("#9cc1df", "#c3dbef", "#6f95b7"),
                                  acc2=("#8c79c9", "#ab9be2", "#6a589f"), bone=("#e9dfcf", "#ffffff", "#c4b8a5"))),
    },
    {
        "id": "cultist", "name": "Cultist", "blurb": "Shaggy blue-feathered cultist in a bird-skull mask. CAW!", "signature": "wave",
        "bot": dict(move="legs", hip=21.5, hip_w=3, leg=(10.5, 11), leg_r=1.4, leg_c="metal", knees=False, foot="nub", foot_c="metal",
                    foot_w=2.5, shoulder=(8, -21), arm=(8.5, 8), arm_r=1.3, arm_c="metal", joints=False, hand="metal",
                    neck=-31, head=head_cultist, torso=torso_cultist, held={"L": held_hook, "R": held_hook},
                    pal=robot_pal("#121626", {},
                                  acc=("#4b74b5", "#6a92d2", "#33528c"), metal=("#8a8f99", "#a3a8b2", "#6a6f78"),
                                  bone=("#bcdff0", "#e4f5ff", "#8db5cc"), acc2=("#b4483a", "#d06654", "#86302a"),
                                  dark=("#1c2030", "#262b3e", "#141724"))),
    },
    {
        "id": "punch", "name": "Punch Construct", "blurb": "Beige blocky automaton with a teal visor and huge fists", "signature": "swing",
        "bot": dict(move="legs", hip=21.5, hip_w=4, leg=(10.5, 10.5), leg_r=1.9, foot="nub", foot_w=3.8, knee_c="metal2",
                    shoulder=(10.5, -23), arm=(8, 8), arm_r=2.6, hand_kind="fist", hand="metal2",
                    neck=-31, neck_r=2.0, neck_c="dark", head=head_punch, torso=torso_punch,
                    pal=robot_pal("#1a1810", dict(lamp_off="#285a5a", lamp_dim="#3fc0c0", lamp_on="#b0ffff"),
                                  metal=("#d6c287", "#efdba5", "#a8955c"), metal2=("#a8925a", "#bea76c", "#867244"),
                                  dark=("#4a4a52", "#5c5c66", "#36363c"))),
    },
    {
        "id": "axebot", "name": "Axebot", "blurb": "Round rusty robot with an anvil head, glowing joints and an axe hand", "signature": "robot",
        "bot": dict(move="legs", hip=16, hip_w=5, leg=(7.5, 7.5), leg_r=3.2, foot_w=5, shoulder=(11, -18), arm=(7, 6.5), arm_r=3,
                    joint_lamp=True, hand_kind="fist", hand="metal2", neck=-27, head=head_axebot, torso=torso_axebot,
                    held={"R": held_axe},
                    pal=robot_pal("#170c08", dict(lamp_off="#5a2e1c", lamp_dim="#e0782a", lamp_on="#ffd070"),
                                  metal=("#9b4a2d", "#b9643f", "#6f321f"), metal2=("#5f2b1d", "#75382a", "#451f15"),
                                  dark=("#3f2722", "#523430", "#2c1a17"), blade=("#a8adb5", "#d8dce2", "#787e88"))),
    },
]
for c in SPIRE:
    c["kind"] = "spire"
CATS += SPIRE



# ------------------------------------------------------------------ export
def upscale(img, k):
    return img.resize((img.width * k, img.height * k), Image.NEAREST)


def save_indexed(img, path):
    """Exact palette PNG: a cat uses a couple dozen colors, so this is lossless and ~3x smaller."""
    colors = [c for _, c in img.getcolors(maxcolors=256)]
    index = {c: i for i, c in enumerate(colors)}
    out = Image.new("P", img.size)
    out.putdata([index[c] for c in img.get_flattened_data()])
    out.putpalette([v for c in colors for v in c[:3]])
    out.save(path, optimize=True, transparency=bytes(c[3] for c in colors))


def save_gif(frames, path, ms, bg):
    out = []
    for f in frames:
        base = Image.new("RGBA", f.size, bg)
        base.alpha_composite(f)
        out.append(base.convert("RGB").convert("P", palette=Image.ADAPTIVE, colors=255))
    out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0, disposal=2, optimize=False)


def layout():
    """Frame offsets for each clip (and its tweens) inside one view's block of the atlas."""
    clips, start = {}, 0
    for cid, c in CLIPS.items():
        clips[cid] = {"name": c["name"], "kind": c["kind"], "start": start, "count": c["frames"], "fps": c["fps"]}
        start += c["frames"]
    for cid in CLIPS:
        clips[cid]["out"] = {"start": start, "count": len(TWEEN_OUT)}
        start += len(TWEEN_OUT)
        clips[cid]["in"] = {"start": start, "count": len(TWEEN_IN)}
        start += len(TWEEN_IN)
    return clips, start


def sequence(poses):
    """Every pose in atlas order: clips first, then each clip's out and in tweens."""
    seq = [p for cid in CLIPS for p in poses[cid]]
    for cid in CLIPS:
        out, inn = tween_poses(CLIPS[cid])
        seq += out + inn
    return seq


def motion_match(poses):
    """How well each dance-move frame flows into each frame of every other move.

    Switching from clip A (showing frame i) to clip B at frame j looks smooth
    when B[j] is close to where A was heading (A[i+1]) and moving the same way.
    The director uses this to change moves without stopping: it jumps into the
    next move at the frame that best carries the current motion through.
    Costs are stored as bytes, A-major: data[((a * n + b) * 16 + i) * 16 + j].
    """
    import base64
    ids = [cid for cid, c in CLIPS.items() if c["kind"] in ("move", "dj") and c["frames"] == 16]
    lin = ("px", "py", "hx", "hy", "lfx", "rfx", "llift", "rlift")
    rotk = (("lean", 0.25), ("tilt", 0.25))

    def wrap(d):
        return (d + 180) % 360 - 180

    def diff(p, q):
        """Weighted distance between two poses (or two pose velocities)."""
        s = sum(abs(p[k] - q[k]) for k in lin)
        s += sum(abs(p[k] - q[k]) * w for k, w in rotk)
        s += sum(abs(wrap(p[k] - q[k])) * 0.12 for k in ANGLES)
        return s

    def vel(seq, k):
        a, b = seq[k], seq[(k + 1) % len(seq)]
        v = {key: b[key] - a[key] for key in lin + ("lean", "tilt")}
        v.update({key: wrap(b[key] - a[key]) for key in ANGLES})
        return v

    P = {cid: poses[cid] for cid in ids}
    V = {cid: [vel(P[cid], k) for k in range(16)] for cid in ids}
    out = bytearray()
    for a in ids:
        for b in ids:
            for i in range(16):
                nxt = (i + 1) % 16
                for j in range(16):
                    cost = diff(P[a][nxt], P[b][j]) + 0.6 * diff(V[a][nxt], V[b][j])
                    out.append(min(255, round(cost * 3)))
    return {"clips": ids, "scale": 3, "data": base64.b64encode(bytes(out)).decode("ascii")}


def main(only=None, manifest_only=False):
    sprites = os.path.join(OUT, "sprites")
    gifs = os.path.join(OUT, "gifs")
    os.makedirs(sprites, exist_ok=True)
    os.makedirs(gifs, exist_ok=True)
    clips, per_view = layout()
    rows = math.ceil(per_view / COLS)
    manifest = {
        "frameWidth": W, "frameHeight": H, "cols": COLS, "rows": rows * len(VIEWS), "tweenFps": TWEEN_FPS,
        "views": {v: i * rows for i, v in enumerate(VIEWS)},  # first atlas row of each view
        "clips": clips,
        "cats": [],
    }
    poses = {cid: clip_poses(c) for cid, c in CLIPS.items()}
    manifest["match"] = motion_match(poses)
    bg = hexc("#1e1830")
    lineup = []
    for cat in CATS:
        if only and cat["id"] not in only:
            continue
        if manifest_only:
            manifest["cats"].append({"id": cat["id"], "name": cat["name"], "blurb": cat["blurb"],
                                     "kind": cat.get("kind") or ("robot" if cat.get("bot") else "cat"),
                                     "signature": cat["signature"], "dance": CLIPS[cat["signature"]]["name"]})
            continue
        sheet = Image.new("RGBA", (W * COLS, H * rows * len(VIEWS)), (0, 0, 0, 0))
        drawn = {}
        seq = sequence(poses)
        for vi, view in enumerate(VIEWS):
            frames = [draw_cat(p, cat, view) for p in seq]
            for i, f in enumerate(frames):
                sheet.paste(f, ((i % COLS) * W, (vi * rows + i // COLS) * H))
            for cid, c in clips.items():
                drawn[(cid, view)] = frames[c["start"]:c["start"] + c["count"]]
                drawn[(cid, "tween", view)] = (frames[c["out"]["start"]:c["out"]["start"] + c["out"]["count"]],
                                               frames[c["in"]["start"]:c["in"]["start"] + c["in"]["count"]])
        save_indexed(sheet, os.path.join(sprites, f"{cat['id']}.png"))
        sig = cat["signature"]
        manifest["cats"].append({"id": cat["id"], "name": cat["name"], "blurb": cat["blurb"],
                                 "kind": cat.get("kind") or ("robot" if cat.get("bot") else "cat"),
                                 "signature": sig, "dance": CLIPS[sig]["name"]})

        # ---- previews: every clip side by side (front), and a turnaround
        k, pad, n = 3, 4, 16
        cids = list(CLIPS)
        grid_w = (W + pad) * 7 + pad
        grid_h = (H + pad) * math.ceil(len(cids) / 7) + pad
        frames = []
        for fi in range(n):
            canvas = Image.new("RGBA", (grid_w, grid_h), bg)
            for ci, cid in enumerate(cids):
                seq = drawn[(cid, "front")]
                canvas.alpha_composite(seq[fi % len(seq)], (pad + (ci % 7) * (W + pad), pad + (ci // 7) * (H + pad)))
            frames.append(upscale(canvas, k))
        save_gif(frames, os.path.join(gifs, f"{cat['id']}_moves.gif"), 83, bg)
        # Flow: moves strung together the way the director does it, tweening
        # through the ready stance and turning to a new facing as it goes.
        flow = []
        plan = [(sig, "front", False), ("disco", "side", False), ("wave", "back", False),
                ("shuffle", "side", True), ("roof", "front", False)]
        prev = None
        for cid, view, flip in plan:
            parts = []
            if prev:
                parts += [(f, prev[2]) for f in drawn[(prev[0], "tween", prev[1])][0]]
            parts += [(f, flip) for f in drawn[(cid, "tween", view)][1]]
            parts += [(f, flip) for f in drawn[(cid, view)]]
            for f, fl in parts:
                if fl:
                    f = f.transpose(Image.FLIP_LEFT_RIGHT)
                canvas = Image.new("RGBA", (W, H), bg)
                canvas.alpha_composite(f)
                flow.append(upscale(canvas, 5))
            prev = (cid, view, flip)
        save_gif(flow, os.path.join(gifs, f"{cat['id']}_flow.gif"), 83, bg)
        lineup.append(drawn[(sig, "front")])
        print("drew", cat["id"])

    if not only:
        with open(os.path.join(OUT, "cats.json"), "w") as fh:
            json.dump(manifest, fh, indent=2)
        if manifest_only:
            return
        k, pad = 4, 4
        lw = (W * len(lineup) + pad * (len(lineup) + 1)) * k
        lh = (H + pad * 2) * k
        line = []
        for fi in range(16):
            canvas = Image.new("RGBA", (lw, lh), bg)
            for ci, frames in enumerate(lineup):
                canvas.alpha_composite(upscale(frames[fi], k), ((pad + ci * (W + pad)) * k, pad * k))
            line.append(canvas)
        save_gif(line, os.path.join(OUT, "lineup.gif"), 83, bg)
        line[0].convert("RGB").save(os.path.join(OUT, "lineup.png"))


if __name__ == "__main__":
    # --manifest: rewrite cats.json only (clips, motion matching), no drawing.
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    main(set(args) or None, manifest_only="--manifest" in sys.argv)
