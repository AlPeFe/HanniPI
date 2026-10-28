"""Genera el logo de Hanni: un dibujo de una sola línea (SVG) y su versión PNG.

Sin fondos: el mark es transparente. Un único trazo cierra la silueta (orejas y cara) y
sólo se añaden los detalles mínimos: la línea interior de cada oreja, dos ojos y la nariz
de corazón. Estética simple, línea fina, rosa.

Uso: python scripts/generate-brand.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs/images"
PINK = (255, 122, 176)
PINK_HEX = "#FF7AB0"
STROKE = 11
INNER_STROKE = 7

# Un solo trazo cerrado: oreja izquierda (exterior, punta, interior), alto de la cabeza,
# oreja derecha (interior, punta, exterior), lado derecho, mandíbula y lado izquierdo.
OUTLINE = [
    ("M", (130, 252)),
    ("C", (120, 200), (128, 130), (150, 78)),
    ("C", (154, 60), (176, 60), (180, 78)),
    ("C", (190, 130), (196, 200), (200, 252)),
    ("C", (238, 226), (274, 226), (312, 252)),
    ("C", (316, 200), (322, 130), (332, 78)),
    ("C", (336, 60), (358, 60), (362, 78)),
    ("C", (384, 130), (392, 200), (382, 252)),
    ("C", (418, 274), (432, 318), (426, 364)),
    ("C", (420, 420), (348, 452), (256, 452)),
    ("C", (164, 452), (92, 420), (86, 364)),
    ("C", (80, 318), (94, 274), (130, 252)),
    ("Z",),
]

# Detalle interior de cada oreja.
INNER_EARS = [
    [("M", (160, 232)), ("C", (156, 190), (160, 140), (166, 104))],
    [("M", (352, 232)), ("C", (356, 190), (352, 140), (346, 104))],
]

EYES = [(210.0, 336.0, 10.0), (302.0, 336.0, 10.0)]
NOSE = (256.0, 382.0, 32.0)


def sample(nodes, steps: int = 32) -> list[list[tuple[float, float]]]:
    """Convierte los nodos en polilíneas (para el raster)."""
    lines: list[list[tuple[float, float]]] = []
    current: list[tuple[float, float]] = []
    cursor = (0.0, 0.0)
    for node in nodes:
        kind = node[0]
        if kind == "M":
            if len(current) > 1:
                lines.append(current)
            cursor = node[1]
            current = [cursor]
        elif kind == "C":
            c1, c2, end = node[1], node[2], node[3]
            for i in range(1, steps + 1):
                t = i / steps
                mt = 1 - t
                x = mt**3 * cursor[0] + 3 * mt**2 * t * c1[0] + 3 * mt * t**2 * c2[0] + t**3 * end[0]
                y = mt**3 * cursor[1] + 3 * mt**2 * t * c1[1] + 3 * mt * t**2 * c2[1] + t**3 * end[1]
                current.append((x, y))
            cursor = end
        else:
            current.append(current[0])
    if len(current) > 1:
        lines.append(current)
    return lines


def heart_shapes(cx: float, cy: float, size: float) -> tuple[list[tuple[float, float, float]], list[tuple[float, float]]]:
    """Corazón como dos lóbulos + triángulo: la misma geometría en SVG y en el raster."""
    r = size / 2
    lobes = [(cx - r / 2, cy - r * 0.2, r / 2), (cx + r / 2, cy - r * 0.2, r / 2)]
    triangle = [(cx - r, cy - r * 0.15), (cx + r, cy - r * 0.15), (cx, cy + r)]
    return lobes, triangle


def render(size: int = 1024) -> Image.Image:
    ss = 2
    s = size * ss
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = s / 512

    def stroke(nodes, width: float) -> None:
        w = max(1, int(width * k))
        for line in sample(nodes):
            pts = [(x * k, y * k) for x, y in line]
            d.line(pts, fill=PINK + (255,), width=w, joint="curve")
            for x, y in (pts[0], pts[-1]):
                d.ellipse((x - w / 2, y - w / 2, x + w / 2, y + w / 2), fill=PINK + (255,))

    stroke(OUTLINE, STROKE)
    for ear in INNER_EARS:
        stroke(ear, INNER_STROKE)

    for cx, cy, r in EYES:
        d.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), fill=PINK + (255,))

    lobes, triangle = heart_shapes(*NOSE)
    for cx, cy, r in lobes:
        d.ellipse(((cx - r) * k, (cy - r) * k, (cx + r) * k, (cy + r) * k), fill=PINK + (255,))
    d.polygon([(x * k, y * k) for x, y in triangle], fill=PINK + (255,))

    return img.resize((size, size), Image.LANCZOS)


def svg_path(nodes) -> str:
    parts: list[str] = []
    for node in nodes:
        if node[0] == "M":
            parts.append(f"M{node[1][0]} {node[1][1]}")
        elif node[0] == "C":
            c1, c2, end = node[1], node[2], node[3]
            parts.append(f"C{c1[0]} {c1[1]} {c2[0]} {c2[1]} {end[0]} {end[1]}")
        else:
            parts.append("Z")
    return " ".join(parts)


def svg() -> str:
    strokes = f'<path d="{svg_path(OUTLINE)}" stroke-width="{STROKE}"/>'
    strokes += "".join(f'<path d="{svg_path(ear)}" stroke-width="{INNER_STROKE}"/>' for ear in INNER_EARS)
    eyes = "".join(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{PINK_HEX}" stroke="none"/>' for cx, cy, r in EYES)
    lobes, triangle = heart_shapes(*NOSE)
    nose = "".join(
        f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="{PINK_HEX}" stroke="none"/>' for cx, cy, r in lobes
    )
    nose += f'<polygon points="{" ".join(f"{x},{y}" for x, y in triangle)}" fill="{PINK_HEX}" stroke="none"/>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" '
        'aria-label="Hanni">'
        f'<g fill="none" stroke="{PINK_HEX}" stroke-linecap="round" stroke-linejoin="round">{strokes}</g>'
        f"{eyes}{nose}</svg>"
    )


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "hanni-logo.svg").write_text(svg() + "\n", encoding="utf-8")
    render(1024).save(OUT / "hanni-logo.png", optimize=True)
    for path in sorted(OUT.glob("hanni-logo.*")):
        print(path.name, path.stat().st_size, "bytes")
