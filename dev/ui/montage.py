"""Crop the right-hand panel region (or full) of several screenshots into one contact sheet."""
import sys
from PIL import Image

out = sys.argv[1]
mode = sys.argv[2]  # 'panel' or 'full'
files = sys.argv[3:]
imgs = [Image.open(f) for f in files]
if mode == 'panel':
    crops = []
    for im in imgs:
        w, h = im.size
        crops.append(im.crop((int(w * 0.78), 50, w, int(h * 0.95))))
else:
    crops = [im.resize((im.width // 2, im.height // 2)) for im in imgs]
cw = sum(c.width for c in crops)
ch = max(c.height for c in crops)
sheet = Image.new('RGB', (cw, ch), (20, 16, 12))
x = 0
for c in crops:
    sheet.paste(c, (x, 0))
    x += c.width
sheet.save(out)
print(out, sheet.size)
