from collections import deque
from pathlib import Path
from PIL import Image

src = Path('src/renderer/icon-original.png')
dst = Path('src/renderer/icon.png')
im = Image.open(src).convert('RGBA')
pixels = im.load()
w, h = im.size

# Remove only the near-white region connected to the image boundary. This keeps
# white highlights enclosed by the actual logo intact.
transparent = set()
queue = deque()
for x in range(w):
    queue.extend(((x, 0), (x, h - 1)))
for y in range(h):
    queue.extend(((0, y), (w - 1, y)))

while queue:
    x, y = queue.popleft()
    if (x, y) in transparent or not (0 <= x < w and 0 <= y < h):
        continue
    r, g, b, a = pixels[x, y]
    # The source uses an off-white solid backdrop. Only flood through pixels
    # sufficiently close to it, so the colored logo remains untouched.
    if a == 0 or (r >= 238 and g >= 238 and b >= 238 and max(r, g, b) - min(r, g, b) <= 8):
        transparent.add((x, y))
        queue.extend(((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)))

for x, y in transparent:
    r, g, b, _ = pixels[x, y]
    pixels[x, y] = (r, g, b, 0)

# Crop transparent margins and add a small breathing room around the mark.
box = im.getbbox()
if box:
    im = im.crop(box)
    pad = max(2, round(max(im.size) * 0.08))
    canvas = Image.new('RGBA', (im.width + pad * 2, im.height + pad * 2), (0, 0, 0, 0))
    canvas.alpha_composite(im, (pad, pad))
    im = canvas

im.save(dst)
print(f'Saved {dst}: {im.size}; transparent pixels: {len(transparent)}')
