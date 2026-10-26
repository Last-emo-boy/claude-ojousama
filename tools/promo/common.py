"""Shared drawing helpers for the promo cards and video (pixel UI in the app's own style)."""
import json
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SPR = os.path.join(ROOT, "assets", "sprites")
OUT = os.path.join(ROOT, "promo")

# palette (matches pet.css / panel.css)
CREAM = (255, 250, 242)
PAPER = (255, 246, 232)
INK = (59, 42, 32)
ORANGE = (255, 154, 60)
ORANGE_L = (255, 179, 107)
ORANGE_D = (217, 98, 43)
SUN = (255, 205, 64)
MUTED = (138, 106, 85)
GREEN = (88, 170, 92)
RED = (214, 72, 40)
CODE_BG = (43, 36, 32)

_fonts = {}


# ------------------------------------------------------------------ colour emoji inside normal text
# Microsoft YaHei has no emoji: split runs and draw emoji with Segoe UI Emoji (in colour).

def _is_emoji(ch):
    o = ord(ch)
    return o >= 0x1F000 or 0x2300 <= o <= 0x23FF or 0x2600 <= o <= 0x27BF or 0x2B00 <= o <= 0x2BFF or o in (0xFE0F, 0x200D)


def _segments(text):
    out = []
    for ch in text:
        e = _is_emoji(ch)
        if out and out[-1][0] == e:
            out[-1][1] += ch
        else:
            out.append([e, ch])
    return out


def _emoji_font(size):
    key = ("emoji", size)
    if key not in _fonts:
        _fonts[key] = ImageFont.truetype("C:/Windows/Fonts/seguiemj.ttf", size)
    return _fonts[key]


_orig_text = ImageDraw.ImageDraw.text
_orig_len = ImageDraw.ImageDraw.textlength


def _has_emoji(text):
    return isinstance(text, str) and any(_is_emoji(c) for c in text)


def _textlength(self, text, font=None, *a, **kw):
    if not _has_emoji(text) or font is None:
        return _orig_len(self, text, font, *a, **kw)
    ef = _emoji_font(max(8, int(font.size * 0.9)))
    return sum(_orig_len(self, s, ef if e else font) + (font.size * 0.08 if e else 0) for e, s in _segments(text))


def _text(self, xy, text, fill=None, font=None, anchor=None, *a, **kw):
    if not _has_emoji(text) or "\n" in text or font is None:
        return _orig_text(self, xy, text, fill, font, anchor, *a, **kw)
    anchor = anchor or "la"
    h, v = anchor[0], anchor[1]
    total = _textlength(self, text, font)
    x = xy[0] - (total / 2 if h == "m" else total if h == "r" else 0)
    ef = _emoji_font(max(8, int(font.size * 0.9)))
    stroke = {k: kw[k] for k in ("stroke_width", "stroke_fill") if k in kw}
    for e, s in _segments(text):
        if e:
            dy = font.size * 0.06 if v in ("a", "t") else 0
            _orig_text(self, (x + font.size * 0.04, xy[1] + dy), s, None, ef, "l" + v, embedded_color=True)
            x += _orig_len(self, s, ef) + font.size * 0.08
        else:
            _orig_text(self, (x, xy[1]), s, fill, font, "l" + v, **stroke)
            x += _orig_len(self, s, font)


ImageDraw.ImageDraw.text = _text
ImageDraw.ImageDraw.textlength = _textlength


def font(size, bold=False):
    key = (size, bold)
    if key not in _fonts:
        path = "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc"
        _fonts[key] = ImageFont.truetype(path, size)
    return _fonts[key]


def mono(size):
    key = ("mono", size)
    if key not in _fonts:
        for p in ("C:/Windows/Fonts/CascadiaMono.ttf", "C:/Windows/Fonts/consola.ttf"):
            if os.path.exists(p):
                _fonts[key] = ImageFont.truetype(p, size)
                break
    return _fonts[key]


# ------------------------------------------------------------------ sprites

with open(os.path.join(SPR, "manifest.json"), encoding="utf8") as fh:
    MANIFEST = json.load(fh)["anims"]
_strips = {}


def frames(name):
    if name not in _strips:
        a = MANIFEST[name]
        strip = Image.open(os.path.join(SPR, a["file"])).convert("RGBA")
        _strips[name] = [strip.crop((i * a["w"], 0, (i + 1) * a["w"], a["h"])) for i in range(a["frames"])]
    return _strips[name]


def frame_at(name, t, loop=None):
    """Frame of `name` at time t (seconds) using its own fps."""
    a = MANIFEST[name]
    fr = frames(name)
    i = int(t * a["fps"])
    lp = a.get("loop", True) if loop is None else loop
    return fr[i % len(fr)] if lp else fr[min(i, len(fr) - 1)]


def scaled(img, s, flip=False):
    out = img.resize((round(img.width * s), round(img.height * s)), Image.NEAREST)
    return out.transpose(Image.FLIP_LEFT_RIGHT) if flip else out


def paste_sprite(canvas, name, t, s, cx, bottom, flip=False, loop=None, shadow=True):
    """Draw a sprite frame with its feet at (cx, bottom). Returns its bbox."""
    im = scaled(frame_at(name, t, loop), s, flip)
    x = int(cx - im.width / 2)
    y = int(bottom - im.height)
    if shadow:
        d = ImageDraw.Draw(canvas, "RGBA")
        w = im.width * 0.5
        d.ellipse([cx - w / 2, bottom - 8, cx + w / 2, bottom + 8], fill=(59, 42, 32, 40))
    canvas.alpha_composite(im, (x, y))
    return (x, y, x + im.width, y + im.height)


def sign_text(canvas, t, s, cx, bottom, text, flip=False):
    """Sign animation with text written on its board (same placement as pet.js)."""
    a = MANIFEST["sign"]
    i = int(t * a["fps"]) % a["frames"]
    box = paste_sprite(canvas, "sign", t, s, cx, bottom, flip)
    b = a["boards"][i]
    bx = box[0] + ((a["w"] - b["x"] - b["w"]) if flip else b["x"]) * s
    by = box[1] + b["y"] * s
    bw, bh = b["w"] * s, b["h"] * s
    d = ImageDraw.Draw(canvas)
    size = int(bh * 0.62)
    while size > 8 and d.textlength(text, font=font(size, True)) > bw * 0.86:
        size -= 1
    d.text((bx + bw / 2, by + bh / 2 + 1), text, fill=(90, 52, 24), font=font(size, True), anchor="mm")
    return box


# ------------------------------------------------------------------ text

def wrap(d, text, f, width):
    lines = []
    for para in str(text).split("\n"):
        cur = ""
        for ch in para:
            if d.textlength(cur + ch, font=f) > width and cur:
                lines.append(cur)
                cur = ch
            else:
                cur += ch
        lines.append(cur)
    return lines


def text_block(d, xy, text, f, fill=INK, width=None, spacing=1.35, anchor_center=False):
    x, y = xy
    lines = wrap(d, text, f, width) if width else str(text).split("\n")
    lh = f.size * spacing
    for i, ln in enumerate(lines):
        if anchor_center:
            d.text((x, y + i * lh), ln, fill=fill, font=f, anchor="ma")
        else:
            d.text((x, y + i * lh), ln, fill=fill, font=f)
    return y + len(lines) * lh


# ------------------------------------------------------------------ pixel UI

def pixel_box(canvas, box, fill=CREAM, border=INK, k=2, radius=6, shadow=True, shadow_alpha=64):
    """Rounded box with a hard offset shadow, the app's bubble/panel style. k = UI scale."""
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(canvas, "RGBA")
    r = radius * k
    if shadow:
        o = 3 * k
        d.rounded_rectangle([x0 + o, y0 + o, x1 + o, y1 + o], r, fill=(59, 42, 32, shadow_alpha))
    d.rounded_rectangle(box, r, fill=fill, outline=border, width=2 * k)
    return d


def button(canvas, box, label, k=2, fill=ORANGE, size=None, pressed=False):
    x0, y0, x1, y1 = box
    if pressed:
        x0, y0, x1, y1 = x0 + k, y0 + k, x1 + k, y1 + k
    d = ImageDraw.Draw(canvas, "RGBA")
    o = (1 if pressed else 2) * k
    d.rounded_rectangle([x0 + o, y0 + o, x1 + o, y1 + o], 4 * k, fill=(59, 42, 32, 80))
    d.rounded_rectangle([x0, y0, x1, y1], 4 * k, fill=fill, outline=INK, width=2 * k)
    f = font(size or int((y1 - y0) * 0.5), False)
    d.text(((x0 + x1) / 2, (y0 + y1) / 2), label, fill=(43, 26, 16), font=f, anchor="mm")


def bubble(canvas, cx, bottom, text, k=2, width=None, buttons=(), size=None, pressed=None, tail=True, max_chars=None, tail_x=None):
    """Speech bubble whose tail points down at (cx, bottom). Returns its box."""
    size = size or 13 * k
    f = font(size)
    d = ImageDraw.Draw(canvas)
    width = width or 230 * k
    pad = 9 * k
    shown = text if max_chars is None else text[:max_chars]
    lines = wrap(d, text, f, width - 2 * pad)  # wrap on the full text: no reflow while typing
    shown_lines, left = [], len(shown)
    for ln in lines:
        shown_lines.append(ln[: max(0, left)])
        left -= len(ln)
    lh = size * 1.45
    bh = pad * 2 + len(lines) * lh + (size * 2.3 if buttons else 0)
    x0 = int(cx - width / 2)
    y1 = int(bottom - (9 * k if tail else 0))
    y0 = int(y1 - bh)
    box = (x0, y0, x0 + width, y1)
    pixel_box(canvas, box, k=k)
    if tail:
        dd = ImageDraw.Draw(canvas)
        s = 7 * k
        tx = cx if tail_x is None else max(x0 + 3 * s, min(x0 + width - 3 * s, tail_x))
        pts = [(tx - s, y1 - 2 * k), (tx + s, y1 - 2 * k), (tx, y1 + s)]
        dd.polygon(pts, fill=CREAM)
        dd.line([(tx - s, y1 - k), (tx, y1 + s), (tx + s, y1 - k)], fill=INK, width=2 * k)
    d = ImageDraw.Draw(canvas)
    for i, ln in enumerate(shown_lines):
        d.text((x0 + pad, y0 + pad + i * lh), ln, fill=INK, font=f)
    if buttons:
        bx = x0 + pad
        by = y1 - pad - int(size * 1.9)
        for i, lab in enumerate(buttons):
            bw = int(d.textlength(lab, font=font(size)) + 18 * k)
            button(canvas, (bx, by, bx + bw, by + int(size * 1.9)), lab, k=k, size=size, pressed=(pressed == i))
            bx += bw + 6 * k
    return box


def window(canvas, box, title, k=2, body=(250, 250, 252), title_bg=(238, 234, 228), dark=False):
    """A simple desktop window with a title bar; returns the content box."""
    x0, y0, x1, y1 = box
    d = ImageDraw.Draw(canvas, "RGBA")
    d.rounded_rectangle([x0 + 4 * k, y0 + 6 * k, x1 + 4 * k, y1 + 8 * k], 8 * k, fill=(30, 20, 10, 50))
    d.rounded_rectangle(box, 8 * k, fill=CODE_BG if dark else body, outline=(120, 104, 92), width=k)
    th = 22 * k
    d.rounded_rectangle([x0, y0, x1, y0 + th], 8 * k, fill=title_bg)
    d.rectangle([x0, y0 + th - 8 * k, x1, y0 + th], fill=title_bg)
    d.line([x0, y0 + th, x1, y0 + th], fill=(200, 192, 182), width=k)
    d.text((x0 + 10 * k, y0 + th / 2), title, fill=(70, 60, 52), font=font(int(10 * k)), anchor="lm")
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)][::-1]):
        cx = x1 - 14 * k - i * 14 * k
        d.ellipse([cx - 4 * k, y0 + th / 2 - 4 * k, cx + 4 * k, y0 + th / 2 + 4 * k], fill=c)
    return (x0, y0 + th, x1, y1)


def wallpaper(w, h, top=(255, 226, 190), bottom=(255, 244, 228)):
    """Warm gradient with soft pixel sparkles."""
    img = Image.new("RGBA", (w, h))
    d = ImageDraw.Draw(img)
    for y in range(h):
        t = y / max(1, h - 1)
        c = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
        d.line([(0, y), (w, y)], fill=c)
    import random

    rnd = random.Random(7)
    for _ in range(int(w * h / 26000)):
        x, y = rnd.randrange(w), rnd.randrange(h)
        s = rnd.choice([4, 6, 8])
        col = rnd.choice([(255, 255, 255, 150), (255, 210, 120, 140), (255, 180, 120, 110)])
        d.rectangle([x, y - s, x + s // 2 - 1, y + s], fill=col)
        d.rectangle([x - s // 2, y - s // 4, x + s, y + s // 4], fill=col)
    return img


def taskbar(canvas, y, h, k=2):
    w = canvas.width
    d = ImageDraw.Draw(canvas, "RGBA")
    d.rectangle([0, y, w, y + h], fill=(250, 244, 236, 235))
    d.line([0, y, w, y], fill=(210, 196, 180), width=k)
    cx = w / 2 - 3 * 20 * k
    cols = [(0, 120, 215), (255, 154, 60), (88, 170, 92), (130, 90, 200), (60, 60, 60)]
    for i, c in enumerate(cols):
        x = cx + i * 26 * k
        d.rounded_rectangle([x, y + h / 2 - 8 * k, x + 16 * k, y + h / 2 + 8 * k], 3 * k, fill=c)
    d.text((w - 12 * k, y + h / 2), "15:55", fill=INK, font=font(int(10 * k)), anchor="rm")


def sunflower(canvas, cx, cy, r):
    d = ImageDraw.Draw(canvas)
    for i in range(10):
        a = i * math.pi / 5
        px, py = cx + math.cos(a) * r * 0.85, cy + math.sin(a) * r * 0.85
        d.ellipse([px - r * 0.42, py - r * 0.42, px + r * 0.42, py + r * 0.42], fill=SUN, outline=(220, 150, 30), width=2)
    d.ellipse([cx - r * 0.55, cy - r * 0.55, cx + r * 0.55, cy + r * 0.55], fill=(120, 72, 36), outline=INK, width=2)


def chip(canvas, xy, label, k=2, fill=(255, 226, 194), size=None):
    d = ImageDraw.Draw(canvas)
    f = font(size or 12 * k)
    w = d.textlength(label, font=f) + 16 * k
    x, y = xy
    h = f.size + 10 * k
    d.rounded_rectangle([x, y, x + w, y + h], h / 2, fill=fill, outline=INK, width=k)
    d.text((x + w / 2, y + h / 2), label, fill=INK, font=f, anchor="mm")
    return x + w


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def outlined(d, xy, text, f, fill=CREAM, outline=INK, w=6, anchor="mm"):
    d.text(xy, text, font=f, fill=fill, anchor=anchor, stroke_width=w, stroke_fill=outline)
