import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type JsonRpcMessage,
	LATEST_PROTOCOL_VERSION,
	McpAuthRequiredError,
	McpHttpError,
	McpSessionExpiredError,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { loadMcpConfig, type McpServerEntry } from "../src/extensions/mcp/config.ts";
import { McpOAuthCredentialStore, McpServerConnection } from "../src/extensions/mcp/runtime.ts";
import { convertMcpResult, createMcpToolName } from "../src/extensions/mcp/tools.ts";

// Config values are resolved at connect time, so the literal reference must survive loading.
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_HEADER = "Bearer ${TOKEN}";

describe("MCP config", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function setup(global: unknown, project: unknown) {
		const root = mkdtempSync(join(tmpdir(), "pi-mcp-config-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify(global));
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify(project));
		return { agentDir, cwd };
	}

	it("merges global and trusted project servers and validates entries", () => {
		const paths = setup(
			{
				mcpServers: {
					shared: { command: "global-cmd" },
					remote: { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } },
					off: { command: "x", enabled: false },
					bad: { args: ["no command"] },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badUrl: { url: "example.com/mcp" },
				},
			},
			{ mcpServers: { shared: { command: "project-cmd", exposure: "direct" } } },
		);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		// Disabled servers are kept so /mcp can enable them again.
		expect(trusted.servers.map((server) => [server.name, server.scope, server.config])).toEqual([
			["shared", "project", { command: "project-cmd", exposure: "direct" }],
			["remote", "global", { url: "https://example.com/mcp", headers: { Authorization: TOKEN_HEADER } }],
			["off", "global", { command: "x", enabled: false }],
		]);
		expect(trusted.errors).toHaveLength(3);
		expect(trusted.errors[0]).toContain('server "bad" needs either "command"');
		expect(trusted.errors[1]).toContain("legacy SSE transport is not supported");
		expect(trusted.errors[2]).toContain('server "badUrl": url must be an http or https URL');

		// Untrusted projects cannot add or override servers, since stdio servers run commands.
		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.servers.find((server) => server.name === "shared")?.config).toEqual({ command: "global-cmd" });
	});

	it("validates exposure and reads autoEnableCodemode with project precedence", () => {
		const paths = setup(
			{
				autoEnableCodemode: false,
				mcpServers: {
					later: { command: "x", exposure: "deferred" },
					off: { command: "x", exposure: "hidden" },
					wrong: { command: "x", exposure: "model-only" },
				},
			},
			{ autoEnableCodemode: "yes", mcpServers: {} },
		);

		const untrusted = loadMcpConfig({ ...paths, projectTrusted: false });
		expect(untrusted.autoEnableCodemode).toBe(false);
		expect(untrusted.servers.map((server) => [server.name, server.config.exposure])).toEqual([
			["later", "deferred"],
			["off", "hidden"],
		]);
		expect(untrusted.errors).toEqual([expect.stringContaining('server "wrong": exposure must be one of')]);

		const trusted = loadMcpConfig({ ...paths, projectTrusted: true });
		expect(trusted.autoEnableCodemode).toBe(false);
		expect(trusted.errors).toContainEqual(expect.stringContaining("autoEnableCodemode must be a boolean"));
	});
});

describe("MCP tools", () => {
	it("creates provider-safe tool names", () => {
		expect(createMcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(createMcpToolName("my-server", "get.item/v2")).toBe("mcp__my-server__get_item_v2");
		const long = createMcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		expect(createMcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		// Names that sanitize to one already taken by another tool get a hash suffix.
		const taken = createMcpToolName("s", "a_b");
		const second = createMcpToolName("s", "a.b", (name) => name === taken);
		expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
	});

	it("converts results, passing the CallToolResult to scripts and flagging errors", () => {
		const blocks = [
			{ type: "resource_link" as const, uri: "file:///a", name: "a" },
			{ type: "resource" as const, resource: { uri: "file:///b", text: "b text" } },
			{ type: "audio" as const, data: "", mimeType: "audio/wav" },
		];
		expect(
			convertMcpResult("docs", "t", { content: blocks, structuredContent: { ok: true }, _meta: { trace: "x" } }),
		).toEqual({
			content: [
				{ type: "text", text: "a: file:///a" },
				{ type: "text", text: "b text" },
				{ type: "text", text: "[audio audio/wav omitted]" },
			],
			details: { server: "docs", tool: "t" },
			// Scripts get the server's blocks as sent, without `_meta`.
			structuredContent: { content: blocks, structuredContent: { ok: true } },
		});
		expect(convertMcpResult("docs", "t", { content: [], structuredContent: { n: 1 } }).content).toEqual([
			{ type: "text", text: '{\n  "n": 1\n}' },
		]);
		expect(convertMcpResult("docs", "t", { content: [{ type: "text", text: "nope" }], isError: true })).toEqual({
			content: [{ type: "text", text: "nope" }],
			details: { server: "docs", tool: "t" },
			structuredContent: { content: [{ type: "text", text: "nope" }], isError: true },
			isError: true,
		});
		expect(convertMcpResult("docs", "t", { content: [], isError: true }).content).toEqual([
			{ type: "text", text: "MCP tool docs/t returned an error" },
		]);
	});
});

describe("MCP connections", () => {
	const servers: InMemoryTransport[] = [];

	/** In-memory server that answers initialize, tools/list, and tools/call with "ok". */
	function createTransport(options: { expireFirstCall?: boolean; methods?: string[]; noTools?: boolean } = {}) {
		const pair = createInMemoryTransportPair();
		servers.push(pair.server);
		pair.server.onMessage((message) => {
			if (!("id" in message) || !("method" in message)) return;
			options.methods?.push(message.method);
			const response: JsonRpcMessage =
				message.method === "initialize"
					? {
							jsonrpc: "2.0",
							id: message.id,
							result: {
								protocolVersion: LATEST_PROTOCOL_VERSION,
								capabilities: options.noTools ? { prompts: {} } : { tools: {} },
								serverInfo: { name: "fake", version: "1.0.0" },
							},
						}
					: message.method === "tools/list"
						? options.noTools
							? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } }
							: { jsonrpc: "2.0", id: message.id, result: { tools: [] } }
						: { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "ok" }] } };
			queueMicrotask(() => void pair.server.send(response));
		});
		void pair.server.start();
		if (options.expireFirstCall) {
			const send = pair.client.send.bind(pair.client);
			// Simulates the HTTP transport's 404 for a session the server no longer knows.
			pair.client.send = async (message: JsonRpcMessage) => {
				if ("method" in message && message.method === "tools/call") throw new McpSessionExpiredError("gone");
				return send(message);
			};
		}
		return pair.client;
	}

	function connect(entry: McpServerEntry, transports: (() => ReturnType<typeof createTransport>)[]) {
		let opened = 0;
		const connection = new McpServerConnection({
			entry,
			cwd: process.cwd(),
			createTransport: () => transports[opened++](),
			credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
			onTools: () => {},
		});
		return { connection, opened: () => opened };
	}

	it("starts a new session and retries once when the session expired", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ expireFirstCall: true }),
			() => createTransport(),
		]);
		const results = await Promise.all([connection.callTool("echo", {}, {}), connection.callTool("echo", {}, {})]);
		expect(results).toEqual([
			{ content: [{ type: "text", text: "ok" }] },
			{ content: [{ type: "text", text: "ok" }] },
		]);
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("connects to servers without the tools capability without listing tools", async () => {
		const methods: string[] = [];
		const { connection } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport({ noTools: true, methods }),
		]);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(connection.tools).toEqual([]);
		expect(methods).toEqual(["initialize"]);
		await connection.close();
	});

	it("marks a dropped connection and reconnects on the next call", async () => {
		const { connection, opened } = connect({ name: "fake", config: { command: "unused" }, source: "test" }, [
			() => createTransport(),
			() => createTransport(),
		]);
		await connection.getClient();
		await servers.at(-1)?.close();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(connection.state).toBe("disconnected");
		expect(connection.error).toBe("Connection closed");
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();
	});

	it("retries HTTP connections that fail with a transient error", async () => {
		const { connection, opened } = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(503, "MCP HTTP request failed with status 503");
					};
					return transport;
				},
				() => createTransport(),
			],
		);
		await connection.getClient();
		expect(connection.state).toBe("connected");
		expect(opened()).toBe(2);
		await connection.close();

		const failing = connect(
			{ name: "fake", config: { url: "http://unused.invalid", headers: { Authorization: "x" } }, source: "test" },
			[
				() => {
					const transport = createTransport();
					transport.send = async () => {
						throw new McpHttpError(400, "MCP HTTP request failed with status 400: bad");
					};
					return transport;
				},
			],
		);
		await expect(failing.connection.getClient()).rejects.toThrow("status 400: bad");
		expect(failing.connection.state).toBe("failed");
		expect(failing.opened()).toBe(1);
	});

	it("asks OAuth servers that keep rejecting requests for a new sign-in", async () => {
		const { connection } = connect({ name: "fake", config: { url: "http://unused.invalid" }, source: "test" }, [
			() => {
				const transport = createTransport();
				transport.send = async () => {
					throw new McpAuthRequiredError(new Response(null, { status: 401 }));
				};
				return transport;
			},
		]);
		await expect(connection.getClient()).rejects.toThrow('MCP server "fake" requires sign-in. Run /mcp to sign in.');
		expect(connection.state).toBe("needs-auth");
		await connection.close();
	});

	it("resolves the OAuth client secret lazily", async () => {
		const { connection } = connect(
			{
				name: "fake",
				config: { url: "http://unused.invalid", oauth: { clientSecret: "!exit 1" } },
				source: "test",
			},
			[() => createTransport()],
		);
		expect(await connection.callTool("echo", {}, {})).toEqual({ content: [{ type: "text", text: "ok" }] });
		expect(() => connection.oauthSettings()).toThrow("oauth.clientSecret");
		await connection.close();
	});
});
