/**
 * Per-turn token accounting for the request prefix.
 *
 * Every request the harness sends starts with a prefix the model can cache: the system
 * prompt and the tool declarations. That prefix is paid at full input price the first time
 * and, on providers with prompt caching, at the (cheaper) cache-read price afterwards.
 * Rewriting any part of it mid-session invalidates the cache and the next turn pays the
 * whole prefix again.
 *
 * This module measures that prefix per turn, hashes it, and keeps the last entries so the
 * TUI can show what a turn costs and whether the prefix changed. The count is an estimate
 * calibrated against cl100k: see {@link estimateTokens}. Provider tokenizers differ, so the
 * absolute number is a reference, not a bill; the provider's own `usage` is the bill.
 */

import { createHash } from "node:crypto";
import {
	contentText,
	getCurrentSystemMessage,
	type SystemMessage,
	type Tool,
	type TranscriptMessages,
	toToolDeclaration,
} from "@earendil-works/pi-ai";
import { type BuildSystemPromptOptions, buildSystemPromptSections } from "./system-prompt.ts";

/** Bumped whenever the hashed prefix content changes shape, so old hashes never collide. */
const PREFIX_HASH_VERSION = "hannipi-prefix-v1";

/**
 * Deterministic, dependency-free token estimate calibrated against cl100k (GPT-4o/tiktoken),
 * the tokenizer `bench/ts/token_budget.mjs` uses. Letters and digits carry most of the
 * information; punctuation and whitespace merge into neighbouring tokens, so they weigh less.
 *
 * Calibration corpus (2026-10-28, harness compiled): system prompt sections, tool schema
 * JSON, AGENTS.md, this repo's README/CHANGELOG/source, docs in Spanish. Worst error on the
 * fixed-cost parts (prompt + schemas) is ~3%; English prose stays within ~8%; heavily
 * accented Spanish prose undershoots by ~15% because cl100k splits accents into extra
 * tokens. It is a comparison instrument, not an invoice.
 */
const LETTERS_PER_TOKEN = 4.05;
const PUNCTUATION_PER_TOKEN = 4.9;
const SPACES_PER_TOKEN = 66;
const NEWLINES_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	if (text.length === 0) return 0;
	let letters = 0;
	let punctuation = 0;
	let spaces = 0;
	let newlines = 0;
	for (const char of text) {
		if (char === "\n") {
			newlines++;
		} else if (char === " " || char === "\t" || char === "\r") {
			spaces++;
		} else if (/[\p{L}\p{N}_]/u.test(char)) {
			letters++;
		} else {
			punctuation++;
		}
	}
	const tokens =
		letters / LETTERS_PER_TOKEN +
		punctuation / PUNCTUATION_PER_TOKEN +
		spaces / SPACES_PER_TOKEN +
		newlines / NEWLINES_PER_TOKEN;
	// An empty-ish string still costs a token, and the estimate must never round to zero.
	return Math.max(1, Math.ceil(tokens));
}

/**
 * Fixed prefix of the default install, measured with the cl100k tokenizer over the compiled
 * harness (2026-10-28): 1,875 tokens with every built-in tool declared (prompt 719 + schemas
 * 1,156) and no context file. Reproduce with `bench/ts/token_budget.mjs` in the CTO repo.
 *
 * The ledger's own estimate for the same prefix is 1,825 (-2.7%), inside the ±5% the spec
 * asks for. Earlier notes quoted 1,735: that figure omitted the promptGuidelines bullets the
 * harness does send, so it undercounts the prompt by ~140 tokens.
 */
export const MEASURED_FIXED_TOKENS = 1875;

/**
 * Declared ceiling for the fixed prefix, same unit as {@link MEASURED_FIXED_TOKENS}: the
 * measured value plus ~4%. Rewording the prompt does not trip it; a new tool with a fat
 * schema does. The startup warning and the `token-budget` eval both compare against it.
 */
export const FIXED_BUDGET_TOKENS = 1950;

/**
 * Provider tokens per cl100k token, measured end-to-end against the opencode-go gateway
 * (2026-10-28): the same default prefix counted 1,875 with cl100k and 2,996 with the
 * provider's own accounting. Use it to translate a ledger figure into what the invoice says.
 */
export const PROVIDER_TOKEN_FACTOR = 1.6;

/** One measured part of the prefix. */
export interface TokenLedgerComponent {
	tokens: number;
	bytes: number;
}

/** The four parts the ledger separates, so a regression names itself. */
export interface TokenLedgerComponents {
	/** Base prompt: preamble, rules, docs pointers, cwd. */
	systemPrompt: TokenLedgerComponent;
	/** The `<tools>` section: names plus one-line snippets the prompt lists. */
	activeTools: TokenLedgerComponent;
	/** Tool declarations sent to the provider: name, description, JSON schema. */
	toolSchemas: TokenLedgerComponent;
	/** Everything injected by extensions or project files: addendum, project context, skills. */
	injectedContext: TokenLedgerComponent;
}

export interface TokenLedgerEntry {
	/** 1-based request number within the session. */
	turn: number;
	timestamp: number;
	/** `provider/model` of the request, when known. */
	model?: string;
	components: TokenLedgerComponents;
	/** Sum of the four components: the fixed cost of this turn before the conversation. */
	total: number;
	/** `sha256:<hex>` over the rendered system prompt and the tool declarations. */
	prefixHash: string;
	/** System prompt section names present, in order. */
	sectionNames: string[];
	/** Tools declared to the model, in declaration order. */
	toolNames: string[];
}

/** Sections that belong to the base prompt rather than to an injection. */
const BASE_PROMPT_SECTIONS = new Set(["preamble", "rules", "docs", "cwd"]);
/** The section that lists tool names and snippets. */
const TOOL_LIST_SECTION = "tools";

function measure(text: string): TokenLedgerComponent {
	return { tokens: estimateTokens(text), bytes: Buffer.byteLength(text, "utf8") };
}

function joinParts(parts: readonly string[]): string {
	return parts.filter((part) => part.length > 0).join("\n\n");
}

/** The parts of a prefix, before they are measured. */
export interface PrefixParts {
	/** Opaque prompt text (a forced prompt); empty for structured sections. */
	content: string;
	/** Structured sections, keyed by name, as `SystemMessage.sections` stores them. */
	sections: Record<string, string>;
	/** Tool declarations exactly as the request carries them. */
	tools: readonly Tool[];
}

/** Split a system message into the parts the ledger measures. */
export function prefixPartsFromSystemMessage(message: SystemMessage | undefined): PrefixParts {
	if (!message) return { content: "", sections: {}, tools: [] };
	const sections: Record<string, string> = {};
	for (const [name, text] of Object.entries(message.sections ?? {})) {
		// A null value removes a section the transcript no longer carries.
		if (text !== null) sections[name] = text;
	}
	return { content: contentText(message.content), sections, tools: message.toolsAdded ?? [] };
}

/**
 * `sha256` over the rendered system prompt and the serialized tool declarations. This is the
 * value a prompt cache keys on: equal hash means the provider can serve the prefix from
 * cache; a different hash means the next turn pays it again.
 */
export function hashPrefix(renderedSystemPrompt: string, tools: readonly Tool[]): string {
	const declarations = tools.map(toToolDeclaration);
	const material = `${PREFIX_HASH_VERSION}\n${renderedSystemPrompt}\n---tools---\n${JSON.stringify(declarations)}`;
	return `sha256:${createHash("sha256").update(material, "utf8").digest("hex")}`;
}

/** Measure one request prefix. `turn` and `timestamp` are filled by {@link TokenLedger}. */
export function measurePrefixParts(
	parts: PrefixParts,
	options: { model?: string; turn?: number; timestamp?: number } = {},
): TokenLedgerEntry {
	const basePrompt: string[] = [parts.content];
	const toolList: string[] = [];
	const injected: string[] = [];
	for (const [name, text] of Object.entries(parts.sections)) {
		if (BASE_PROMPT_SECTIONS.has(name)) basePrompt.push(text);
		else if (name === TOOL_LIST_SECTION) toolList.push(text);
		else injected.push(text);
	}

	const systemPromptText = joinParts(basePrompt);
	const activeToolsText = joinParts(toolList);
	const injectedText = joinParts(injected);
	const toolSchemasText = JSON.stringify(parts.tools.map(toToolDeclaration));
	const components: TokenLedgerComponents = {
		systemPrompt: measure(systemPromptText),
		activeTools: measure(activeToolsText),
		toolSchemas: measure(toolSchemasText),
		injectedContext: measure(injectedText),
	};
	const total =
		components.systemPrompt.tokens +
		components.activeTools.tokens +
		components.toolSchemas.tokens +
		components.injectedContext.tokens;

	// The hash covers the prompt exactly as the provider receives it: the original section
	// order, with volatile per-turn content kept out of it (that travels in later messages).
	const rendered = joinParts([parts.content, ...Object.values(parts.sections)]);

	return {
		turn: options.turn ?? 1,
		timestamp: options.timestamp ?? Date.now(),
		...(options.model ? { model: options.model } : {}),
		components,
		total,
		prefixHash: hashPrefix(rendered, parts.tools),
		sectionNames: Object.keys(parts.sections),
		toolNames: parts.tools.map((tool) => tool.name),
	};
}

/** Measure the current prefix of a transcript, exactly as the next request will send it. */
export function measureTranscriptPrefix(
	messages: TranscriptMessages,
	options: { model?: string; turn?: number; timestamp?: number } = {},
): TokenLedgerEntry {
	return measurePrefixParts(prefixPartsFromSystemMessage(getCurrentSystemMessage(messages)), options);
}

/**
 * Measure the fixed prefix of the default prompt for a tool set, without a session. This is
 * what `packages/evals` gates: the same prompt builder and the same declarations the harness
 * sends on its first turn.
 */
export function measureFixedPrefix(input: {
	cwd: string;
	tools: ReadonlyArray<{
		name: string;
		description?: string;
		parameters?: unknown;
		promptSnippet?: string;
		promptGuidelines?: string[];
	}>;
	options?: BuildSystemPromptOptions;
}): TokenLedgerEntry {
	const toolSnippets: Record<string, string> = {};
	const toolGuidelines: Record<string, string[]> = {};
	for (const tool of input.tools) {
		if (tool.promptSnippet) toolSnippets[tool.name] = tool.promptSnippet;
		if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
			toolGuidelines[tool.name] = [...tool.promptGuidelines];
		}
	}
	const sections = buildSystemPromptSections({
		selectedTools: input.tools.map((tool) => tool.name),
		toolSnippets,
		toolGuidelines,
		cwd: input.cwd,
		...input.options,
	});
	const declarations: Tool[] = input.tools.map((tool) => ({
		name: tool.name,
		description: tool.description ?? "",
		parameters: (tool.parameters ?? { type: "object", properties: {} }) as Tool["parameters"],
	}));
	return measurePrefixParts({ content: "", sections, tools: declarations });
}

/** Per-tool schema cost, so an over-budget report can name the tool that grew. */
export interface ToolSchemaMeasurement {
	name: string;
	/** Source label, for example `builtin` or an extension path. */
	label: string;
	tokens: number;
}

export function measureToolSchemas(
	tools: ReadonlyArray<{ name: string; label: string; description?: string; parameters?: unknown }>,
): ToolSchemaMeasurement[] {
	return tools.map((tool) => ({
		name: tool.name,
		label: tool.label,
		tokens: estimateTokens(
			JSON.stringify({
				name: tool.name,
				description: tool.description ?? "",
				parameters: tool.parameters ?? {},
			}),
		),
	}));
}

/** Human-readable warning for a prefix over {@link FIXED_BUDGET_TOKENS}, if it is over. */
export function formatBudgetWarning(
	entry: TokenLedgerEntry,
	schemas: readonly ToolSchemaMeasurement[],
	budget: number = FIXED_BUDGET_TOKENS,
): string | undefined {
	if (entry.total <= budget) return undefined;
	const overage = entry.total - budget;
	const perLabel = new Map<string, number>();
	for (const schema of schemas) perLabel.set(schema.label, (perLabel.get(schema.label) ?? 0) + schema.tokens);
	const labels = [...perLabel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
	const biggest = [...schemas].sort((a, b) => b.tokens - a.tokens).slice(0, 3);
	const byLabel = labels.map(([label, tokens]) => `${label} ${tokens}`).join(", ");
	const byTool = biggest.map((schema) => `${schema.name} ${schema.tokens}`).join(", ");
	return (
		`Fixed prompt prefix is ${entry.total} tokens (budget ${budget}, +${overage}). ` +
		`Tool schemas by source: ${byLabel}. Largest schemas: ${byTool}. ` +
		"Every turn pays this prefix before the conversation; trim the extension that grew it or raise FIXED_BUDGET_TOKENS in core/token-ledger.ts."
	);
}

/** Round-robin log of measured prefixes. Entries are immutable; the newest is last. */
export class TokenLedger {
	private readonly _entries: TokenLedgerEntry[] = [];
	private readonly _limit: number;

	constructor(limit = 50) {
		this._limit = limit;
	}

	get entries(): readonly TokenLedgerEntry[] {
		return this._entries;
	}

	get current(): TokenLedgerEntry | undefined {
		return this._entries[this._entries.length - 1];
	}

	get previous(): TokenLedgerEntry | undefined {
		return this._entries[this._entries.length - 2];
	}

	/** Append a measured prefix, numbering it as the next turn. Returns the stored entry. */
	record(parts: PrefixParts, options: { model?: string; timestamp?: number } = {}): TokenLedgerEntry {
		const entry = measurePrefixParts(parts, {
			...options,
			turn: this._entries.length + 1,
			timestamp: options.timestamp ?? Date.now(),
		});
		this._entries.push(entry);
		if (this._entries.length > this._limit) this._entries.shift();
		return entry;
	}

	/** Record the prefix of a transcript as the next request will send it. */
	recordTranscript(messages: TranscriptMessages, options: { model?: string } = {}): TokenLedgerEntry {
		const measured = measureTranscriptPrefix(messages, { ...options, turn: this._entries.length + 1 });
		this._entries.push(measured);
		if (this._entries.length > this._limit) this._entries.shift();
		return measured;
	}

	clear(): void {
		this._entries.length = 0;
	}
}

function formatComponent(component: TokenLedgerComponent): string {
	return `${component.tokens}`;
}

/** `+12`, `-40` or `0`, for a total delta between two turns. */
export function formatTokenDelta(value: number): string {
	if (value === 0) return "0";
	return value > 0 ? `+${value}` : String(value);
}

/**
 * Plain-text rendering of the ledger for the TUI. The caller applies theme colors; keeping
 * the layout here makes the numbers testable without a terminal.
 */
export function formatTokenLedger(
	entries: readonly TokenLedgerEntry[],
	budget: number = FIXED_BUDGET_TOKENS,
): string[] {
	const lines: string[] = [];
	lines.push("Token ledger (cl100k-calibrated estimate; provider tokens ~x1.73)");
	lines.push("");
	lines.push("turn  system  tools  schemas  injected  total  budget  hash      delta");
	entries.forEach((entry, index) => {
		const previous = index > 0 ? entries[index - 1] : undefined;
		const changed = previous !== undefined && previous.prefixHash !== entry.prefixHash;
		const delta = previous === undefined ? "" : formatTokenDelta(entry.total - previous.total);
		const budgetState = entry.total > budget ? `+${entry.total - budget}` : "ok";
		const hash = entry.prefixHash.replace(/^sha256:/, "").slice(0, 8);
		lines.push(
			[
				String(entry.turn).padStart(4),
				formatComponent(entry.components.systemPrompt).padStart(7),
				formatComponent(entry.components.activeTools).padStart(6),
				formatComponent(entry.components.toolSchemas).padStart(8),
				formatComponent(entry.components.injectedContext).padStart(9),
				String(entry.total).padStart(6),
				budgetState.padStart(7),
				hash.padEnd(9),
				delta,
				changed ? "PREFIX-CHANGED" : "",
			]
				.filter((cell, cellIndex) => !(cellIndex === 9 && cell === ""))
				.join("  ")
				.trimEnd(),
		);
	});
	return lines;
}
