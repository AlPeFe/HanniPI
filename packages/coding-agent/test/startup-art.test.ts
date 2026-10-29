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
	HANNI_HEART_ART,
	HANNI_HEART_NARROW,
	HanniHeartComponent,
	hanniHeartLines,
	STARTUP_ART_MIN_COLUMNS,
	startupArtSupportsColor,
} from "../src/modes/interactive/components/hanni-heart.ts";
import { hanniWordmark } from "../src/modes/interactive/components/hanni-logo.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * SPEC-008 B: escena ASCII de arranque de la TUI. Se pinta una vez al montar, desaparece al primer
 * mensaje y nunca se pinta fuera de la TUI (`--print`, `--mode json`, RPC).
 */
const ART_MARKERS = ["conejita de una línea", "/  \\________/  \\", "\\____________/", "hanni♥"];

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

	it("con arte activo, el arranque pinta las 6 líneas del arte y el wordmark", async () => {
		const art = new HanniHeartComponent({ color: true }).render(120);

		expect(art).toHaveLength(6);
		expect(art.map(stripAnsi)).toEqual([...HANNI_HEART_ART]);

		// El dibujo es el de la spec: orejas, ojos de corazón, boca, contorno y leyenda.
		expect(HANNI_HEART_ART[0].trim()).toBe("/\\          /\\");
		expect(HANNI_HEART_ART[1]).toContain("/  \\________/  \\");
		expect(HANNI_HEART_ART[2]).toContain("♥");
		expect(HANNI_HEART_ART[3]).toContain("‿‿");
		expect(HANNI_HEART_ART[4].trim()).toBe("\\____________/");
		expect(HANNI_HEART_ART[5].trim()).toBe("conejita de una línea");

		// La escena de arranque = arte + wordmark, como la monta la cabecera de la TUI.
		const scene = [...art, hanniWordmark()];

		// Y tal cual se ve en un terminal real (VirtualTerminal emula el xterm).
		const terminal = new VirtualTerminal(120, 20);
		terminal.write(scene.join("\r\n"));
		const viewport = await terminal.flushAndGetViewport();
		const painted = viewport.map((line) => line.trimEnd()).filter((line) => line !== "");

		expect(painted.slice(0, 6)).toEqual([...HANNI_HEART_ART]);
		expect(stripAnsi(painted[6])).toBe("hanni♥");
	});

	it("con display.startupArt: false no se pinta nada", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-startup-art-setting-"));
		tempDirs.push(dir);
		const manager = SettingsManager.create(dir, join(dir, "agent"));

		expect(manager.getStartupArt()).toBe(true);
		expect(new HanniHeartComponent({ enabled: manager.getStartupArt() }).render(120)).toHaveLength(6);

		manager.setStartupArt(false);
		await manager.flush();
		expect(manager.getStartupArt()).toBe(false);
		expect(SettingsManager.create(dir, join(dir, "agent")).getStartupArt()).toBe(false);
		expect(new HanniHeartComponent({ enabled: manager.getStartupArt() }).render(120)).toEqual([]);
	});

	it("a 50 columnas usa la variante de una línea y no parte el arte", () => {
		expect(STARTUP_ART_MIN_COLUMNS).toBe(60);
		const lines = new HanniHeartComponent({ color: false }).render(50);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toBe(HANNI_HEART_NARROW);
		expect(lines[0]).toBe("( \\_/ )  hanni♥  (\\_/)");
		expect(visibleWidth(lines[0])).toBeLessThanOrEqual(50);

		// Con sitio, el arte grande tampoco se sale de su ancho.
		for (const line of hanniHeartLines(120, false)) expect(visibleWidth(line)).toBeLessThan(60);
		expect(hanniHeartLines(59, false)).toHaveLength(1);
		expect(hanniHeartLines(60, false)).toHaveLength(6);
	});

	it("se degrada a mono cuando el terminal no soporta color", () => {
		expect(startupArtSupportsColor({ TERM: "xterm-256color" })).toBe(true);
		expect(startupArtSupportsColor({ TERM: "xterm-256color", NO_COLOR: "1" })).toBe(false);
		expect(startupArtSupportsColor({ TERM: "dumb" })).toBe(false);

		const mono = new HanniHeartComponent({ color: false }).render(120);
		for (const line of mono) expect(line).toBe(stripAnsi(line));
		// La degradación es sólo de color: el dibujo es el mismo.
		expect(mono).toEqual([...HANNI_HEART_ART]);

		// Con color, los dos rosas de marca (#FF7AB0 contorno y #FFC9E0 ojos) están ahí, en el modo
		// de color que use el terminal (truecolor o 256).
		const mode = theme.getColorMode();
		const colored = new HanniHeartComponent({ color: true }).render(120);
		const outline = foregroundAnsi(rgbColor(255, 122, 176), mode);
		const eyes = foregroundAnsi(rgbColor(255, 201, 224), mode);
		expect(outline).not.toBe(eyes);
		expect(colored[0]).toContain(outline);
		expect(colored[2]).toContain(eyes);
	});

	it("no aparece en --print ni en --mode json", async () => {
		const dirs = createProject();

		const printed = await runCli(["--approve", "--provider", "stub", "--model", "stub-1", "-p", "hola"], dirs);
		expect(printed.code).toBe(0);
		// Turno real completado: la salida es exactamente la respuesta del modelo, sin decoración.
		expect(printed.stdout.trim()).toBe("respuesta del stub");
		for (const marker of ART_MARKERS) expect(printed.stdout).not.toContain(marker);
		for (const line of HANNI_HEART_ART) expect(printed.stdout).not.toContain(line.trim());

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
		for (const line of HANNI_HEART_ART) expect(json.stdout).not.toContain(line.trim());
	});
});
