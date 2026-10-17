import { type Component, type Keybinding, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/** What the harness is doing right now, shown as the chip at the left of the status bar. */
export type StatusBarMode = "idle" | "working" | "compacting" | "bash" | "queue";

interface ModeStyle {
	label: string;
	color: ThemeColor;
	hints: ReadonlyArray<readonly [string, string]>;
}

const MODE_STYLES: Record<StatusBarMode, ModeStyle> = {
	idle: {
		label: "lista",
		color: "accent",
		hints: [
			["tui.input.submit", "enviar"],
			["tui.input.newLine", "salto de línea"],
			["app.tools.expand", "herramientas"],
			["/", "comandos"],
			["!", "bash"],
		],
	},
	working: {
		label: "pensando",
		color: "warning",
		hints: [
			["app.interrupt", "interrumpir"],
			["tui.input.newLine", "encolar respuesta"],
			["app.tools.expand", "herramientas"],
		],
	},
	compacting: {
		label: "compactando",
		color: "warning",
		hints: [["app.interrupt", "interrumpir"]],
	},
	bash: {
		label: "bash",
		color: "success",
		hints: [
			["tui.input.submit", "ejecutar"],
			["app.interrupt", "cancelar"],
		],
	},
	queue: {
		label: "cola",
		color: "accent",
		hints: [
			["tui.input.submit", "enviar"],
			["app.message.dequeue", "editar la cola"],
			["app.interrupt", "interrumpir"],
		],
	},
};

export interface StatusBarOptions {
	/** Read on render, so the bar always follows the session state without extra wiring. */
	getMode: () => StatusBarMode;
	/** Optional right-aligned note, e.g. the queued message count. */
	getTrailing?: () => string | undefined;
}

/**
 * Bottom bar of the interface: the current mode on the left and the shortcuts that apply to it.
 * Identity, tokens, and context live in the top bar (`TopBarComponent`), so this stays one line
 * next to the input, like the mode/hint bar of a full-screen TUI.
 */
export class StatusBarComponent implements Component {
	private options: StatusBarOptions;

	constructor(options: StatusBarOptions) {
		this.options = options;
	}

	invalidate(): void {
		// Everything is computed from the getters on render.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const mode = this.options.getMode();
		const style = MODE_STYLES[mode];
		const chip = theme.bg("selectedBg", theme.bold(theme.fg(style.color, ` ${style.label} `)));
		const hints = style.hints
			.map(([key, description]) => {
				const keyLabel = resolveKeyLabel(key);
				// A keybinding with no keys in this session is not worth showing.
				if (!keyLabel) return undefined;
				return `${theme.fg("text", keyLabel)} ${theme.fg("dim", description)}`;
			})
			.filter((hint): hint is string => hint !== undefined)
			.join(theme.fg("dim", " · "));
		const trailing = this.options.getTrailing?.();
		const right = trailing ? theme.fg("muted", trailing) : "";

		const rightWidth = visibleWidth(right);
		const chipWidth = visibleWidth(chip);
		if (width <= chipWidth + 2) return [truncateToWidth(chip, width, "")];

		const hintsBudget = width - chipWidth - 1 - (right ? rightWidth + 2 : 0);
		const clippedHints = truncateToWidth(hints, Math.max(0, hintsBudget), "…");
		const line = `${chip} ${clippedHints}`;
		if (!right) return [pad(line, width)];
		const gap = Math.max(1, width - visibleWidth(line) - rightWidth);
		return [pad(line + " ".repeat(gap) + right, width)];
	}
}

/** Resolves a hint key: binding ids (`app.*`, `tui.*`) take their first key, raw keys (`/`, `!`) stay. */
function resolveKeyLabel(key: string): string | undefined {
	if (!key.includes(".")) return key;
	return keyText(key as Keybinding).split("/")[0] || undefined;
}

function pad(line: string, width: number): string {
	const missing = width - visibleWidth(line);
	return missing > 0 ? line + " ".repeat(missing) : line;
}
