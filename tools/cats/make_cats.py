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


def arm_points(shoulder, upper, fore, side):
    """side = -1 for the screen-left arm, +1 for the screen-right arm."""
    def d(theta):
        r = math.radians(theta)
        return side * math.sin(r), math.cos(r)
    ux, uy = d(upper)
    fx, fy = d(fore)
    elbow = (shoulder[0] + ux * 9.5, shoulder[1] + uy * 9.5)
    paw = (elbow[0] + fx * 8.5, elbow[1] + fy * 8.5)
    return elbow, paw


def side_arm_points(shoulder, upper, fore):
    """Profile view: sideways reach is foreshortened into a short forward reach."""
    def d(theta):
        r = math.radians(theta)
        return 0.5 * abs(math.sin(r)), math.cos(r)
    ux, uy = d(upper)
    fx, fy = d(fore)
    elbow = (shoulder[0] + ux * 9.5, shoulder[1] + uy * 9.5)
    paw = (elbow[0] + fx * 8.5, elbow[1] + fy * 8.5)
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
            sw = p["tail"]
            ctrl = (base[0] + 13 + 2 * math.sin(math.radians(sw)), base[1] + 3)
            tipx, tipy = rot(7, -15, sw)
            tip = (base[0] + 10 + tipx, base[1] - 1 + tipy)
        else:
            base = W_(8, -3)
            sw = p["tail"]
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
    sw = p["tail"]
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
    # ---- reactions
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
    return poses


# ------------------------------------------------------------------ tweens
# Every clip can ease out to a shared "ready" stance and back in from it, so the
# director can change moves (and turn around) without snapping: the last loop
# ends on frame 0, OUT eases to the stance, IN eases from it into the next clip.
HUB = dict(py=2, la=18, lf=8, ra=18, rf=8, lfx=-9, rfx=9, tail=0)
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


def main(only=None):
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
    bg = hexc("#1e1830")
    lineup = []
    for cat in CATS:
        if only and cat["id"] not in only:
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
    main(set(sys.argv[1:]) or None)
