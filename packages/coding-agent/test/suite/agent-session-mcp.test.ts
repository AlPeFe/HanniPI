import { fauxAssistantMessage, fauxToolCall, getCurrentTools, type TranscriptContext } from "@earendil-works/pi-ai";
import type { SystemMessage, ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCodemodeTool } from "../../src/core/tools/codemode.ts";
import type { McpExposure, McpServerEntry } from "../../src/extensions/mcp/config.ts";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createMcpToolName } from "../../src/extensions/mcp/tools.ts";
import { createHarness, type Harness } from "./harness.ts";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const SERVER_TOOLS = [
	{
		name: "search",
		description: "Search the docs.",
		inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
		outputSchema: {
			type: "object",
			properties: { hits: { type: "array", items: { type: "string" } } },
			required: ["hits"],
		},
	},
	{ name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} } },
	{ name: "shot", description: "Returns an image.", inputSchema: { type: "object", properties: {} } },
];

/** Minimal MCP server over an in-memory transport. Records the tool calls it receives. */
function createFakeServer(calls: string[], listTools: () => unknown[] = () => SERVER_TOOLS) {
	const pair = createInMemoryTransportPair();
	const respond = (request: JsonRpcRequest): unknown => {
		switch (request.method) {
			case "initialize":
				return {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "docs", version: "1.0.0" },
				};
			case "tools/list":
				return { tools: listTools() };
			case "tools/call": {
				const params = request.params as { name: string; arguments?: { query?: string } };
				calls.push(`${params.name}:${JSON.stringify(params.arguments ?? {})}`);
				if (params.name === "search") {
					const hits = [`${params.arguments?.query} guide`, `${params.arguments?.query} faq`];
					return { content: [{ type: "text", text: hits.join("\n") }], structuredContent: { hits } };
				}
				if (params.name === "shot") {
					return { content: [{ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" }] };
				}
				return { content: [{ type: "text", text: "server exploded" }], isError: true };
			}
			default:
				return {};
		}
	};
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		const request = message as JsonRpcRequest;
		queueMicrotask(() => {
			void pair.server.send({ jsonrpc: "2.0", id: request.id, result: respond(request) });
		});
	});
	return pair;
}

describe("AgentSession MCP integration", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		exposure: McpExposure,
		listTools?: () => unknown[],
		options: { autoEnableCodemode?: boolean; builtInTools?: string[] } = {},
	) {
		const { builtInTools, ...configOptions } = options;
		const calls: string[] = [];
		const servers: ReturnType<typeof createFakeServer>["server"][] = [];
		const entry: McpServerEntry = {
			name: "docs",
			config: { url: "http://unused.invalid", exposure },
			source: "test",
		};
		// `builtInTools` uses the session's own built-in tools (exec with models, tool_search).
		const harness = await createHarness({
			...(builtInTools ? {} : { tools: [createCodemodeTool()] }),
			initialActiveToolNames: builtInTools ?? [],
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({ servers: [entry], errors: [], ...configOptions }),
					createTransport: () => {
						const pair = createFakeServer(calls, listTools);
						servers.push(pair.server);
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({});
		return { harness, calls, servers };
	}

	function declaredToolNames(harness: Harness): string[] {
		return harness.session.messages
			.filter((message): message is SystemMessage => message.role === "system")
			.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
	}

	function nestedToolNames(harness: Harness): string[] {
		return (harness.session.agent.state.nestedTools ?? []).map((tool) => tool.name);
	}

	function toolResult(harness: Harness, toolName: string): ToolResultMessage {
		const result = harness.session.messages.find(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
		);
		if (!result) throw new Error(`No ${toolName} tool result`);
		return result;
	}

	function text(message: ToolResultMessage): string {
		return message.content.map((block) => (block.type === "text" ? block.text : `<${block.type}>`)).join("\n");
	}

	it("exposes codemode-only MCP tools through exec and hides them from the model", async () => {
		const { harness, calls } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		// Written like a script for Codex: MCP tools resolve to their CallToolResult, errors included.
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("exec", {
						code: `
							const [a, b] = await Promise.allSettled([
								tools.${searchName}({ query: "mcp" }),
								tools.${searchName}({ query: "pi" }),
							]);
							const failure = await tools.mcp__docs__fail({});
							const shot = await tools.mcp__docs__shot({});
							image(shot.content[0]);
							text(JSON.stringify({
								hits: [...a.value.structuredContent.hits, ...b.value.structuredContent.hits],
								failed: failure.isError,
								failure: failure.content[0].text,
								found: ALL_TOOLS.filter((tool) => tool.name.includes("search")).map((tool) => tool.name),
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("search the docs");

		// Exec was activated for the codemode-exposed server; MCP tools are never declared.
		expect(harness.session.getActiveToolNames()).toEqual(["exec"]);
		expect(declaredToolNames(harness)).toEqual(["exec"]);
		expect(nestedToolNames(harness)).toEqual([searchName, "mcp__docs__fail", "mcp__docs__shot"]);
		const exec = harness.session.agent.state.tools.find((tool) => tool.name === "exec");
		expect(exec?.description).toContain("Shared MCP Types:\n```ts\ntype Role =");
		expect(exec?.description).toContain("Nested tools: COMPLETE list (3 tools).");
		expect(exec?.description).toContain(
			"## mcp__docs (3 tools)\nTools in the mcp__docs namespace.\n\n### `mcp__docs__search`",
		);
		expect(exec?.description).toContain(
			`declare const tools: { ${searchName}(args: { query: string; }): Promise<CallToolResult<{ hits: Array<string>; }>>; };`,
		);

		const result = toolResult(harness, "exec");
		expect(result.isError).toBe(false);
		// Output items keep the order the script produced them in.
		expect(result.content[1]).toEqual({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
		expect(JSON.parse((result.content[2] as { text: string }).text)).toEqual({
			hits: ["mcp guide", "mcp faq", "pi guide", "pi faq"],
			failed: true,
			failure: "server exploded",
			found: [searchName],
		});
		expect(result.content).toHaveLength(3);
		expect(calls).toEqual(['search:{"query":"mcp"}', 'search:{"query":"pi"}', "fail:{}", "shot:{}"]);
	});

	it("reports MCP isError results to the model as errors", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__fail", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__fail");
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("server exploded");
	});

	it("keeps codemode-only MCP tools callable across tree navigation", async () => {
		const { harness } = await setup("codemode");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");
		expect(harness.session.getActiveToolNames()).toEqual(["exec"]);
		expect(nestedToolNames(harness)).toContain(searchName);

		const firstAssistant = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		if (!firstAssistant) throw new Error("No assistant entry");
		await harness.session.navigateTree(firstAssistant.id);

		expect(harness.session.getActiveToolNames()).toEqual(["exec"]);
		expect(nestedToolNames(harness)).toContain(searchName);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "exec");
		expect(codemode?.description).toContain(`${searchName}(args: {`);
	});

	it("rejects direct model calls to codemode-only MCP tools", async () => {
		const { harness, calls } = await setup("codemode");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall(createMcpToolName("docs", "search"), { query: "x" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "mcp__docs__search");
		expect(result.isError).toBe(true);
		expect(text(result)).toBe("Tool mcp__docs__search not found");
		expect(calls).toEqual([]);
	});

	it("declares directly exposed MCP tools to the model", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("mcp__docs__search", { query: "direct" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(declaredToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]);
		expect(harness.session.getActiveToolNames()).not.toContain("exec");
		const result = toolResult(harness, "mcp__docs__search");
		expect(text(result)).toBe("direct guide\ndirect faq");
	});

	it("deactivates MCP tools the server withdraws and restores them when offered again", async () => {
		let tools = SERVER_TOOLS;
		const { harness, servers } = await setup("direct", () => tools);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["mcp__docs__search", "mcp__docs__fail", "mcp__docs__shot"]),
		);

		const listChanged = async () => {
			await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
		await listChanged();
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__fail");
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__search");

		tools = SERVER_TOOLS;
		await listChanged();
		expect(harness.session.getActiveToolNames()).toContain("mcp__docs__fail");
	});

	it("hides withdrawn codemode-only MCP tools from codemode and restores them when offered again", async () => {
		let tools = SERVER_TOOLS;
		const { harness, servers } = await setup("codemode", () => tools);
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		expect(nestedToolNames(harness)).toContain("mcp__docs__fail");

		const listChanged = async () => {
			await servers[0].send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
			await new Promise((resolve) => setTimeout(resolve, 10));
		};
		tools = SERVER_TOOLS.filter((tool) => tool.name !== "fail");
		await listChanged();
		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search", "mcp__docs__shot"]);
		expect(harness.session.getAllTools().find((tool) => tool.name === "mcp__docs__fail")?.exposure).toBe("hidden");
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "exec");
		expect(codemode?.description).not.toContain("mcp__docs__fail");

		tools = SERVER_TOOLS;
		await listChanged();
		expect(nestedToolNames(harness)).toContain("mcp__docs__fail");
		expect(harness.session.getActiveToolNames()).toEqual(["exec"]);
	});

	it("keeps deferred MCP tools callable from codemode but out of its description", async () => {
		const { harness, calls } = await setup("deferred");
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("exec", { code: `return (await tools.${searchName}({ query: "d" })).structuredContent;` })],
				{
					stopReason: "toolUse",
				},
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		expect(harness.session.getActiveToolNames()).toEqual(["exec"]);
		const codemode = harness.session.agent.state.tools.find((tool) => tool.name === "exec");
		expect(codemode?.description).not.toContain(searchName);
		const result = toolResult(harness, "exec");
		expect(result.isError).toBe(false);
		expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({ hits: ["d guide", "d faq"] });
		expect(calls).toEqual(['search:{"query":"d"}']);
	});

	it("does not activate codemode when autoEnableCodemode is false", async () => {
		const { harness } = await setup("codemode", undefined, { autoEnableCodemode: false });
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");

		expect(harness.session.getActiveToolNames()).toEqual([]);
		expect(nestedToolNames(harness)).toContain("mcp__docs__search");
	});

	it("does not let codemode call itself or inactive direct tools", async () => {
		const { harness } = await setup("direct");
		harness.setResponses([fauxAssistantMessage("ready")]);
		await harness.session.prompt("start");
		harness.session.setActiveToolsByName(["exec", "mcp__docs__search"]);

		expect(nestedToolNames(harness)).toEqual(["mcp__docs__search"]);
		// codemode.mode "on": the declared tool carries its exec declaration.
		const search = harness.session.agent.state.tools.find((tool) => tool.name === "mcp__docs__search");
		expect(search?.description).toContain(
			"Search the docs.\n\nexec tool declaration:\n```ts\ndeclare const tools: { mcp__docs__search(",
		);
	});

	it("presents tools per codemode.mode, hiding direct tools from requests in only mode", async () => {
		const requestTools: string[][] = [];
		const record = (context: TranscriptContext) => {
			requestTools.push(getCurrentTools(context.messages).map((tool) => tool.name));
			return fauxAssistantMessage("ok");
		};
		const { harness } = await setup("codemode", undefined, { builtInTools: ["read", "tool_search"] });
		harness.setResponses([record]);
		await harness.session.prompt("on");
		const exec = () => harness.session.agent.state.tools.find((tool) => tool.name === "exec")?.description ?? "";
		const read = () => harness.session.agent.state.tools.find((tool) => tool.name === "read")?.description ?? "";
		// on: read is declared with its exec declaration; exec lists only the MCP tools.
		expect(read()).toContain("exec tool declaration:");
		expect(exec()).not.toContain("### `read`");
		expect(exec()).toContain("### `mcp__docs__search`");
		expect(requestTools[0]).toEqual(expect.arrayContaining(["read", "exec", "tool_search"]));

		harness.settingsManager.applyOverrides({ codemode: { mode: "only" } });
		harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
		harness.setResponses([record]);
		await harness.session.prompt("only");
		// only: exec lists read, read keeps its plain description and is hidden from the request,
		// while it stays active (declared in the transcript).
		expect(exec()).toContain("### `read`");
		expect(read()).not.toContain("exec tool declaration:");
		expect(harness.session.getActiveToolNames()).toContain("read");
		expect(requestTools[1]).not.toContain("read");
		expect(requestTools[1]).toEqual(expect.arrayContaining(["exec", "tool_search"]));
	});

	it("finds tools from scripts with searchTools() and describeTool()", async () => {
		const { harness, calls } = await setup("deferred");
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("exec", {
						code: `
							const [match] = await searchTools("search the docs", { limit: 1 });
							const none = await searchTools("docs", { namespace: "mcp__other" });
							const declaration = await describeTool(match.name);
							const result = await tools[match.name]({ query: "found" });
							text(JSON.stringify({
								name: match.name,
								sameAsAllTools: ALL_TOOLS.find((tool) => tool.name === match.name).description === match.description,
								none: none.length,
								declared: declaration.includes("exec tool declaration:"),
								missing: (await describeTool("nope")) === undefined,
								hits: result.structuredContent.hits,
							}));
						`,
					}),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("go");

		const result = toolResult(harness, "exec");
		expect(result.isError).toBe(false);
		expect(JSON.parse((result.content[1] as { text: string }).text)).toEqual({
			name: "mcp__docs__search",
			sameAsAllTools: true,
			none: 0,
			declared: true,
			missing: true,
			hits: ["found guide", "found faq"],
		});
		expect(calls).toEqual(['search:{"query":"found"}']);
	});

	it("loads searched tools with tool_search and keeps them declared on the branch", async () => {
		const { harness, calls } = await setup("deferred", undefined, { builtInTools: ["tool_search"] });
		const searchName = createMcpToolName("docs", "search");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "search the docs", limit: 1 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage([fauxToolCall(searchName, { query: "loaded" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("find a docs tool");

		const toolSearch = harness.session.agent.state.tools.find((tool) => tool.name === "tool_search");
		expect(toolSearch?.description).toContain("- mcp__docs: Tools in the mcp__docs namespace.");

		const search = toolResult(harness, "tool_search");
		expect(text(search)).toBe(
			`Loaded 1 tool. They are available from your next call:\n- ${searchName}: Search the docs.`,
		);
		// Only the loaded tool is added; earlier declarations are not repeated.
		const loadMessages = harness.session.messages.filter(
			(message): message is SystemMessage =>
				message.role === "system" && (message.toolsAdded ?? []).some((tool) => tool.name === searchName),
		);
		expect(loadMessages).toHaveLength(1);
		expect(loadMessages[0].toolsAdded?.map((tool) => tool.name)).toEqual([searchName]);
		expect(text(toolResult(harness, searchName))).toBe("loaded guide\nloaded faq");
		expect(calls).toEqual(['search:{"query":"loaded"}']);

		// Loads are recorded in the transcript: navigating back before the load drops the tool,
		// navigating to a later entry restores it.
		const branch = harness.sessionManager.getBranch();
		const firstUser = branch.find((entry) => entry.type === "message" && entry.message.role === "user");
		const last = branch.at(-1);
		if (!firstUser || !last) throw new Error("Missing entries");
		await harness.session.navigateTree(firstUser.id);
		expect(harness.session.getActiveToolNames()).not.toContain(searchName);
		await harness.session.navigateTree(last.id);
		expect(harness.session.getActiveToolNames()).toContain(searchName);
	});

	it("finds nothing to load when every matching tool is already declared", async () => {
		const { harness } = await setup("direct", undefined, { builtInTools: ["tool_search"] });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("tool_search", { query: "docs" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(text(toolResult(harness, "tool_search"))).toBe("No matching tools found.");
	});
});
