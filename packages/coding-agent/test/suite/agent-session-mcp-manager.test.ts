import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { type Component, setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { KeybindingsManager } from "../../src/core/keybindings.ts";
import { createCodemodeExtension } from "../../src/extensions/codemode/index.ts";
import { loadMcpConfig } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { initTheme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

/** MCP server over an in-memory transport offering one `lookup` tool. */
function createFakeServer() {
	const pair = createInMemoryTransportPair();
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		const result =
			request.method === "initialize"
				? {
						protocolVersion: LATEST_PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "fake", version: "1.0.0" },
					}
				: request.method === "tools/list"
					? { tools: [{ name: "lookup", description: "Look things up.", inputSchema: { type: "object" } }] }
					: {};
		queueMicrotask(() => void pair.server.send({ jsonrpc: "2.0", id: request.id, result }));
	});
	void pair.server.start();
	return pair.client;
}

/** Drives the component that `ctx.ui.custom()` shows, like a user at the terminal. */
class ManagerDriver {
	component: Component | undefined;
	private closed: Promise<void> | undefined;

	uiContext(notifications: string[]): ExtensionUIContext {
		const tui = { requestRender: () => {} } as unknown as TUI;
		return {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message) => notifications.push(message),
			onTerminalInput: () => () => {},
			setStatus: () => {},
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]) => {
				const closed = new Promise<T>((resolve) => {
					void Promise.resolve(
						factory(tui, theme, new KeybindingsManager(), (result) => resolve(result as T)),
					).then((component) => {
						this.component = component;
					});
				});
				this.closed = closed.then(() => undefined);
				return closed;
			},
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditorComponent: () => {},
			getEditorComponent: () => undefined,
			get theme() {
				return theme;
			},
			getAllThemes: () => [],
			getTheme: () => undefined,
			setTheme: () => ({ success: false, error: "not available in tests" }),
			getToolsExpanded: () => false,
			setToolsExpanded: () => {},
		};
	}

	screen(): string {
		return stripVTControlCharacters((this.component?.render(120) ?? []).join("\n"));
	}

	/** Wait until the screen shows `text`. */
	async waitFor(text: string): Promise<string> {
		for (let attempt = 0; attempt < 200; attempt++) {
			const screen = this.screen();
			if (screen.includes(text)) return screen;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`Timed out waiting for "${text}". Screen:\n${this.screen()}`);
	}

	press(...keys: string[]): void {
		for (const key of keys) this.component?.handleInput?.(key);
	}

	/** Press escape until the manager closes; each screen goes back one level. */
	async close(): Promise<void> {
		let done = false;
		void this.closed?.then(() => {
			done = true;
		});
		for (let attempt = 0; attempt < 20 && !done; attempt++) {
			this.press(ESCAPE);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		await this.closed;
	}
}

describe("/mcp manager", () => {
	const cleanups: (() => void)[] = [];

	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	async function setup(config: Record<string, unknown>) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-manager-"));
		cleanups.push(() => rmSync(agentDir, { recursive: true, force: true }));
		mkdirSync(agentDir, { recursive: true });
		const configPath = join(agentDir, "mcp.json");
		writeFileSync(configPath, `${JSON.stringify({ mcpServers: config }, null, "\t")}\n`);
		const notifications: string[] = [];
		const driver = new ManagerDriver();
		const harness: Harness = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createCodemodeExtension(),
				createMcpExtension({
					loadConfig: (ctx) => loadMcpConfig({ agentDir, cwd: ctx.cwd, projectTrusted: false }),
					createTransport: () => createFakeServer(),
				}),
			],
		});
		cleanups.push(() => harness.cleanup());
		await harness.session.bindExtensions({ mode: "tui", uiContext: driver.uiContext(notifications) });
		const readConfig = () => JSON.parse(readFileSync(configPath, "utf8")).mcpServers as Record<string, unknown>;
		return { harness, driver, notifications, readConfig, configPath };
	}

	it("lists servers and enables, re-exposes, and disables them, saving to mcp.json", async () => {
		const { harness, driver, readConfig, configPath } = await setup({
			docs: { command: "docs-server" },
			off: { command: "off-server", enabled: false },
		});
		const running = harness.session.prompt("/mcp");
		const list = await driver.waitFor("MCP servers");
		expect(list).toContain("docs");
		expect(list).toContain("connected · 1 tool · codemode · global");
		expect(list).toContain("disabled · codemode · global");

		// Disabled servers are listed last; enable "off".
		driver.press(DOWN, ENTER);
		expect(await driver.waitFor("MCP server off")).toContain("Enable");
		driver.press(ENTER);
		await driver.waitFor("Tools");
		expect(readConfig().off).toEqual({ command: "off-server" });
		expect(readFileSync(configPath, "utf8")).toContain('\t"mcpServers"');
		expect(harness.session.getCallableToolNames()).toContain("mcp__off__lookup");

		// Make its tools direct: they are declared to the model.
		driver.press(DOWN, DOWN, ENTER);
		await driver.waitFor("Exposure of off");
		driver.press(DOWN, DOWN, ENTER);
		await driver.waitFor("MCP server off");
		expect(readConfig().off).toEqual({ command: "off-server", exposure: "direct" });
		expect(harness.session.getActiveToolNames()).toContain("mcp__off__lookup");

		// Disable it again: its tools become unreachable.
		driver.press(DOWN, DOWN, DOWN, ENTER);
		await driver.waitFor("Enable");
		expect(readConfig().off).toEqual({ command: "off-server", exposure: "direct", enabled: false });
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__off__lookup");
		expect(harness.session.getCallableToolNames()).not.toContain("mcp__off__lookup");

		await driver.close();
		await running;
	});

	it("reports startup problems once and shows the error in the manager", async () => {
		const { harness, driver, notifications } = await setup({ docs: { command: "docs-server" } });
		// Replace the working server with one that fails, then restart the session.
		const failing = await createHarness({
			initialActiveToolNames: [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({
						servers: [{ name: "broken", config: { command: "broken" }, source: "test", scope: "global" }],
						errors: ["mcp.json: bad entry"],
					}),
					createTransport: () => {
						throw new Error("spawn broken ENOENT");
					},
				}),
			],
		});
		cleanups.push(() => failing.cleanup());
		const failingNotifications: string[] = [];
		const failingDriver = new ManagerDriver();
		await failing.session.bindExtensions({ mode: "tui", uiContext: failingDriver.uiContext(failingNotifications) });
		const running = failing.session.prompt("/mcp");
		await failingDriver.waitFor("MCP servers");
		expect(failingNotifications).toEqual([
			"MCP servers need attention:\n  config: mcp.json: bad entry\n  broken: failed: spawn broken ENOENT\nRun /mcp to fix.",
		]);
		failingDriver.press(ENTER);
		const detail = await failingDriver.waitFor("MCP server broken");
		expect(detail).toContain("spawn broken ENOENT");
		expect(detail).toContain("Reconnect");
		await failingDriver.close();
		await running;

		// A session without problems reports nothing.
		const ok = harness.session.prompt("/mcp");
		await driver.waitFor("MCP servers");
		expect(notifications).toEqual([]);
		await driver.close();
		await ok;
	});
});
