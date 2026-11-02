import {
	backgroundAnsi,
	type Color,
	type Component,
	foregroundAnsi,
	rgbColor,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { StartupArtTheme } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { hanniWordmark } from "./hanni-logo.ts";

/**
 * Escena de arranque de la TUI: Hanni, la mascota de la casa, en pixel art junto a los datos de la
 * sesión. Es decoración de arranque, no del protocolo: sólo `interactive-mode` la monta.
 *
 * - Se pinta una sola vez, al montar la TUI, encima de la cabecera; desaparece al primer mensaje.
 * - Cada celda del terminal son dos píxeles: `▀` con color de texto arriba y de fondo abajo. Los
 *   colores son de marca, igual que el wordmark: no siguen al tema, sólo al modo de color.
 * - `display.startupArtTheme: "denim"` cambia el rosa por azul vaquero y el nombre por un rótulo
 *   de tres líneas. El rosa es el predeterminado.
 * - Sin color en el terminal (`NO_COLOR`, `TERM=dumb`) se degrada a la silueta en mono: los ojos, la
 *   nariz y el interior de las orejas quedan como huecos.
 * - Terminal estrecho (< 40 columnas): variante de una línea, para no partir el dibujo.
 * - Determinista y sin animación: el arranque no espera a nada y los tests pueden comparar bytes.
 */

/** Por debajo de este ancho se usa la variante de una línea. */
export const STARTUP_ART_MIN_COLUMNS = 40;

type Pixel = "." | "P" | "S" | "B" | "E" | "W";

/** El dibujo del logo (orejas largas, cara ancha, nariz de corazón), a dos píxeles por celda. */
const HANNI_PIXELS: readonly string[] = [
	"...PP.....PP...",
	"..PSSP...PSSP..",
	"..PSSP...PSSP..",
	"..PSSP...PSSP..",
	"..PSSPPPPPSSP..",
	".PPPPPPPPPPPPP.",
	"PPPPPPPPPPPPPPP",
	"PPPWEPPPPPWEPPP",
	"PPPEEPSPSPEEPPP",
	"PBBPPPPSPPPPBBP",
	".PPPPPPPPPPPPP.",
	"...PPPPPPPPP...",
];

type Palette = Record<Exclude<Pixel, ".">, Color>;

const PALETTES: Record<StartupArtTheme, Palette> = {
	pink: {
		P: rgbColor(255, 122, 176), // #FF7AB0: cuerpo, el rosa de marca
		S: rgbColor(255, 201, 224), // #FFC9E0: orejas y nariz, el rosa suave de marca
		B: rgbColor(255, 160, 200), // #FFA0C8: mejillas
		E: rgbColor(59, 23, 48), // #3B1730: ojos
		W: rgbColor(255, 255, 255), // brillo de los ojos
	},
	denim: {
		P: rgbColor(74, 122, 176), // #4A7AB0: cuerpo, azul vaquero
		S: rgbColor(176, 205, 232), // #B0CDE8: orejas y nariz, vaquero lavado
		B: rgbColor(110, 152, 200), // #6E98C8: mejillas
		E: rgbColor(16, 32, 56), // #102038: ojos
		W: rgbColor(255, 255, 255), // brillo de los ojos
	},
};

/** El rótulo del tema denim. El corazón sigue en rosa: es lo único que no cambia de color. */
const HANNI_BANNER: readonly string[] = ["╦ ╦╔═╗╔╗╔╔╗╔╦", "╠═╣╠═╣║║║║║║║", "╩ ╩╩ ╩╝╚╝╝╚╝╩"];
const HEART_PINK = rgbColor(255, 122, 176);

const RESET = "\x1b[0m";
const ART_INDENT = "  ";
const INFO_GAP = "   ";
const TAGLINE = "tu conejita de código";
const WORDMARK_TEXT = "hanni♥";

function pixelAt(row: number, column: number): Pixel {
	return HANNI_PIXELS[row][column] as Pixel;
}

function monoCell(top: Pixel, bottom: Pixel): string {
	const isFilled = (pixel: Pixel) => pixel === "P" || pixel === "B";
	if (isFilled(top)) return isFilled(bottom) ? "█" : "▀";
	return isFilled(bottom) ? "▄" : " ";
}

function colorCell(top: Pixel, bottom: Pixel, palette: Palette, mode: ReturnType<typeof theme.getColorMode>): string {
	if (top === "." && bottom === ".") return `${RESET} `;
	if (top === ".") return `${RESET}${foregroundAnsi(palette[bottom as Exclude<Pixel, ".">], mode)}▄`;
	const foreground = foregroundAnsi(palette[top as Exclude<Pixel, ".">], mode);
	if (bottom === ".") return `${RESET}${foreground}▀`;
	if (bottom === top) return `${RESET}${foreground}█`;
	return `${foreground}${backgroundAnsi(palette[bottom as Exclude<Pixel, ".">], mode)}▀`;
}

function artRows(color: boolean, artTheme: StartupArtTheme = "pink"): string[] {
	// El mono no consulta el tema: `HANNI_MASCOT_ART` se calcula al cargar el módulo, antes de `initTheme`.
	const mode = color ? theme.getColorMode() : undefined;
	const rows: string[] = [];
	for (let row = 0; row < HANNI_PIXELS.length; row += 2) {
		let line = "";
		for (let column = 0; column < HANNI_PIXELS[row].length; column++) {
			const top = pixelAt(row, column);
			const bottom = pixelAt(row + 1, column);
			line += mode ? colorCell(top, bottom, PALETTES[artTheme], mode) : monoCell(top, bottom);
		}
		rows.push(mode ? `${line}${RESET}` : line);
	}
	return rows;
}

/** Las seis líneas del dibujo en mono, sin datos al lado: la referencia que comparan los tests. */
export const HANNI_MASCOT_ART: readonly string[] = artRows(false);

/** Ancho del dibujo en celdas; a partir de ahí empieza la columna de datos. */
export const HANNI_MASCOT_WIDTH = HANNI_PIXELS[0].length;

/** Datos de la sesión que se pintan a la derecha del dibujo. */
export interface HanniMascotInfo {
	version: string;
	/** Se omite mientras no haya modelo elegido. */
	model?: string;
	cwd: string;
}

/** ¿El terminal soporta color? `NO_COLOR` y `TERM=dumb` piden mono explícitamente. */
export function startupArtSupportsColor(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
	return env.TERM !== "dumb";
}

/** El tema denim: el rótulo ocupa el lugar del nombre y de la leyenda. */
function denimInfoLines(info: HanniMascotInfo, color: boolean): string[] {
	const version = `v${info.version}`;
	const heart = "♥";
	if (!color) {
		const banner = HANNI_BANNER.map((row, index) => (index === 2 ? `${row} ${heart}` : row));
		return [...banner, version, ...(info.model ? [info.model] : []), info.cwd];
	}
	const mode = theme.getColorMode();
	// El tono medio: el vaquero lavado apenas se lee sobre un terminal claro.
	const letters = foregroundAnsi(PALETTES.denim.B, mode);
	const pink = foregroundAnsi(HEART_PINK, mode);
	return [
		...HANNI_BANNER.map((row, index) => {
			const painted = `${letters}${row}${RESET}`;
			return index === 2 ? `${painted} ${pink}${heart}${RESET}` : painted;
		}),
		theme.fg("dim", version),
		...(info.model ? [theme.fg("text", info.model)] : []),
		theme.fg("dim", info.cwd),
	];
}

function infoLines(info: HanniMascotInfo, color: boolean): string[] {
	const version = `v${info.version}`;
	if (!color) {
		return [`${WORDMARK_TEXT} ${version}`, TAGLINE, ...(info.model ? [info.model] : []), info.cwd];
	}
	return [
		`${hanniWordmark()} ${theme.fg("dim", version)}`,
		theme.fg("muted", TAGLINE),
		...(info.model ? [theme.fg("text", info.model)] : []),
		theme.fg("dim", info.cwd),
	];
}

/** Líneas de la escena: el dibujo con los datos a la derecha, o una sola línea si no cabe. */
export function hanniMascotLines(
	width: number,
	options: { color?: boolean; info?: HanniMascotInfo; theme?: StartupArtTheme } = {},
): string[] {
	const color = options.color ?? true;
	const artTheme = options.theme ?? "pink";
	if (width < STARTUP_ART_MIN_COLUMNS) {
		if (!color) return [`(\\_/) ${WORDMARK_TEXT}`];
		if (artTheme === "pink") return [`(\\_/) ${hanniWordmark()}`];
		const mode = theme.getColorMode();
		const name = `${foregroundAnsi(PALETTES.denim.B, mode)}hanni${RESET}`;
		return [`(\\_/) ${name}${foregroundAnsi(HEART_PINK, mode)}♥${RESET}`];
	}
	const art = artRows(color, artTheme);
	if (!options.info) return art.map((row) => `${ART_INDENT}${row}`);

	const info = artTheme === "denim" ? denimInfoLines(options.info, color) : infoLines(options.info, color);
	const firstInfoRow = Math.floor((art.length - info.length) / 2);
	const infoWidth = width - ART_INDENT.length - HANNI_MASCOT_WIDTH - INFO_GAP.length;
	return art.map((row, index) => {
		const text = info[index - firstInfoRow];
		const line = `${ART_INDENT}${row}`;
		return text === undefined ? line : `${line}${INFO_GAP}${truncateToWidth(text, infoWidth)}`;
	});
}

/**
 * Componente de la escena de arranque. `enabled: false` renderiza cero líneas (lo pide
 * `display.startupArt: false`); `color: false` fuerza mono. Los datos se leen en cada render: el
 * modelo puede cambiar mientras la escena sigue en pantalla.
 */
export class HanniMascotComponent implements Component {
	private readonly enabled: boolean;
	private readonly color: boolean;
	private readonly getInfo: (() => HanniMascotInfo) | undefined;
	private readonly theme: StartupArtTheme;

	constructor(
		options: { enabled?: boolean; color?: boolean; getInfo?: () => HanniMascotInfo; theme?: StartupArtTheme } = {},
	) {
		this.enabled = options.enabled !== false;
		this.color = options.color ?? startupArtSupportsColor();
		this.getInfo = options.getInfo;
		this.theme = options.theme ?? "pink";
	}

	render(width: number): string[] {
		if (!this.enabled) return [];
		return hanniMascotLines(width, { color: this.color, info: this.getInfo?.(), theme: this.theme });
	}

	invalidate(): void {
		// Sin caché: cada render recalcula el dibujo y los datos.
	}
}
