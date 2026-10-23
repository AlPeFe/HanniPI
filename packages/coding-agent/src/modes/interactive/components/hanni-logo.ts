import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Paleta de marca de Hanni: rosa pastel con un degradado rosa → lila. Los colores
// de marca no siguen al tema (son la identidad), solo el modo de color del terminal.
const BUNNY_PINK = rgbColor(255, 178, 210); // conejito
const WORDMARK_ROWS = [rgbColor(255, 205, 227), rgbColor(255, 173, 208), rgbColor(238, 165, 224)] as const;
const WORDMARK_ACCENT = rgbColor(255, 140, 190); // la "I" final, más saturada
const RESET = "\x1b[0m";

/**
 * El conejito de Hanni, un icono kawaii de tres líneas alineado sobre el wordmark
 * (que mide 21 celdas). Se dibuja con caracteres corrientes, así que se ve igual
 * en cualquier terminal monoespaciada:
 *
 *   (\_/)
 *   (•ω•)
 *   c(")(")
 */
const BUNNY_LINES: ReadonlyArray<{ text: string; indent: number }> = [
	{ text: "(\\_/)", indent: 8 },
	{ text: "(•ω•)", indent: 8 },
	{ text: 'c(")(")', indent: 7 },
];

/**
 * "HANNI" en letras de bloque, 3 líneas y 21 celdas: el nombre es parte del logo,
 * debajo del conejito. Cada letra se dibuja con bloques llenos y medios para que
 * no dependa de la fuente ni de figlet:
 *
 *   █  █ ▄▀▀▄ █  █ █  █ █
 *   █▀▀█ █▀▀█ █▄ █ █▄ █ █
 *   █  █ █  █ █ ▀█ █ ▀█ █
 */
const HANNI_GLYPHS: Record<string, readonly [string, string, string]> = {
	H: ["█  █", "█▀▀█", "█  █"],
	A: ["▄▀▀▄", "█▀▀█", "█  █"],
	N: ["█  █", "█▄ █", "█ ▀█"],
	I: ["█", "█", "█"],
};

const HANNI_LETTERS: ReadonlyArray<{ letter: keyof typeof HANNI_GLYPHS; accent?: boolean }> = [
	{ letter: "H" },
	{ letter: "A" },
	{ letter: "N" },
	{ letter: "N" },
	{ letter: "I", accent: true },
];

/** El logo completo: conejito arriba, nombre debajo (6 líneas). */
export function hanniLogoLines(): string[] {
	const mode = theme.getColorMode();
	const bunny = BUNNY_LINES.map(
		({ text, indent }) => `${" ".repeat(indent)}${foregroundAnsi(BUNNY_PINK, mode)}${text}${RESET}`,
	);
	const rows: [string, string, string] = ["", "", ""];
	HANNI_LETTERS.forEach((entry, index) => {
		const glyph = HANNI_GLYPHS[entry.letter];
		for (let row = 0; row < rows.length; row++) {
			const color = entry.accent ? WORDMARK_ACCENT : WORDMARK_ROWS[row];
			const chunk = `${foregroundAnsi(color, mode)}${glyph[row] ?? ""}${RESET}`;
			rows[row] += (index === 0 ? "" : " ") + chunk;
		}
	});
	return [...bunny, ...rows];
}

/**
 * Whether the terminal renders the block banner correctly. Apple Terminal draws
 * gaps between rows and misaligns the blocks, so it gets the text wordmark instead.
 */
export function supportsHanniLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback: "hanni" con el corazón de la marca, para terminales que no pintan bloques. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(BUNNY_PINK, mode)}hanni${RESET}${foregroundAnsi(WORDMARK_ACCENT, mode)}♡${RESET}`;
}
