import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Paleta de marca de Hanni: todo rosa, en tonos. Los colores de marca no siguen al tema
// (son la identidad), solo el modo de color del terminal.
const NAME_PINK = rgbColor(255, 111, 174); // el nombre, el rosa más saturado
const ART_COLORS = [
	rgbColor(255, 217, 236), // orejas
	rgbColor(255, 233, 244), // frente
	rgbColor(255, 217, 236), // cara
	rgbColor(255, 233, 244), // hocico
	rgbColor(255, 194, 222), // barbilla
	rgbColor(255, 140, 189), // cuerpo
] as const;
const RESET = "\x1b[0m";

type RGB = ReturnType<typeof rgbColor>;

/**
 * Hanni en pixel-art de bloques: cabeza redonda con orejas, nariz de corazón, cuerpo con
 * otro corazón (el mismo personaje que el logo de `docs/images/`) y el nombre debajo. El
 * bloque va centrado: todas las filas miden lo mismo, así el header lo pinta tal cual venga.
 *
 *      ▐▌  ▐▌
 *      ██  ██
 *   ▄████████▄
 *   ▐██████████▌
 *   █ ◕      ◕ █
 *   █    ♥     █
 *   ▀██████████▀
 *     ▐██████▌
 *     ▐█ ♥ █▌
 *     ▀██████▀
 *     h a n n i
 */
const ART_ROWS: ReadonlyArray<{ text: string; color: RGB }> = [
	{ text: "     ▐▌  ▐▌     ", color: ART_COLORS[0] },
	{ text: "     ██  ██     ", color: ART_COLORS[0] },
	{ text: "  ▄████████▄    ", color: ART_COLORS[1] },
	{ text: "  ▐██████████▌  ", color: ART_COLORS[1] },
	{ text: "  █ ◕      ◕ █  ", color: ART_COLORS[2] },
	{ text: "  █    ♥     █  ", color: ART_COLORS[3] },
	{ text: "  ▀██████████▀  ", color: ART_COLORS[4] },
	{ text: "    ▐██████▌    ", color: ART_COLORS[5] },
	{ text: "    ▐█ ♥ █▌     ", color: ART_COLORS[5] },
	{ text: "    ▀██████▀    ", color: ART_COLORS[5] },
	{ text: "    h a n n i   ", color: NAME_PINK },
];

/** Ancho del bloque: la fila más larga. */
function artWidth(): number {
	return Math.max(...ART_ROWS.map((row) => [...row.text].length));
}

/** Cada fila centrada al ancho del bloque, para que el logo no baile según la terminal. */
function centered(row: string, width: number): string {
	const length = [...row].length;
	const pad = Math.floor((width - length) / 2);
	return `${" ".repeat(pad)}${row}${" ".repeat(Math.max(0, width - length - pad))}`;
}

/** El logo completo: personaje + nombre, con los rosas por filas. */
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

/** Fallback de una línea: el nombre con el corazón de la marca, para terminales sin bloques. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(NAME_PINK, mode)}hanni${RESET}${foregroundAnsi(ART_COLORS[0], mode)}♥${RESET}`;
}
