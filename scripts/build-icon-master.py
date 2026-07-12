#!/usr/bin/env python3
"""Create the deterministic macOS-safe FlowZ icon master from generated artwork."""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter


SIZE = 1024
SAFE_MARGIN = 70
SUPERELLIPSE_POWER = 5.0


def superellipse_mask(size: int, margin: int, power: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    pixels = mask.load()
    radius = (size - margin * 2) / 2
    center = (size - 1) / 2
    feather = 2.25
    for y in range(size):
        ny = abs((y - center) / radius)
        for x in range(size):
            nx = abs((x - center) / radius)
            distance = nx**power + ny**power
            if distance <= 1:
                alpha = 255
            elif distance <= 1 + feather / radius:
                alpha = max(0, round(255 * (1 - (distance - 1) * radius / feather)))
            else:
                alpha = 0
            pixels[x, y] = alpha
    return mask


def fit_square(source: Image.Image, size: int) -> Image.Image:
    source = source.convert("RGB")
    edge = min(source.size)
    left = (source.width - edge) // 2
    top = (source.height - edge) // 2
    return source.crop((left, top, left + edge, top + edge)).resize((size, size), Image.Resampling.LANCZOS)


def build(source_path: Path, output_path: Path) -> None:
    artwork = fit_square(Image.open(source_path), SIZE)
    mask = superellipse_mask(SIZE, SAFE_MARGIN, SUPERELLIPSE_POWER)

    inner = SIZE - SAFE_MARGIN * 2
    inset_art = artwork.resize((inner, inner), Image.Resampling.LANCZOS)
    icon_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    icon_layer.alpha_composite(inset_art.convert("RGBA"), (SAFE_MARGIN, SAFE_MARGIN))
    icon_layer.putalpha(ImageChops.multiply(icon_layer.getchannel("A"), mask))

    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow = mask.filter(ImageFilter.GaussianBlur(18))
    shadow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    shadow_layer.putalpha(shadow.point(lambda value: round(value * 0.38)))
    canvas.alpha_composite(shadow_layer, (0, 12))
    canvas.alpha_composite(icon_layer)

    edge = ImageChops.subtract(mask, mask.filter(ImageFilter.GaussianBlur(3)))
    outline = Image.new("RGBA", (SIZE, SIZE), (255, 255, 255, 0))
    outline.putalpha(edge.point(lambda value: round(value * 0.18)))
    canvas.alpha_composite(outline)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output_path, "PNG", optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: build-icon-master.py SOURCE OUTPUT")
    build(Path(sys.argv[1]), Path(sys.argv[2]))
