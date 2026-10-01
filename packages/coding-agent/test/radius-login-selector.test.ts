import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { TUI } from "../../tui/src/tui.ts";
import {
	createLoginMenuSelector,
	createRadiusSignInSelector,
} from "../src/modes/interactive/components/radius-login-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RADIUS_BLUE = "38;2;77;154;191m"; // #4d9abf, first Radius logo color

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function createMenu(requestRender = vi.fn()) {
	const tui = { requestRender } as unknown as TUI;
	return createLoginMenuSelector(
		tui,
		"Select:",
		["Sign in with an account", "Sign in with Radius ✓ configured"],
		{ label: "Sign in with Radius ✓ configured", text: "Sign in with Radius" },
		{ onSelect: () => {}, onCancel: () => {} },
	);
}

describe("Radius login selectors", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	test("animates the Radius option only while it is selected", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const selector = createMenu(requestRender);

		expect(vi.getTimerCount()).toBe(0);
		expect(selector.render(80).join("\n")).not.toContain(RADIUS_BLUE);

		selector.handleInput(DOWN);
		vi.advanceTimersByTime(200);
		expect(requestRender).toHaveBeenCalled();
		const first = selector.render(80).join("\n");
		expect(first).toContain(RADIUS_BLUE);
		expect(stripAnsi(first)).toContain(" → Sign in with Radius ✓ configured");
		vi.advanceTimersByTime(400);
		expect(selector.render(80).join("\n")).not.toBe(first);

		selector.handleInput(UP);
		requestRender.mockClear();
		vi.advanceTimersByTime(500);
		expect(requestRender).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		selector.dispose();
	});

	test("aligns options with the title", () => {
		const lines = createMenu()
			.render(80)
			.map((line) => stripAnsi(line).trimEnd());
		expect(lines).toContain(" Select:");
		expect(lines).toContain(" → Sign in with an account");
		expect(lines).toContain("   Sign in with Radius ✓ configured");
	});

	test("shows the Radius intro above the sign-in method title", () => {
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const selector = createRadiusSignInSelector(tui, "Sign in to Radius:", ["Browser"], {
			onSelect: () => {},
			onCancel: () => {},
		});
		const lines = selector.render(80).map((line) => stripAnsi(line).trim());
		const intro = lines.indexOf("Radius is a service crafted for Pi by the builders of Pi, Earendil Works");
		expect(intro).toBeGreaterThan(-1);
		expect(lines[intro + 1]).toBe("");
		expect(lines[intro + 2]).toBe("Sign in to Radius:");
		expect(vi.getTimerCount()).toBe(0);
	});
});
