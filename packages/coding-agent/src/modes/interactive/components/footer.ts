import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Format token counts for compact display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Show the working directory relative to the home directory when it is inside it.
 * The top bar has one line for it, so `~/proyecto` is worth more than `/home/user/proyecto`.
 */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	// Always `/`: the top bar is one line, and a Windows path would read as `~\proyecto`.
	return relativeToHome === "" ? "~" : `~/${relativeToHome.split(sep).join("/")}`;
}
