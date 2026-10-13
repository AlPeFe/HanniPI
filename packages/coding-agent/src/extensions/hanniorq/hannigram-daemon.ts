import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const HEALTH_TIMEOUT_MS = 400;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 250;

type SpawnDaemon = (command: string, args: string[]) => void;

function defaultSpawnDaemon(command: string, args: string[]): void {
	const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
	child.once("error", () => {});
	child.unref();
}

function siblingDaemonCandidates(cwd: string): Array<{ command: string; args: string[] }> {
	const candidates: Array<{ command: string; args: string[] }> = [];
	for (const directory of ["HanniGram", "Hannigram"]) {
		const releaseDir = resolve(cwd, "..", directory, "src", "HanniGram.Server", "bin", "Release");
		if (!existsSync(releaseDir)) continue;
		let frameworks: string[];
		try {
			frameworks = readdirSync(releaseDir).sort().reverse();
		} catch {
			continue;
		}
		for (const framework of frameworks) {
			const appHost = join(
				releaseDir,
				framework,
				process.platform === "win32" ? "HanniGram.Server.exe" : "HanniGram.Server",
			);
			const assembly = join(releaseDir, framework, "HanniGram.Server.dll");
			if (existsSync(appHost)) candidates.push({ command: appHost, args: [] });
			else if (existsSync(assembly)) candidates.push({ command: "dotnet", args: [assembly] });
		}
	}
	return candidates;
}

function daemonCommand(cwd: string): { command: string; args: string[] } | undefined {
	const configured = process.env.HANNIGRAM_DAEMON;
	if (configured) {
		const isPath = configured.includes("/") || configured.includes("\\");
		const command = isPath ? resolve(cwd, configured) : configured;
		if (isPath && !existsSync(command)) {
			return undefined;
		}
		if (configured.toLowerCase().endsWith(".dll")) return { command: "dotnet", args: [command] };
		return { command, args: [] };
	}
	return siblingDaemonCandidates(cwd)[0];
}

async function healthy(baseUrl: string, fetcher: typeof fetch): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
	try {
		const response = await fetcher(new URL("/health", baseUrl), { signal: controller.signal });
		if (!response.ok) return false;
		const body: unknown = await response.json();
		return typeof body === "object" && body !== null && "status" in body && body.status === "ok";
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

export async function ensureHanniGramDaemon(options: {
	cwd: string;
	baseUrl: string;
	fetcher?: typeof fetch;
	spawnDaemon?: SpawnDaemon;
	wait?: (milliseconds: number) => Promise<void>;
	startupTimeoutMs?: number;
}): Promise<boolean> {
	const fetcher = options.fetcher ?? fetch;
	if (await healthy(options.baseUrl, fetcher)) return true;
	const executable = daemonCommand(options.cwd);
	if (!executable) return false;
	try {
		(options.spawnDaemon ?? defaultSpawnDaemon)(executable.command, [
			...executable.args,
			"--urls",
			process.env.HANNIGRAM_URLS ?? new URL(options.baseUrl).origin,
		]);
	} catch {
		return false;
	}
	const wait =
		options.wait ?? ((milliseconds: number) => new Promise((resolveWait) => setTimeout(resolveWait, milliseconds)));
	const deadline = Date.now() + (options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS);
	do {
		if (await healthy(options.baseUrl, fetcher)) return true;
		if (Date.now() >= deadline) break;
		await wait(Math.min(STARTUP_POLL_MS, Math.max(0, deadline - Date.now())));
	} while (Date.now() <= deadline);
	return false;
}
