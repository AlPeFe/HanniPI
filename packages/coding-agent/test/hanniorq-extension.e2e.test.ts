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
import {
	builtinExtensionEnabled,
	createHanniorqExtension,
	parseGitStatusPaths,
} from "../src/extensions/hanniorq/index.ts";
import { publishMcpConnectionStatuses } from "../src/extensions/mcp/status.ts";

function createMockPi() {
	const registeredCommands = new Map<string, { description: string; handler: (...args: any[]) => any }>();
	const shortcuts = new Map<string, { description?: string; handler: (...args: any[]) => any }>();
	const tools = new Map<string, any>();
	const listeners = new Map<string, ((...args: any[]) => any)[]>();
	const widgets = new Map<string, string[] | ((...args: any[]) => unknown)>();
	const sentMessages: string[] = [];
	let railWidth = 34;
	let railHidden = false;
	let railTasksCollapsed = false;
	/** Patrones del ajuste `extensions` que ve la extensión (tests de MCP desactivado). */
	const extensionOverrides: string[] = [];

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
		getRailHidden: () => railHidden,
		setRailHidden: (hidden: boolean) => {
			railHidden = hidden;
		},
		getRailTasksCollapsed: () => railTasksCollapsed,
		setRailTasksCollapsed: (collapsed: boolean) => {
			railTasksCollapsed = collapsed;
		},
		getContextUsage: () => undefined,
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
		getSettings: () => ({ extensions: extensionOverrides }),
		sendUserMessage: (content: string) => {
			sentMessages.push(content);
		},
		ui,
	} as unknown as Parameters<ExtensionFactory>[0];

	return { registeredCommands, shortcuts, tools, listeners, widgets, ui, pi, sentMessages, extensionOverrides };
}

async function emit(pi: ReturnType<typeof createMockPi>["pi"], event: string, payload: any, ctx: any) {
	const handlers = (pi as any).__listeners?.get(event) ?? [];
	for (const h of handlers) await h(payload, ctx);
}

/**
 * Extension sin daemon real: los tests no arrancan procesos ni escriben en la memoria del usuario
 * (la BD real de HanniGram acabo llena de proyectos temporales de tests).
 */
function createHermeticExtension(pi: Parameters<ExtensionFactory>[0]): void {
	createHanniorqExtension({ ensureDaemon: async () => false })(pi);
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
		createHermeticExtension(pi);
		expect(registeredCommands.has("hanniorq")).toBe(true);
		expect(registeredCommands.has("hannigram")).toBe(true);
		expect(registeredCommands.get("hanniorq")!.description).toContain("Orquestador sODD");
		expect(registeredCommands.get("hannigram")!.description).toContain("Memoria del proyecto");
	});

	it("registra /helpme, /hannidump y /explore", () => {
		const { registeredCommands, pi } = createMockPi();
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		expect(rail).toContain("conectado");
		expect(rail).toContain("local");
		expect(rail).toContain("caído");
	});

	it("muestra los servidores de mcp.json aunque la extensión MCP no haya conectado", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const agentDir = mkdtempSync(join(tmpdir(), "hanniorq-mcp-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "hanniorq-mcp-cwd-"));
		const previousAgentDir = process.env.HANNI_CODING_AGENT_DIR;
		process.env.HANNI_CODING_AGENT_DIR = agentDir;
		// Los estados MCP son estado de módulo: se limpian para no arrastrar el test anterior.
		publishMcpConnectionStatuses("test", []);
		try {
			writeFileSync(
				join(agentDir, "mcp.json"),
				JSON.stringify({
					mcpServers: {
						context7: { url: "https://mcp.context7.com/mcp" },
						exa: { command: "npx", args: ["-y", "exa-mcp"], enabled: false },
					},
				}),
			);
			await emit(pi, "session_start", {}, { cwd, ui: (pi as any).ui });
			const rail = railText(widgets, 44);
			expect(rail).toContain("MCP");
			expect(rail).toContain("context7");
			expect(rail).toContain("sin conectar");
			expect(rail).toContain("exa");
			expect(rail).toContain("desactivado");
		} finally {
			if (previousAgentDir === undefined) delete process.env.HANNI_CODING_AGENT_DIR;
			else process.env.HANNI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("el rail avisa cuando el built-in mcp está desactivado en los ajustes", async () => {
		const { listeners, widgets, pi, extensionOverrides } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const agentDir = mkdtempSync(join(tmpdir(), "hanniorq-mcp-off-"));
		const previousAgentDir = process.env.HANNI_CODING_AGENT_DIR;
		process.env.HANNI_CODING_AGENT_DIR = agentDir;
		publishMcpConnectionStatuses("test", []);
		try {
			// Sin servidores y con el built-in excluido: el rail lo dice en vez de quedarse mudo.
			extensionOverrides.push("-builtin:mcp");
			await emit(pi, "session_start", {}, { cwd: agentDir, ui: (pi as any).ui });
			expect(railText(widgets, 44)).toContain("desactivado (-builtin:mcp)");

			// Con servidores configurados pero sin extensión MCP, avisa y los lista.
			writeFileSync(
				join(agentDir, "mcp.json"),
				JSON.stringify({ mcpServers: { local: { command: "mcp-server" } } }),
			);
			await emit(pi, "session_start", {}, { cwd: agentDir, ui: (pi as any).ui });
			const rail = railText(widgets, 44);
			expect(rail).toContain("built-in mcp desactivado");
			expect(rail).toContain("local");
		} finally {
			extensionOverrides.length = 0;
			if (previousAgentDir === undefined) delete process.env.HANNI_CODING_AGENT_DIR;
			else process.env.HANNI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("cierra el turno con la línea hannigram → memory de lo que cambió", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };
		await emit(pi, "turn_start", {}, ctx);

		// Una lectura, un mem_save que crea, otro que actualiza y un borrado.
		for (const [toolName, result, isError] of [
			["mem_search", { content: [{ type: "text", text: "2 resultados" }] }, false],
			["mem_save", { content: [{ type: "text", text: "Saved observation #12: rail" }] }, false],
			["mem_save", { content: [{ type: "text", text: "Updated observation #9: memoria" }] }, false],
			["mem_delete", { content: [{ type: "text", text: "Deleted observation #3" }] }, false],
		] as const) {
			await emit(pi, "tool_execution_start", { toolName, toolCallId: `${toolName}-1`, args: {} }, ctx);
			await emit(pi, "tool_execution_end", { toolName, toolCallId: `${toolName}-1`, result, isError }, ctx);
		}
		await emit(pi, "turn_end", {}, ctx);

		const widget = widgets.get("hanniorq-turn");
		const lines = Array.isArray(widget) ? widget : [];
		expect(lines.join("\n")).toContain("hannigram → memory: +1 nuevo · ~1 update · -1 borrado · ≫1 leído");
	});

	it("no pinta la línea de memoria cuando el turno no la toca", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };
		await emit(pi, "turn_start", {}, ctx);
		await emit(pi, "tool_execution_start", { toolName: "read", toolCallId: "r1", args: {} }, ctx);
		await emit(pi, "turn_execution_end", {}, ctx);
		await emit(pi, "turn_end", {}, ctx);
		const widget = widgets.get("hanniorq-turn");
		const lines = Array.isArray(widget) ? widget : [];
		expect(lines.join("\n")).not.toContain("hannigram → memory");
	});

	it("el rail avisa del contexto y de la compactación inminente", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		await emit(
			pi,
			"session_start",
			{},
			{
				cwd: "C:/x",
				ui: (pi as any).ui,
				getContextUsage: () => ({ tokens: 190_000, contextWindow: 200_000, percent: 95 }),
			},
		);
		const rail = railText(widgets, 40);
		expect(rail).toContain("contexto");
		expect(rail).toContain("95% (190k/200k)");
		expect(rail).toContain("compactación inminente");
	});

	it("builtinExtensionEnabled respeta -builtin, !builtin y +builtin", () => {
		expect(builtinExtensionEnabled([], "mcp")).toBe(true);
		expect(builtinExtensionEnabled(["-builtin:mcp"], "mcp")).toBe(false);
		expect(builtinExtensionEnabled(["!builtin:mcp"], "mcp")).toBe(false);
		expect(builtinExtensionEnabled(["-builtin:mcp", "+builtin:mcp"], "mcp")).toBe(true);
		expect(builtinExtensionEnabled(["-builtin:sodd"], "mcp")).toBe(true);
	});

	it("renders the active sheet TODOs and current modified-file snapshot", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		const exec = vi.fn(async () => ({ stdout: " M source.ts\0?? new.ts\0", stderr: "", code: 0, killed: false }));
		(pi as any).exec = exec;
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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

	it("/hanniorq rail <n> fija el ancho del rail y el toggle lo oculta/muestra", async () => {
		const { registeredCommands, widgets, pi } = createMockPi();
		createHermeticExtension(pi);
		const root = mkdtempSync(join(tmpdir(), "hanniorq-rail-width-"));
		try {
			const ui = (pi as any).ui;
			const ctx = { cwd: root, ui };
			await registeredCommands.get("hanniorq")!.handler("rail 60", ctx);
			expect(ui.getRailWidth()).toBe(60);
			expect(widgets.has("hanniorq-rail")).toBe(true);
			expect(ui.getRailHidden()).toBe(false);

			// El toggle persiste el estado en el ui context (settings); el widget sigue
			// publicado y la TUI lo oculta con la gate rightRailVisible.
			await registeredCommands.get("hanniorq")!.handler("rail", ctx);
			expect(ui.getRailWidth()).toBe(60);
			expect(ui.getRailHidden()).toBe(true);

			await registeredCommands.get("hanniorq")!.handler("rail", ctx);
			expect(ui.getRailHidden()).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("muestra sODD activo con una ficha status:active aunque falte odd/.active", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
		const handler = registeredCommands.get("hannidump")!.handler;
		const ctx = { cwd: "C:/proyectos/demo", ui: (pi as any).ui };
		// Sin daemon HanniGram (fetch falla → undefined), no hay observaciones. El daemon real
		// puede estar corriendo en la maquina de desarrollo (127.0.0.1:8765), asi que se simula
		// que no responde en vez de depender del entorno.
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("daemon caido");
			}),
		);
		try {
			await handler("", ctx);
		} finally {
			vi.unstubAllGlobals();
		}
		expect(sentMessages.length).toBe(0);
	});

	it("genera el widget de fin de turno con tools · sODD · memoria cuando se usa memoria", async () => {
		const { listeners, widgets, pi } = createMockPi();
		// exponer listeners en pi para el helper emit
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const ctx = { cwd: "C:/x", ui: (pi as any).ui };

		// turn_start resetea
		await emit(pi, "turn_start", {}, ctx);
		// el agente usa herramientas: una de memoria + una normal
		await emit(pi, "tool_execution_start", { toolName: "mem_save", toolCallId: "t1", args: {} }, ctx);
		await emit(
			pi,
			"tool_execution_end",
			{
				toolName: "mem_save",
				toolCallId: "t1",
				result: { content: [{ type: "text", text: "Saved observation #1: rail" }] },
				isError: false,
			},
			ctx,
		);
		await emit(pi, "tool_execution_start", { toolName: "search_files", toolCallId: "t2", args: {} }, ctx);
		// fin de turno → widget
		await emit(pi, "turn_end", {}, ctx);

		const widget = widgets.get("hanniorq-turn");
		expect(widget).toBeDefined();
		const lines = widget as string[];
		expect(lines[0]).toContain("tools: mem_save, search_files");
		// La última línea del turno resume la memoria: qué cambió, muy corto.
		expect(lines[lines.length - 1]).toContain("hannigram → memory: +1 nuevo");
		// sin ficha sODD no se pinta nada de sODD (ni "activo" ni "inactivo")
		expect(lines[0]).not.toContain("sODD:");
	});

	it("marca sODD tocado cuando se usa /task", async () => {
		const { listeners, widgets, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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

	it("inyecta el briefing de memoria en el system prompt antes de trabajar", async () => {
		const { listeners, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		// ensureDaemon falso: el test no arranca el daemon real.
		createHermeticExtension(pi);
		const cwd = mkdtempSync(join(tmpdir(), "hanniorq-briefing-"));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown) => {
				const target = String(url);
				if (target.includes("/api/sessions")) {
					return Response.json([
						{
							goal: "arreglar la actualizacion",
							summary: "swap por renombrado de la carpeta de instalacion",
							nextSteps: "revisar hanniorq",
							endedAtUtc: "2026-10-17T14:15:07.157851Z",
						},
					]);
				}
				if (target.includes("/api/observations")) {
					return Response.json([
						{
							id: 7,
							title: "hanni update se mataba a si mismo",
							topicKey: "hannipi/update/windows",
							type: "adr",
						},
					]);
				}
				return new Response("", { status: 404 });
			}),
		);
		try {
			await emit(pi, "session_start", {}, { cwd, ui: (pi as any).ui });
			const sections: Record<string, string> = {};
			const promptGuidelines: string[] = [];
			const event = {
				type: "before_agent_start",
				prompt: "sigue con lo de ayer",
				systemPrompt: "",
				systemPromptOptions: { sections, promptGuidelines },
			};
			await emit(pi, "before_agent_start", event, { cwd, ui: (pi as any).ui });

			const briefing = sections.memoria;
			expect(briefing).toContain("última sesión");
			expect(briefing).toContain("hecho: swap por renombrado de la carpeta de instalacion");
			expect(briefing).toContain("revisar hanniorq");
			expect(briefing).toContain("hanni update se mataba a si mismo");
			expect(promptGuidelines.join(" ")).toContain("mem_context");
			expect(promptGuidelines.join(" ")).toContain("mem_session_summary");

			// Sin daemon no se inventa memoria: ni sección ni guideline.
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error("daemon caido");
				}),
			);
			const other = mkdtempSync(join(tmpdir(), "hanniorq-briefing-off-"));
			try {
				const offlineSections: Record<string, string> = {};
				const offlineEvent = {
					type: "before_agent_start",
					prompt: "hola",
					systemPrompt: "",
					systemPromptOptions: { sections: offlineSections, promptGuidelines: [] },
				};
				await emit(pi, "before_agent_start", offlineEvent, { cwd: other, ui: (pi as any).ui });
				expect(offlineSections.memoria).toBeUndefined();
			} finally {
				rmSync(other, { recursive: true, force: true });
			}
		} finally {
			vi.unstubAllGlobals();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("guarda un handoff rodante si el turno deja trabajo y no hay resumen de sesion", async () => {
		const { listeners, pi } = createMockPi();
		(pi as any).__listeners = listeners;
		createHermeticExtension(pi);
		const cwd = mkdtempSync(join(tmpdir(), "hanniorq-handoff-"));
		mkdirSync(join(cwd, "odd", "tasks"), { recursive: true });
		writeFileSync(join(cwd, "odd", ".active"), "demo");
		writeFileSync(
			join(cwd, "odd", "tasks", "demo.md"),
			"---\nstatus: active\n---\n# demo\n\n## Pasos\n- [x] S1 hecho\n- [ ] S2 pendiente\n",
		);
		const posts: Array<Record<string, any>> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: unknown, init?: any) => {
				if (init?.method === "POST") {
					posts.push(JSON.parse(String(init.body)));
					return Response.json({ id: 1 });
				}
				if (String(url).includes("/api/sessions")) return Response.json([]);
				if (String(url).includes("/api/observations")) return Response.json([]);
				return new Response("", { status: 404 });
			}),
		);
		try {
			const ctx = { cwd, ui: (pi as any).ui };
			await emit(pi, "session_start", {}, ctx);
			await emit(
				pi,
				"before_agent_start",
				{
					type: "before_agent_start",
					prompt: "arregla el rail",
					systemPrompt: "",
					systemPromptOptions: { sections: {}, promptGuidelines: [] },
				},
				ctx,
			);
			await emit(pi, "turn_start", {}, ctx);
			await emit(pi, "turn_end", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 30));

			const handoff = posts.find((p) => p.topicKey === "handoff/actual");
			expect(handoff).toBeDefined();
			expect(handoff!.content).toContain("objetivo: arregla el rail");
			expect(handoff!.content).toContain("en curso: odd/tasks/demo.md (1/2 pasos)");
			expect(handoff!.content).toContain("S2 pendiente");

			// Con un resumen de sesion en el turno, el handoff rodante sobra.
			posts.length = 0;
			await emit(pi, "turn_start", {}, ctx);
			await emit(
				pi,
				"tool_execution_end",
				{ toolName: "mem_session_summary", isError: false, result: { content: [] }, toolCallId: "t1" },
				ctx,
			);
			await emit(pi, "turn_end", {}, ctx);
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(posts.filter((p) => p.topicKey === "handoff/actual")).toEqual([]);

			// Y el briefing de la proxima sesion lee ese estado cuando no hay resumen de sesion.
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: unknown) => {
					if (String(url).includes("/api/sessions")) return Response.json([]);
					if (String(url).includes("/api/observations")) {
						return Response.json([
							{
								topicKey: "handoff/actual",
								type: "handoff",
								createdAtUtc: "2026-10-17T14:20:00.000000Z",
								content:
									"objetivo: arregla el rail\nen curso: odd/tasks/demo.md (1/2 pasos)\nsiguiente: S2 pendiente",
							},
						]);
					}
					return new Response("", { status: 404 });
				}),
			);
			const next = mkdtempSync(join(tmpdir(), "hanniorq-handoff-next-"));
			try {
				const sections: Record<string, string> = {};
				await emit(
					pi,
					"before_agent_start",
					{
						type: "before_agent_start",
						prompt: "sigue",
						systemPrompt: "",
						systemPromptOptions: { sections, promptGuidelines: [] },
					},
					{ cwd: next, ui: (pi as any).ui },
				);
				expect(sections.memoria).toContain("último estado guardado");
				expect(sections.memoria).toContain("S2 pendiente");
			} finally {
				rmSync(next, { recursive: true, force: true });
			}
		} finally {
			vi.unstubAllGlobals();
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("la tool todo pinta las tareas del harness y las marca completadas", async () => {
		const { widgets, tools, pi } = createMockPi();
		createHermeticExtension(pi);
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
		createHermeticExtension(pi);
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
