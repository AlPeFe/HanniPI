/**
 * Tests de la extensión `pipeline` (SPEC-006, fase 1).
 *
 * Los tres criterios medibles de la spec están aquí:
 *  1. con 3 roles, en ningún instante hay 2 `running` (assert sobre los eventos de la cola);
 *  2. cancelar el rol 2 deja `cancelled` y el 3 pasa a `running`; cancelar el 1 deja todo
 *     `cancelled` y la ficha marca por dónde se quedó;
 *  3. reanudar tras reinicio reconstruye la cola desde la ficha.
 * Y el gate de tokens en su forma unitaria: la extensión no registra NINGUNA tool.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	activeSheetPath,
	createPipelineExtension,
	DEFAULT_ROLES,
	type PipelineDispatch,
	type PipelineDispatchInput,
	type PipelineDispatchResult,
	PipelineQueue,
	PipelineRunner,
	parsePipelineSection,
	pipelineLines,
	readPipelineFromSheet,
	renderPipeline,
	resolveRoles,
	restoreQueue,
	upsertPipelineSection,
	writePipelineToSheet,
} from "../src/extensions/pipeline/index.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lanzador controlado a mano: cada llamada queda pendiente hasta que el test la suelta. */
function gatedDispatch(): {
	dispatch: PipelineDispatch;
	calls: PipelineDispatchInput[];
	release: (result?: PipelineDispatchResult) => void;
} {
	const calls: PipelineDispatchInput[] = [];
	const waiters: Array<(result: PipelineDispatchResult) => void> = [];
	const dispatch: PipelineDispatch = (input) =>
		new Promise<PipelineDispatchResult>((resolve) => {
			calls.push(input);
			waiters.push(resolve);
			input.signal.addEventListener("abort", () => resolve({ ok: false, note: "abortado" }), { once: true });
		});
	return {
		dispatch,
		calls,
		release: (result = { ok: true }) => waiters.shift()?.(result),
	};
}

function threeCards(): PipelineQueue {
	return new PipelineQueue({ task: "montar la cola", cards: DEFAULT_ROLES.map((role) => ({ role: role.id })) });
}

function statuses(queue: PipelineQueue): string[] {
	return queue.all.map((card) => card.status);
}

describe("pipeline: roles declarativos", () => {
	it("usa la terna explorer → builder → reviewer por defecto", () => {
		expect(resolveRoles(undefined).map((role) => role.id)).toEqual(["explorer", "builder", "reviewer"]);
	});

	it("acepta roles de settings.json, completando label/icon/prompt del rol conocido", () => {
		const roles = resolveRoles({
			pipeline: { roles: [{ id: "explorer" }, { id: "qa", label: "QA", prompt: "prueba" }] },
		});
		expect(roles.map((role) => role.id)).toEqual(["explorer", "qa"]);
		expect(roles[0].label).toBe("Explorer");
		expect(roles[1]).toMatchObject({ label: "QA", prompt: "prueba" });
	});

	it("ignora entradas rotas y cae en la terna por defecto si no queda ninguna", () => {
		expect(
			resolveRoles({ pipeline: { roles: [{ id: "" }, { id: "../evil" }, 42 as never] } }).map((r) => r.id),
		).toEqual(["explorer", "builder", "reviewer"]);
	});
});

describe("pipeline: ejecución estrictamente secuencial", () => {
	it("nunca tiene dos roles running a la vez (assert sobre los eventos de la cola)", async () => {
		const queue = threeCards();
		const gated = gatedDispatch();
		const runner = new PipelineRunner({ queue, roles: DEFAULT_ROLES, dispatch: gated.dispatch });

		const run = runner.run();
		await tick();
		expect(queue.runningCards().map((card) => card.id)).toEqual(["1"]);
		expect(statuses(queue)).toEqual(["running", "queued", "queued"]);

		gated.release();
		await tick();
		expect(queue.runningCards().map((card) => card.id)).toEqual(["2"]);

		gated.release();
		await tick();
		expect(queue.runningCards().map((card) => card.id)).toEqual(["3"]);

		gated.release();
		await run.then(() => tick());

		expect(statuses(queue)).toEqual(["done", "done", "done"]);
		// Ningún evento de la cola vio más de un rol en vuelo.
		expect(queue.history.length).toBeGreaterThan(5);
		expect(queue.history.filter((event) => event.running.length > 1)).toEqual([]);
		expect(queue.history.map((event) => `${event.card}:${event.type}`)).toEqual([
			"1:running",
			"1:done",
			"2:running",
			"2:done",
			"3:running",
			"3:done",
		]);
	});

	it("una tarjeta en error no frena a las siguientes", async () => {
		const queue = threeCards();
		const gated = gatedDispatch();
		const runner = new PipelineRunner({ queue, roles: DEFAULT_ROLES, dispatch: gated.dispatch });
		const run = runner.run();
		await tick();
		gated.release({ ok: false, note: "el explorer falló" });
		await tick();
		gated.release();
		await tick();
		gated.release();
		await run.then(() => tick());

		expect(statuses(queue)).toEqual(["error", "done", "done"]);
		expect(queue.all[0].note).toBe("el explorer falló");
	});
});

describe("pipeline: cancelación", () => {
	it("cancelar el rol 2 (en cola) deja cancelled y el 3 pasa a running", async () => {
		const queue = threeCards();
		const gated = gatedDispatch();
		const runner = new PipelineRunner({ queue, roles: DEFAULT_ROLES, dispatch: gated.dispatch });
		const run = runner.run();
		await tick();

		const outcome = runner.cancel("2");
		expect(outcome).toEqual({ aborted: false, cancelled: ["2"] });
		expect(statuses(queue)).toEqual(["running", "cancelled", "queued"]);

		gated.release();
		await tick();
		expect(queue.runningCards().map((card) => card.id)).toEqual(["3"]);

		gated.release();
		await run.then(() => tick());

		expect(statuses(queue)).toEqual(["done", "cancelled", "done"]);
		expect(queue.history.filter((event) => event.running.length > 1)).toEqual([]);
	});

	it("cancelar el rol 1 (en vuelo) deja todo cancelled, con stoppedAt y sin arrastrar al 3", async () => {
		const queue = threeCards();
		const gated = gatedDispatch();
		const runner = new PipelineRunner({ queue, roles: DEFAULT_ROLES, dispatch: gated.dispatch });
		const run = runner.run();
		await tick();

		const outcome = runner.cancel("1");
		expect(outcome.aborted).toBe(true);
		expect(outcome.cancelled).toEqual(["1", "2", "3"]);
		await run.then(() => tick());

		expect(statuses(queue)).toEqual(["cancelled", "cancelled", "cancelled"]);
		expect(queue.stoppedAt).toBe("1 · explorer");
		// El 3 nunca llegó a lanzarse: una sola llamada al lanzador en toda la ejecución.
		expect(gated.calls.map((call) => call.card.id)).toEqual(["1"]);
		expect(queue.history.filter((event) => event.running.length > 1)).toEqual([]);
	});

	it("el atajo cancela el rol en curso a través de /pipeline", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-cancel-"));
		roots.push(root);
		const gated = gatedDispatch();
		const mock = createMockPi(root, { dispatch: gated.dispatch });

		await mock.command("pipeline", "start algo");
		await tick();
		expect(mock.widgetLines("pipeline").some((line) => line.includes("Running"))).toBe(true);

		mock.shortcut();
		expect(mock.widgetLines("pipeline").some((line) => line.includes("Cancelled"))).toBe(true);
	});

	it("una llamada a subagent que no es el turno en curso se bloquea", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-block-"));
		roots.push(root);
		const gated = gatedDispatch();
		const mock = createMockPi(root, { dispatch: gated.dispatch });

		expect(mock.toolCall("otra-cosa")).toBeUndefined();
		await mock.command("pipeline", "start algo");
		await tick();

		const blocked = mock.toolCall("subagent");
		expect(blocked).toEqual({ block: true, reason: expect.stringContaining("ya hay un rol en vuelo") });
	});
});

describe("pipeline: persistencia en la ficha sODD", () => {
	it("escribe la cola en la ficha activa sin tocar el resto de la ficha", () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-sheet-"));
		roots.push(root);
		const sheet = writeSheet(root, "demo", SHEET);
		const queue = threeCards();

		const slug = writePipelineToSheet(root, queue.snapshot());
		expect(slug).toBe("demo");

		const text = readFileSync(sheet, "utf-8");
		expect(text).toContain("## Pasos");
		expect(text).toContain("- [ ] S1 algo");
		expect(text).toContain("## Siguiente");
		expect(text).toContain("pipeline_task: montar la cola");
		expect(text).toContain("- [queued] 1 · explorer");
		expect(text).toContain("- [queued] 3 · reviewer");

		// Escribir dos veces no duplica la sección.
		writePipelineToSheet(root, queue.snapshot());
		const again = readFileSync(sheet, "utf-8");
		expect(again.match(/## Pipeline/g)?.length).toBe(1);
		expect(again.match(/pipeline:begin/g)?.length).toBe(1);
	});

	it("round-trip: parse(serialize(state)) conserva estados y notas", () => {
		const state = {
			task: "tarea con\nsalto",
			stoppedAt: "2 · builder",
			updatedAt: "2026-10-28T10:00:00.000Z",
			cards: [
				{ id: "1", role: "explorer", status: "done" as const },
				{ id: "2", role: "builder", status: "cancelled" as const, note: "cancelada en vuelo" },
				{ id: "3", role: "reviewer", status: "queued" as const },
			],
		};
		const text = upsertPipelineSection(SHEET, state);
		const parsed = parsePipelineSection(text);
		expect(parsed?.cards).toEqual(state.cards);
		expect(parsed?.stoppedAt).toBe("2 · builder");
		expect(parsed?.task).toBe("tarea con salto");
	});

	it("reanudar tras el reinicio reconstruye la cola desde la ficha y sigue por el rol 2", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-resume-"));
		roots.push(root);
		const sheet = writeSheet(root, "demo", SHEET);
		// Sesión anterior: 1 hecha, 2 a medias (se cortó), 3 pendiente.
		writeFileSync(
			sheet,
			upsertPipelineSection(SHEET, {
				task: "montar la cola",
				updatedAt: "2026-10-28T10:00:00.000Z",
				cards: [
					{ id: "1", role: "explorer", status: "done" },
					{ id: "2", role: "builder", status: "running" },
					{ id: "3", role: "reviewer", status: "queued" },
				],
			}),
		);

		const saved = readPipelineFromSheet(root);
		expect(saved?.slug).toBe("demo");
		const restored = restoreQueue(saved!.state);
		// Un `running` huérfano no está en vuelo: vuelve a la cola.
		expect(statuses(restored)).toEqual(["done", "queued", "queued"]);

		const gated = gatedDispatch();
		const mock = createMockPi(root, { dispatch: gated.dispatch });
		await mock.command("pipeline", "resume");
		await tick();
		expect(gated.calls.map((call) => call.card.role)).toEqual(["builder"]);
		gated.release();
		await tick();
		expect(gated.calls.map((call) => call.card.role)).toEqual(["builder", "reviewer"]);
		gated.release();
		await tick();
		await tick();

		const text = readFileSync(sheet, "utf-8");
		expect(text).toContain("- [done] 1 · explorer");
		expect(text).toContain("- [done] 2 · builder");
		expect(text).toContain("- [done] 3 · reviewer");
		expect(text).toContain("- [ ] S1 algo");
	});
});

describe("pipeline: render", () => {
	it("pinta TAMBIÉN las tarjetas en cola, con rol y estado (Waiting its turn)", () => {
		const queue = threeCards();
		const rows = queue.all.map((card) => ({
			id: card.id,
			role: card.role,
			label: card.role,
			icon: "◎",
			status: card.status,
		}));
		const lines = pipelineLines(rows, { now: 0, title: "pipeline", task: "montar la cola" });
		expect(lines[0]).toContain("pipeline");
		const queued = lines.filter((line) => line.includes("Queued"));
		expect(queued).toHaveLength(3);
		expect(queued[0]).toContain("Waiting its turn");
		expect(queued[0]).toContain("explorer");
	});

	it("renderPipeline oculta el widget cuando no hay filas", () => {
		const widgets = new Map<string, string[] | undefined>();
		const ui = {
			setWidget: (key: string, content?: string[]) => {
				widgets.set(key, content);
			},
		} as never;
		renderPipeline(ui, "pipeline", []);
		expect(widgets.get("pipeline")).toBeUndefined();
		renderPipeline(ui, "pipeline", [{ id: "1", role: "explorer", label: "Explorer", icon: "◎", status: "queued" }]);
		expect(widgets.get("pipeline")?.join("\n")).toContain("Waiting its turn");
	});
});

describe("pipeline: coste de tokens", () => {
	it("no registra ninguna tool ni añade comandos de esquema", () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-tokens-"));
		roots.push(root);
		const mock = createMockPi(root, { dispatch: gatedDispatch().dispatch });
		expect(mock.tools).toEqual([]);
	});
});

describe("pipeline: lanzador real (reuso de la tool subagent)", () => {
	it("pide UNA llamada a subagent por rol, la reclama y encadena al terminar", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-dispatch-"));
		roots.push(root);
		// Sin dispatch inyectado: se ejercita el camino real (sendUserMessage + eventos).
		const mock = createMockPi(root, {});

		await mock.command("pipeline", "start algo");
		await tick();
		expect(mock.sentMessages).toHaveLength(1);
		expect(mock.sentMessages[0]).toContain("[pipeline 1/3 · Explorer]");
		expect(mock.sentMessages[0]).toContain("subagent");

		// Dos llamadas en el mismo turno: la primera es el turno del rol, la segunda se bloquea.
		expect(mock.toolCall("subagent", "call-a")).toBeUndefined();
		expect(mock.toolCall("subagent", "call-b")).toEqual({
			block: true,
			reason: expect.stringContaining("ya hay un rol en vuelo"),
		});

		mock.end("call-a");
		await tick();
		// El rol 1 quedó done y la cola liberó el 2 (nuevo mensaje de turno).
		expect(mock.widgetLines("pipeline").some((line) => line.includes("1 Explorer · Done"))).toBe(true);
		expect(mock.sentMessages).toHaveLength(2);
		expect(mock.sentMessages[1]).toContain("[pipeline 2/3 · Builder]");
	});

	it("un subagente con error deja la tarjeta en error y sigue con el siguiente rol", async () => {
		const root = mkdtempSync(join(tmpdir(), "pipeline-dispatch-error-"));
		roots.push(root);
		const mock = createMockPi(root, {});

		await mock.command("pipeline", "start algo");
		await tick();
		mock.toolCall("subagent", "call-a");
		mock.end("call-a", true);
		await tick();

		expect(mock.widgetLines("pipeline").some((line) => line.includes("Error"))).toBe(true);
		expect(mock.sentMessages[1]).toContain("[pipeline 2/3 · Builder]");
	});
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const SHEET = `---
topic_key: odd/demo/tasks
status: active
base: abc1234
---
# Demo

Objetivo: probar la cola.

## Pasos

- [ ] S1 algo

## Siguiente

S1: algo
`;

function writeSheet(root: string, slug: string, content: string): string {
	mkdirSync(join(root, "odd", "tasks"), { recursive: true });
	writeFileSync(join(root, "odd", ".active"), slug);
	const path = activeSheetPath(root, slug)!;
	writeFileSync(path, content);
	return path;
}

/** pi falso: captura comandos, atajos, listeners, widgets y tools registradas. */
function createMockPi(
	root: string,
	options: { dispatch?: PipelineDispatch; settings?: Record<string, unknown> } = {},
): {
	tools: string[];
	sentMessages: string[];
	command: (name: string, args: string) => Promise<void>;
	shortcut: () => void;
	emit: (event: string, payload: unknown) => unknown[];
	toolCall: (toolName: string, toolCallId?: string) => unknown;
	end: (toolCallId: string, isError?: boolean) => unknown[];
	widgetLines: (key: string) => string[];
} {
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const shortcuts = new Map<string, { handler: (ctx: unknown) => void }>();
	const listeners = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const widgets = new Map<string, string[] | undefined>();
	const notifications: string[] = [];
	const tools: string[] = [];
	const sentMessages: string[] = [];

	const ui = {
		notify: (message: string) => notifications.push(message),
		setWidget: (key: string, content?: string[] | undefined) => {
			if (content === undefined) widgets.delete(key);
			else widgets.set(key, content);
		},
		getRailWidth: () => 80,
	};

	const pi = {
		on: (event: string, handler: (payload: unknown, ctx: unknown) => unknown) => {
			const list = listeners.get(event) ?? [];
			list.push(handler);
			listeners.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, opts);
		},
		registerShortcut: (_key: string, opts: { handler: (ctx: unknown) => void }) => {
			shortcuts.set(_key, opts);
		},
		registerTool: (tool: { name: string }) => tools.push(tool.name),
		getSettings: () => options.settings ?? {},
		getActiveTools: () => [],
		getAllTools: () => [],
		sendUserMessage: (text: string) => {
			sentMessages.push(text);
		},
		exec: vi.fn(),
	} as unknown as ExtensionAPI;

	createPipelineExtension({ ...(options.dispatch ? { dispatch: options.dispatch } : {}) })(pi);

	const ctx = { cwd: root, ui, mode: "tui", hasUI: true } as unknown;
	const emit = (event: string, payload: unknown): unknown[] =>
		(listeners.get(event) ?? []).map((handler) => handler(payload, ctx));

	return {
		tools,
		sentMessages,
		command: async (name: string, args: string) => {
			const command = commands.get(name);
			if (!command) throw new Error(`comando no registrado: ${name}`);
			await command.handler(args, ctx);
		},
		shortcut: () => {
			const shortcut = [...shortcuts.values()][0];
			if (!shortcut) throw new Error("atajo no registrado");
			shortcut.handler(ctx);
		},
		emit,
		toolCall: (toolName: string, toolCallId = "id-1") =>
			emit("tool_call", { type: "tool_call", toolCallId, toolName, input: {} })[0],
		end: (toolCallId: string, isError = false) =>
			emit("tool_execution_end", {
				type: "tool_execution_end",
				toolCallId,
				toolName: "subagent",
				isError,
				result: {},
			}),
		widgetLines: (key: string) => widgets.get(key) ?? [],
	};
}
