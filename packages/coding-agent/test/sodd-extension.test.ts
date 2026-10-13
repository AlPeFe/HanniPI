import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/types.ts";
import { createSoddExtension } from "../src/extensions/sodd/index.ts";

describe("sODD extension", () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("creates the task directory before writing a new task sheet", async () => {
		const root = mkdtempSync(join(tmpdir(), "sodd-task-"));
		roots.push(root);
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const listeners = new Map<string, (...args: any[]) => void>();
		const pi = {
			registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commands.set(name, command);
			},
			on(event: string, handler: (...args: any[]) => void) {
				listeners.set(event, handler);
			},
			getAllTools: () => [],
			exec: vi.fn(),
		} as unknown as Parameters<ExtensionFactory>[0];
		createSoddExtension()(pi);
		await commands.get("task")!.handler("new sample", { cwd: root, ui: { notify() {} } });
		expect(readFileSync(join(root, "odd", "tasks", "sample.md"), "utf8")).toContain("status: active");
		expect(readFileSync(join(root, "odd", ".active"), "utf8")).toBe("sample");
		const event = { messages: [] as Array<{ role: string; content: string; timestamp: number }> };
		listeners.get("context")!(event, { cwd: root });
		expect(event.messages[0]?.content).toContain("Classify this request automatically");
		expect(event.messages[0]?.content).toContain("No subagent tool is available");
	});

	it("refuses to commit unrelated staged files", async () => {
		const root = mkdtempSync(join(tmpdir(), "sodd-task-commit-"));
		roots.push(root);
		const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
		const pi = {
			registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }) {
				commands.set(name, command);
			},
			on() {},
			getAllTools: () => [],
			exec: vi.fn(),
		} as unknown as Parameters<ExtensionFactory>[0];
		createSoddExtension()(pi);
		const notifications: string[] = [];
		await commands.get("task")!.handler("commit feat: test", {
			cwd: root,
			ui: {
				notify(message: string) {
					notifications.push(message);
				},
			},
		});
		expect(notifications).toContain("No hay ficha activa para commitear.");
	});
});
