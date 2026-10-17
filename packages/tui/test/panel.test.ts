import assert from "node:assert";
import { describe, it } from "node:test";
import { Panel } from "../src/components/panel.ts";
import { Text } from "../src/components/text.ts";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../src/tui.ts";
import { visibleWidth } from "../src/utils.ts";

class StaticLines implements Component {
	private readonly lines: string[];
	handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined;
	constructor(lines: string[]) {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

const bold = (text: string) => `\u001b[1m${text}\u001b[22m`;

function assertExactWidth(lines: string[], width: number): void {
	for (const line of lines) {
		assert.strictEqual(visibleWidth(line), width, `line is not ${width} columns: ${JSON.stringify(line)}`);
	}
}

describe("Panel", () => {
	it("draws a rounded border with the title in the top border", () => {
		const panel = new Panel(new StaticLines(["hello"]), { title: "bash" });
		const lines = panel.render(20);
		assert.deepStrictEqual(lines, ["╭─ bash ───────────╮", "│ hello            │", "╰──────────────────╯"]);
		assertExactWidth(lines, 20);
	});

	it("puts the status at the right end of the top border and the caption in the bottom border", () => {
		const panel = new Panel(new StaticLines(["out"]), { title: "bash", status: "ok 0.4s", caption: "ctrl+o" });
		const lines = panel.render(24);
		assert.deepStrictEqual(lines, [
			"╭─ bash ───── ok 0.4s ─╮",
			"│ out                  │",
			"╰─ ctrl+o ─────────────╯",
		]);
		assertExactWidth(lines, 24);
	});

	it("keeps every line at the requested width with ANSI colors, wide glyphs and long labels", () => {
		const panel = new Panel(new Text("日本語 テスト\nout: \u001b[31mrojo\u001b[39m", 0, 0), {
			title: bold("herramienta con un nombre larguísimo"),
			status: "ok",
			caption: "una nota larga que no cabe en el borde inferior",
			borderColor: (text) => `\u001b[38;5;240m${text}\u001b[39m`,
		});
		for (const width of [12, 20, 33, 80]) {
			assertExactWidth(panel.render(width), width);
		}
	});

	it("renders nothing when there is no room for two borders and a corner", () => {
		const panel = new Panel(new StaticLines(["x"]), { title: "t" });
		assert.deepStrictEqual(panel.render(3), []);
		assert.strictEqual(panel.render(4).length, 3);
	});

	it("supports the heavy and double border styles", () => {
		const heavy = new Panel(new StaticLines(["x"]), { title: "t", borderStyle: "heavy" }).render(8);
		assert.deepStrictEqual(heavy, ["┏━ t ━━┓", "┃ x    ┃", "┗━━━━━━┛"]);
		const double = new Panel(new StaticLines(["x"]), { borderStyle: "double" }).render(6);
		assert.deepStrictEqual(double, ["╔════╗", "║ x  ║", "╚════╝"]);
	});

	it("forwards mouse events shifted by the border and inner padding", () => {
		const child = new StaticLines(["a", "b"]);
		const seen: Array<{ x: number; y: number; width: number; height: number }> = [];
		child.handleMouse = (event) => {
			seen.push({ x: event.x, y: event.y, width: event.width, height: event.height });
			return { handled: true };
		};
		const panel = new Panel(child, { paddingX: 2 });
		panel.render(20);
		const click = (x: number, y: number) => ({
			type: "click" as const,
			button: "left" as const,
			x,
			y,
			width: 20,
			height: 3,
			screenX: 0,
			screenY: 0,
			shift: false,
			alt: false,
			ctrl: false,
		});
		panel.handleMouse(click(3, 2));
		assert.deepStrictEqual(seen, [{ x: 0, y: 1, width: 14, height: 2 }]);
		// Outside the borders or the inner padding.
		assert.strictEqual(panel.handleMouse(click(0, 1)), undefined);
	});
});
