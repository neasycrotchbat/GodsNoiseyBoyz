"""Pixel-art dancing cat generator for God's Noisey BoyZ.

Builds each cat from simple parts (head, torso, limbs, tail) on a 48x56 grid,
adds chunky outlines and rim shading, and exports sprite sheets + GIFs.
"""
import json
import math
import os

from PIL import Image

W, H = 48, 56
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")


def hexc(h, a=255):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), a)


# ---------------------------------------------------------------- primitives
def _col(color, s, t):
    return color(s, t) if callable(color) else color


def ellipse(cx, cy, rx, ry, color):
    def f(px, py):
        lx, ly = px - cx, py - cy
        if (lx / rx) ** 2 + (ly / ry) ** 2 <= 1:
            return _col(color, lx, ly)
    return f


def chain(points, r, color):
    """Thick polyline; color(s, total) gets distance along the chain."""
    segs = []
    acc = 0.0
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        L = math.hypot(x1 - x0, y1 - y0) or 1e-9
        segs.append((x0, y0, x1, y1, L, acc))
        acc += L
    total = acc

    def f(px, py):
        best = None
        for x0, y0, x1, y1, L, a in segs:
            dx, dy = x1 - x0, y1 - y0
            t = max(0.0, min(1.0, ((px - x0) * dx + (py - y0) * dy) / (L * L)))
            qx, qy = x0 + t * dx, y0 + t * dy
            d2 = (px - qx) ** 2 + (py - qy) ** 2
            rr = r(a + t * L, total) if callable(r) else r
            if d2 <= rr * rr:
                s = a + t * L
                if best is None or s > best:
                    best = s
        if best is not None:
            return _col(color, best, total)
    return f


def poly(pts, color):
    def f(px, py):
        inside = False
        n = len(pts)
        for i in range(n):
            x0, y0 = pts[i]
            x1, y1 = pts[(i + 1) % n]
            if (y0 > py) != (y1 > py):
                xi = x0 + (py - y0) * (x1 - x0) / (y1 - y0)
                if px < xi:
                    inside = not inside
        if inside:
            return _col(color, px, py)
    return f


def pix(cx, cy, offsets, color):
    ix, iy = int(round(cx)), int(round(cy))
    s = set(offsets)

    def f(px, py):
        if (int(px) - ix, int(py) - iy) in s:
            return color
    return f


def bezier(p0, p1, p2, n=10):
    pts = []
    for i in range(n + 1):
        t = i / n
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1]
        pts.append((x, y))
    return pts


# ---------------------------------------------------------------- canvas
class Canvas:
    def __init__(self):
        self.col = [[None] * W for _ in range(H)]
        self.grp = [[-1] * W for _ in range(H)]
        self.n = 0

    def group(self, prims, inner=True):
        gid = self.n
        self.n += 1
        mask = set()
        for prim in prims:
            for y in range(H):
                for x in range(W):
                    c = prim(x + 0.5, y + 0.5)
                    if c is not None:
                        self.col[y][x] = c
                        self.grp[y][x] = gid
                        mask.add((x, y))
        if inner:
            for x, y in mask:
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < W and 0 <= ny < H and (nx, ny) not in mask \
                            and self.col[ny][nx] not in (None, "ol"):
                        self.col[ny][nx] = "ol"
                        self.grp[ny][nx] = -2

    def finish(self, pal):
        # outer outline
        out = [row[:] for row in self.col]
        for y in range(H):
            for x in range(W):
                if self.col[y][x] is None:
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = x + dx, y + dy
                        if 0 <= nx < W and 0 <= ny < H and self.col[ny][nx] is not None:
                            out[y][x] = "ol"
                            break
        # rim shading on the right / bottom edges
        shaded = [row[:] for row in out]
        for y in range(H):
            for x in range(W):
                k = out[y][x]
                if k is None or k == "ol" or (k + "_s") not in pal:
                    continue
                edge = False
                for dx, dy in ((1, 0), (0, 1)):
                    nx, ny = x + dx, y + dy
                    if not (0 <= nx < W and 0 <= ny < H) or out[ny][nx] in (None, "ol"):
                        edge = True
                if edge:
                    shaded[y][x] = k + "_s"
        # ground shadow under everything
        for y in range(H):
            for x in range(W):
                if shaded[y][x] is None and ((x + 0.5 - 24) / 14) ** 2 + ((y + 0.5 - 52.5) / 2.2) ** 2 <= 1:
                    shaded[y][x] = "shadow"
        img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        px = img.load()
        for y in range(H):
            for x in range(W):
                k = shaded[y][x]
                if k is not None:
                    px[x, y] = pal[k]
        return img


# ---------------------------------------------------------------- poses
def mirror_pose(p, head_dx=0, tail=None):
    m = lambda pt: (48 - pt[0], pt[1])
    q = dict(p)
    q["arms"] = [tuple(m(pt) for pt in a) for a in reversed(p["arms"])]
    q["legs"] = [tuple(m(pt) for pt in leg) for leg in reversed(p["legs"])]
    q["head"] = (48 - p["head"][0] + head_dx, p["head"][1])
    if tail:
        q["tail"] = tail
    return q


POSE_A = {  # left paw thrown up high, right fist at chest
    "b": 0, "head": (23, 18),
    "arms": [((18, 28), (13, 21), (9, 12)), ((30, 28), (35, 31), (33, 25))],
    "legs": [((20, 41), (15, 46), (13, 50)), ((28, 41), (33, 46), (35, 50))],
    "tail": ((30, 41), (42, 45), (40, 33)),
}
POSE_B = {  # bounce down, fists pumping
    "b": 2, "head": (24, 20),
    "arms": [((18, 30), (13, 34), (16, 27)), ((30, 30), (35, 34), (32, 27))],
    "legs": [((20, 43), (14, 47), (12, 50)), ((28, 43), (34, 47), (36, 50))],
    "tail": ((30, 43), (43, 46), (43, 37)),
}
POSE_C = mirror_pose(POSE_A, head_dx=0, tail=((30, 41), (41, 43), (42, 32)))
POSE_D = {  # jazz hands
    "b": 1, "head": (24, 19),
    "arms": [((18, 29), (12, 28), (8, 22)), ((30, 29), (36, 28), (40, 22))],
    "legs": [((20, 42), (15, 46), (13, 50)), ((28, 42), (33, 46), (35, 50))],
    "tail": ((30, 42), (42, 44), (41, 35)),
}
IDLE_1 = {
    "b": 0, "head": (24, 18),
    "arms": [((18, 28), (16, 33), (17, 38)), ((30, 28), (32, 33), (31, 38))],
    "legs": [((20, 41), (18, 46), (17, 50)), ((28, 41), (30, 46), (31, 50))],
    "tail": ((30, 41), (41, 44), (40, 34)),
}
IDLE_2 = dict(IDLE_1, b=1, head=(24, 19),
              arms=[((18, 29), (16, 34), (17, 39)), ((30, 29), (32, 34), (31, 39))],
              tail=((30, 42), (42, 42), (42, 33)))

DANCE = [POSE_A, POSE_B, POSE_C, POSE_D]
IDLE = [IDLE_1, IDLE_2]


# ---------------------------------------------------------------- cat builder
def draw_cat(pose, cat):
    pal, pat, acc = cat["pal"], cat["pattern"], cat["accessory"]
    b = pose["b"]
    hx, hy = pose["head"]
    cv = Canvas()

    def P(part, base):
        return lambda s, t: pat(part, s, t, base)

    # tail
    p0, p1, p2 = pose["tail"]
    pts = bezier(p0, p1, p2)
    cv.group([chain(pts, lambda s, T: 1.9 - 0.5 * s / T, P("tail", "body"))])

    # legs + feet
    for i, (hip, knee, foot) in enumerate(pose["legs"]):
        cv.group([chain([hip, knee, foot], 2.4, P("leg%d" % i, "body"))])
    for i, (_, _, foot) in enumerate(pose["legs"]):
        fx = foot[0] + (-1 if i == 0 else 1)
        cv.group([ellipse(fx, foot[1] + 0.5, 3.2, 1.9, P("foot", "paw"))])

    # torso + belly
    ty = 34 + b
    cv.group([
        ellipse(24, ty, 7.6, 10, P("torso", "body")),
        ellipse(24.5, ty + 1.5, 4.3, 7.2, P("belly", "belly")),
    ])

    # arms + paws
    for i, (sh, el, paw) in enumerate(pose["arms"]):
        cv.group([chain([sh, el, paw], 1.9, P("arm%d" % i, "body"))])
        cv.group([ellipse(paw[0], paw[1], 2.4, 2.4, P("paw", "paw"))])

    # head
    L = lambda pts: [(hx + x, hy + y) for x, y in pts]
    cv.group([
        poly(L([(-9, 0), (-7.5, -11.5), (-1.5, -5.5)]), P("ear0", "body")),
        poly(L([(9, 0), (7.5, -11.5), (1.5, -5.5)]), P("ear1", "body")),
        poly(L([(-7, -3.5), (-6.6, -9), (-3.6, -5.8)]), "pink"),
        poly(L([(7, -3.5), (6.6, -9), (3.6, -5.8)]), "pink"),
        ellipse(hx, hy, 9.2, 7.2, P("head", "body")),
        ellipse(hx, hy + 3, 4.2, 2.8, P("muzzle", "belly")),
    ])
    # face
    face = [
        pix(hx, hy, [(-5, 0), (-4, -1), (-3, -1), (-2, 0)], "ol"),
        pix(hx, hy, [(2, 0), (3, -1), (4, -1), (5, 0)], "ol"),
        pix(hx, hy, [(-6, 2), (-5, 2), (5, 2), (6, 2)], "blush"),
        pix(hx, hy, [(0, 2)], "nose"),
        pix(hx, hy, [(-1, 4), (1, 4), (0, 3)], "ol"),
    ]
    cv.group(face, inner=False)

    if acc:
        acc(cv, pal, hx, hy, b)
    return cv.finish(pal)


# ---------------------------------------------------------------- accessories
def collar(cv, pal, hx, hy, b):
    cv.group([chain([(hx - 5, hy + 7.5), (hx, hy + 8.5), (hx + 5, hy + 7.5)], 0.9, "acc")])
    cv.group([ellipse(hx, hy + 10, 1.4, 1.4, "acc2")])


def headphones(cv, pal, hx, hy, b):
    band = [(hx - 9.5, hy + 0.5), (hx - 8.5, hy - 5), (hx - 4, hy - 8.6),
            (hx + 4, hy - 8.6), (hx + 8.5, hy - 5), (hx + 9.5, hy + 0.5)]
    cv.group([chain(band, 0.8, "acc2")])
    cv.group([ellipse(hx - 9.5, hy + 1.5, 2.2, 3.2, "acc")])
    cv.group([ellipse(hx + 9.5, hy + 1.5, 2.2, 3.2, "acc")])


def shades(cv, pal, hx, hy, b):
    cv.group([
        ellipse(hx - 3.6, hy - 0.2, 2.9, 2.0, "acc"),
        ellipse(hx + 3.6, hy - 0.2, 2.9, 2.0, "acc"),
        chain([(hx - 6.5, hy - 1.2), (hx + 6.5, hy - 1.2)], 0.6, "acc"),
    ], inner=False)
    cv.group([pix(hx, hy, [(-5, -1), (2, -1)], "glint")], inner=False)
    cv.group([chain([(hx - 4.5, hy + 7.5), (hx, hy + 10.5), (hx + 4.5, hy + 7.5)], 0.6, "acc2"),
              ellipse(hx, hy + 11.5, 1.4, 1.4, "acc2")], inner=False)


def bow(cv, pal, hx, hy, b):
    cx, cy = hx - 6, hy - 6.5
    cv.group([
        poly([(cx, cy), (cx - 4, cy - 2.8), (cx - 4, cy + 2.8)], "acc"),
        poly([(cx, cy), (cx + 4, cy - 2.8), (cx + 4, cy + 2.8)], "acc"),
    ])
    cv.group([ellipse(cx, cy, 1.3, 1.3, "acc2")])


def bandana(cv, pal, hx, hy, b):
    cv.group([poly([(hx - 7, hy + 6), (hx + 7, hy + 6), (hx, hy + 13)],
                   lambda x, y: "acc2" if (int(x) + int(y)) % 4 == 0 else "acc")])


# ---------------------------------------------------------------- patterns
def plain(part, s, t, base):
    return base


def tabby(part, s, t, base):
    if base != "body":
        return base
    if part == "torso" and int(t + 40) % 4 == 0 and abs(s) > 3:
        return "stripe"
    if part == "head" and t < -3.5 and int(s + 40) % 3 == 0 and abs(s) < 4:
        return "stripe"
    if part.startswith(("arm", "leg", "tail")) and int(s) % 3 == 1:
        return "stripe"
    return base


def calico(part, s, t, base):
    if base != "body":
        return base
    if part == "tail":
        return "patch2"
    if part == "ear1":
        return "patch2"
    if part in ("ear0",):
        return "patch1"
    if part == "head" and s < -1 and t < 1.5:
        return "patch1"
    if part == "head" and s > 3 and t < -2:
        return "patch2"
    if part == "torso":
        if (s + 3) ** 2 + (t + 4) ** 2 < 14:
            return "patch1"
        if (s - 4) ** 2 + (t - 3) ** 2 < 10:
            return "patch2"
    if part == "arm1" and s > 4:
        return "patch1"
    if part == "leg0" and s < 5:
        return "patch1"
    return base


def siamese(part, s, t, base):
    if part in ("paw", "foot"):
        return "point"
    if part in ("ear0", "ear1", "tail"):
        return "point"
    if part.startswith("leg") and s > 4:
        return "point"
    if part.startswith("arm") and s > 6:
        return "point"
    if part == "muzzle":
        return "point_l"
    return base


# ---------------------------------------------------------------- the five cats
COMMON = {
    "pink": hexc("#f1a3a3"), "blush": hexc("#f38c8c"), "nose": hexc("#e2657a"),
    "shadow": (44, 36, 66, 110),
}

CATS = [
    {
        "id": "biscuit", "name": "Biscuit", "blurb": "Classic cream with a red collar and bell",
        "pattern": plain, "accessory": collar,
        "pal": dict(COMMON, ol=hexc("#2b1a1e"), body=hexc("#f6d19c"), body_s=hexc("#d99b68"),
                    belly=hexc("#fff8ec"), belly_s=hexc("#efd9bf"), paw=hexc("#fff8ec"), paw_s=hexc("#e7cdb4"),
                    acc=hexc("#d63c43"), acc_s=hexc("#a42a32"), acc2=hexc("#f5c34d"), acc2_s=hexc("#c9932b")),
    },
    {
        "id": "smokey", "name": "Smokey", "blurb": "Gray tabby in red headphones",
        "pattern": tabby, "accessory": headphones,
        "pal": dict(COMMON, ol=hexc("#1c1e26"), body=hexc("#a3abb8"), body_s=hexc("#78808e"),
                    stripe=hexc("#626a79"), stripe_s=hexc("#4e5563"),
                    belly=hexc("#eef0f3"), belly_s=hexc("#cfd4db"), paw=hexc("#eef0f3"), paw_s=hexc("#cfd4db"),
                    acc=hexc("#e2475a"), acc_s=hexc("#ad3242"), acc2=hexc("#34343f")),
    },
    {
        "id": "midnight", "name": "Midnight", "blurb": "Tuxedo cat in shades and a gold chain",
        "pattern": plain, "accessory": shades,
        "pal": dict(COMMON, ol=hexc("#0f0b14"), body=hexc("#433a52"), body_s=hexc("#2c2638"),
                    belly=hexc("#f4f1ea"), belly_s=hexc("#d6d0c4"), paw=hexc("#f4f1ea"), paw_s=hexc("#d6d0c4"),
                    acc=hexc("#09070d"), glint=hexc("#8fdcff"), acc2=hexc("#f5c34d")),
    },
    {
        "id": "pepper", "name": "Pepper", "blurb": "Calico with a pink bow",
        "pattern": calico, "accessory": bow,
        "pal": dict(COMMON, ol=hexc("#241a1d"), body=hexc("#fbf6ee"), body_s=hexc("#e0d5c5"),
                    patch1=hexc("#f0a04e"), patch1_s=hexc("#c47a33"), patch2=hexc("#3b3238"), patch2_s=hexc("#29232a"),
                    belly=hexc("#fffdf8"), belly_s=hexc("#e8dfd2"), paw=hexc("#fffdf8"), paw_s=hexc("#e2d8c9"),
                    acc=hexc("#ff7fb5"), acc_s=hexc("#d65a92"), acc2=hexc("#ffd1e6")),
    },
    {
        "id": "mochi", "name": "Mochi", "blurb": "Siamese in a blue polka-dot bandana",
        "pattern": siamese, "accessory": bandana,
        "pal": dict(COMMON, ol=hexc("#20160f"), body=hexc("#f3e5cb"), body_s=hexc("#d5bf9b"),
                    point=hexc("#5c4030"), point_s=hexc("#432e21"), point_l=hexc("#8e6c53"), point_l_s=hexc("#755740"),
                    belly=hexc("#fbf3e4"), belly_s=hexc("#e6d6bc"), paw=hexc("#5c4030"),
                    acc=hexc("#3f80d8"), acc_s=hexc("#2e60aa"), acc2=hexc("#eaf2ff")),
    },
]


# ---------------------------------------------------------------- export
def upscale(img, k):
    return img.resize((img.width * k, img.height * k), Image.NEAREST)


def save_gif(frames, path, ms, bg=None):
    out = []
    for f in frames:
        if bg is not None:
            base = Image.new("RGBA", f.size, bg)
            base.alpha_composite(f)
            out.append(base.convert("P", palette=Image.ADAPTIVE))
        else:
            out.append(f)
    out[0].save(path, save_all=True, append_images=out[1:], duration=ms, loop=0,
                disposal=2, optimize=False, **({} if bg is not None else {"transparency": 0}))


def main():
    sheets_dir = os.path.join(OUT, "sprites")
    gif_dir = os.path.join(OUT, "gifs")
    os.makedirs(sheets_dir, exist_ok=True)
    os.makedirs(gif_dir, exist_ok=True)
    manifest = {"frameWidth": W, "frameHeight": H,
                "animations": {"dance": {"frames": [0, 1, 2, 3], "fps": 6},
                               "idle": {"frames": [4, 5], "fps": 2.5}},
                "cats": []}
    all_dance = []
    for cat in CATS:
        frames = [draw_cat(p, cat) for p in DANCE + IDLE]
        sheet = Image.new("RGBA", (W * len(frames), H), (0, 0, 0, 0))
        for i, f in enumerate(frames):
            sheet.paste(f, (i * W, 0))
        sheet.save(os.path.join(sheets_dir, f"{cat['id']}.png"))
        upscale(sheet, 4).save(os.path.join(sheets_dir, f"{cat['id']}@4x.png"))
        big = [upscale(f, 8) for f in frames]
        save_gif(big[:4], os.path.join(gif_dir, f"{cat['id']}_dance.gif"), 160, bg=(255, 255, 255, 255))
        save_gif(big[4:], os.path.join(gif_dir, f"{cat['id']}_idle.gif"), 400, bg=(255, 255, 255, 255))
        all_dance.append(frames[:4])
        manifest["cats"].append({"id": cat["id"], "name": cat["name"], "blurb": cat["blurb"],
                                 "sheet": f"sprites/{cat['id']}.png"})
    with open(os.path.join(OUT, "cats.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)

    # lineup: all five dancing, staggered by one frame so they don't move in lockstep
    k, pad = 5, 4
    lw = (W * len(CATS) + pad * (len(CATS) + 1)) * k
    lh = (H + pad * 2) * k
    line = []
    for fi in range(4):
        canvas = Image.new("RGBA", (lw, lh), hexc("#1e1830"))
        for ci, frames in enumerate(all_dance):
            f = upscale(frames[(fi + ci) % 4], k)
            canvas.alpha_composite(f, ((pad + ci * (W + pad)) * k, pad * k))
        line.append(canvas)
    save_gif(line, os.path.join(OUT, "lineup.gif"), 160, bg=hexc("#1e1830"))
    line[0].convert("RGB").save(os.path.join(OUT, "lineup.png"))


if __name__ == "__main__":
    main()
