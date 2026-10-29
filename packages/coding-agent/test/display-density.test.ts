import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { type DisplayDensity, getDisplayDensity, setDisplayDensity } from "../src/core/display-density.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { DEFAULT_COMPACT_RAIL_WIDTH, DEFAULT_RAIL_WIDTH, SettingsManager } from "../src/core/settings-manager.ts";
import { RailContent } from "../src/extensions/hanniorq/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { TopBarComponent } from "../src/modes/interactive/components/top-bar.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * SPEC-007 B: la sesión de referencia es cabecera + un mensaje del asistente + un bloque de
 * herramienta + rail. Se renderiza a texto y se cuentan las líneas ocupadas (alto de pantalla:
 * cabecera + max(transcript, rail)), que es lo que el usuario nota como densidad.
 */
const REFERENCE_WIDTH = 120;
const RAIL_SECTIONS = [
	{ title: "proyecto", lines: ["HanniPI", "rama main"] },
	{ title: "memoria", lines: ["ON · 2.1k", "ultima sesion"] },
	{ title: "contexto", lines: ["12% de 200k"] },
];

const ASSISTANT_TEXT = [
	"He revisado el compositor y el rail.",
	"La densidad se mide en lineas, no en puntos.",
	"Siguiente paso: medir la sesion de referencia.",
].join("\n");

const fixturePath = fileURLToPath(new URL("./fixtures/spec007-normal-render.json", import.meta.url));

interface ReferenceBlocks {
	header: string[];
	assistant: string[];
	tool: string[];
	rail: string[];
}

function createSession(): AgentSession {
	const entries: Array<Record<string, unknown>> = [
		{
			type: "message",
			message: {
				role: "assistant",
				usage: { input: 12_345, output: 6_789, cacheRead: 4_000, cacheWrite: 0, cost: { total: 0.123 } },
			},
		},
	];
	const session = {
		state: {
			model: { id: "test-model", provider: "test", contextWindow: 200_000, reasoning: true },
			thinkingLevel: "medium",
		},
		sessionManager: {
			getEntries: () => entries,
			getEntryCount: () => entries.length,
			getSessionId: () => "spec007-session",
			getLeafId: () => null,
			getSessionName: () => "sesion de referencia",
			getCwd: () => "/home/user/proyecto",
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: 12.3 }),
		routedModel: undefined,
		modelRuntime: { isUsingSubscription: () => false },
	};
	return session as unknown as AgentSession;
}

function createFooterData(): ReadonlyFooterDataProvider {
	const provider = {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map<string, string>([["mem", "mem · 2.1k"]]),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
	return provider as unknown as ReadonlyFooterDataProvider;
}

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: ASSISTANT_TEXT }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AssistantMessage;
}

function renderReferenceSession(density: DisplayDensity): ReferenceBlocks {
	setDisplayDensity(density);

	const topBar = new TopBarComponent(createSession(), createFooterData(), "0.2.26-test");
	const assistant = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1);
	assistant.updateContent(createAssistantMessage(), false);

	const tui = new TuiMainScreen(new VirtualTerminal(REFERENCE_WIDTH, 40));
	const tool = new ToolExecutionComponent(
		"read",
		"tool-1",
		{ path: "src/index.ts" },
		{ showImages: false, outputPad: 1 },
		undefined,
		tui,
		"/home/user/proyecto",
	);
	tool.updateResult({ content: [{ type: "text", text: "ok" }], isError: false }, false);

	const rail = new RailContent(
		() => RAIL_SECTIONS,
		() => theme,
	);

	return {
		header: topBar.render(REFERENCE_WIDTH),
		assistant: assistant.render(REFERENCE_WIDTH),
		tool: tool.render(REFERENCE_WIDTH),
		rail: rail.render(density === "compact" ? DEFAULT_COMPACT_RAIL_WIDTH : DEFAULT_RAIL_WIDTH),
	};
}

/** Alto de pantalla de la sesión de referencia: cabecera + la columna más alta. */
function sessionHeight(blocks: ReferenceBlocks): number {
	return blocks.header.length + Math.max(blocks.assistant.length + blocks.tool.length, blocks.rail.length);
}

describe("display.density (SPEC-007)", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterAll(() => {
		setDisplayDensity("compact");
	});

	test("normal reproduce byte a byte el render anterior", () => {
		const golden = JSON.parse(readFileSync(fixturePath, "utf8")) as ReferenceBlocks;
		const blocks = renderReferenceSession("normal");

		expect(blocks.header).toEqual(golden.header);
		expect(blocks.assistant).toEqual(golden.assistant);
		expect(blocks.tool).toEqual(golden.tool);
		expect(blocks.rail).toEqual(golden.rail);
	});

	test("compact ocupa al menos un 25% menos de lineas en la sesion de referencia", () => {
		const normal = sessionHeight(renderReferenceSession("normal"));
		const compact = sessionHeight(renderReferenceSession("compact"));

		expect(compact).toBeLessThanOrEqual(Math.floor(normal * 0.75));
		expect(compact).toBeLessThan(normal);
	});

	test("compact no pierde informacion de la cabecera", () => {
		const blocks = renderReferenceSession("compact");
		const header = stripAnsi(blocks.header.join("\n"));

		expect(blocks.header).toHaveLength(1);
		expect(header).toContain("/home/user/proyecto");
		expect(header).toContain("(main)");
		expect(header).toContain("sesion de referencia");
		expect(header).toContain("mem · 2.1k");
		expect(header).toContain("test-model • medium");
		expect(header).toContain("↑12k");
		expect(header).toContain("↓6.8k");
		expect(header).toContain("ctx");
		expect(header).toContain("12%");
		expect(header).toContain("$0.123");
	});

	test("compact conserva mensaje, herramienta y secciones del rail", () => {
		const blocks = renderReferenceSession("compact");
		const assistant = stripAnsi(blocks.assistant.join("\n"));
		const tool = stripAnsi(blocks.tool.join("\n"));
		const rail = stripAnsi(blocks.rail.join("\n"));

		for (const line of ASSISTANT_TEXT.split("\n")) {
			expect(assistant).toContain(line);
		}
		expect(assistant).toContain("hanni");
		expect(tool).toContain("read");
		expect(tool).toContain("✓ ok");
		expect(tool).toContain('"path": "src/index.ts"');
		for (const section of RAIL_SECTIONS) {
			expect(rail).toContain(section.title);
			for (const line of section.lines) expect(rail).toContain(line);
		}
	});

	test("compact dibuja reglas de una linea y no cajas con bordes laterales", () => {
		const blocks = renderReferenceSession("compact");

		for (const block of [blocks.assistant, blocks.tool, blocks.rail]) {
			const lines = block.map(stripAnsi);
			expect(lines.some((line) => line.startsWith("│") || line.endsWith("│"))).toBe(false);
			expect(lines.some((line) => line.includes("╭") || line.includes("╯"))).toBe(false);
			expect(lines.some((line) => line.startsWith("─"))).toBe(true);
		}
	});

	test("por defecto la densidad es compact y el rail arranca mas estrecho", () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-density-"));
		const manager = SettingsManager.create(tempDir, join(tempDir, "agent"));

		expect(manager.getDensity()).toBe("compact");
		expect(manager.getRailWidth()).toBe(DEFAULT_COMPACT_RAIL_WIDTH);

		manager.setDensity("normal");
		expect(manager.getDensity()).toBe("normal");
		expect(manager.getRailWidth()).toBe(DEFAULT_RAIL_WIDTH);

		rmSync(tempDir, { recursive: true, force: true });
	});

	test("normal mantiene la densidad por defecto del modulo al terminar", () => {
		renderReferenceSession("normal");
		expect(getDisplayDensity()).toBe("normal");
		setDisplayDensity("compact");
		expect(getDisplayDensity()).toBe("compact");
	});
});
