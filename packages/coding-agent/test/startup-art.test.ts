import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { foregroundAnsi, rgbColor, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	HANNI_MASCOT_ART,
	HANNI_MASCOT_WIDTH,
	HanniMascotComponent,
	hanniMascotLines,
	STARTUP_ART_MIN_COLUMNS,
	startupArtSupportsColor,
} from "../src/modes/interactive/components/hanni-mascot.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * SPEC-008 B: escena de arranque de la TUI. Se pinta una vez al montar, desaparece al primer
 * mensaje y nunca se pinta fuera de la TUI (`--print`, `--mode json`, RPC).
 */
const ART_MARKERS = ["tu conejita de código", "hanni♥", "█", "▀", "▄"];
const INFO = { version: "1.2.3-hannipi", model: "stub-1", cwd: "~/proyecto" };

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;

/** Proveedor falso: un turno real de `--print` sin red y sin credenciales. */
const STUB_PROVIDER = `
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export default function (pi) {
	pi.registerProvider("stub", {
		baseUrl: "http://127.0.0.1:9",
		api: "stub-api",
		apiKey: "stub-key",
		models: [
			{
				id: "stub-1",
				name: "Stub",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8000,
				maxTokens: 1024,
			},
		],
		streamSimple: (model) => {
			const stream = createAssistantMessageEventStream();
			const output = {
				role: "assistant",
				content: [{ type: "text", text: "respuesta del stub" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: output });
			stream.push({ type: "text_start", contentIndex: 0, partial: output });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "respuesta del stub", partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: "respuesta del stub", partial: output });
			stream.push({ type: "done", reason: "stop", message: output });
			stream.end();
			return stream;
		},
	});
}
`;

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface CliDirs {
	projectDir: string;
	agentDir: string;
}

function createProject(): CliDirs {
	const root = mkdtempSync(join(tmpdir(), "pi-startup-art-"));
	tempDirs.push(root);
	const projectDir = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(join(projectDir, ".pi", "extensions"), { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(projectDir, ".pi", "extensions", "stub-provider.ts"), STUB_PROVIDER);
	writeFileSync(
		join(projectDir, ".pi", "settings.json"),
		JSON.stringify({ extensions: [".pi/extensions/stub-provider.ts"] }),
	);
	return { projectDir, agentDir };
}

async function runCli(args: string[], dirs: CliDirs): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...args], {
			cwd: dirs.projectDir,
			env: { ...process.env, [ENV_AGENT_DIR]: dirs.agentDir, PI_OFFLINE: "1" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ stdout, stderr, code }));
	});
}

describe("display.startupArt (SPEC-008 B)", () => {
	beforeAll(() => {
		initTheme("dark", false);
	});

	it("con arte activo, pinta las 6 líneas del dibujo con los datos de la sesión a la derecha", async () => {
		const scene = new HanniMascotComponent({ color: true, getInfo: () => INFO }).render(120);

		expect(scene).toHaveLength(6);

		// Dibujo: todas las filas miden lo mismo y sólo usan bloques.
		expect(HANNI_MASCOT_ART).toHaveLength(6);
		for (const row of HANNI_MASCOT_ART) {
			expect(visibleWidth(row)).toBe(HANNI_MASCOT_WIDTH);
			expect(row).toMatch(/^[ █▀▄]+$/);
		}

		// Tal cual se ve en un terminal real (VirtualTerminal emula el xterm).
		const terminal = new VirtualTerminal(120, 20);
		terminal.write(scene.join("\r\n"));
		const viewport = await terminal.flushAndGetViewport();
		const painted = viewport.map((line) => line.trimEnd()).filter((line) => line !== "");

		expect(painted).toHaveLength(6);
		expect(painted[1]).toContain("hanni♥ v1.2.3-hannipi");
		expect(painted[2]).toContain("tu conejita de código");
		expect(painted[3]).toContain("stub-1");
		expect(painted[4]).toContain("~/proyecto");
	});

	it("sin modelo elegido no deja un hueco en los datos", () => {
		const lines = hanniMascotLines(120, { color: false, info: { version: "1.2.3", cwd: "~/proyecto" } });

		expect(lines).toHaveLength(6);
		expect(lines[1]).toContain("hanni♥ v1.2.3");
		expect(lines[2]).toContain("tu conejita de código");
		expect(lines[3]).toContain("~/proyecto");
	});

	it("con display.startupArt: false no se pinta nada", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-startup-art-setting-"));
		tempDirs.push(dir);
		const manager = SettingsManager.create(dir, join(dir, "agent"));

		expect(manager.getStartupArt()).toBe(true);
		expect(new HanniMascotComponent({ enabled: manager.getStartupArt() }).render(120)).toHaveLength(6);

		manager.setStartupArt(false);
		await manager.flush();
		expect(manager.getStartupArt()).toBe(false);
		expect(SettingsManager.create(dir, join(dir, "agent")).getStartupArt()).toBe(false);
		expect(new HanniMascotComponent({ enabled: manager.getStartupArt() }).render(120)).toEqual([]);
	});

	it("en terminal estrecho usa la variante de una línea y nunca se sale del ancho", () => {
		expect(STARTUP_ART_MIN_COLUMNS).toBe(40);
		const lines = new HanniMascotComponent({ color: false, getInfo: () => INFO }).render(30);

		expect(lines).toEqual(["(\\_/) hanni♥"]);
		expect(hanniMascotLines(39, { color: false })).toHaveLength(1);
		expect(hanniMascotLines(40, { color: false })).toHaveLength(6);

		// Justo en el límite, un directorio largo se recorta en vez de partir la línea.
		const longCwd = { ...INFO, cwd: `~/${"carpeta/".repeat(20)}` };
		for (const color of [true, false]) {
			for (const line of hanniMascotLines(40, { color, info: longCwd })) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			}
		}
	});

	it("se degrada a mono cuando el terminal no soporta color", () => {
		expect(startupArtSupportsColor({ TERM: "xterm-256color" })).toBe(true);
		expect(startupArtSupportsColor({ TERM: "xterm-256color", NO_COLOR: "1" })).toBe(false);
		expect(startupArtSupportsColor({ TERM: "dumb" })).toBe(false);

		const mono = new HanniMascotComponent({ color: false, getInfo: () => INFO }).render(120);
		for (const line of mono) expect(line).toBe(stripAnsi(line));
		expect(mono[1]).toContain("hanni♥ v1.2.3-hannipi");
		for (const [index, row] of HANNI_MASCOT_ART.entries()) expect(mono[index]).toContain(row);

		// Con color, el cuerpo (#FF7AB0) y las orejas (#FFC9E0) llevan los rosas de marca, en el modo
		// de color que use el terminal (truecolor o 256), y cada línea cierra su estilo.
		const mode = theme.getColorMode();
		const colored = new HanniMascotComponent({ color: true }).render(120);
		const body = foregroundAnsi(rgbColor(255, 122, 176), mode);
		const ears = foregroundAnsi(rgbColor(255, 201, 224), mode);
		expect(body).not.toBe(ears);
		expect(colored[0]).toContain(body);
		expect(colored[1]).toContain(ears);
		for (const line of colored) expect(line.endsWith("\x1b[0m")).toBe(true);
	});

	it("no aparece en --print ni en --mode json", async () => {
		const dirs = createProject();

		const printed = await runCli(["--approve", "--provider", "stub", "--model", "stub-1", "-p", "hola"], dirs);
		expect(printed.code).toBe(0);
		// Turno real completado: la salida es exactamente la respuesta del modelo, sin decoración.
		expect(printed.stdout.trim()).toBe("respuesta del stub");
		for (const marker of ART_MARKERS) expect(printed.stdout).not.toContain(marker);

		const jsonDirs = createProject();
		const json = await runCli(
			["--approve", "--provider", "stub", "--model", "stub-1", "--mode", "json", "-p", "hola"],
			jsonDirs,
		);
		expect(json.code).toBe(0);
		const events = json.stdout
			.split("\n")
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } });
		expect(events.some((event) => event.type === "agent_end")).toBe(true);
		for (const marker of ART_MARKERS) expect(json.stdout).not.toContain(marker);
	});
});
