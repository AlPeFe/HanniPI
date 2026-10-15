import { describe, expect, it } from "vitest";
import type {
	ContextUsage,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
} from "../src/core/extensions/types.ts";
import { contextRailLines, createHanniorqExtension } from "../src/extensions/hanniorq/index.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as ExtensionUIContext["theme"];

/** Monta la extensión y le da un `ctx` con el uso de contexto (el rail lo lee de ahí). */
async function setup(
	usage: ContextUsage | undefined,
	compaction: { enabled?: boolean; reserveTokens?: number } = {},
): Promise<string[]> {
	const handlers = new Map<string, Array<(...args: any[]) => any>>();
	const pi = {
		registerCommand: () => {},
		registerShortcut: () => {},
		registerTool: () => {},
		on: (event: string, handler: (...args: any[]) => any) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getSettings: () => ({ extensions: [], compaction }),
		ui: {},
	} as unknown as Parameters<ExtensionFactory>[0];
	createHanniorqExtension()(pi);

	const ui = {
		notify: () => {},
		setWidget: () => {},
		theme,
	} as unknown as ExtensionUIContext;
	const ctx = {
		cwd: process.cwd(),
		ui,
		getContextUsage: () => usage,
	} as unknown as ExtensionContext;
	for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
	return contextRailLines(theme, 30);
}

const WINDOW = 200_000;
const usageAt = (tokens: number, percent?: number): ContextUsage => ({
	tokens,
	contextWindow: WINDOW,
	percent: percent ?? (tokens / WINDOW) * 100,
});

describe("rail: contexto y compactación", () => {
	it("muestra el porcentaje y el umbral cuando queda margen", async () => {
		const lines = await setup(usageAt(120_000));
		const text = lines.join("\n");
		expect(text).toContain("contexto");
		// 120k/200k = 60%, el umbral con la reserva por defecto (16k) es 184k = 92%.
		expect(text).toContain("60% (120k/200k)");
		expect(text).toContain("compacta a 92%");
	});

	it("avisa cuando la compactación está cerca", async () => {
		const lines = await setup(usageAt(170_000));
		const text = lines.join("\n");
		expect(text).toContain("85% (170k/200k)");
		expect(text).toContain("compacta a 184k");
	});

	it("avisa en inminente cuando ya pasó el umbral", async () => {
		const lines = await setup(usageAt(190_000));
		expect(lines.join("\n")).toContain("compactación inminente");
	});

	it("respeta la reserva configurada y el auto-compact desactivado", async () => {
		// Reserva de 50k → umbral 150k (75%): a 140k aún no llegó, pero está cerca.
		const lines = await setup(usageAt(140_000), { reserveTokens: 50_000 });
		expect(lines.join("\n")).toContain("70% (140k/200k)");
		expect(lines.join("\n")).toContain("compacta a 150k");

		// Con la reserva por defecto (16k) esos mismos 140k aún no avisan.
		expect((await setup(usageAt(140_000))).join("\n")).toContain("compacta a 92%");

		const off = await setup(usageAt(190_000), { enabled: false });
		expect(off.join("\n")).toContain("auto-compact off");
		expect(off.join("\n")).not.toContain("inminente");
	});

	it("no pinta nada sin contexto conocido y lo dice tras una compactación", async () => {
		expect(await setup(undefined)).toEqual([]);
		expect((await setup({ tokens: null, contextWindow: WINDOW, percent: null })).join("\n")).toContain("se estima");
	});
});
