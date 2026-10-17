/**
 * Prueba de los handlers de /hannigram contra el daemon HanniGram REAL.
 * - status: health + observaciones recientes del proyecto
 * - adr: guarda una ADR de verdad en la BD
 *
 * ESCRIBE en la memoria del usuario, asi que queda DESACTIVADO por defecto: el resto de tests
 * aislan HanniGram con un puerto muerto (packages/coding-agent/vitest.config.ts) y este se abre a
 * proposito. Para lanzarlo:
 *
 *   HANNIGRAM_E2E=1 HANNIGRAM_URL=http://127.0.0.1:8765 \
 *     node ../../node_modules/vitest/dist/cli.js --run test/hannigram-daemon.e2e.test.ts
 */
import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createHanniorqExtension } from "../src/extensions/hanniorq/index.ts";

const runE2E = process.env.HANNIGRAM_E2E === "1";

type Handler = (args: string, ctx: any) => Promise<void> | void;

function loadHandlers() {
	const commands = new Map<string, { description: string; handler: Handler }>();
	const notifications: { type: string; message: string }[] = [];
	const ui = {
		notify: (message: string, type: string = "info") => notifications.push({ type, message }),
		setWidget: () => {},
	};
	const pi = {
		registerCommand: (name: string, def: { description: string; handler: Handler }) => commands.set(name, def),
		on: () => {},
		ui,
	} as unknown as Parameters<ExtensionFactory>[0];
	createHanniorqExtension()(pi);
	return { commands, notifications };
}

describe.skipIf(!runE2E)("/hannigram contra daemon real", () => {
	it("status devuelve daemon OK con observaciones del proyecto", async () => {
		const { commands, notifications } = loadHandlers();
		const ctx = {
			cwd: "C:/Users/alexlocal/projects/AlPeFePI",
			ui: { notify: (m: string, t?: string) => notifications.push({ type: t ?? "info", message: m }) },
		};
		await commands.get("hannigram")!.handler("status", ctx);
		// el daemon respondió → notify info con HanniGram: ok
		const info = notifications.filter((n) => n.type === "info");
		expect(info.length).toBeGreaterThan(0);
		expect(info[0].message).toContain("HanniGram:");
		expect(info[0].message).toContain("ok");
	});

	it("adr guarda una decisión real en la BD", async () => {
		const { commands, notifications } = loadHandlers();
		const ctx = {
			cwd: "C:/Users/alexlocal/projects/AlPeFePI",
			ui: { notify: (m: string, t?: string) => notifications.push({ type: t ?? "info", message: m }) },
		};
		const stamp = `e2e-adr-${Date.now()}`;
		await commands.get("hannigram")!.handler(`adr ${stamp} Decision de prueba e2e guardada desde el test`, ctx);
		const info = notifications.filter((n) => n.type === "info" && n.message.startsWith("ADR guardada"));
		expect(info.length).toBe(1);
		expect(info[0].message).toContain(`adr/${stamp}`);
		expect(info[0].message).toMatch(/#\d+\)?$/);
	});
});
