#!/usr/bin/env python3
"""Generate Pearl Wallet PWA icons: deep-sapphire vault identity.

Draws a rounded-square icon with a sapphire gradient, an iridescent ring,
and a silver vault-"P" / pearl emblem. Outputs 180/192/512 + apple-touch-icon.
"""
from PIL import Image, ImageDraw, ImageFont
import math, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = HERE

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m

def draw_icon(size):
    # background: deep sapphire vertical gradient
    top = (16, 30, 58)
    bottom = (5, 10, 24)
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        c = lerp(top, bottom, y / max(size - 1, 1))
        for x in range(size):
            px[x, y] = c
    d = ImageDraw.Draw(img, "RGBA")
    cx = cy = size / 2

    # iridescent ring: segmented arc ring with blue -> violet -> teal sweep
    ring_r = size * 0.36
    ring_w = max(size * 0.035, 4)
    palette = [(79, 124, 255), (139, 92, 246), (45, 212, 191), (79, 124, 255)]
    segs = 72
    for i in range(segs):
        a0 = 360 * i / segs
        a1 = 360 * (i + 1.2) / segs
        t = i / segs * (len(palette) - 1)
        k = int(t)
        f = t - k
        col = lerp(palette[k], palette[k + 1], f)
        d.arc([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r],
              start=a0 - 90, end=a1 - 90, fill=col + (255,), width=int(ring_w))

    # pearl: radial silver orb in the center
    pr = size * 0.20
    for r in range(int(pr), 0, -1):
        t = r / pr
        # highlight toward upper-left
        c = lerp((240, 244, 250), (150, 165, 190), t * 0.85)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=c)
    # shine spot
    sr = pr * 0.38
    sx, sy = cx - pr * 0.32, cy - pr * 0.36
    d.ellipse([sx - sr, sy - sr, sx + sr, sy + sr], fill=(255, 255, 255, 200))
    # vault "P" cut: draw a bold P in deep sapphire over the pearl
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                                  int(size * 0.30))
    except Exception:
        font = ImageFont.load_default()
    txt = "P"
    bbox = d.textbbox((0, 0), txt, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    d.text((cx - tw / 2 - bbox[0], cy - th / 2 - bbox[1]), txt,
           font=font, fill=(10, 20, 40, 255))

    # rounded corners
    img.putalpha(rounded_mask(size, int(size * 0.225)))
    return img

for size, name in [(180, "icon-180.png"), (192, "icon-192.png"),
                   (512, "icon-512.png")]:
    draw_icon(size).save(os.path.join(OUT, name))
    print("wrote", name)
# apple-touch-icon: same art at 180 (iOS ignores alpha; flatten on bg color)
icon = draw_icon(180).convert("RGB")
icon.save(os.path.join(OUT, "apple-touch-icon.png"))
print("wrote apple-touch-icon.png")
# maskable: full-bleed version (no rounded alpha) for Android adaptive icons
full = draw_icon(512).convert("RGB")
full.save(os.path.join(OUT, "icon-maskable-512.png"))
print("wrote icon-maskable-512.png")
