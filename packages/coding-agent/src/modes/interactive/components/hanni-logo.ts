import { foregroundAnsi, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

// Marca de Hanni: rosa. Los colores de marca no siguen al tema (son la identidad), solo el
// modo de color del terminal. El dibujo vive en los PNG de `docs/images/`; en la TUI, el
// nombre es todo el logo.
const NAME_PINK = rgbColor(255, 122, 176);
const HEART_PINK = rgbColor(255, 201, 224);
const RESET = "\x1b[0m";

/** El wordmark de una línea: `hanni` con el corazón de la marca. */
export function hanniWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(NAME_PINK, mode)}hanni${RESET}${foregroundAnsi(HEART_PINK, mode)}♥${RESET}`;
}
