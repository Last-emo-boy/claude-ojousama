"""Turn raw 4-frame sprite sheets (assets/raw/*.png) into pixel-art strips.

Output: assets/sprites/<name>.png (frames side by side) + assets/sprites/manifest.json,
Icons are produced separately by tools/make_icons.py.

The generator lays frames out on an even 4-cell grid, so frames are cut by cell and
cropped with one union box per animation to keep the authored alignment.
"""
import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "assets", "raw")
OUT = os.path.join(ROOT, "assets", "sprites")

CELLS = 4
DESK_TARGET_H = 100  # native pixel height of the desk scene
PALETTE_COLORS = 128
ALPHA_CUT = 120

# name: (fps, loop, relative scale)
ANIMS = {
    "idle": (3, True, 1.0),
    "typing": (8, True, 1.0),
    "thinking": (3, True, 1.0),
    "sleep": (2, True, 1.0),
    "error": (6, True, 1.0),
    "happy": (7, True, 1.0),
    "wave": (5, True, 1.0),
    "walk": (7, True, 1.0),
    "drag": (5, True, 1.0),
    "dangle": (7, True, 1.0),
    "peek": (3, False, 0.62),
    "surprise": (5, False, 1.0),
    # second batch (python tools/process_sprites.py --add <names>)
    "look": (4, True, 1.0),
    "magnify": (4, True, 1.0),
    "stretch": (3, True, 1.0),
    "water": (4, True, 1.0),
    "read": (2, True, 1.0),
    "eat": (5, True, 1.0),
    "giggle": (6, True, 1.0),
    "point": (4, True, 1.0),
    "sit": (3, True, 1.0),
    "yawn": (3, True, 1.0),
    "sulk": (4, True, 1.0),
    "cheer": (6, True, 1.0),
    "shush": (3, True, 1.0),
    "music": (5, True, 1.0),
    "cry": (5, True, 1.0),
    # third batch
    "nap": (2, True, 1.0),
    "phone": (3, True, 1.0),
    "clean": (6, True, 1.0),
    "umbrella": (4, True, 1.0),
    "write": (5, True, 1.0),
    "relax": (3, True, 1.0),
    "confused": (3, True, 1.0),
    "shy": (4, True, 1.0),
    "dizzy": (5, True, 1.0),
    "angry": (6, True, 1.0),
    "laugh": (6, True, 1.0),
    "thumbsup": (4, True, 1.0),
    "sign": (2, True, 1.0),
    "gift": (3, True, 1.0),
    "squish": (3, True, 1.0),
    "run": (9, True, 1.0),
    "tumble": (3, False, 1.0),
    "dance": (5, True, 1.0),
    "pet": (3, True, 1.0),
    "magic": (6, True, 1.0),
}


def load_cells(name):
    a = np.array(Image.open(os.path.join(RAW, name + ".png")).convert("RGBA"))
    h, w, _ = a.shape
    cw = w / CELLS
    cells = []
    for i in range(CELLS):
        c = a[:, int(round(i * cw)) : int(round((i + 1) * cw))].copy()
        alpha = c[..., 3]
        c[..., 3] = np.where(alpha >= ALPHA_CUT, 255, 0).astype(np.uint8)
        c[c[..., 3] == 0] = 0
        cells.append(c)
    width = min(c.shape[1] for c in cells)
    return [c[:, :width] for c in cells]


def union_box(cells):
    mask = np.zeros(cells[0].shape[:2], bool)
    for c in cells:
        mask |= c[..., 3] > 0
    rows = np.where(mask.any(axis=1))[0]
    cols = np.where(mask.any(axis=0))[0]
    return cols.min(), rows.min(), cols.max() + 1, rows.max() + 1


def downscale(cell, box, scale):
    x0, y0, x1, y1 = box
    im = Image.fromarray(cell[y0:y1, x0:x1], "RGBA")
    size = (max(1, round((x1 - x0) * scale)), max(1, round((y1 - y0) * scale)))
    small = im.convert("RGBa").resize(size, Image.BOX).convert("RGBA")
    arr = np.array(small)
    arr[..., 3] = np.where(arr[..., 3] >= 128, 255, 0).astype(np.uint8)
    arr[arr[..., 3] == 0] = 0
    return arr


def remove_specks(arr, min_neighbors=1):
    """Drop isolated single opaque pixels (resampling dust)."""
    op = arr[..., 3] > 0
    p = np.pad(op, 1)
    n = sum(
        p[1 + dy : p.shape[0] - 1 + dy, 1 + dx : p.shape[1] - 1 + dx]
        for dy in (-1, 0, 1)
        for dx in (-1, 0, 1)
        if dy or dx
    )
    lonely = op & (n < min_neighbors)
    arr[lonely] = 0
    return arr


def build_palette(frames):
    pix = np.concatenate([f[f[..., 3] > 0][:, :3] for f in frames], axis=0)
    side = int(np.ceil(np.sqrt(len(pix))))
    pad = np.zeros((side * side - len(pix), 3), np.uint8)
    img = Image.fromarray(np.concatenate([pix, pad])[: side * side].reshape(side, side, 3), "RGB")
    # Octree keeps small saturated accents (green CRT code, red error X) that median cut drops.
    return img.quantize(colors=PALETTE_COLORS, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)


def apply_palette(arr, pal):
    rgb = Image.fromarray(arr[..., :3], "RGB").quantize(palette=pal, dither=Image.Dither.NONE).convert("RGB")
    out = np.dstack([np.array(rgb), arr[..., 3]])
    out[out[..., 3] == 0] = 0
    return out


def rope_points(frames):
    """For the drag strip: y of the rope where it leaves the left edge, per frame."""
    pts = []
    for f in frames:
        ys = []
        for x in range(min(4, f.shape[1])):
            col = np.where(f[:, x, 3] > 0)[0]
            ys.extend(col.tolist())
        pts.append(int(np.median(ys)) if ys else f.shape[0] // 2)
    return pts


def seat_sink(frames):
    """For the sit strip: rows of dangling legs below the seat (where the body gets wide)."""
    f = frames[0]
    op = f[..., 3] > 0
    widths = op.sum(axis=1)
    wide = widths.max() * 0.55
    for y in range(f.shape[0] - 1, -1, -1):
        if widths[y] >= wide:
            return int(f.shape[0] - 1 - y)
    return 0


def board_rects(frames):
    """For the sign strip: the blank board (largest flat-coloured area in the middle), per frame."""
    from collections import Counter, deque

    rects = []
    for f in frames:
        h, w = f.shape[:2]
        band = f[int(h * 0.4) : int(h * 0.8), int(w * 0.25) : int(w * 0.75)]
        cols = Counter(tuple(p[:3]) for row in band for p in row if p[3] > 0)
        color = np.array(cols.most_common(1)[0][0], dtype=int)
        mask = (f[..., 3] > 0) & (np.abs(f[..., :3].astype(int) - color).sum(axis=2) <= 24)
        seen = np.zeros_like(mask)
        best = []
        for y0, x0 in zip(*np.nonzero(mask)):
            if seen[y0, x0]:
                continue
            q = deque([(y0, x0)])
            seen[y0, x0] = True
            pts = []
            while q:
                y, x = q.popleft()
                pts.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(pts) > len(best):
                best = pts
        ys = [p[0] for p in best]
        xs = [p[1] for p in best]
        rects.append({"x": int(min(xs)), "y": int(min(ys)), "w": int(max(xs) - min(xs) + 1), "h": int(max(ys) - min(ys) + 1)})
    return rects


def add_boards():
    """Write the sign's board rects into the manifest without re-processing the strip."""
    with open(os.path.join(OUT, "manifest.json"), encoding="utf8") as fh_:
        manifest = json.load(fh_)
    a = manifest["anims"]["sign"]
    strip = np.array(Image.open(os.path.join(OUT, a["file"])).convert("RGBA"))
    a["boards"] = board_rects([strip[:, i * a["w"] : (i + 1) * a["w"]] for i in range(a["frames"])])
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as fh_:
        json.dump(manifest, fh_, indent=2)
    print("sign boards", a["boards"])


def add(names):
    """Process only `names` and merge them into the existing manifest; existing strips stay untouched."""
    with open(os.path.join(OUT, "manifest.json"), encoding="utf8") as fh_:
        manifest = json.load(fh_)
    tb = union_box(load_cells("typing"))
    global_scale = DESK_TARGET_H / (tb[3] - tb[1])
    staged = {}
    for name in names:
        fps, loop, rel = ANIMS[name]
        cells = load_cells(name)
        box = union_box(cells)
        staged[name] = [remove_specks(downscale(c, box, global_scale * rel)) for c in cells]
    # Share colours with the existing art: seed the palette with the built strips' pixels.
    seeds = []
    for entry in manifest["anims"].values():
        seeds.append(np.array(Image.open(os.path.join(OUT, entry["file"])).convert("RGBA")))
    pal = build_palette(seeds + [f for fr in staged.values() for f in fr])
    for name, frames in staged.items():
        fps, loop, rel = ANIMS[name]
        frames = [apply_palette(f, pal) for f in frames]
        fh = max(f.shape[0] for f in frames)
        fw = max(f.shape[1] for f in frames)
        strip = np.zeros((fh, fw * len(frames), 4), np.uint8)
        for i, f in enumerate(frames):
            strip[fh - f.shape[0] :, i * fw : i * fw + f.shape[1]] = f
        Image.fromarray(strip, "RGBA").save(os.path.join(OUT, name + ".png"))
        entry = {"file": name + ".png", "frames": len(frames), "w": fw, "h": fh, "fps": fps, "loop": loop}
        if name == "sit":
            entry["sink"] = seat_sink([strip[:, i * fw : (i + 1) * fw] for i in range(len(frames))])
        if name == "sign":
            entry["boards"] = board_rects([strip[:, i * fw : (i + 1) * fw] for i in range(len(frames))])
        manifest["anims"][name] = entry
        print(f"{name}: {len(frames)} x {fw}x{fh}" + (f" sink={entry['sink']}" if name == "sit" else ""))
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as fh_:
        json.dump(manifest, fh_, indent=2)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--add":
        return add(sys.argv[2:])
    if len(sys.argv) > 1 and sys.argv[1] == "--boards":
        return add_boards()
    os.makedirs(OUT, exist_ok=True)
    names = [n for n in ANIMS if os.path.exists(os.path.join(RAW, n + ".png"))]
    typing_cells = load_cells("typing")
    tb = union_box(typing_cells)
    global_scale = DESK_TARGET_H / (tb[3] - tb[1])
    print(f"global scale {global_scale:.4f}")

    staged = {}
    for name in names:
        fps, loop, rel = ANIMS[name]
        cells = load_cells(name)
        box = union_box(cells)
        frames = [remove_specks(downscale(c, box, global_scale * rel)) for c in cells]
        staged[name] = frames

    pal = build_palette([f for fr in staged.values() for f in fr])
    manifest = {"scaleNote": "native pixels; renderer multiplies by settings.scale", "anims": {}}
    for name, frames in staged.items():
        fps, loop, rel = ANIMS[name]
        frames = [apply_palette(f, pal) for f in frames]
        fh = max(f.shape[0] for f in frames)
        fw = max(f.shape[1] for f in frames)
        strip = np.zeros((fh, fw * len(frames), 4), np.uint8)
        for i, f in enumerate(frames):
            strip[fh - f.shape[0] :, i * fw : i * fw + f.shape[1]] = f
        Image.fromarray(strip, "RGBA").save(os.path.join(OUT, name + ".png"))
        entry = {"file": name + ".png", "frames": len(frames), "w": fw, "h": fh, "fps": fps, "loop": loop}
        if name == "drag":
            entry["rope"] = rope_points(frames)
        if name == "peek":
            entry["anchor"] = "right"
        manifest["anims"][name] = entry
        print(f"{name}: {len(frames)} x {fw}x{fh}")
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf8") as fh_:
        json.dump(manifest, fh_, indent=2)
    # Icons come from tools/make_icons.py (transparent head crop of the wave sprite).


if __name__ == "__main__":
    sys.exit(main())
