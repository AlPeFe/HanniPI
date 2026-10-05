import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Hanni brand palette: deep blues of the mascot (monitor character) + pastel pink accent.
const HANNI_BLUE = rgbColor(36, 43, 77); // deep navy from the mascot
const HANNI_LIGHT_BLUE = rgbColor(79, 142, 179); // lighter blue (eyes/headphones)
const HANNI_PINK = rgbColor(236, 125, 166); // pastel pink accent
const RESET = "\x1b[0m";

/**
 * The Hanni logo: 5 cells wide and 2 lines tall. Each cell shows two square
 * pixels with half blocks, drawing a stylized "H" (the mascot's monitor) with
 * the brand navy and a pink headphone dot:
 *
 *   navy  .     navy  .     pink
 *   navy  navy  navy  navy  .
 *   navy  .     navy  .     pink?
 *
 * Brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function hanniLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof HANNI_BLUE) => foregroundAnsi(color, mode);
	const bg = (color: typeof HANNI_BLUE) => backgroundAnsi(color, mode);
	const top = `${fg(HANNI_BLUE)}█${RESET}${bg(HANNI_LIGHT_BLUE)}▀${RESET}${fg(HANNI_BLUE)}██${RESET} ${fg(HANNI_PINK)}●${RESET}`;
	const bottom = `${fg(HANNI_BLUE)}██${RESET}${bg(HANNI_PINK)}▄${RESET}${fg(HANNI_BLUE)}█${RESET} ${RESET}`;
	return [top, bottom];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws
 * gaps between rows and misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsHanniLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback: "Hanni" with the brand navy and pink. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(HANNI_BLUE, mode)}Hanni${RESET}${foregroundAnsi(HANNI_PINK, mode)}✦${RESET}`;
}
