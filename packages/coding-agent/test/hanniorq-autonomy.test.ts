import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import {
	autoOutcome,
	createHanniorqExtension,
	parseFrontmatter,
	parseGoalArgs,
	parseGoalSheet,
	setSheetFields,
	sheetSteps,
	splitArgs,
} from "../src/extensions/hanniorq/index.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as ExtensionUIContext["theme"];

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** Monta la extensión y devuelve sus comandos + lo que se envía al agente y se notifica. */
function mount(): {
	run: (args: string, cwd: string) => Promise<void>;
	settle: (cwd: string) => Promise<void>;
	sent: string[];
	notices: string[];
} {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
	const commands = new Map<string, { handler: Handler }>();
	const sent: string[] = [];
	const notices: string[] = [];
	const pi = {
		registerCommand: (name: string, options: { handler: Handler }) => commands.set(name, options),
		registerShortcut: () => {},
		registerTool: () => {},
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getSettings: () => ({ extensions: [], compaction: {} }),
		getCommands: () => [],
		sendUserMessage: (text: string) => sent.push(text),
		ui: {},
	} as unknown as Parameters<ExtensionFactory>[0];
	createHanniorqExtension()(pi);

	const run = async (args: string, cwd: string): Promise<void> => {
		await commands.get("hanniorq")?.handler(args, { cwd, ui: uiFor(cwd, notices), getContextUsage: () => undefined });
	};
	const settle = async (cwd: string): Promise<void> => {
		for (const handler of handlers.get("agent_settled") ?? []) {
			await handler({ type: "agent_settled" }, { cwd, ui: uiFor(cwd, notices), getContextUsage: () => undefined });
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	};
	return { run, settle, sent, notices };
}

/** UI mínima que aguanta el rail (paneles, tema, widgets). */
function uiFor(_cwd: string, notices: string[]): Record<string, unknown> {
	return {
		notify: (message: string) => notices.push(message),
		setWidget: () => {},
		getRailTasksCollapsed: () => false,
		getRailWidth: () => 34,
		theme,
	};
}

function project(): string {
	return mkdtempSync(join(tmpdir(), "hanniorq-auto-"));
}

const SHEET = [
	"---",
	"topic_key: demo/feat/x",
	"status: active",
	"goal: arreglar el rail",
	"done_when:",
	"  - el rail muestra iconos",
	"verify: [npm run check]",
	"autonomy: guarded",
	"max_iterations: 4",
	"max_tokens: 50000",
	"---",
	"# x",
	"",
	"## Pasos",
	"- [x] S1 explorar — a1b2c3d",
	"- [ ] S2 implementar (verify: node --test test/x.test.ts)",
	"- [ ] S3 documentar",
	"",
	"## Siguiente",
	"S2: implementar",
].join("\n");

describe("goal en el frontmatter", () => {
	it("lee goal, criterios, verificación, autonomía y límites", () => {
		const sheet = parseGoalSheet(SHEET);
		expect(sheet.goal).toBe("arreglar el rail");
		expect(sheet.doneWhen).toEqual(["el rail muestra iconos"]);
		expect(sheet.verify).toEqual(["npm run check"]);
		expect(sheet.autonomy).toBe("guarded");
		expect(sheet.limits).toEqual({ maxIterations: 4, maxIdle: 1, maxTokens: 50_000 });
	});

	it("una ficha sin frontmatter no tiene goal ni autonomía", () => {
		const sheet = parseGoalSheet("## Pasos\n- [ ] S1 algo");
		expect(sheet.goal).toBeUndefined();
		expect(sheet.autonomy).toBe("off");
	});

	it("reescribe un campo conservando el resto del fichero y su orden", () => {
		const next = setSheetFields(SHEET, { autonomy: "off", goal: "otro objetivo: con dos puntos" });
		expect(next).toContain("autonomy: off");
		expect(next).toContain('goal: "otro objetivo: con dos puntos"');
		expect(next).toContain("- [ ] S3 documentar");
		expect(parseGoalSheet(next).doneWhen).toEqual(["el rail muestra iconos"]);
	});

	it("crea el frontmatter si la ficha no lo tiene y borra con undefined", () => {
		const created = setSheetFields("# ficha\n", { goal: "x", autonomy: "guarded" });
		expect(created.startsWith("---\ngoal: x\nautonomy: guarded\n---\n# ficha")).toBe(true);
		const removed = setSheetFields(created, { autonomy: undefined });
		expect(removed).not.toContain("autonomy:");
		expect(removed).toContain("goal: x");
	});

	it("acepta listas de bloque e inline", () => {
		const fields = parseFrontmatter("---\na:\n  - uno\n  - dos\nb: [tres, 'cuatro']\n---\n");
		expect(fields.get("a")).toEqual(["uno", "dos"]);
		expect(fields.get("b")).toEqual(["tres", "cuatro"]);
	});
});

describe("pasos de la ficha", () => {
	it("saca id, estado y texto solo de ## Pasos", () => {
		const steps = sheetSteps(SHEET);
		expect(steps.map((step) => [step.id, step.done])).toEqual([
			["S1", true],
			["S2", false],
			["S3", false],
		]);
		expect(steps[1]?.text).toContain("verify: node --test");
	});

	it("sin sección ## Pasos no hay pasos (aunque haya checkboxes en Notas)", () => {
		expect(sheetSteps("## Notas\n- [ ] idea")).toEqual([]);
	});
});

describe("bucle desatendido: guardas en orden", () => {
	const base = { stepsRun: 0, maxSteps: 3, idle: 0, maxIdle: 1, tokens: 0, maxTokens: 1000, pending: 2 };

	it("sin pasos pendientes para y lo dice", () => {
		expect(autoOutcome({ ...base, pending: 0 })).toEqual({
			stop: true,
			reason: "plan terminado: no quedan pasos pendientes",
		});
	});

	it("respeta el techo de pasos de la invocación", () => {
		expect(autoOutcome({ ...base, stepsRun: 3 }).reason).toContain("3 de 3");
	});

	it("para cuando no hay progreso, antes de mirar el presupuesto", () => {
		const outcome = autoOutcome({ ...base, idle: 1, tokens: 5000 });
		expect(outcome.reason).toContain("sin progreso");
	});

	it("corta al agotar el presupuesto de tokens", () => {
		expect(autoOutcome({ ...base, tokens: 1000 }).reason).toContain("presupuesto agotado");
	});

	it("sigue cuando hay margen", () => {
		expect(autoOutcome(base)).toEqual({ stop: false, reason: "" });
	});
});

describe("argumentos de /hanniorq goal", () => {
	it("respeta comillas y admite flags repetibles", () => {
		const args = parseGoalArgs(
			'"arreglar el rail y sus tareas" --done "iconos por fila" --verify "npm run check" --max-tokens 40000',
		);
		expect(args.goal).toBe("arreglar el rail y sus tareas");
		expect(args.doneWhen).toEqual(["iconos por fila"]);
		expect(args.verify).toEqual(["npm run check"]);
		expect(args.maxTokens).toBe(40_000);
		expect(args.maxIterations).toBeUndefined();
	});

	it("splitArgs no rompe palabras sin comillas", () => {
		expect(splitArgs("a b  c")).toEqual(["a", "b", "c"]);
	});
});

describe("/hanniorq goal|autonomy|auto|stop", () => {
	it("crea la ficha con el goal en el frontmatter y no lanza nada", async () => {
		const cwd = project();
		const { run, sent, notices } = mount();
		await run('goal "arreglar el rail" --done "iconos" --verify "npm run check"', cwd);
		const text = readFileSync(join(cwd, "odd", "tasks", "arreglar-el-rail.md"), "utf-8");
		expect(text).toContain("goal: arreglar el rail");
		expect(text).toContain("  - iconos");
		expect(text).toContain("verify:");
		expect(text).toContain("autonomy: off");
		expect(readFileSync(join(cwd, "odd", ".active"), "utf-8")).toBe("arreglar-el-rail");
		expect(sent).toEqual([]);
		expect(notices.join("\n")).toContain("autonomía: off");
	});

	it("auto se niega con autonomía apagada y arranca al encenderla", async () => {
		const cwd = project();
		const { run, sent, notices } = mount();
		await run('goal "arreglar el rail"', cwd);
		const path = join(cwd, "odd", "tasks", "arreglar-el-rail.md");
		await run("auto", cwd);
		expect(sent).toEqual([]);
		expect(notices.join("\n")).toContain("Autonomía apagada");

		await run("autonomy on", cwd);
		expect(readFileSync(path, "utf-8")).toContain("autonomy: guarded");
		// Sin pasos pendientes no hay nada que ejecutar.
		await run("auto", cwd);
		expect(sent).toEqual([]);
		expect(notices.join("\n")).toContain("No quedan pasos pendientes");

		// Con un paso pendiente, arranca y manda el prompt del paso (sin planificar).
		writeFileSync(
			path,
			readFileSync(path, "utf-8").replace("## Pasos\n", "## Pasos\n- [ ] S1 implementar (verify: true)\n"),
		);
		await run("auto 2", cwd);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("hanniorq auto · iteración 1/2");
		expect(sent[0]).toContain("S1 implementar");
		expect(sent[0]).toContain("nada de reescribir el plan");
		await run("stop", cwd);
	});
});

describe("bucle: encadena pasos y para solo", () => {
	/** Ficha con dos pasos pendientes y autonomía encendida. */
	async function startRun(): Promise<{
		cwd: string;
		path: string;
		run: (args: string, cwd: string) => Promise<void>;
		settle: (cwd: string) => Promise<void>;
		sent: string[];
		notices: string[];
	}> {
		const cwd = project();
		const mounted = mount();
		await mounted.run("stop", cwd); // el bucle es estado de módulo: se limpia entre tests
		await mounted.run('goal "arreglar el rail"', cwd);
		const path = join(cwd, "odd", "tasks", "arreglar-el-rail.md");
		writeFileSync(
			path,
			readFileSync(path, "utf-8").replace(
				"## Pasos",
				["## Pasos", "- [ ] S1 implementar (verify: true)", "- [ ] S2 documentar"].join("\n"),
			),
		);
		await mounted.run("autonomy on", cwd);
		return { cwd, path, ...mounted };
	}

	it("manda el siguiente paso cuando el anterior deja rastro, y para sin progreso", async () => {
		const { cwd, path, run, settle, sent, notices } = await startRun();
		await run("auto 3", cwd);
		expect(sent).toHaveLength(1);

		// El agente hizo el paso: S1 marcado.
		writeFileSync(path, readFileSync(path, "utf-8").replace("- [ ] S1 implementar", "- [x] S1 implementar"));
		await settle(cwd);
		expect(sent).toHaveLength(2);
		expect(sent[1]).toContain("iteración 2/3");
		expect(sent[1]).toContain("S2 documentar");

		// Nada cambió: una iteración sin progreso corta el bucle.
		await settle(cwd);
		expect(sent).toHaveLength(2);
		expect(notices.join("\n")).toContain("sin progreso");
	});

	it("para al llegar al techo de pasos de la invocación", async () => {
		const { cwd, path, run, settle, sent, notices } = await startRun();
		await run("auto 1", cwd);
		expect(sent).toHaveLength(1);
		writeFileSync(path, readFileSync(path, "utf-8").replace("- [ ] S1 implementar", "- [x] S1 implementar"));
		await settle(cwd);
		expect(sent).toHaveLength(1);
		expect(notices.join("\n")).toContain("1 de 1");
	});

	it("para cuando se acaban los pasos", async () => {
		const { cwd, path, run, settle, sent, notices } = await startRun();
		await run("auto 5", cwd);
		let text = readFileSync(path, "utf-8");
		text = text
			.replace("- [ ] S1 implementar", "- [x] S1 implementar")
			.replace("- [ ] S2 documentar", "- [x] S2 documentar");
		writeFileSync(path, text);
		await settle(cwd);
		expect(sent).toHaveLength(1);
		expect(notices.join("\n")).toContain("plan terminado");
	});

	it("/hanniorq stop corta el bucle y deja la ficha abierta", async () => {
		const { cwd, run, sent, notices } = await startRun();
		await run("auto 3", cwd);
		expect(sent).toHaveLength(1);
		await run("stop", cwd);
		expect(notices.join("\n")).toContain("detenido por ti");
		expect(readFileSync(join(cwd, "odd", ".active"), "utf-8")).toBe("arreglar-el-rail");
	});
});
