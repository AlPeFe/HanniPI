/**
 * Prueba e2e de la extensión hanniorq (HanniPI):
 * - comandos registrados (/hanniorq, /hannigram)
 * - widget de fin de turno (tools · sODD · memoria) estilo "updated skill" de Hermes
 * - detección de uso de memoria y sODD
 *
 * Se ejecuta contra la extensión real, con un pi mock que captura eventos y widgets.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createHanniorqExtension, parseGitStatusPaths } from "../src/extensions/hanniorq/index.ts";
import { publishMcpConnectionStatuses } from "../src/extensions/mcp/status.ts";

function createMockPi() {
	const registeredCommands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
	const listeners = new Map<string, ((...args: any[]) => any)[]>();
	const widgets = new Map<string, string[] | ((...args: any[]) => unknown)>();
	const sentMessages: string[] = [];

	const ui = {
		notify: () => {},
		select: async () => undefined,
		setWidget: (name: string, lines?: string[] | ((...args: any[]) => unknown)) => {
			if (lines === undefined) widgets.delete(name);
			else widgets.set(name, lines);
		},
		theme: {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		},
	};

	const pi = {
		registerCommand: (name: string, def: { description: string; handler: (...args: any[]) => any }) => {
			registeredCommands.set(name, def);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		on: (event: string, handler: (...args: any[]) => any) => {
			const arr = listeners.get(event) ?? [];
			arr.push(handler);
			listeners.set(event, arr);
		},
		sendUserMessage: (content: string) => {
			sentMessages.push(content);
		},
		ui,
	} as unknown as Parameters<ExtensionFactory>[0];

	return { registeredCommands, listeners, widgets, ui, pi, sentMessages };
}

async function emit(pi: ReturnType<typeof createMockPi>["pi"], event: string, payload: any, ctx: any) {
	const handlers = (pi as any).__listeners?.get(event) ?? [];
	for (const h of handlers) await h(payload, ctx);
}

describe("extensión hanniorq", () => {
	it("parses NUL-delimited modified and renamed paths from git status", () => {
		expect(parseGitStatusPaths(" M file with spaces.ts\0?? untracked.ts\0R  new-name.ts\0old-name.ts\0")).toEqual([
			"file with spaces.ts",
			"untracked.ts",
			"new-name.ts",
		]);
	});

	it("registra los comandos /hanniorq y /hannigram", () => {
		const { registeredCommands, pi } = createMockPi();
		createHanniorqExtension()(pi);
		expect(registeredCommands.has("hanniorq")).toBe(true);
		expect(registeredCommands.has("hannigram")).toBe(true);
		expect(registeredCommands.get("hanniorq")!.description).toContain("Orquestador sODD");
		expect(registeredCommands.get("hannigram")!.description).toContain("Memoria del proyecto");
	});

	it("registra /helpme, /hannidump y /explore", () => {
		const { registeredCommands, pi } = createMockPi();
		createHanniorqExtension()(pi);
		expect(registeredCommands.has("helpme")).toBe(true);
		expect(registeredCommands.has("hannidump")).toBe(true);
		expect(registeredCommands.has("explore")).toBe(true);
		expect(registeredCommands.get("helpme")!.description).toContain("comandos de HanniPI");
		expect(registeredCommands.get("hannidump")!.description).toContain("agents.md");
		expect(registeredCommands.get("explore")!.description).toContain("memoria inicial");
	});

	it("renders configured MCP connection state on the right rail", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };
		publishMcpConnectionStatuses("test", [
			{ name: "context7", state: "connected" },
			{ name: "local", state: "failed" },
		]);
		await emit(pi, "session_start", {}, ctx);
		const railWidget = widgets.get("hanniorq-rail");
		const rail =
			typeof railWidget === "function"
				? (railWidget as () => { render(width: number): string[] })().render(32).join("\n")
				: "";
		expect(rail).toContain("MCP");
		expect(rail).toContain("context7");
		expect(rail).toContain("connected");
		expect(rail).toContain("local");
	});

	it("renders the active sheet TODOs and current modified-file snapshot", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		const exec = vi.fn(async () => ({ stdout: " M source.ts\0?? new.ts\0", stderr: "", code: 0, killed: false }));
		(pi as any).exec = exec;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			writeFileSync(join(root, "odd", ".active"), "demo");
			writeFileSync(join(root, "odd", "tasks", "demo.md"), "## Pasos\n- [ ] S1 visible todo\n- [x] S2 completed\n");
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			const widget = widgets.get("hanniorq-rail");
			const rail =
				typeof widget === "function"
					? (widget as () => { render(width: number): string[] })().render(32).join("\n")
					: "";
			expect(rail).toContain("visible todo");
			expect(rail).toContain("source.ts");
			expect(rail).toContain("new.ts");
			expect(exec).toHaveBeenCalledWith("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
				cwd: root,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("/explore envía un turno al modelo pidiendo construir memoria del proyecto", async () => {
		const { registeredCommands, pi, sentMessages } = createMockPi();
		createHanniorqExtension()(pi);
		const handler = registeredCommands.get("explore")!.handler;
		const ctx = { cwd: "C:/proyectos/demo", ui: (pi as any).ui };
		await handler("", ctx);
		expect(sentMessages.length).toBe(1);
		const msg = sentMessages[0];
		expect(msg).toContain("C:/proyectos/demo");
		expect(msg).toContain("mem_save");
		expect(msg).toContain("type=adr");
		expect(msg).toContain("topicKey=adr/");
	});

	it("/hannidump sin memoria avisa y no envía turno", async () => {
		const { registeredCommands, pi, sentMessages } = createMockPi();
		createHanniorqExtension()(pi);
		const handler = registeredCommands.get("hannidump")!.handler;
		const ctx = { cwd: "C:/proyectos/demo", ui: (pi as any).ui };
		// Sin daemon HanniGram (fetch falla → undefined), no hay observaciones.
		await handler("", ctx);
		expect(sentMessages.length).toBe(0);
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
		const line = (widget as string[])[0];
		expect(line).toContain("memoria: +1");
		expect(line).toContain("tools: mem_save, search_files");
		// sin ficha sODD en disco → inactivo
		expect(line).toContain("sODD: inactivo");
	});

	it("marca sODD tocado cuando se usa /task", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		await emit(pi, "turn_start", {}, ctx);
		await emit(pi, "tool_execution_start", { toolName: "task", toolCallId: "t1", args: {} }, ctx);
		await emit(pi, "turn_end", {}, ctx);

		const line = (widgets.get("hanniorq-turn") as string[])[0];
		expect(line).toContain("sODD: activo");
	});

	it("no marca memoria cuando no se escribió", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		await emit(pi, "turn_start", {}, ctx);
		await emit(pi, "tool_execution_start", { toolName: "read_file", toolCallId: "t1", args: {} }, ctx);
		await emit(pi, "turn_end", {}, ctx);

		const line = (widgets.get("hanniorq-turn") as string[])[0];
		expect(line).not.toContain("memoria:");
	});

	it("muestra lecturas y escrituras de memoria en el rail derecho", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };
		await emit(pi, "turn_start", {}, ctx);
		await emit(
			pi,
			"tool_execution_start",
			{ toolName: "mem_save", toolCallId: "t1", args: { title: "decisión ADR" } },
			ctx,
		);
		await emit(
			pi,
			"tool_execution_start",
			{ toolName: "mem_search", toolCallId: "t2", args: { query: "paleta rosa" } },
			ctx,
		);
		const widget = widgets.get("hanniorq-rail");
		const rail =
			typeof widget === "function"
				? (widget as () => { render(width: number): string[] })().render(32).join("\n")
				: "";
		expect(rail).toContain("decisión ADR"); // escritura
		expect(rail).toContain("paleta rosa"); // lectura
		expect(rail).toContain("inactivo"); // sin ficha sODD
	});
});
