# Paste screenshots side by side and shrink the sheet so its longest side is <= MAX px.
# Usage: python _sheet.py out.png in1.png [in2.png ...]   (keeps images small for review)
import sys
from PIL import Image

MAX = 760
out, names = sys.argv[1], sys.argv[2:]
ims = [Image.open(n).convert("RGBA") for n in names]
W = sum(i.width for i in ims) + 8 * (len(ims) - 1)
H = max(i.height for i in ims)
sheet = Image.new("RGBA", (W, H), (120, 132, 150, 255))
x = 0
for i in ims:
    sheet.alpha_composite(i, (x, 0))
    x += i.width + 8
scale = min(1.0, MAX / max(W, H))
if scale < 1:
    sheet = sheet.resize((max(1, int(W * scale)), max(1, int(H * scale))), Image.LANCZOS)
sheet.convert("RGB").save(out)
print(sheet.size)
