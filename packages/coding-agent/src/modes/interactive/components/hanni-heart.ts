import { type Component, foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

/**
 * Escena ASCII de arranque de la TUI (SPEC-008 B): el corazón con orejas de Hanni, la «mascota»
 * de la casa. Es decoración de arranque, no del protocolo: sólo `interactive-mode` la monta.
 *
 * - Se pinta una sola vez, al montar la TUI, encima de la cabecera; desaparece al primer mensaje.
 * - Colores de marca fijos (`#FF7AB0` contorno y orejas, `#FFC9E0` corazones de los ojos), igual
 *   que el wordmark: no siguen al tema. Sin color en el terminal (`NO_COLOR`, `TERM=dumb`) se
 *   degrada a mono.
 * - Terminal estrecho (< 60 columnas): variante de una línea, para no partir el dibujo.
 * - Determinista y sin animación: el arranque no espera a nada y los tests pueden comparar bytes.
 */

const BRAND_PINK = rgbColor(255, 122, 176);
const BRAND_SOFT_PINK = rgbColor(255, 201, 224);
const RESET = "\x1b[0m";

/** Por debajo de este ancho se usa la variante de una línea (el arte grande mide 35 columnas). */
export const STARTUP_ART_MIN_COLUMNS = 60;

type Tone = "outline" | "heart";

interface ArtSegment {
	text: string;
	tone: Tone;
}

/**
 * Arte principal, seis líneas: el dibujo de la spec (orejas, ojos de corazón, boca y contorno) más
 * la leyenda de la mascota en su propia línea — así el bloque entero cabe en 35 columnas en vez de
 * las 52 que ocupaba con la leyenda pegada al ojo derecho, y sigue siendo el mismo dibujo.
 */
const HANNI_HEART_SEGMENTS: readonly (readonly ArtSegment[])[] = [
	[{ text: "      /\\          /\\", tone: "outline" }],
	[
		{ text: "     /  \\________/  \\        hanni", tone: "outline" },
		{ text: "♥", tone: "heart" },
	],
	[
		{ text: "    (   ", tone: "outline" },
		{ text: "♥", tone: "heart" },
		{ text: "        ", tone: "outline" },
		{ text: "♥", tone: "heart" },
		{ text: "   )", tone: "outline" },
	],
	[{ text: "     \\      ‿‿      /", tone: "outline" }],
	[{ text: "      \\____________/", tone: "outline" }],
	[{ text: "      conejita de una línea", tone: "heart" }],
];

/** Las seis líneas del arte, sin colores: la referencia que comparan los tests. */
export const HANNI_HEART_ART: readonly string[] = HANNI_HEART_SEGMENTS.map((line) =>
	line.map((segment) => segment.text).join(""),
);

/** Variante de una línea para terminales estrechos. */
const HANNI_HEART_NARROW_SEGMENTS: readonly ArtSegment[] = [
	{ text: "( \\_/ )  hanni", tone: "outline" },
	{ text: "♥", tone: "heart" },
	{ text: "  (\\_/)", tone: "outline" },
];

export const HANNI_HEART_NARROW: string = HANNI_HEART_NARROW_SEGMENTS.map((segment) => segment.text).join("");

/** ¿El terminal soporta color? `NO_COLOR` y `TERM=dumb` piden mono explícitamente. */
export function startupArtSupportsColor(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	return env.TERM !== "dumb";
}

function paintSegments(segments: readonly ArtSegment[], color: boolean): string {
	if (!color) return segments.map((segment) => segment.text).join("");
	const mode = theme.getColorMode();
	return segments
		.map((segment) => {
			const ansi = foregroundAnsi(segment.tone === "heart" ? BRAND_SOFT_PINK : BRAND_PINK, mode);
			return `${ansi}${segment.text}${RESET}`;
		})
		.join("");
}

/** Líneas de la escena de arranque: arte de seis líneas o la variante de una línea si no cabe. */
export function hanniHeartLines(width: number, color = true): string[] {
	if (width < STARTUP_ART_MIN_COLUMNS) return [paintSegments(HANNI_HEART_NARROW_SEGMENTS, color)];
	return HANNI_HEART_SEGMENTS.map((segments) => paintSegments(segments, color));
}

/**
 * Componente de la escena de arranque. `enabled: false` renderiza cero líneas (lo pide
 * `display.startupArt: false`); `color: false` fuerza mono.
 */
export class HanniHeartComponent implements Component {
	private readonly enabled: boolean;
	private readonly color: boolean;

	constructor(options: { enabled?: boolean; color?: boolean } = {}) {
		this.enabled = options.enabled !== false;
		this.color = options.color ?? startupArtSupportsColor();
	}

	render(width: number): string[] {
		if (!this.enabled) return [];
		return hanniHeartLines(width, this.color);
	}

	invalidate(): void {
		// Dibujo estático: no hay nada cacheado que invalidar.
	}
}
