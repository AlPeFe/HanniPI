import {
	type Component,
	Container,
	type TuiMouseButton,
	type TuiMouseEvent,
	type TuiMouseEventType,
} from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

function mouseEvent(type: TuiMouseEventType, screenX: number, button: TuiMouseButton = "left"): TuiMouseEvent {
	return {
		type,
		button,
		x: 0,
		y: 0,
		screenX,
		screenY: 0,
		width: 1,
		height: 24,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

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
		expect(viewport.railResizeHandle).toBeUndefined();
	});

	test("no hay separador de arrastre sin railResize", () => {
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			rightRail: new Container(),
		});
		expect(viewport.railResizeHandle).toBeUndefined();
	});

	test("el separador pinta una columna y redimensiona el rail al arrastrarlo", () => {
		let railWidth = 34;
		const resized: number[] = [];
		const committed: number[] = [];
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			rightRail: new Container(),
			railResize: {
				getRailWidth: () => railWidth,
				onResize: (width) => {
					railWidth = width;
					resized.push(width);
				},
				onResizeEnd: (width) => {
					railWidth = width;
					committed.push(width);
				},
				renderLine: () => "│",
			},
		});
		const handle = viewport.railResizeHandle;
		expect(handle).toBeDefined();
		expect(handle!.render(1)[0]).toBe("│");

		// Pulsar en el borde captura el gesto y seguirá recibiendo sus arrastres.
		expect(handle!.handleMouse(mouseEvent("press", 86))).toEqual({ handled: true, capture: true });

		// Mover el ratón a la izquierda (screenX 86 → 80) agranda el rail en 6 columnas.
		expect(handle!.handleMouse(mouseEvent("drag", 80))).toEqual({ handled: true, capture: true });
		expect(resized).toEqual([40]);

		// Al soltar se confirma el ancho propuesto para su persistencia.
		expect(handle!.handleMouse(mouseEvent("release", 76))).toEqual({ handled: true });
		expect(committed).toEqual([44]);
	});

	test("el arrastre queda sujeto al clamp del rail (20-100)", () => {
		let railWidth = 34;
		const applied: number[] = [];
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			rightRail: new Container(),
			railResize: {
				getRailWidth: () => railWidth,
				onResize: (width) => applied.push(width),
				onResizeEnd: (width) => {
					railWidth = width;
				},
				renderLine: () => "│",
			},
		});
		const handle = viewport.railResizeHandle!;

		handle.handleMouse(mouseEvent("press", 200));
		handle.handleMouse(mouseEvent("drag", 100)); // arrastre enorme a la izquierda
		expect(applied).toEqual([100]);

		// Un gesto nuevo desde el estado confirmado: clamp al mínimo.
		handle.handleMouse(mouseEvent("press", 100));
		handle.handleMouse(mouseEvent("drag", 400));
		expect(applied.at(-1)).toBe(20);

		handle.handleMouse(mouseEvent("release", 400));
		expect(railWidth).toBe(20);
	});

	test("la rueda o un pulso sin arrastre no redimensionan el rail", () => {
		const onResize = vi.fn();
		const viewport = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			rightRail: new Container(),
			railResize: {
				getRailWidth: () => 34,
				onResize,
				onResizeEnd: onResize,
				renderLine: () => "│",
			},
		});
		const handle = viewport.railResizeHandle!;
		expect(handle.handleMouse(mouseEvent("wheel", 86, "none"))).toBeUndefined();
		expect(handle.handleMouse({ ...mouseEvent("press", 86), button: "right" })).toBeUndefined();
		expect(onResize).not.toHaveBeenCalled();

		// Pulso y suelto sin pasar por el editor: click cierra el gesto sin propuesta.
		expect(handle.handleMouse(mouseEvent("press", 86))).toEqual({ handled: true, capture: true });
		expect(handle.handleMouse(mouseEvent("release", 86))).toEqual({ handled: true });
		expect(handle.handleMouse(mouseEvent("click", 86))).toEqual({ handled: true });
	});
});
