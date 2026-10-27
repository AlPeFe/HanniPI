"""Genera el branding de Hanni: mascota, banner y avatar (PNG) con PIL.

Estilo: sticker kawaii de línea gruesa y relleno plano (crema y rosa), con la nariz y la
barriga en forma de corazón, y el nombre `hanni` al lado. Todo en rosa. Sin fuentes ni
assets externos: la tipografía es la Rysana Mono del propio harness y el dibujo son formas.

Uso: python scripts/generate-brand.py
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "packages/coding-agent/src/modes/interactive/assets/fonts/rysana/ttf"
OUT = ROOT / "docs/images"

OUTLINE = (74, 58, 68)  # plum oscuro de la línea
CREAM = (255, 249, 244)
PINK = (255, 194, 222)
PINK_SOFT = (255, 224, 238)
PINK_DEEP = (255, 122, 176)
BG_SOFT = (255, 236, 246)

SS = 2  # supersampling


def gradient(size: tuple[int, int], a: tuple[int, int, int], b: tuple[int, int, int]) -> Image.Image:
    """Gradiente vertical suave entre dos rosas (imagen 1x2 reescalada)."""
    small = Image.new("RGB", (1, 2))
    small.putpixel((0, 0), a)
    small.putpixel((0, 1), b)
    return small.resize(size, Image.BICUBIC)


def heart(draw: ImageDraw.ImageDraw, cx: float, cy: float, size: float, fill) -> None:
    """Corazón de cuatro lóbulos, centrado en (cx, cy)."""
    r = size / 2
    draw.ellipse((cx - r, cy - r * 0.9, cx, cy + r * 0.1), fill=fill)
    draw.ellipse((cx, cy - r * 0.9, cx + r, cy + r * 0.1), fill=fill)
    draw.polygon([(cx - r, cy - r * 0.15), (cx + r, cy - r * 0.15), (cx, cy + r)], fill=fill)


def mascot(height: int) -> Image.Image:
    """La mascota entera: cabeza redonda con orejas, nariz de corazón, cuerpo con corazón."""
    s = height * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = s / 100.0
    line = max(2, int(2.6 * u))

    def px(*values: float) -> tuple[float, ...]:
        return tuple(v * u for v in values)

    # bracitos y pies (detrás del cuerpo)
    for x0 in (25.0, 67.0):
        d.ellipse(px(x0, 74, x0 + 9, 84), fill=CREAM, outline=OUTLINE, width=line)
    for x0 in (39.0, 53.0):
        d.ellipse(px(x0, 92, x0 + 8, 100), fill=CREAM, outline=OUTLINE, width=line)

    # cuerpo (huevo) con parche de barriga
    d.ellipse(px(33, 58, 67, 98), fill=CREAM, outline=OUTLINE, width=line)
    d.ellipse(px(39, 74, 61, 94), fill=PINK, outline=OUTLINE, width=max(2, int(1.6 * u)))
    heart(d, 50 * u, 85 * u, 9 * u, PINK_DEEP)

    # orejas (cápsulas) con interior rosa
    for cx, tilt in ((36.0, -5), (64.0, 5)):
        d.rounded_rectangle(px(cx - 8 + tilt, 2, cx + 8 + tilt, 44), radius=8 * u, fill=CREAM, outline=OUTLINE, width=line)
        d.rounded_rectangle(px(cx - 3.6 + tilt, 8, cx + 3.6 + tilt, 36), radius=3.6 * u, fill=PINK_SOFT)

    # cabeza
    d.rounded_rectangle(px(15, 26, 85, 72), radius=25 * u, fill=CREAM, outline=OUTLINE, width=line)

    # mejillas
    for cx in (28.0, 72.0):
        d.ellipse(px(cx - 7, 54, cx + 7, 62), fill=PINK)

    # ojos
    for cx in (38.0, 62.0):
        d.ellipse(px(cx - 3.4, 42, cx + 3.4, 49.4), fill=OUTLINE)
        d.ellipse(px(cx - 1.5, 43.2, cx + 0.2, 45.3), fill=(255, 255, 255))

    # nariz de corazón
    heart(d, 50 * u, 53 * u, 7 * u, PINK_DEEP)

    return img.resize((height, height), Image.LANCZOS)


def letterspaced(draw: ImageDraw.ImageDraw, xy: tuple[float, float], text: str, font, fill, spacing: float) -> None:
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + spacing


def banner() -> None:
    w, h = 1600, 520
    img = gradient((w * SS, h * SS), BG_SOFT, (255, 214, 236)).convert("RGBA")
    mask = Image.new("L", (w * SS, h * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * SS - 1, h * SS - 1), radius=64 * SS, fill=255)
    img.putalpha(mask)
    d = ImageDraw.Draw(img)

    # marco interior
    d.rounded_rectangle(
        (24 * SS, 24 * SS, (w - 24) * SS, (h - 24) * SS),
        radius=48 * SS,
        outline=OUTLINE + (60,),
        width=int(2 * SS),
    )

    # mascota
    art = mascot(430 * SS)
    img.alpha_composite(art, (90 * SS, 40 * SS))

    # nombre y tagline
    bold = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Bold.ttf"), 220 * SS)
    letterspaced(d, (600 * SS, 110 * SS), "hanni", bold, OUTLINE + (255,), spacing=12 * SS)

    small = ImageFont.truetype(str(FONT_DIR / "RysanaMono-Regular.ttf"), 44 * SS)
    letterspaced(d, (606 * SS, 388 * SS), "memory · sodd · autonomy", small, PINK_DEEP + (255,), spacing=4 * SS)

    img.resize((w, h), Image.LANCZOS).save(OUT / "hannibanner.png", optimize=True)


def avatar() -> None:
    size = 1024
    s = size * SS
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    bg = gradient((s, s), (255, 226, 242), (255, 198, 229))
    circle = Image.new("L", (s, s), 0)
    ImageDraw.Draw(circle).ellipse((0, 0, s - 1, s - 1), fill=255)
    img.paste(bg, (0, 0), circle)
    d = ImageDraw.Draw(img)
    d.ellipse((26 * SS, 26 * SS, s - 26 * SS, s - 26 * SS), outline=OUTLINE + (255,), width=int(7 * SS))
    art = mascot(720 * SS)
    img.alpha_composite(art, ((s - 720 * SS) // 2, 150 * SS))
    img.resize((size, size), Image.LANCZOS).save(OUT / "hanni-avatar.png", optimize=True)


def mascot_file() -> None:
    mascot(512).save(OUT / "hanni-mascot.png", optimize=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    banner()
    avatar()
    mascot_file()
    for path in sorted(OUT.glob("*.png")):
        print(path.name, path.stat().st_size, "bytes")
