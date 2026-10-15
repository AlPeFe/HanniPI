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
	const shortcuts = new Map<string, { description?: string; handler: (...args: any[]) => any }>();
	const tools = new Map<string, any>();
	const listeners = new Map<string, ((...args: any[]) => any)[]>();
	const widgets = new Map<string, string[] | ((...args: any[]) => unknown)>();
	const sentMessages: string[] = [];
	let railWidth = 34;

	const ui = {
		notify: () => {},
		select: async () => undefined,
		setWidget: (name: string, lines?: string[] | ((...args: any[]) => unknown)) => {
			if (lines === undefined) widgets.delete(name);
			else widgets.set(name, lines);
		},
		getRailWidth: () => railWidth,
		setRailWidth: (width: number) => {
			railWidth = Math.max(20, Math.min(100, Math.round(width)));
			return railWidth;
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
		registerShortcut: (shortcut: string, def: { description?: string; handler: (...args: any[]) => any }) => {
			shortcuts.set(shortcut, def);
		},
		registerTool: (def: { name: string }) => {
			tools.set(def.name, def);
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

	return { registeredCommands, shortcuts, tools, listeners, widgets, ui, pi, sentMessages };
}

async function emit(pi: ReturnType<typeof createMockPi>["pi"], event: string, payload: any, ctx: any) {
	const handlers = (pi as any).__listeners?.get(event) ?? [];
	for (const h of handlers) await h(payload, ctx);
}

/** Texto del widget del rail derecho, renderizado al ancho dado (por defecto, el de la TUI). */
function railText(widgets: Map<string, string[] | ((...args: any[]) => unknown)>, width = 32): string {
	const widget = widgets.get("hanniorq-rail");
	return typeof widget === "function"
		? (widget as () => { render(width: number): string[] })().render(width).join("\n")
		: "";
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

	it("lista los pasos aunque la ficha no use la sección ## Pasos", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-tasks-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			writeFileSync(join(root, "odd", ".active"), "demo");
			writeFileSync(
				join(root, "odd", "tasks", "demo.md"),
				"---\nstatus: active\n---\n# demo\n## Tasks\n- [x] S1 hecho\n- [ ] S2 pendiente visible\n",
			);
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(railText(widgets)).toContain("pendiente visible");
			expect(railText(widgets)).toContain("tareas (1/2)");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("envuelve las tareas largas y las muestra enteras al ensanchar el rail", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-wrap-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			writeFileSync(join(root, "odd", ".active"), "demo");
			const long = "S1 redimensionar el rail derecho desde la TUI con atajos de teclado y un comando";
			writeFileSync(join(root, "odd", "tasks", "demo.md"), `---\nstatus: active\n---\n## Pasos\n- [ ] ${long}\n`);
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));

			// Ancho estrecho: el texto se reparte en varias líneas, no se corta a la primera.
			const narrow = railText(widgets, 34).split("\n");
			expect(narrow.some((line) => line.includes("comando"))).toBe(true);

			// Más ancho: cabe en menos líneas.
			const wide = railText(widgets, 100).split("\n");
			expect(wide.find((line) => line.includes("redimensionar"))).toContain("comando");
			expect(wide.length).toBeLessThan(narrow.length);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("/hanniorq rail <n> fija el ancho del rail", async () => {
		const { registeredCommands, widgets, pi } = createMockPi();
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-width-"));
		try {
			const ui = (pi as any).ui;
			const ctx = { cwd: root, ui };
			await registeredCommands.get("hanniorq")!.handler("rail 60", ctx);
			expect(ui.getRailWidth()).toBe(60);
			expect(widgets.has("hanniorq-rail")).toBe(true);

			await registeredCommands.get("hanniorq")!.handler("rail", ctx);
			expect(ui.getRailWidth()).toBe(60);
			expect(widgets.has("hanniorq-rail")).toBe(false);

			// Deja el rail visible otra vez: el estado es de módulo y afectaría a los tests siguientes.
			await registeredCommands.get("hanniorq")!.handler("rail", ctx);
			expect(widgets.has("hanniorq-rail")).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("muestra sODD activo con una ficha status:active aunque falte odd/.active", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-status-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			// Sin odd/.active: el indicador cae a la ficha con status: active.
			writeFileSync(
				join(root, "odd", "tasks", "demo.md"),
				"---\nstatus: active\n---\n# demo\n## Pasos\n- [ ] S1 paso\n",
			);
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(railText(widgets)).toContain("sODD");
			expect(railText(widgets)).toContain("activo");
			expect(railText(widgets)).not.toContain("inactivo");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("sODD activo muestra working durante el turno y not working en reposo", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-work-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			writeFileSync(join(root, "odd", ".active"), "demo");
			writeFileSync(join(root, "odd", "tasks", "demo.md"), "---\nstatus: active\n---\n## Pasos\n- [ ] S1\n");
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(railText(widgets)).toContain("not working");

			await emit(pi, "turn_start", {}, ctx);
			expect(railText(widgets)).toContain("working");
			expect(railText(widgets)).not.toContain("not working");

			await emit(pi, "turn_end", {}, ctx);
			expect(railText(widgets)).toContain("not working");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("la tecla del rail pliega y despliega los pasos", async () => {
		const { listeners, widgets, shortcuts, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-toggle-"));
		try {
			mkdirSync(join(root, "odd", "tasks"), { recursive: true });
			writeFileSync(join(root, "odd", ".active"), "demo");
			writeFileSync(join(root, "odd", "tasks", "demo.md"), "## Pasos\n- [ ] S1 paso visible\n");
			const ctx = { cwd: root, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(railText(widgets)).toContain("paso visible");

			const shortcut = shortcuts.get("ctrl+alt+t");
			expect(shortcut).toBeDefined();
			await shortcut!.handler(ctx);
			expect(railText(widgets)).not.toContain("paso visible");
			expect(railText(widgets)).toContain("plegadas");

			await shortcut!.handler(ctx);
			expect(railText(widgets)).toContain("paso visible");
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
		// sin ficha sODD no se pinta nada de sODD (ni "activo" ni "inactivo")
		expect(line).not.toContain("sODD:");
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
		expect(rail).not.toContain("inactivo"); // sin ficha sODD no se pinta inactivo
	});

	it("la tool todo pinta las tareas del harness y las marca completadas", async () => {
		const { widgets, tools, pi } = createMockPi();
		createHanniorqExtension()(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };
		const todo = tools.get("todo");
		expect(todo).toBeDefined();

		await todo.execute(
			"t1",
			{
				todos: [
					{ text: "S1 hecho", status: "completed" },
					{ text: "S2 en curso", status: "in_progress" },
					{ text: "S3 pendiente", status: "pending" },
				],
			},
			undefined,
			undefined,
			ctx,
		);
		const rail = railText(widgets);
		expect(rail).toContain("tareas (1/3)");
		expect(rail).toContain("S1 hecho");
		expect(rail).toContain("S2 en curso");
		expect(rail).toContain("S3 pendiente");

		// Una lista nueva limpia las tareas anteriores.
		await todo.execute("t2", { todos: [{ text: "N1 nueva", status: "pending" }] }, undefined, undefined, ctx);
		expect(railText(widgets)).toContain("N1 nueva");
		expect(railText(widgets)).not.toContain("S1 hecho");
	});

	it("el rail indica si la memoria quedó igual, con altas o con bajas", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHanniorqExtension()(pi);
		const fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ status: "ok" }) }));
		vi.stubGlobal("fetch", fetchStub);
		try {
			const ctx = { cwd: "C:/x", ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(railText(widgets)).toContain("ON");
			expect(railText(widgets)).toContain("igual");
			expect(railText(widgets)).not.toContain("obs");

			await emit(
				pi,
				"tool_execution_start",
				{ toolName: "mem_save", toolCallId: "t1", args: { title: "algo" } },
				ctx,
			);
			expect(railText(widgets)).toContain("nuevo");

			await emit(pi, "tool_execution_start", { toolName: "mem_delete", toolCallId: "t2", args: { id: 3 } }, ctx);
			expect(railText(widgets)).toContain("nuevo + borrado");
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
