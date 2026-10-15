import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("resizes the right rail column without rebuilding the layout", () => {
		const railWidths: number[] = [];
		const rail: Component = {
			render: (width) => {
				railWidths.push(width);
				return ["rail"];
			},
			invalidate: () => {},
		};
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			rightRail: rail,
			rightRailWidth: 30,
			rightRailMinTerminalWidth: 60,
		});

		viewport.root.render(120);
		expect(railWidths.at(-1)).toBe(30);

		viewport.setRightRailWidth(52);
		viewport.root.render(120);
		expect(railWidths.at(-1)).toBe(52);
	});

	test("keeps the default rail width when the viewport has no rail", () => {
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
		});
		expect(() => viewport.setRightRailWidth(40)).not.toThrow();
	});
});
