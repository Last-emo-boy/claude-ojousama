"""Build README media from assets/sprites: docs/images/gallery.png and docs/images/hero.gif.

Usage: python tools/readme_media.py
"""
import json
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPR = os.path.join(ROOT, "assets", "sprites")
OUT = os.path.join(ROOT, "docs", "images")
BG = (255, 248, 239)
INK = (59, 42, 32)

GROUPS = [
    ("core", "idle typing thinking sleep error happy wave walk drag dangle peek surprise"),
    ("screen & mood", "look magnify point giggle cheer sulk cry shush music stretch water read eat yawn sit"),
    ("daily life", "nap phone clean umbrella write relax"),
    ("emotions", "confused shy dizzy angry laugh"),
    ("social", "thumbsup sign gift squish"),
    ("moves", "run tumble dance pet magic"),
]


def font(size):
    for f in ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/segoeui.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def frames(manifest, name):
    a = manifest[name]
    strip = Image.open(os.path.join(SPR, a["file"])).convert("RGBA")
    return [strip.crop((i * a["w"], 0, (i + 1) * a["w"], a["h"])) for i in range(a["frames"])], a


def gallery(manifest):
    cols, cw, ch = 7, 112, 150
    names = [n for _, g in GROUPS for n in g.split() if n in manifest]
    rows = (len(names) + cols - 1) // cols
    img = Image.new("RGB", (cols * cw, rows * ch), BG)
    d = ImageDraw.Draw(img)
    f = font(13)
    for i, n in enumerate(names):
        fr, a = frames(manifest, n)
        x, y = (i % cols) * cw, (i // cols) * ch
        sprite = fr[min(1, len(fr) - 1)]
        img.paste(sprite, (x + (cw - sprite.width) // 2, y + ch - 22 - sprite.height), sprite)
        w = d.textlength(n, font=f)
        d.text((x + (cw - w) / 2, y + ch - 19), n, fill=INK, font=f)
    img.save(os.path.join(OUT, "gallery.png"), optimize=True)
    return img.size


def hero(manifest, names=("wave", "typing", "magic", "dance", "umbrella", "pet"), scale=1.2, steps=12, ms=150):
    seqs = [frames(manifest, n) for n in names if n in manifest]
    cell_w = int(max(a["w"] for _, a in seqs) * scale) + 8
    cell_h = int(max(a["h"] for _, a in seqs) * scale) + 8
    out = []
    for s in range(steps):
        t = s * ms / 1000
        canvas = Image.new("RGBA", (cell_w * len(seqs), cell_h), BG + (255,))
        for i, (fr, a) in enumerate(seqs):
            k = int(t * a["fps"]) % len(fr)
            sp = fr[k].resize((int(fr[k].width * scale), int(fr[k].height * scale)), Image.NEAREST)
            canvas.alpha_composite(sp, (i * cell_w + (cell_w - sp.width) // 2, cell_h - sp.height - 4))
        out.append(canvas.convert("P", palette=Image.ADAPTIVE, colors=255))
    out[0].save(os.path.join(OUT, "hero.gif"), save_all=True, append_images=out[1:], duration=ms, loop=0, optimize=True)
    return out[0].size


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(SPR, "manifest.json"), encoding="utf8") as fh:
        manifest = json.load(fh)["anims"]
    print("gallery", gallery(manifest), "animations", len(manifest))
    print("hero", hero(manifest))


if __name__ == "__main__":
    main()
