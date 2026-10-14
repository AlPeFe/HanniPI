import { foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Hanni brand palette: deep blues of the mascot (monitor character) + pastel pink accent.
const HANNI_LIGHT_BLUE = rgbColor(79, 142, 179); // lighter blue (eyes/headphones)
const HANNI_PINK = rgbColor(236, 125, 166); // pastel pink accent
const RESET = "\x1b[0m";

/**
 * The Hanni banner: "HANNI" in block letters, 3 lines tall and 21 cells wide.
 * Each letter is drawn with full/half blocks so it renders the same in every
 * terminal (no font/figlet needed). The final "I" is pink to keep the brand's
 * blue + pink accent:
 *
 *   █  █ ▄▀▀▄ █  █ █  █ █
 *   █▀▀█ █▀▀█ █▄ █ █▄ █ █
 *   █  █ █  █ █ ▀█ █ ▀█ █
 *
 * Brand colors stay fixed across themes; they follow the terminal's color mode.
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

export function hanniLogoLines(): string[] {
	const mode = theme.getColorMode();
	const blue = (text: string) => `${foregroundAnsi(HANNI_LIGHT_BLUE, mode)}${text}${RESET}`;
	const pink = (text: string) => `${foregroundAnsi(HANNI_PINK, mode)}${text}${RESET}`;
	const rows: [string, string, string] = ["", "", ""];
	HANNI_LETTERS.forEach((entry, index) => {
		const glyph = HANNI_GLYPHS[entry.letter];
		for (let row = 0; row < rows.length; row++) {
			const chunk = entry.accent ? pink(glyph[row] ?? "") : blue(glyph[row] ?? "");
			rows[row] += (index === 0 ? "" : " ") + chunk;
		}
	});
	return rows;
}

/**
 * Whether the terminal renders the block banner correctly. Apple Terminal draws
 * gaps between rows and misaligns the blocks, so it gets the text wordmark instead.
 */
export function supportsHanniLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback: "Hanni" with the brand blue and pink. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(HANNI_LIGHT_BLUE, mode)}Hanni${RESET}${foregroundAnsi(HANNI_PINK, mode)}✦${RESET}`;
}
