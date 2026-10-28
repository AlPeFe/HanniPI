"""Genera el branding de Hanni: banner, avatar, mascota y patrón (PNG) con PIL.

Estilo: ilustración mínima de línea fina, estética coreana/Y2K, rosa pastel y patrón de
motivos pequeños. Sin texto coreano ni caras: solo el personaje y el nombre `hanni`.

Uso: python scripts/generate-brand.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "packages/coding-agent/src/modes/interactive/assets/fonts/rysana/ttf"
OUT = ROOT / "docs/images"

INK = (74, 58, 68)  # línea fina
CREAM = (255, 251, 253)
PINK = (255, 201, 224)  # relleno suave / patrón
PINK_DEEP = (255, 122, 176)  # acentos (nariz, tagline)
BG = (255, 248, 252)

SS = 2


def heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, fill) -> None:
    r = size / 2
    draw.ellipse((cx - r, cy - r * 0.9, cx, cy + r * 0.1), fill=fill)
    draw.ellipse((cx, cy - r * 0.9, cx + r, cy + r * 0.1), fill=fill)
    draw.polygon([(cx - r, cy - r * 0.15), (cx + r, cy - r * 0.15), (cx, cy + r)], fill=fill)


def sparkle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill) -> None:
    w = r * 0.28
    draw.polygon(
        [
            (cx, cy - r),
            (cx + w, cy - w),
            (cx + r, cy),
            (cx + w, cy + w),
            (cx, cy + r),
            (cx - w, cy + w),
            (cx - r, cy),
            (cx - w, cy - w),
        ],
        fill=fill,
    )


def bunny(size: int, line: float = 2.2) -> Image.Image:
    """Cabeza de Hanni: orejas largas, ojos redondos, mejillas y nariz de corazón."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 100.0
    w = max(2, int(line * u))

    def px(*values: float) -> tuple[float, ...]:
        return tuple(v * u for v in values)

    # orejas
    for cx, tilt in ((36.0, -4), (64.0, 4)):
        d.rounded_rectangle(px(cx - 7.5 + tilt, 5, cx + 7.5 + tilt, 46), radius=7.5 * u, fill=CREAM, outline=INK, width=w)

    # cabeza
    d.rounded_rectangle(px(18, 30, 82, 84), radius=27 * u, fill=CREAM, outline=INK, width=w)

    # mejillas
    for x0 in (25.0, 63.0):
        d.ellipse(px(x0, 62, x0 + 12, 69), fill=PINK)

    # ojos
    for cx in (39.0, 61.0):
        d.ellipse(px(cx - 2.8, 52, cx + 2.8, 57.6), fill=INK)

    # nariz de corazón
    heart(d, 50 * u, 64 * u, 6.5 * u, PINK_DEEP)

    return img.resize((size, size), Image.LANCZOS)


def pattern(width: int, height: int, step: float, color, alpha: int = 255) -> Image.Image:
    """Patrón de motivos pequeños (corazón, punto, destello, flor) en una rejilla alterna."""
    tile = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(tile)
    fill = color + (alpha,)
    rows = int(height / step) + 2
    cols = int(width / step) + 2
    i = 0
    for gy in range(rows):
        for gx in range(cols):
            cx = (gx + 0.5 + (0.28 if gy % 2 else 0)) * step
            cy = (gy + 0.4) * step
            kind = i % 5
            if kind == 0:
                heart(d, cx, cy, step * 0.3, fill)
            elif kind == 1:
                d.ellipse((cx - step * 0.06, cy - step * 0.06, cx + step * 0.06, cy + step * 0.06), fill=fill)
            elif kind == 2:
                sparkle(d, cx, cy, step * 0.17, fill)
            elif kind == 3:
                for k in range(5):
                    a = -math.pi / 2 + k * 2 * math.pi / 5
                    px, py = cx + math.cos(a) * step * 0.1, cy + math.sin(a) * step * 0.1
                    d.ellipse((px - step * 0.05, py - step * 0.05, px + step * 0.05, py + step * 0.05), fill=fill)
            else:
                d.ellipse(
                    (cx - step * 0.08, cy - step * 0.08, cx + step * 0.08, cy + step * 0.08),
                    outline=fill,
                    width=max(1, int(step * 0.025)),
                )
            i += 1
    return tile


def letterspaced(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, font, fill, spacing: float) -> None:
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing


def banner() -> None:
    w, h = 1600, 520
    img = Image.new("RGBA", (w * SS, h * SS), BG + (255,))
    img.alpha_composite(pattern(w * SS, h * SS, 160 * SS, PINK, 80))
    d = ImageDraw.Draw(img)

    art = bunny(340 * SS)
    img.alpha_composite(art, (150 * SS, 90 * SS))

    light = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Regular.ttf"), 190 * SS)
    letterspaced(d, (610 * SS, 150 * SS), "hanni", light, INK + (255,), spacing=12 * SS)

    small = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Regular.ttf"), 40 * SS)
    letterspaced(d, (616 * SS, 380 * SS), "memory · sodd · autonomy", small, PINK_DEEP + (255,), spacing=5 * SS)

    img.resize((w, h), Image.LANCZOS).save(OUT / "hannibanner.png", optimize=True)


def avatar() -> None:
    size = 1024
    s = size * SS
    img = Image.new("RGBA", (s, s), PINK + (255,))
    img.alpha_composite(pattern(s, s, 170 * SS, (255, 255, 255), 130))
    art = bunny(640 * SS)
    img.alpha_composite(art, ((s - 640 * SS) // 2, (s - 640 * SS) // 2))
    img.resize((size, size), Image.LANCZOS).save(OUT / "hanni-avatar.png", optimize=True)


def mascot_file() -> None:
    bunny(512).save(OUT / "hanni-mascot.png", optimize=True)


def pattern_file() -> None:
    pattern(800, 800, 110, PINK_DEEP, 255).save(OUT / "hanni-pattern.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    banner()
    avatar()
    mascot_file()
    pattern_file()
    for path in sorted(OUT.glob("*.png")):
        print(path.name, path.stat().st_size, "bytes")
