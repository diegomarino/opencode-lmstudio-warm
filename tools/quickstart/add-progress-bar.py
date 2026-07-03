#!/usr/bin/env python3
"""Overlay a playback progress bar along the bottom edge of the demo GIF.

agg has no built-in progress indicator, so this post-processes its output:
a 4 px track drawn across the bottom of every frame, filled proportionally
to elapsed time (per-frame GIF durations). Keeps the animation from looking
frozen during the deliberate cold-load pause.

Usage:  python3 tools/quickstart/add-progress-bar.py docs/quickstart.gif [output.gif]

Re-quantizing per frame breaks GIF inter-frame compression; recover it with
`gifsicle -O3 --colors 256 --batch <gif>` afterwards (~700K → ~400K).
"""

import sys

from PIL import Image, ImageDraw, ImageSequence

TRACK = (40, 45, 56)   # slightly lighter than the asciinema theme background
FILL = (78, 201, 176)  # teal accent, matches the prompt/table greens
BAR_H = 4

src = sys.argv[1] if len(sys.argv) > 1 else "docs/quickstart.gif"
dst = sys.argv[2] if len(sys.argv) > 2 else src

im = Image.open(src)
durations = [f.info.get("duration", 0) for f in ImageSequence.Iterator(im)]
total = sum(durations) or 1

frames = []
elapsed = 0
im.seek(0)
for frame, d in zip(ImageSequence.Iterator(im), durations):
    rgb = frame.convert("RGB")
    w, h = rgb.size
    draw = ImageDraw.Draw(rgb)
    draw.rectangle([0, h - BAR_H, w, h], fill=TRACK)
    elapsed += d
    draw.rectangle([0, h - BAR_H, int(w * elapsed / total), h], fill=FILL)
    frames.append(rgb)

frames[0].save(
    dst,
    save_all=True,
    append_images=frames[1:],
    duration=durations,
    loop=0,
    optimize=True,
)
print(f"wrote {dst} ({len(frames)} frames, {total / 1000:.1f}s)")
