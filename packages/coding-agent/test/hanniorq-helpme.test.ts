import { describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { BUILTIN_SLASH_COMMANDS } from "../src/core/slash-commands.ts";
import { createHanniorqExtension, helpRows } from "../src/extensions/hanniorq/index.ts";

type Handler = (args: string, ctx: unknown) => Promise<void>;

/** Monta la extensión y ejecuta su `/helpme` real, devolviendo lo registrado y el texto pintado. */
async function runHelpme(): Promise<{ registered: string[]; text: string }> {
	const commands = new Map<string, { description?: string; handler: Handler }>();
	const pi = {
		registerCommand: (name: string, options: { description?: string; handler: Handler }) =>
			commands.set(name, options),
		registerShortcut: () => {},
		registerTool: () => {},
		on: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getSettings: () => ({ extensions: [], compaction: {} }),
		// Como el registro real: los comandos de extensión salen de aquí.
		getCommands: () =>
			[...commands.entries()].map(([name, options]) => ({
				name,
				description: options.description,
				source: "extension" as const,
				sourceInfo: { path: "test" },
			})),
		ui: {},
	} as unknown as Parameters<ExtensionFactory>[0];
	createHanniorqExtension()(pi);

	let text = "";
	const ctx = {
		cwd: process.cwd(),
		ui: {
			notify: (message: string) => {
				text = message;
			},
			select: async () => undefined,
		},
	};
	await commands.get("helpme")?.handler("", ctx);
	return { registered: [...commands.keys()].filter((name) => name !== "helpme"), text };
}

describe("/helpme: el listado no se queda corto", () => {
	it("incluye todos los comandos que registra la extensión", async () => {
		const { registered, text } = await runHelpme();
		expect(registered.length).toBeGreaterThan(5);
		for (const name of registered) expect(text).toContain(`/${name}`);
	});

	it("incluye todos los comandos de core", async () => {
		const { text } = await runHelpme();
		for (const command of BUILTIN_SLASH_COMMANDS) expect(text).toContain(`/${command.name}`);
	});

	it("un comando sin uso en el mapa sale igualmente, con su nombre", () => {
		const { hannipi } = helpRows([{ name: "sin-mapa", description: "hace algo" }]);
		expect(hannipi).toEqual([{ cmd: "/sin-mapa", desc: "hace algo" }]);
	});

	it("pone /helpme primero y muestra la firma de los comandos con uso conocido", () => {
		const { hannipi } = helpRows([{ name: "task" }, { name: "helpme" }, { name: "extract" }]);
		expect(hannipi.map((row) => row.cmd)).toEqual([
			"/helpme",
			"/extract [--dir <ruta>] [--overwrite|--version]",
			"/task new|list|plan <petición>",
		]);
	});
});
