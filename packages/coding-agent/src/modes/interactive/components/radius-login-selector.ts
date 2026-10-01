/**
 * Selectors for the Radius login flow. Internal to the interactive mode: the Radius shimmer and intro are not
 * configurable and must not be exposed to other selectors.
 */

import {
	type Color,
	Container,
	foregroundAnsi,
	getKeybindings,
	mixColors,
	parseColor,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const RADIUS_INTRO = "Radius is a service crafted for Pi by the builders of Pi, Earendil Works";

/** The four colors of the Radius logo, in the order they stream across the text. */
const RADIUS_COLORS: readonly Color[] = ["#4d9abf", "#83ccd2", "#f1be57", "#f09082"].map((hex) => parseColor(hex));
/** Width of each color band, in characters. */
const CHARS_PER_COLOR = 4;
const CHARS_PER_SECOND = 10;
const ANIMATION_FRAME_MS = 50;

/** Color `text` with the Radius logo colors flowing left to right; `elapsedMs` is the animation time. */
function radiusShimmer(text: string, elapsedMs: number): string {
	const mode = theme.getColorMode();
	const cycle = RADIUS_COLORS.length * CHARS_PER_COLOR;
	const offset = (elapsedMs / 1000) * CHARS_PER_SECOND;
	let result = "";
	let index = 0;
	for (const char of text) {
		const position = (((index - offset) % cycle) + cycle) % cycle;
		const band = Math.floor(position / CHARS_PER_COLOR);
		const t = position / CHARS_PER_COLOR - band;
		// Smoothstep keeps each band recognizable while still blending into the next one.
		const amount = t * t * (3 - 2 * t);
		const from = RADIUS_COLORS[band] as Color;
		const to = RADIUS_COLORS[(band + 1) % RADIUS_COLORS.length] as Color;
		result += foregroundAnsi(mixColors(from, to, amount, "srgb"), mode) + char;
		index++;
	}
	return `${result}\x1b[39m`;
}

/** The "Sign in with Radius" option: `label` is the full option, starting with the animated `text`. */
type RadiusOption = { label: string; text: string };

type SelectorCallbacks = { onSelect: (option: string) => void; onCancel: () => void };

/**
 * Top-level `/login` selector. `radiusOption` shimmers in the Radius logo colors while it is selected; the rest
 * of its label (for example its status) is shown as is.
 */
export function createLoginMenuSelector(
	tui: TUI,
	title: string,
	options: string[],
	radiusOption: RadiusOption,
	callbacks: SelectorCallbacks,
): RadiusLoginSelectorComponent {
	return new RadiusLoginSelectorComponent(tui, title, options, callbacks, radiusOption, undefined);
}

/** Radius sign-in method selector, with the Radius intro above the title. */
export function createRadiusSignInSelector(
	tui: TUI,
	title: string,
	options: string[],
	callbacks: SelectorCallbacks,
): RadiusLoginSelectorComponent {
	return new RadiusLoginSelectorComponent(tui, title, options, callbacks, undefined, RADIUS_INTRO);
}

/** Renders like `ExtensionSelectorComponent`. Create it with the factories above. */
class RadiusLoginSelectorComponent extends Container {
	private readonly tui: TUI;
	private readonly options: string[];
	private readonly callbacks: SelectorCallbacks;
	private readonly radiusOption: RadiusOption | undefined;
	private readonly listContainer = new Container();
	private selectedIndex = 0;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private animationStart = 0;

	constructor(
		tui: TUI,
		title: string,
		options: string[],
		callbacks: SelectorCallbacks,
		radiusOption: RadiusOption | undefined,
		intro: string | undefined,
	) {
		super();
		this.tui = tui;
		this.options = options;
		this.callbacks = callbacks;
		this.radiusOption = radiusOption;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		if (intro) {
			this.addChild(new Text(theme.fg("text", intro), 1, 0));
			this.addChild(new Spacer(1));
		}
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.selectionChanged();
	}

	private radiusSelected(): boolean {
		return this.radiusOption !== undefined && this.options[this.selectedIndex] === this.radiusOption.label;
	}

	private selectionChanged(): void {
		if (this.radiusSelected()) {
			if (!this.animationTimer) {
				this.animationStart = performance.now();
				this.animationTimer = setInterval(() => {
					this.updateList();
					this.tui.requestRender();
				}, ANIMATION_FRAME_MS);
				this.animationTimer.unref?.();
			}
		} else {
			this.stopAnimation();
		}
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const option = this.options[i] as string;
			let text: string;
			if (i !== this.selectedIndex) {
				text = `  ${theme.fg("text", option)}`;
			} else if (this.radiusOption && option === this.radiusOption.label) {
				const elapsedMs = performance.now() - this.animationStart;
				const rest = option.slice(this.radiusOption.text.length);
				text = theme.fg("accent", "→ ") + radiusShimmer(this.radiusOption.text, elapsedMs) + rest;
			} else {
				text = theme.fg("accent", "→ ") + theme.fg("accent", option);
			}
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	private stopAnimation(): void {
		if (!this.animationTimer) return;
		clearInterval(this.animationTimer);
		this.animationTimer = undefined;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.selectionChanged();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.selectionChanged();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) {
				this.stopAnimation();
				this.callbacks.onSelect(selected);
			}
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.stopAnimation();
			this.callbacks.onCancel();
		}
	}

	dispose(): void {
		this.stopAnimation();
	}
}

export type { RadiusLoginSelectorComponent };
