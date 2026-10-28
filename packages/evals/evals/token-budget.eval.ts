import {
	allToolNames,
	createAllToolDefinitions,
	createCodingToolDefinitions,
	FIXED_BUDGET_TOKENS,
	MEASURED_FIXED_TOKENS,
	measureFixedPrefix,
	measureToolSchemas,
	type TokenLedgerEntry,
	type ToolSchemaMeasurement,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

/**
 * SPEC-003/SPEC-004: the fixed prefix per turn is a declared number, not an emergent one.
 *
 * This eval builds the same prompt and the same tool declarations the harness sends on the
 * first turn and fails when their cost crosses FIXED_BUDGET_TOKENS. It runs offline with no
 * provider and costs nothing, so it can gate every commit: a new extension (or a fatter
 * schema on an existing tool) cannot make every turn more expensive in silence.
 *
 * The count is the ledger's cl100k-calibrated estimate. Reference figures below come from
 * `bench/ts/token_budget.mjs` (real cl100k tokenizer, 2026-10-28): 1,865 tokens for this
 * prompt with every built-in tool at cwd /workspace/project.
 */
const CWD = "/workspace/project";
const BUILTIN_NAMES: ReadonlySet<string> = new Set(allToolNames);
const REFERENCE_ALL_TOOLS = 1865;

function overBudgetMessage(entry: TokenLedgerEntry, schemas: readonly ToolSchemaMeasurement[]): string {
	const over = entry.total - FIXED_BUDGET_TOKENS;
	const extensionTools = schemas.filter((schema) => !BUILTIN_NAMES.has(schema.name));
	const extensionTokens = extensionTools.reduce((sum, schema) => sum + schema.tokens, 0);
	const biggest = [...schemas].sort((a, b) => b.tokens - a.tokens).slice(0, 5);
	const lines = [
		`fixed_tokens_per_turn ${entry.total} exceeds the declared budget of ${FIXED_BUDGET_TOKENS} by ${over}.`,
		`components: prompt ${entry.components.systemPrompt.tokens} + tool list ${entry.components.activeTools.tokens} + ` +
			`schemas ${entry.components.toolSchemas.tokens} + injected ${entry.components.injectedContext.tokens}.`,
		`largest schemas: ${biggest.map((schema) => `${schema.name} ${schema.tokens}`).join(", ")}.`,
	];
	if (extensionTools.length > 0) {
		lines.push(
			`extension tools account for ${extensionTokens} tokens: ` +
				extensionTools.map((schema) => `${schema.name} ${schema.tokens}`).join(", ") +
				". Trim or defer that extension, or raise FIXED_BUDGET_TOKENS in packages/coding-agent/src/core/token-ledger.ts with a measured reason.",
		);
	}
	return lines.join("\n");
}

describe("token budget", () => {
	it("keeps the default fixed prefix within the declared budget", () => {
		const tools = Object.values(createAllToolDefinitions(CWD));
		const entry = measureFixedPrefix({ cwd: CWD, tools });
		const schemas = measureToolSchemas(
			tools.map((tool) => ({
				name: tool.name,
				label: BUILTIN_NAMES.has(tool.name) ? "builtin" : "extension",
				description: tool.description,
				parameters: tool.parameters,
			})),
		);
		expect(entry.total, overBudgetMessage(entry, schemas)).toBeLessThanOrEqual(FIXED_BUDGET_TOKENS);
		// Drift guard: the estimate must stay close to the tokenizer reference.
		expect(Math.abs(entry.total - REFERENCE_ALL_TOOLS) / REFERENCE_ALL_TOOLS).toBeLessThan(0.05);
		expect(entry.total).toBeGreaterThanOrEqual(MEASURED_FIXED_TOKENS - 200);
	});

	it("keeps the vanilla four-tool prefix within the declared budget", () => {
		const entry = measureFixedPrefix({ cwd: CWD, tools: createCodingToolDefinitions(CWD) });
		const schemas = measureToolSchemas(
			createCodingToolDefinitions(CWD).map((tool) => ({
				name: tool.name,
				label: "builtin",
				description: tool.description,
				parameters: tool.parameters,
			})),
		);
		expect(entry.total, overBudgetMessage(entry, schemas)).toBeLessThanOrEqual(FIXED_BUDGET_TOKENS);
		expect(entry.toolNames).toEqual(["read", "bash", "edit", "write"]);
	});
});
