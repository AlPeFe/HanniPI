import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMcpCommand } from "../src/extensions/mcp/cli.ts";

const FIXTURE = resolve(import.meta.dirname, "../../mcp/test/fixtures/stdio-server.mjs");

describe("pi mcp", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
	});

	async function run(args: string[], servers: Record<string, unknown>) {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-mcp-command-"));
		dirs.push(agentDir);
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }));
		const output: string[] = [];
		const exitCode = await runMcpCommand(args, {
			cwd: agentDir,
			agentDir,
			log: (line) => output.push(line),
			error: (line) => output.push(line),
		});
		return { exitCode, output: output.join("\n") };
	}

	const servers = {
		fixture: { command: process.execPath, args: [FIXTURE] },
		broken: { command: "pi-test-missing-mcp-server" },
		parked: { command: process.execPath, args: [FIXTURE], enabled: false },
		bad: { args: ["no command"] },
	};

	it("lists servers with their state, tools, and errors, and fails while anything is wrong", async () => {
		const { exitCode, output } = await run(["list"], servers);
		expect(exitCode).toBe(1);
		expect(output).toContain("fixture: connected, 1 tool (codemode, global)\n");
		expect(output).toContain("  tools: echo");
		expect(output).toContain(
			"broken: failed (codemode, global)\n  pi-test-missing-mcp-server\n  spawn pi-test-missing-mcp-server ENOENT",
		);
		expect(output).toContain("parked: disabled (codemode, global)");
		expect(output).toContain("config error: ");
		expect(output).toContain('server "bad" needs either "command"');

		const ok = await run(["list"], { fixture: servers.fixture });
		expect(ok.exitCode).toBe(0);
	});

	it("prints JSON for scripts", async () => {
		const { exitCode, output } = await run(["list", "--json"], { fixture: servers.fixture, parked: servers.parked });
		expect(exitCode).toBe(0);
		const parsed = JSON.parse(output) as { servers: { name: string; state: string; tools: string[] }[] };
		expect(parsed.servers.map(({ name, state, tools }) => ({ name, state, tools }))).toEqual([
			{ name: "fixture", state: "connected", tools: ["echo"] },
			{ name: "parked", state: "disabled", tools: [] },
		]);
	});

	it("rejects unknown servers and servers without OAuth for login and logout", async () => {
		expect(await run(["login", "nope"], servers)).toEqual({
			exitCode: 1,
			output: 'No MCP server named "nope". Configured: fixture, broken, parked.',
		});
		expect(await run(["logout", "fixture"], servers)).toEqual({
			exitCode: 1,
			output: 'MCP server "fixture" does not use OAuth. Only HTTP servers without an Authorization header do.',
		});
		expect((await run(["frobnicate"], servers)).exitCode).toBe(1);
	});
});
