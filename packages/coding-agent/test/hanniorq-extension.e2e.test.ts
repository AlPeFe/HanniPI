/**
 * Prueba e2e de la extensión hanniorq (HanniPI):
 * - comandos registrados (/hanniorq, /hannigram)
 * - widget de fin de turno (tools · sODD · memoria) estilo "updated skill" de Hermes
 * - detección de uso de memoria y sODD
 *
 * Se ejecuta contra la extensión real, con un pi mock que captura eventos y widgets.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createHanniorqExtension } from "../src/extensions/hanniorq/index.ts";

function createMockPi() {
	const registeredCommands = new Map<string, { description: string; handler: Function }>();
	const listeners = new Map<string, Function[]>();
	const widgets = new Map<string, string[]>();

	const ui = {
		notify: () => {},
		setWidget: (name: string, lines?: string[]) => {
			if (lines === undefined) widgets.delete(name);
			else widgets.set(name, lines);
		},
	};

	const pi = {
		registerCommand: (name: string, def: { description: string; handler: Function }) => {
			registeredCommands.set(name, def);
		},
		on: (event: string, handler: Function) => {
			const arr = listeners.get(event) ?? [];
			arr.push(handler);
			listeners.set(event, arr);
		},
		ui,
	} as unknown as Parameters<ExtensionFactory>[0];

	return { registeredCommands, listeners, widgets, ui, pi };
}

async function emit(pi: ReturnType<typeof createMockPi>["pi"], event: string, payload: any, ctx: any) {
	const handlers = (pi as any).__listeners?.get(event) ?? [];
	for (const h of handlers) await h(payload, ctx);
}

describe("extensión hanniorq", () => {
	it("registra los comandos /hanniorq y /hannigram", () => {
		const { registeredCommands, pi } = createMockPi();
		createHanniorqExtension()(pi);
		expect(registeredCommands.has("hanniorq")).toBe(true);
		expect(registeredCommands.has("hannigram")).toBe(true);
		expect(registeredCommands.get("hanniorq")!.description).toContain("Orquestador sODD");
		expect(registeredCommands.get("hannigram")!.description).toContain("Memoria del proyecto");
	});

	it("genera el widget de fin de turno con tools · sODD · memoria cuando se usa memoria", async () => {
		const { listeners, widgets, pi } = createMockPi();
		// exponer listeners en pi para el helper emit
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		// turn_start resetea
		await emit(pi, "turn_start", {}, ctx);
		// el agente usa herramientas: una de memoria + una normal
		await emit(pi, "tool_execution_start", { toolName: "mem_save", toolCallId: "t1", args: {} }, ctx);
		await emit(pi, "tool_execution_start", { toolName: "search_files", toolCallId: "t2", args: {} }, ctx);
		// fin de turno → widget
		await emit(pi, "turn_end", {}, ctx);

		const widget = widgets.get("hanniorq-turn");
		expect(widget).toBeDefined();
		const line = widget![0];
		expect(line).toContain("mem: +1");
		expect(line).toContain("tools: mem_save, search_files");
		// sin ficha sODD en disco → inline o tocado
		expect(line).toMatch(/sODD: (inline|tocado)/);
	});

	it("marca sODD tocado cuando se usa /task", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		await emit(pi, "turn_start", {}, ctx);
		await emit(pi, "tool_execution_start", { toolName: "task", toolCallId: "t1", args: {} }, ctx);
		await emit(pi, "turn_end", {}, ctx);

		const line = widgets.get("hanniorq-turn")![0];
		expect(line).toContain("sODD: tocado");
	});

	it("no marca memoria cuando no se escribió", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		await emit(pi, "turn_start", {}, ctx);
		await emit(pi, "tool_execution_start", { toolName: "read_file", toolCallId: "t1", args: {} }, ctx);
		await emit(pi, "turn_end", {}, ctx);

		const line = widgets.get("hanniorq-turn")![0];
		expect(line).toContain("mem: —");
	});
});
