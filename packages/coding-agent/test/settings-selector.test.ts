import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createSettingsConfig(overrides: Partial<SettingsConfig> = {}): SettingsConfig {
	return {
		autoCompact: true,
		defaultModel: "not set",
		availableDefaultModels: [],
		showImages: true,
		imageWidthCells: 60,
		autoResizeImages: true,
		blockImages: false,
		enableSkillCommands: true,
		steeringMode: "one-at-a-time",
		followUpMode: "one-at-a-time",
		transport: "sse",
		httpIdleTimeoutMs: 60000,
		cacheWarmingMode: "off",
		thinkingLevel: "off",
		availableThinkingLevels: [],
		modelThinkingLevels: {},
		currentTheme: "dark",
		terminalTheme: "dark",
		availableThemes: [],
		hideThinkingBlock: false,
		mermaidRenderingMode: "streaming",
		showCacheMissNotices: true,
		collapseChangelog: false,
		enableInstallTelemetry: false,
		doubleEscapeAction: "tree",
		treeFilterMode: "default",
		showHardwareCursor: false,
		editorPaddingX: 0,
		outputPad: 0,
		autocompleteMaxVisible: 5,
		quietStartup: false,
		defaultProjectTrust: "ask",
		clearOnShrink: false,
		showTerminalProgress: false,
		tuiMode: "fullscreen",
		fullscreenExitOutput: "transcript",
		fullscreenScrollbar: "auto",
		fullscreenCopyOnSelect: true,
		warnings: {},
		...overrides,
	};
}

function createSettingsCallbacks(overrides: Partial<SettingsCallbacks> = {}): SettingsCallbacks {
	const noop = () => {};
	return {
		onAutoCompactChange: noop,
		onShowImagesChange: noop,
		onImageWidthCellsChange: noop,
		onAutoResizeImagesChange: noop,
		onBlockImagesChange: noop,
		onEnableSkillCommandsChange: noop,
		onSteeringModeChange: noop,
		onFollowUpModeChange: noop,
		onTransportChange: noop,
		onHttpIdleTimeoutMsChange: noop,
		onCacheWarmingModeChange: noop,
		onModelThinkingLevelChange: noop,
		onModelThinkingLevelRemove: noop,
		onThemeChange: noop,
		onHideThinkingBlockChange: noop,
		onMermaidRenderingModeChange: noop,
		onShowCacheMissNoticesChange: noop,
		onCollapseChangelogChange: noop,
		onEnableInstallTelemetryChange: noop,
		onDoubleEscapeActionChange: noop,
		onTreeFilterModeChange: noop,
		onShowHardwareCursorChange: noop,
		onEditorPaddingXChange: noop,
		onOutputPadChange: noop,
		onAutocompleteMaxVisibleChange: noop,
		onQuietStartupChange: noop,
		onDefaultProjectTrustChange: noop,
		onClearOnShrinkChange: noop,
		onShowTerminalProgressChange: noop,
		onTuiModeChange: noop,
		onFullscreenExitOutputChange: noop,
		onFullscreenScrollbarChange: noop,
		onFullscreenCopyOnSelectChange: noop,
		onWarningsChange: noop,
		onCancel: noop,
		...overrides,
	};
}

describe("SettingsSelectorComponent", () => {
	let harness: Harness | undefined;
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	it("cycles through fullscreen settings", () => {
		const onExitOutputChange = vi.fn<SettingsCallbacks["onFullscreenExitOutputChange"]>();
		const onScrollbarChange = vi.fn<SettingsCallbacks["onFullscreenScrollbarChange"]>();
		const onCopyOnSelectChange = vi.fn<SettingsCallbacks["onFullscreenCopyOnSelectChange"]>();
		const config = createSettingsConfig();
		const callbacks = createSettingsCallbacks({
			onFullscreenExitOutputChange: onExitOutputChange,
			onFullscreenScrollbarChange: onScrollbarChange,
			onFullscreenCopyOnSelectChange: onCopyOnSelectChange,
		});

		const cycle = (label: string, count: number) => {
			const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
			for (const character of label) list.handleInput(character);
			for (let i = 0; i < count; i++) list.handleInput("\r");
		};

		cycle("Fullscreen exit output", 2);
		expect(onExitOutputChange.mock.calls.flat()).toEqual(["resume-hint", "transcript"]);
		cycle("Fullscreen scrollbar", 3);
		expect(onScrollbarChange.mock.calls.flat()).toEqual(["always", "hidden", "auto"]);
		cycle("Fullscreen copy on select", 2);
		expect(onCopyOnSelectChange.mock.calls.flat()).toEqual([false, true]);
	});

	// #9758: custom settings remain selected until the user chooses a preset.
	it("includes custom wheel values and saves a selected preset", () => {
		const config = createSettingsConfig({ mouseWheel: { normalLines: 12, altLines: 2 } });
		const onNormalChange = vi.fn<NonNullable<SettingsCallbacks["onMouseWheelNormalLinesChange"]>>();
		const onAltChange = vi.fn<NonNullable<SettingsCallbacks["onMouseWheelAltLinesChange"]>>();
		const callbacks = createSettingsCallbacks({
			onMouseWheelNormalLinesChange: onNormalChange,
			onMouseWheelAltLinesChange: onAltChange,
		});
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();
		list.selectItem("mouse-wheel");
		list.handleInput("\r");
		list.handleInput("\r");
		expect(stripAnsi(list.render(120).join("\n"))).toMatch(/→ ✓ 12\s*$/m);
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		expect(onNormalChange).toHaveBeenCalledExactlyOnceWith(20);
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		list.handleInput("\x1b[B");
		list.handleInput("\r");
		expect(onAltChange).toHaveBeenCalledExactlyOnceWith(3);
	});

	it("keeps the configured fixed theme marked while browsing", () => {
		const config = createSettingsConfig({
			currentTheme: "dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light"],
		});
		const callbacks = createSettingsCallbacks();
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("    Automatic");
		expect(output).toContain("→ ✓ dark");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ dark");
		expect(output).toContain("→   light");
	});

	it("keeps a configured automatic theme marked while browsing", () => {
		const config = createSettingsConfig({
			currentTheme: "light/dark",
			terminalTheme: "dark",
			availableThemes: ["dark", "light", "other"],
		});
		const callbacks = createSettingsCallbacks();
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("theme");
		list.handleInput("\r");
		list.handleInput("\r");
		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ light");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ light");
		expect(output).toContain("→   other");
	});

	it("keeps the configured per-model thinking level marked while browsing", async () => {
		harness = await createHarness({
			models: [{ id: "thinking-model", reasoning: true }],
		});
		const model = harness.getModel("thinking-model");
		if (!model) throw new Error("Expected thinking-model in the harness");
		const modelKey = `${model.provider}/${model.id}`;
		const config = createSettingsConfig({
			defaultModel: modelKey,
			availableDefaultModels: [model],
			thinkingLevel: "high",
			modelThinkingLevels: { [modelKey]: "medium" },
		});
		const callbacks = createSettingsCallbacks();
		const list = new SettingsSelectorComponent(config, callbacks).getSettingsList();

		list.selectItem("model-thinking");
		list.handleInput("\r");
		list.handleInput("\r");

		let output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("→ ✓ medium");
		expect(output).toContain("    (clear override)");

		list.handleInput("\x1b[B");
		output = stripAnsi(list.render(120).join("\n"));
		expect(output).toContain("  ✓ medium");
		expect(output).toContain("→   high");
	});
});
