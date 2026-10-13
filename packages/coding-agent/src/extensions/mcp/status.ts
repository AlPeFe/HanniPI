export interface McpConnectionStatus {
	name: string;
	state: "starting" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed" | "disabled";
}

const statusByExtension = new Map<string, readonly McpConnectionStatus[]>();
const listeners = new Set<() => void>();

export function getMcpConnectionStatuses(): readonly McpConnectionStatus[] {
	return [...statusByExtension.values()].flat();
}

export function subscribeMcpConnectionStatuses(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function publishMcpConnectionStatuses(extensionId: string, next: readonly McpConnectionStatus[]): void {
	if (next.length === 0) statusByExtension.delete(extensionId);
	else statusByExtension.set(extensionId, next.map(({ name, state }) => ({ name, state })));
	for (const listener of listeners) listener();
}
