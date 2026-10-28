import { describe, expect, it } from "vitest";
import { buildSystemPromptSections } from "../src/core/system-prompt.ts";
import {
	FIXED_BUDGET_TOKENS,
	formatBudgetWarning,
	formatTokenDelta,
	formatTokenLedger,
	hashPrefix,
	MEASURED_FIXED_TOKENS,
	measureFixedPrefix,
	measurePrefixParts,
	measureToolSchemas,
	type PrefixParts,
	TokenLedger,
} from "../src/core/token-ledger.ts";
import { createAllToolDefinitions, createCodingToolDefinitions } from "../src/core/tools/index.ts";

/**
 * Reference counts come from `gpt-tokenizer` (cl100k) over the compiled harness, the same
 * tokenizer `bench/ts/token_budget.mjs` uses. cwd is fixed so the reference does not move
 * with the machine. Regenerate with the bench if the prompt text changes on purpose.
 */
const CWD = "/workspace/project";
const REFERENCE_ALL_TOOLS = 1865; // prompt 709 + schemas 1,156
const REFERENCE_BASE_TOOLS = 1261; // prompt 676 + schemas 585

function parts(overrides: Partial<PrefixParts> = {}): PrefixParts {
	return {
		content: "",
		sections: {
			preamble: "You are Hanni.",
			tools: "<tools>\n- read: Read a file\n</tools>",
			rules: "<rules>\n- Be concise in your responses\n</rules>",
			cwd: CWD,
		},
		tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
		...overrides,
	};
}

describe("token ledger", () => {
	it("estimates the fixed prefix within 5% of the cl100k reference", () => {
		const all = measureFixedPrefix({ cwd: CWD, tools: Object.values(createAllToolDefinitions(CWD)) });
		const base = measureFixedPrefix({ cwd: CWD, tools: createCodingToolDefinitions(CWD) });
		expect(Math.abs(all.total - REFERENCE_ALL_TOOLS) / REFERENCE_ALL_TOOLS).toBeLessThan(0.05);
		expect(Math.abs(base.total - REFERENCE_BASE_TOOLS) / REFERENCE_BASE_TOOLS).toBeLessThan(0.05);
		// The four components are disjoint and add up to the total.
		const { components } = all;
		expect(
			components.systemPrompt.tokens +
				components.activeTools.tokens +
				components.toolSchemas.tokens +
				components.injectedContext.tokens,
		).toBe(all.total);
		expect(all.total).toBeLessThanOrEqual(FIXED_BUDGET_TOKENS);
		expect(MEASURED_FIXED_TOKENS).toBeLessThanOrEqual(FIXED_BUDGET_TOKENS);
	});

	it("keeps the prefix hash equal between two turns without a configuration change", () => {
		const options = {
			selectedTools: ["read"],
			toolSnippets: { read: "Read a file" },
			cwd: CWD,
		};
		const first = buildSystemPromptSections(options);
		const second = buildSystemPromptSections(options);
		expect(second).toEqual(first);

		const declarations = [{ name: "read", description: "Read a file", parameters: { type: "object" } }];
		expect(hashPrefix(Object.values(first).join("\n\n"), declarations)).toBe(
			hashPrefix(Object.values(second).join("\n\n"), declarations),
		);

		// Two transcript turns that only append conversation keep the same prefix.
		const ledger = new TokenLedger();
		const turnOne = ledger.record({ content: "", sections: first, tools: declarations });
		const turnTwo = ledger.record({ content: "", sections: second, tools: declarations });
		expect(turnTwo.prefixHash).toBe(turnOne.prefixHash);
		expect(turnTwo.total).toBe(turnOne.total);
		expect(formatTokenLedger(ledger.entries).join("\n")).not.toContain("PREFIX-CHANGED");
	});

	it("changes the hash when the prompt or the tool declarations change", () => {
		const base = measurePrefixParts(parts());
		expect(measurePrefixParts(parts({ content: "" })).prefixHash).toBe(base.prefixHash);
		expect(
			measurePrefixParts(parts({ sections: { ...parts().sections, cwd: "/workspace/other" } })).prefixHash,
		).not.toBe(base.prefixHash);
		expect(
			measurePrefixParts(
				parts({
					tools: [{ name: "read", description: "Read a file and more", parameters: { type: "object" } }],
				}),
			).prefixHash,
		).not.toBe(base.prefixHash);
	});

	it("marks PREFIX-CHANGED when the prefix is rewritten mid-session", () => {
		const ledger = new TokenLedger();
		ledger.record({ content: "", sections: { preamble: "You are Hanni." }, tools: [] });
		ledger.record({
			content: "",
			sections: { preamble: "You are Hanni.", rules: "<rules>\n- Be concise\n</rules>" },
			tools: [],
		});
		const lines = formatTokenLedger(ledger.entries);
		// lines[2] is the header, lines[3] and lines[4] the two turns.
		expect(lines[3]).not.toContain("PREFIX-CHANGED");
		expect(lines[4]).toContain("PREFIX-CHANGED");
		expect(lines[4]).toContain(formatTokenDelta(ledger.current!.total - ledger.previous!.total));
	});

	it("warns over the declared budget and names the schema that grew", () => {
		const entry = measurePrefixParts({
			content: "",
			sections: { preamble: "You are Hanni." },
			tools: [
				{ name: "mem_admin", description: "Administers memory", parameters: { type: "object", properties: {} } },
			],
		});
		const schemas = measureToolSchemas([
			{ name: "mem_admin", label: "hanniorq", description: "Administers memory", parameters: { type: "object" } },
			{ name: "read", label: "builtin", description: "Read a file", parameters: { type: "object" } },
		]);
		expect(formatBudgetWarning(entry, schemas)).toBeUndefined();

		const big = measurePrefixParts({
			content: "",
			sections: { preamble: "x".repeat(20_000) },
			tools: [{ name: "mem_admin", description: "Administers memory", parameters: { type: "object" } }],
		});
		const warning = formatBudgetWarning(big, schemas);
		expect(warning).toContain(`budget ${FIXED_BUDGET_TOKENS}`);
		expect(warning).toContain("hanniorq");
		expect(warning).toContain("mem_admin");
	});
});
