"""Genera el branding de Hanni: banner, avatar y mascota (PNG) con PIL.

Estética: Y2K / revista de los 2000, rosa pastel → lila, acento denim, conejito sticker y
el nombre en Rysana Mono (la fuente del propio harness). Nada de fuentes ni assets externos.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "packages/coding-agent/src/modes/interactive/assets/fonts/rysana/ttf"
OUT = ROOT / "docs/images"
OUT.mkdir(parents=True, exist_ok=True)

PINK = (255, 158, 200)
PINK_DEEP = (255, 111, 174)
PINK_SOFT = (255, 217, 236)
CREAM = (255, 247, 251)
LILAC = (217, 176, 255)
LILAC_DEEP = (166, 122, 220)
DENIM = (143, 180, 255)
INK = (94, 59, 82)

SS = 2  # supersampling


def gradient(size: tuple[int, int], a: tuple[int, int, int], b: tuple[int, int, int], c: tuple[int, int, int]) -> Image.Image:
    """Gradiente diagonal suave a partir de una imagen 3x3 reescalada."""
    mid = tuple((x + y + z) // 3 for x, y, z in zip(a, b, c))
    small = Image.new("RGB", (3, 3), mid)
    small.putpixel((0, 0), a)
    small.putpixel((2, 0), b)
    small.putpixel((0, 2), b)
    small.putpixel((2, 2), c)
    return small.resize(size, Image.BICUBIC)


def rounded_mask(size: tuple[int, int], radius: int) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return mask


def sparkle(draw: ImageDraw.ImageDraw, cx: float, cy: float, r: float, fill: tuple[int, int, int]) -> None:
    """Destello de cuatro puntas (✦) dibujado como polígono cóncavo."""
    w = r * 0.30
    points = [
        (cx, cy - r),
        (cx + w, cy - w),
        (cx + r, cy),
        (cx + w, cy + w),
        (cx, cy + r),
        (cx - w, cy + w),
        (cx - r, cy),
        (cx - w, cy - w),
    ]
    draw.polygon(points, fill=fill)


def bunny(size: int) -> Image.Image:
    """Conejito sticker sobre fondo transparente, con un lazo denim."""
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 100.0  # unidad: 100x100 de rejilla

    def r(*vals: float) -> tuple[float, ...]:
        return tuple(v * u for v in vals)

    # orejas (cápsulas), con el interior rosa
    for cx, tilt in ((37.0, -7), (63.0, 7)):
        d.rounded_rectangle(r(cx - 7.5 + tilt, 3, cx + 7.5 + tilt, 48), radius=7.5 * u, fill=CREAM, outline=PINK, width=int(2.4 * u))
        d.rounded_rectangle(r(cx - 3.2 + tilt, 10, cx + 3.2 + tilt, 41), radius=3.2 * u, fill=PINK_SOFT)

    # cabeza
    d.rounded_rectangle(r(16, 34, 84, 92), radius=27 * u, fill=CREAM, outline=PINK, width=int(2.8 * u))

    # lazo denim sobre la oreja derecha (detalle Y2K)
    d.polygon([r(71, 25), r(61, 19.5), r(62.5, 30.5)], fill=DENIM)
    d.polygon([r(71, 25), r(81, 19.5), r(79.5, 30.5)], fill=DENIM)
    d.ellipse(r(67, 20.8, 75, 29.2), fill=DENIM, outline=(90, 130, 210), width=int(1.1 * u))

    # mejillas
    for cx in (30.0, 70.0):
        d.ellipse(r(cx - 7.5, 60, cx + 7.5, 68), fill=(255, 205, 228))

    # ojos y boca
    for cx in (38.0, 62.0):
        d.ellipse(r(cx - 4.4, 47, cx + 4.4, 56.4), fill=INK)
        d.ellipse(r(cx - 1.8, 48.4, cx + 0.8, 51.4), fill=(255, 255, 255))
    d.arc(r(45.5, 59, 54.5, 68), start=20, end=160, fill=INK, width=int(2.0 * u))

    return img.resize((size, size), Image.LANCZOS)


def letterspaced(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, font, fill, spacing: float, stroke: int = 0, stroke_fill=None) -> float:
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill, stroke_width=stroke, stroke_fill=stroke_fill)
        x += draw.textlength(ch, font=font) + spacing
    return x


def banner() -> None:
    w, h = 1600 * SS, 520 * SS
    base = gradient((w, h), (255, 236, 245), (255, 214, 236), (227, 214, 255))
    card = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    card.paste(base, (0, 0), rounded_mask((w, h), 72 * SS))
    d = ImageDraw.Draw(card)

    # marco interior translúcido
    d.rounded_rectangle((26 * SS, 26 * SS, w - 26 * SS, h - 26 * SS), radius=54 * SS, outline=(255, 255, 255, 150), width=int(3 * SS))

    # destellos
    for cx, cy, r, color in (
        (150, 110, 26, DENIM),
        (1430, 140, 34, LILAC_DEEP),
        (1340, 430, 18, DENIM),
        (250, 420, 15, LILAC_DEEP),
    ):
        sparkle(d, cx * SS, cy * SS, r * SS, color + (255,))

    # conejito
    mascot = bunny(330 * SS)
    card.alpha_composite(mascot, (140 * SS, 95 * SS))

    # wordmark
    bold = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Bold.ttf"), 210 * SS)
    letterspaced(d, (500 * SS, 128 * SS), "hanni", bold, PINK_DEEP + (255,), spacing=14 * SS, stroke=int(7 * SS), stroke_fill=(255, 255, 255, 235))

    # tagline
    small = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Regular.ttf"), 46 * SS)
    letterspaced(d, (505 * SS, 372 * SS), "memory · sodd · autonomy", small, LILAC_DEEP + (255,), spacing=4 * SS)

    card.resize((1600, 520), Image.LANCZOS).save(OUT / "hannibanner.png", optimize=True)


def avatar() -> None:
    size = 1024
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = gradient((s, s), (255, 222, 240), (255, 190, 222), (226, 205, 255))
    circle = Image.new("L", (s, s), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, s - 1, s - 1), fill=255)
    img.paste(bg, (0, 0), circle)
    d = ImageDraw.Draw(img)
    d.ellipse((28 * SS, 28 * SS, s - 28 * SS, s - 28 * SS), outline=LILAC_DEEP + (255,), width=int(9 * SS))
    mascot = bunny(700 * SS)
    img.alpha_composite(mascot, ((s - 700 * SS) // 2, 150 * SS))
    img.resize((size, size), Image.LANCZOS).save(OUT / "hanni-avatar.png", optimize=True)


def mascot() -> None:
    bunny(512).save(OUT / "hanni-mascot.png", optimize=True)


if __name__ == "__main__":
    banner()
    avatar()
    mascot()
    for path in sorted(OUT.glob("*.png")):
        print(path.name, path.stat().st_size, "bytes")
