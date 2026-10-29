import { type Component, TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { setDisplayDensity } from "../src/core/display-density.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ui = new TuiMainScreen(new VirtualTerminal(80, 24));

const tool: ToolDefinition = {
	name: "custom_tool",
	label: "custom_tool",
	description: "custom tool",
	parameters: Type.Any(),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};

type OutputPaddedComponent = Component & { setOutputPad(outputPad: number): void };

/**
 * Text lines without ANSI codes or trailing fill, ready to compare indentation across outputPad values.
 * Panels add their own frame: the border lines are dropped and the vertical border is removed so the
 * comparison is about the content the padding applies to.
 */
function renderLines(component: Component): string[] {
	return component
		.render(60)
		.map((line) => stripAnsi(line).trimEnd())
		.filter((line) => /[\w$(]/.test(line))
		.filter((line) => !/^[╭╰╔╚┏┗]/.test(line))
		.map((line) => line.replace(/^│/, "").replace(/│$/, "").trimEnd());
}

function createTool(definition: ToolDefinition | undefined, outputPad: number): ToolExecutionComponent {
	const component = new ToolExecutionComponent("custom_tool", "id", {}, { outputPad }, definition, ui, "/");
	component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
	return component;
}

const components: Array<{ name: string; create: (outputPad: number) => OutputPaddedComponent }> = [
	{
		name: "bash execution",
		create: (outputPad) => {
			const component = new BashExecutionComponent("pwd", ui, false, outputPad);
			component.appendOutput("/tmp");
			component.setComplete(1, false);
			return component;
		},
	},
	{ name: "tool execution", create: (outputPad) => createTool(tool, outputPad) },
	{ name: "tool execution without a definition", create: (outputPad) => createTool(undefined, outputPad) },
	{
		name: "self-rendered edit result",
		create: (outputPad) => {
			const component = new ToolExecutionComponent(
				"edit",
				"id",
				{ path: "file.txt", edits: [{ oldText: "old", newText: "new" }] },
				{ outputPad },
				createEditToolDefinition("/"),
				ui,
				"/",
			);
			component.updateResult({ content: [{ type: "text", text: "Could not find old text" }], isError: true });
			return component;
		},
	},
	{
		name: "compaction summary",
		create: (outputPad) =>
			new CompactionSummaryMessageComponent(
				{ role: "compactionSummary", summary: "summary", tokensBefore: 10, timestamp: 0 },
				undefined,
				outputPad,
			),
	},
];

describe("outputPad", () => {
	beforeAll(() => {
		initTheme("dark");
		// The padding contract here is measured on the classic frame: compact drops the card's
		// vertical padding on purpose (SPEC-007), so it is asserted in display-density.test.ts.
		setDisplayDensity("normal");
	});

	afterAll(() => {
		ui.stop();
	});

	test.each(components)("$name renders at outputPad 0 and 1", ({ create }) => {
		const component = create(0);
		const lines = renderLines(component);
		expect(lines.filter((line) => line.startsWith(" "))).toEqual([]);
		component.setOutputPad(1);
		expect(renderLines(component)).toEqual(lines.map((line) => ` ${line}`));
	});
});
