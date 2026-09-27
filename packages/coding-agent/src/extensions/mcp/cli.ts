/**
 * `pi mcp`: check MCP servers and sign in to them outside a session. Agents run it through bash to
 * verify an `mcp.json` they wrote and to start an OAuth sign-in; the user only approves access in
 * the browser. Running sessions pick up new credentials on their next turn.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../../config.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { type LoadedMcpConfig, loadMcpConfig, type McpServerEntry } from "./config.ts";
import {
	createDefaultTransport,
	McpOAuthCredentialStore,
	McpServerConnection,
	McpSignInCancelledError,
	signInMcpServer,
} from "./runtime.ts";

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} mcp list [--json]
  ${APP_NAME} mcp login <server> [--timeout <seconds>]
  ${APP_NAME} mcp logout <server>

Check MCP servers and sign in to OAuth servers without starting a session.
Reads ~/${CONFIG_DIR_NAME}/agent/mcp.json and, in trusted projects, ${CONFIG_DIR_NAME}/mcp.json.

Commands:
  list                    Show state, tools, and errors (exits 1 on failure)
  login <server>          Sign in through the browser
  logout <server>         Delete the stored OAuth credentials

Options:
  --json                  Print the list as JSON
  --timeout <seconds>     How long login waits for the browser (default: 300)`;

const HELP_HINT = chalk.dim(`Use "${APP_NAME} mcp --help" for usage.`);

const DEFAULT_LOGIN_TIMEOUT_SECONDS = 300;

export interface McpCommandOptions {
	cwd: string;
	agentDir: string;
	/** Defaults to `mcp-auth.json` in the agent directory. */
	credentials?: McpOAuthCredentialStore;
	/** Defaults to the platform browser. */
	openUrl?: (url: string) => void;
	/** Defaults to console output. */
	log?: (line: string) => void;
	error?: (line: string) => void;
}

interface ServerReport {
	name: string;
	scope: string;
	source: string;
	enabled: boolean;
	exposure: string;
	transport: string;
	state: string;
	tools: string[];
	error?: string;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function describeTransport(entry: McpServerEntry): string {
	const { config } = entry;
	return "url" in config ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}

function createConnection(entry: McpServerEntry, options: McpCommandOptions, credentials: McpOAuthCredentialStore) {
	return new McpServerConnection({
		entry,
		cwd: options.cwd,
		createTransport: createDefaultTransport,
		credentials,
		onTools: () => {},
	});
}

/** Parse `--name value` options; returns undefined and reports unknown ones. */
function parseOptions(
	args: string[],
	known: Record<string, "flag" | "value">,
	error: (line: string) => void,
): { positional: string[]; values: Map<string, string | true> } | undefined {
	const positional: string[] = [];
	const values = new Map<string, string | true>();
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const name = arg.slice(2);
		const kind = known[name];
		if (!kind) {
			error(`Unknown option ${arg}.\n${HELP_HINT}`);
			return undefined;
		}
		if (kind === "flag") {
			values.set(name, true);
			continue;
		}
		const value = args[++index];
		if (value === undefined) {
			error(`${arg} needs a value.`);
			return undefined;
		}
		values.set(name, value);
	}
	return { positional, values };
}

/** Run `pi mcp <args>` and return the exit code. */
export async function runMcpCommand(args: string[], options: McpCommandOptions): Promise<number> {
	const log = options.log ?? ((line: string) => console.log(line));
	const error = options.error ?? ((line: string) => console.error(line));
	const [command, ...rest] = args;
	if (command === undefined || command === "help" || args.includes("--help") || args.includes("-h")) {
		log(HELP);
		return 0;
	}

	const projectConfig = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
	const projectTrusted = new ProjectTrustStore(options.agentDir).get(options.cwd) === true;
	const loaded = loadMcpConfig({ agentDir: options.agentDir, cwd: options.cwd, projectTrusted });
	const untrustedNote =
		!projectTrusted && existsSync(projectConfig)
			? `${projectConfig} is ignored because the project is not trusted. Start ${APP_NAME} in the project to trust it.`
			: undefined;
	const credentials = options.credentials ?? new McpOAuthCredentialStore();

	switch (command) {
		case "list": {
			const parsed = parseOptions(rest, { json: "flag" }, error);
			if (!parsed) return 1;
			if (parsed.positional.length > 0) {
				error(`Usage: ${APP_NAME} mcp list [--json]\n${HELP_HINT}`);
				return 1;
			}
			return list(loaded, parsed.values.has("json"), untrustedNote, options, credentials, log);
		}
		case "login":
		case "logout": {
			const parsed = parseOptions(rest, command === "login" ? { timeout: "value" } : {}, error);
			if (!parsed) return 1;
			const [name, ...extra] = parsed.positional;
			if (!name || extra.length > 0) {
				error(`Usage: ${APP_NAME} mcp ${command} <server>\n${HELP_HINT}`);
				return 1;
			}
			const entry = loaded.servers.find((server) => server.name === name);
			if (!entry) {
				error(
					`No MCP server named "${name}".${untrustedNote ? ` ${untrustedNote}` : ""} Configured: ${loaded.servers.map((server) => server.name).join(", ") || "none"}.`,
				);
				return 1;
			}
			const connection = createConnection(entry, options, credentials);
			const url = connection.oauthUrl;
			if (!url) {
				error(`MCP server "${name}" does not use OAuth. Only HTTP servers without an Authorization header do.`);
				return 1;
			}
			if (command === "logout") {
				const removed = credentials.remove(url);
				log(removed ? `Signed out of MCP server "${name}".` : `No stored credentials for MCP server "${name}".`);
				return 0;
			}
			const timeout = Number(parsed.values.get("timeout") ?? DEFAULT_LOGIN_TIMEOUT_SECONDS);
			if (!Number.isFinite(timeout) || timeout <= 0) {
				error("--timeout must be a positive number of seconds.");
				return 1;
			}
			try {
				return await login(entry, connection, url, timeout * 1000, options, credentials, log, error);
			} finally {
				await connection.close();
			}
		}
		default:
			error(`Unknown mcp command "${command}".\n${HELP_HINT}`);
			return 1;
	}
}

async function list(
	loaded: LoadedMcpConfig,
	json: boolean,
	untrustedNote: string | undefined,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
): Promise<number> {
	const reports = await Promise.all(
		loaded.servers.map(async (entry): Promise<ServerReport> => {
			const report: ServerReport = {
				name: entry.name,
				scope: entry.scope ?? "global",
				source: entry.source,
				enabled: entry.config.enabled !== false,
				exposure: entry.config.exposure ?? "codemode",
				transport: describeTransport(entry),
				state: "disabled",
				tools: [],
			};
			if (!report.enabled) return report;
			const connection = createConnection(entry, options, credentials);
			try {
				await connection.getClient();
			} catch {
				// The connection records the state and error.
			}
			report.state = connection.state;
			report.tools = connection.tools.map((tool) => tool.name);
			if (connection.state !== "connected" && connection.error) report.error = connection.error;
			await connection.close();
			return report;
		}),
	);
	const failed = loaded.errors.length > 0 || reports.some((report) => report.enabled && report.state !== "connected");

	if (json) {
		log(
			JSON.stringify(
				{ servers: reports, errors: loaded.errors, ...(untrustedNote ? { note: untrustedNote } : {}) },
				null,
				2,
			),
		);
		return failed ? 1 : 0;
	}
	if (reports.length === 0 && loaded.errors.length === 0) {
		log(`No MCP servers configured. Add them to ${join(options.agentDir, "mcp.json")} or .pi/mcp.json.`);
	}
	for (const report of reports) {
		const state =
			report.state === "connected"
				? `connected, ${report.tools.length} tool${report.tools.length === 1 ? "" : "s"}`
				: report.state === "needs-auth"
					? "needs sign-in"
					: report.state;
		log(`${report.name}: ${state} (${report.exposure}, ${report.scope})`);
		log(`  ${report.transport}`);
		if (report.state === "needs-auth") log(`  sign in with: ${APP_NAME} mcp login ${report.name}`);
		if (report.tools.length > 0) log(`  tools: ${report.tools.join(", ")}`);
		if (report.error) log(`  ${report.error.split("\n").join("\n  ")}`);
	}
	for (const configError of loaded.errors) log(`config error: ${configError}`);
	if (untrustedNote) log(untrustedNote);
	return failed ? 1 : 0;
}

async function login(
	entry: McpServerEntry,
	connection: McpServerConnection,
	url: string,
	timeoutMs: number,
	options: McpCommandOptions,
	credentials: McpOAuthCredentialStore,
	log: (line: string) => void,
	error: (line: string) => void,
): Promise<number> {
	const { name } = entry;
	// Connecting first answers whether a sign-in is needed and records the server's challenge.
	try {
		await connection.getClient();
		log(`Already signed in to MCP server "${name}" (${connection.tools.length} tools).`);
		return 0;
	} catch {
		if (connection.state !== "needs-auth") {
			error(`MCP server "${name}" failed to connect: ${connection.error ?? "unknown error"}`);
			return 1;
		}
	}

	const openUrl = options.openUrl ?? openBrowser;
	const interactive = process.stdin.isTTY === true && options.openUrl === undefined;
	try {
		await signInMcpServer({
			serverUrl: url,
			store: credentials.forServer(url),
			settings: connection.oauthSettings(),
			challenge: connection.challenge,
			prompt: {
				showAuthorizationUrl: (authorizationUrl) => {
					log(`Sign in to MCP server "${name}" in your browser:\n${authorizationUrl.href}`);
					openUrl(authorizationUrl.href);
				},
				promptForRedirectUrl: (signal) => waitForRedirectUrl(signal, timeoutMs, interactive),
			},
		});
	} catch (signInError) {
		error(
			signInError instanceof McpSignInCancelledError
				? `Sign-in to MCP server "${name}" was cancelled or not completed within ${Math.round(timeoutMs / 1000)} seconds.`
				: `Sign-in to MCP server "${name}" failed: ${errorMessage(signInError)}`,
		);
		return 1;
	}
	connection.challenge = undefined;
	try {
		await connection.reconnect();
	} catch (connectError) {
		error(`Signed in, but ${errorMessage(connectError)}`);
		return 1;
	}
	log(`Signed in to MCP server "${name}" (${connection.tools.length} tools).`);
	return 0;
}

/**
 * The pasted redirect URL in a terminal; otherwise only the browser callback can finish the sign-in.
 * Resolves to undefined (cancelling the sign-in) after `timeoutMs`, or when the callback arrived.
 */
async function waitForRedirectUrl(
	signal: AbortSignal,
	timeoutMs: number,
	interactive: boolean,
): Promise<string | undefined> {
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(abort, timeoutMs);
	try {
		if (!interactive) {
			await new Promise<void>((resolve) =>
				controller.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
			return undefined;
		}
		const readline = createInterface({ input: process.stdin, output: process.stderr });
		try {
			return await readline.question(
				"If the browser cannot reach this machine, paste the URL it was redirected to: ",
				{ signal: controller.signal },
			);
		} catch {
			return undefined;
		} finally {
			readline.close();
		}
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
	}
}
