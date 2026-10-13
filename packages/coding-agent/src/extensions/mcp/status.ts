export interface McpConnectionStatus {
	name: string;
	state: "starting" | "connecting" | "connected" | "disconnected" | "needs-auth" | "failed" | "closed" | "disabled";
}

const statusByExtension = new Map<string, readonly McpConnectionStatus[]>();
const listeners = new Set<() => void>();

export function getMcpConnectionStatuses(): readonly McpConnectionStatus[] {
	const statuses = new Map<string, McpConnectionStatus>();
	for (const extensionStatuses of statusByExtension.values()) {
		for (const status of extensionStatuses) statuses.set(status.name, status);
	}
	return [...statuses.values()];
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
