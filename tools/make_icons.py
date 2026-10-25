import json, os, sys
import numpy as np
from PIL import Image
root = sys.argv[1]
m = json.load(open(os.path.join(root, "assets", "sprites", "manifest.json")))["anims"]["wave"]
strip = Image.open(os.path.join(root, "assets", "sprites", m["file"])).convert("RGBA")
frame = strip.crop((0, 0, m["w"], m["h"]))
a = np.array(frame)[..., 3]
rows = np.where(a.any(axis=1))[0]
top = rows.min()
# head region: from the top of the hair, a square about 46% of the frame height
size = int(m["h"] * 0.46)
cols = np.where(a[top:top + size].any(axis=0))[0]
cx = int((cols.min() + cols.max()) / 2)
box = (cx - size // 2, top - 1, cx - size // 2 + size, top - 1 + size)
head = frame.crop(box)
head.save(os.path.join(root, "assets", "head.png"))
for px, name in ((256, "icon-256.png"), (64, "icon.png"), (32, "tray.png")):
    head.resize((px, px), Image.NEAREST if px >= size else Image.BOX).save(os.path.join(root, "assets", name))
head.resize((256, 256), Image.NEAREST).save(os.path.join(root, "assets", "icon.ico"), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("head", size, box)
