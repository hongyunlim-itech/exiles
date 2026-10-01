# Usage: python montage.py out.png cols width img1 img2 ... (labels = file stem)
import sys, os
from PIL import Image, ImageDraw
out, cols, w = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
files = sys.argv[4:]
ims = [Image.open(f).convert('RGB') for f in files]
h = int(w * ims[0].height / ims[0].width)
rows = (len(ims) + cols - 1) // cols
M = Image.new('RGB', (cols * w, rows * h), (0, 0, 0))
d = ImageDraw.Draw(M)
for i, (f, im) in enumerate(zip(files, ims)):
    t = im.resize((w, h), Image.LANCZOS)
    x, y = (i % cols) * w, (i // cols) * h
    M.paste(t, (x, y))
    d.rectangle([x, y, x + 8 * len(os.path.basename(f)) , y + 14], fill=(0, 0, 0))
    d.text((x + 2, y + 1), os.path.basename(f)[:-4], fill=(255, 255, 0))
M.save(out)
print(out, M.size)
