import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader } from "../src/core/session-manager.ts";

describe("HTML export typeface", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-font-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("inlines the bundled Rysana Mono faces and puts them first in the font stack", async () => {
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "font-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const user = {
			type: "message",
			id: "user",
			parentId: null,
			timestamp: 0,
			message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
		};
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${[header, user].map((entry) => JSON.stringify(entry)).join("\n")}\n`);

		const html = readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8");

		expect(html.match(/@font-face \{/g)).toHaveLength(2);
		expect(html.match(/data:font\/woff2;base64,/g)).toHaveLength(2);
		expect(html).toContain("font-family: 'Rysana Mono';");
		expect(html).toMatch(/font-family: 'Rysana Mono', ui-monospace/);
	});
});
