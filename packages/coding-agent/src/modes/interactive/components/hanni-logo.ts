import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Paleta de marca de Hanni: rosa pastel con degradado a lila y un acento denim. Los colores
// de marca no siguen al tema (son la identidad), solo el modo de color del terminal.
const SPARK_BLUE = rgbColor(143, 180, 255); // destellos y el acento denim
const WORDMARK_PINK = rgbColor(255, 111, 174); // el nombre, más saturado
const ART_COLORS = [
	rgbColor(255, 217, 236), // orejas
	rgbColor(255, 194, 222),
	rgbColor(255, 168, 210), // frente
	rgbColor(255, 158, 200), // cara
	rgbColor(231, 166, 242),
	rgbColor(217, 176, 255), // barbilla, ya lila
] as const;
const RESET = "\x1b[0m";

type RGB = ReturnType<typeof rgbColor>;

/**
 * El conejito de Hanni en pixel-art de bloques (sticker Y2K: rosa pastel, lila y un toque
 * denim) con el nombre en minúsculas espaciadas debajo. El arte es un bloque centrado: todas
 * las filas miden lo mismo, así el header lo pinta tal cual venga.
 *
 *   ✦              ✧
 *      ▄▄▄▄  ▄▄▄▄
 *     ▐████▌▐████▌
 *     ▐██████████▌
 *     ██ ◕    ◕ ██
 *     ██   ⌣    ██
 *      ▀████████▀
 *        ▀▀▀▀▀▀
 *       h a n n i
 */
const ART_ROWS: ReadonlyArray<{ text: string; color: RGB }> = [
	{ text: "  ✦              ✧  ", color: SPARK_BLUE },
	{ text: "     ▄▄▄▄  ▄▄▄▄     ", color: ART_COLORS[0] },
	{ text: "    ▐████▌▐████▌    ", color: ART_COLORS[0] },
	{ text: "    ▐██████████▌    ", color: ART_COLORS[1] },
	{ text: "    ██ ◕    ◕ ██    ", color: ART_COLORS[2] },
	{ text: "    ██   ⌣    ██    ", color: ART_COLORS[3] },
	{ text: "     ▀████████▀     ", color: ART_COLORS[4] },
	{ text: "       ▀▀▀▀▀▀       ", color: ART_COLORS[5] },
	{ text: "      h a n n i     ", color: WORDMARK_PINK },
];

/** Ancho del bloque: la fila más larga (el arte ya viene cuadrado, pero no se asume). */
function artWidth(): number {
	return Math.max(...ART_ROWS.map((row) => [...row.text].length));
}

/** Cada fila centrada al ancho del bloque, para que el logo no baile según la terminal. */
function centered(row: string, width: number): string {
	const length = [...row].length;
	const pad = Math.floor((width - length) / 2);
	return `${" ".repeat(pad)}${row}${" ".repeat(Math.max(0, width - length - pad))}`;
}

/** El logo completo: conejito + nombre, con el degradado rosa → lila por filas. */
export function hanniLogoLines(): string[] {
	const mode = theme.getColorMode();
	const width = artWidth();
	return ART_ROWS.map((row) => `${foregroundAnsi(row.color, mode)}${centered(row.text, width)}${RESET}`);
}

/**
 * Whether the terminal renders the block banner correctly. Apple Terminal draws
 * gaps between rows and misaligns the blocks, so it gets the text wordmark instead.
 */
export function supportsHanniLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Fallback de una línea: el nombre con el destello de la marca, para terminales sin bloques. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(WORDMARK_PINK, mode)}hanni${RESET}${foregroundAnsi(SPARK_BLUE, mode)}✦${RESET}`;
}
