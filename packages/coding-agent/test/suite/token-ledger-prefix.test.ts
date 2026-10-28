import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { FIXED_BUDGET_TOKENS } from "../../src/core/token-ledger.ts";
import { createHarness, type Harness } from "./harness.ts";

/**
 * SPEC-003: the prefix (system prompt + tool declarations) is what a provider caches, so it
 * must not move between turns unless the configuration moves. These tests fail when it does.
 */
describe("token ledger prefix immutability", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("keeps one prefix hash across two turns without a configuration change", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const entries = harness.session.tokenLedger.entries;
		expect(entries).toHaveLength(2);
		expect(entries[0].toolNames).toEqual(harness.session.getActiveToolNames());
		expect(entries[1].prefixHash).toBe(entries[0].prefixHash);
		expect(entries[1].total).toBe(entries[0].total);
		// The conversation grew, but nothing entered the prefix.
		expect(entries[1].components.injectedContext.tokens).toBe(entries[0].components.injectedContext.tokens);
		expect(harness.session.getTokenBudgetWarning()).toBeUndefined();
	});

	it("changes the hash only when the tool loadout or the prompt changes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);

		await harness.session.prompt("one");
		const before = harness.session.tokenLedger.current;
		if (!before) throw new Error("no ledger entry");

		harness.session.setActiveToolsByName(["read"]);
		await harness.session.prompt("two");
		const after = harness.session.tokenLedger.current;
		if (!after) throw new Error("no ledger entry");

		expect(after.prefixHash).not.toBe(before.prefixHash);
		expect(after.toolNames).toEqual(["read"]);
		expect(after.components.toolSchemas.tokens).toBeLessThan(before.components.toolSchemas.tokens);
	});

	it("warns at startup when an extension pushes the prefix over the budget", async () => {
		// A schema fat enough to cross FIXED_BUDGET_TOKENS on its own, like the old 14-tool
		// memory surface did (1,734 tokens of mem_* schemas).
		const fatSchema = Type.Object(
			Object.fromEntries(
				Array.from({ length: 40 }, (_, index) => [
					`field_${index}`,
					Type.String({ description: `Very important parameter number ${index} for the fat tool` }),
				]),
			),
		);
		const fatExtension = (pi: ExtensionAPI): void => {
			pi.registerTool({
				name: "fat_tool",
				label: "fat_tool",
				description: "An extension tool with a schema nobody trimmed.",
				parameters: fatSchema,
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			});
		};
		const harness = await createHarness({ extensionFactories: [{ name: "fat-ext", factory: fatExtension }] });
		harnesses.push(harness);
		await harness.session.bindExtensions({});

		const entry = harness.session.getFixedPrefixEntry();
		expect(entry.total).toBeGreaterThan(FIXED_BUDGET_TOKENS);
		const warning = harness.session.getTokenBudgetWarning();
		expect(warning).toContain(`budget ${FIXED_BUDGET_TOKENS}`);
		expect(warning).toContain("inline:fat-ext");
		expect(warning).toContain("fat_tool");
	});
});
