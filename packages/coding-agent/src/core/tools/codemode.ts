/**
 * The `exec` tool (codemode): the model writes JavaScript that calls other tools. The surface
 * follows the `exec` tool of OpenAI Codex, which models are trained on, so scripts written for
 * Codex work unchanged: `tools`, `ALL_TOOLS`, `text()`, `image()`, `exit()`, `store()`/`load()`,
 * the `// @exec:` pragma, and the "Script completed" result header. pi additions are strict
 * supersets: `return <value>` appends the value like `text()`, `console.*` appends text, the pragma
 * accepts `timeout_ms`, and `models.*` exposes the model catalog and classifiers.
 *
 * Scripts can call the agent loop's nested tools: active `direct` tools and every `codemode` or
 * `deferred` tool. Nested calls run through the agent loop's tool pipeline (`ctx.executeTool`), so
 * validation, `tool_call`/`tool_result` hooks, and permission checks apply exactly as for direct
 * calls. Only the script's output reaches the model; nested results do not.
 *
 * Nested results are handed to the script as follows:
 * - A tool that declares `outputSchema` resolves to its `structuredContent`, also for error
 *   results that carry one (MCP tools resolve to their `CallToolResult`, including `isError`).
 * - Any other tool resolves to its text content as one string.
 * - A failed, blocked, or invalid call rejects with an Error carrying the tool's error text.
 *
 * A script that fails returns a normal error result that keeps its partial output, followed by
 * "Script error:" and the error. `store(key, value)` and `load(key)` keep JSON values across
 * calls; successful scripts append their writes to the session as `codemode-store` custom entries,
 * so each branch sees the values written on its own path.
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CodemodeJsonSchema, CodemodeTool } from "@earendil-works/pi-codemode";
import {
	MCP_TYPESCRIPT_PREAMBLE,
	mcpStructuredContentSchema,
	renderDeclarations,
	renderToolSample,
	toCodemodeIdentifier,
} from "@earendil-works/pi-codemode/declarations";
import { CODEMODE_SOURCE_GRAMMAR } from "@earendil-works/pi-codemode/source";
import { type Static, Type } from "typebox";
import type { ToolDefinition, ToolNamespace } from "../extensions/types.ts";
import type { ModelRuntime } from "../model-runtime.ts";
import { loadCodemodeExecutor } from "./codemode-execute.lazy.ts";
import { codemodeRenderers } from "./renderers/codemode.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const CODEMODE_TOOL_NAME = "exec";

/** Custom entry type holding one script's `store()` writes: {@link CodemodeStoreEntryData}. */
export const CODEMODE_STORE_ENTRY_TYPE = "codemode-store";

export interface CodemodeStoreEntryData {
	set: Record<string, unknown>;
	delete: string[];
}

/** The part of `ModelRuntime` that scripts reach through `models`. */
export type CodemodeModelRuntime = Pick<
	ModelRuntime,
	"getModelsOfType" | "getAvailableOfType" | "getModelOfType" | "classify"
>;

export interface CodemodeToolOptions {
	/** Exposes the `models` namespace to scripts. Without it, `models` is not declared. */
	models?: CodemodeModelRuntime;
	/**
	 * Persists `store()` writes as a session custom entry. Without it, writes last only for the
	 * current script; `load()` still reads entries already on the branch.
	 */
	appendEntry?: (customType: string, data: CodemodeStoreEntryData) => void;
}

const TEXT_OUTPUT_SCHEMA: CodemodeJsonSchema = { type: "string" };

export const codemodeSchema = Type.Object({
	code: Type.String({
		description:
			'Raw JavaScript source. Top-level await and return work. May start with a `// @exec: {"max_output_tokens": 1000}` pragma line.',
	}),
});

export type CodemodeToolInput = Static<typeof codemodeSchema>;

export type CodemodeNestedCallStatus = "running" | "ok" | "error" | "cancelled";

export interface CodemodeNestedCall {
	/** Tool call id of the nested call, `<exec call id>/<n>`. */
	id: string;
	name: string;
	/** Compact JSON of the arguments, truncated for display. */
	args: string;
	status: CodemodeNestedCallStatus;
	durationMs?: number;
	/** Error text, truncated for display. */
	error?: string;
}

export interface CodemodeToolDetails {
	calls: CodemodeNestedCall[];
	/** Temp file with the full text output, when the output was truncated. */
	fullOutputPath?: string;
}

export const codemodeToolSystemPromptContribution = {
	snippet: "Run JavaScript that calls other tools (chains, loops, Promise.all, filtering large results)",
	guidelines: [
		"Use exec to batch or chain several tool calls, or to filter large tool output down to what you need, instead of issuing many individual tool calls. Batch independent calls in one exec using await Promise.allSettled([...]).",
	],
} as const;

const DESCRIPTION_INTRO = `Run JavaScript code to orchestrate/compose tool calls
- Evaluates the provided JavaScript code in a fresh QuickJS sandbox as the body of an async function: top-level \`await\` and \`return\` work.
- All nested tools are available on the global \`tools\` object, for example \`await tools.read(...)\`. Tool names are exposed as normalized JavaScript identifiers, for example \`await tools.mcp__ologs__get_profile(...)\`.
- Nested tool methods take an object as their input argument.
- Nested tools return either an object or a string, based on the description.
- A nested tool call that fails, is blocked, or gets invalid arguments rejects with an Error carrying the tool's error text.
- Runs raw JavaScript -- no Node, no file system, no network access, no timers.
- Accepts raw JavaScript source text, not JSON, quoted strings, or markdown code fences.
- You may optionally start the tool input with a first-line pragma like \`// @exec: {"max_output_tokens": 1000, "timeout_ms": 60000}\`.
- \`max_output_tokens\` sets the token budget for direct \`exec\` results. Defaults to 10000 tokens.
- \`timeout_ms\` sets a hard deadline for the whole script. By default there is none. \`yield_time_ms\` is accepted, but scripts always run to completion.
- When the JS code is fully evaluated, calls that are still running are cancelled and unawaited promises are silently discarded.
- Tool calls are real and have side effects. If the script fails partway, earlier calls are not undone.
- Scripts have a 256 MB memory limit; exceeding it throws \`InternalError: out of memory\`. Filter or aggregate large data instead of accumulating it.

- Global helpers:
- \`exit()\`: Immediately ends the current script successfully (like an early return from the top level).
- \`text(value: string | number | boolean | undefined | null)\`: Appends a text item. Non-string values are stringified with \`JSON.stringify(...)\` when possible.
- \`image(imageUrlOrItem: string | { image_url: string } | ImageContent)\`: Appends an image item. \`image_url\` should be a base64-encoded \`data:\` URL. To forward an MCP tool image, pass an individual \`ImageContent\` block from \`result.content\`, for example \`image(result.content[0])\`.
- \`store(key: string, value: any)\`: stores a serializable value under a string key for later \`exec\` calls in the same session. Storing \`undefined\` deletes the key. Writes are kept only if the script succeeds.
- \`load(key: string)\`: returns the stored value for a string key, or \`undefined\` if it is missing.
- \`ALL_TOOLS\`: metadata for the enabled nested tools as \`{ name, description }\` entries.
- \`console.log(...)\` and the other \`console\` methods append a text item like \`text()\`.
- \`return value\` at the top level appends the value like \`text()\`.`;

const MODEL_TYPES = `type ModelType = "chat" | "image" | "classifier";
/** A model catalog entry. \`provider\` and \`id\` identify it; the other fields depend on the type. */
interface ModelInfo {
  type?: ModelType;
  provider: string;
  id: string;
  name: string;
  api: string;
  input: ("text" | "image")[];
  contextWindow?: number;
  [key: string]: unknown;
}
type ClassifierQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } };
type ClassifierAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; confidence: number }
  | { type: "bool"; probability: number };
interface ClassifierContext {
  state: Record<string, unknown>;
  questions: Record<string, ClassifierQuestion>;
}
interface ClassifierResult {
  api: string;
  provider: string;
  model: string;
  answers: Record<string, ClassifierAnswer>;
  stopReason: "stop" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}`;

/** Declarations of the `models` globals; codemode-execute.ts implements them. */
export const MODEL_GLOBAL_DECLARATIONS: readonly Omit<CodemodeTool, "execute">[] = [
	{
		name: "models.getModelsOfType",
		description: "Every known model of a type, optionally for one provider.",
		signature: "(type: ModelType, provider?: string): Promise<ModelInfo[]>",
	},
	{
		name: "models.getAvailableOfType",
		description: "Models of a type whose provider has working credentials.",
		signature: "(type: ModelType, provider?: string): Promise<ModelInfo[]>",
	},
	{
		name: "models.getModelOfType",
		description: "One catalog entry, or undefined.",
		signature: "(type: ModelType, provider: string, id: string): Promise<ModelInfo | undefined>",
	},
	{
		name: "models.classify",
		description:
			"Run a classifier model on one state. Only `provider` and `id` of `model` are used. Provider errors do not throw: check `stopReason` and `errorMessage`.",
		signature: "(model: ModelInfo, context: ClassifierContext): Promise<ClassifierResult>",
	},
];

const DEFERRED_TOOLS_GUIDANCE = `Some deferred nested tools may be omitted from this description. They are still available on the global \`tools\` object and listed in \`ALL_TOOLS\`.
To find one, filter \`ALL_TOOLS\` by \`name\` and \`description\`.`;

/** What a script sees of a tool. Tools without an output schema resolve to their text output. */
export function toCodemodeDeclaration(tool: AgentTool<any>): Omit<CodemodeTool, "execute"> {
	return {
		name: tool.name,
		description: tool.description,
		inputSchema: tool.parameters as CodemodeJsonSchema,
		outputSchema: (tool.outputSchema as CodemodeJsonSchema | undefined) ?? TEXT_OUTPUT_SCHEMA,
	};
}

/** Tools a script may call: every given tool except the exec tool itself. */
export function getCodemodeCallableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
	return tools.filter((tool) => tool.name !== CODEMODE_TOOL_NAME);
}

export interface CodemodeDescriptionOptions {
	/** Declare the `models` namespace; only for tools created with model access. */
	models?: boolean;
	/** Namespace of each tool, by tool name. Tools of one namespace are listed under one heading. */
	namespaces?: ReadonlyMap<string, ToolNamespace>;
	/** Whether some callable tools are not listed (`deferred` exposure). Adds Codex's guidance to find them. */
	hasDeferredTools?: boolean;
}

/** `### \`id\` (\`raw name\`)` followed by the tool's description and declaration, like Codex. */
function renderToolSection(declaration: Omit<CodemodeTool, "execute">): string {
	const id = toCodemodeIdentifier(declaration.name);
	const heading = id === declaration.name ? `### \`${id}\`` : `### \`${id}\` (\`${declaration.name}\`)`;
	return `${heading}\n${renderToolSample(declaration).trim()}`;
}

/**
 * Model-facing description in the layout of Codex's code-mode-only `exec` description: the helper
 * list, guidance for deferred tools, the shared MCP types when MCP tools are listed, and one section
 * per tool, grouped by namespace. The `models` API is a pi addition.
 */
export function createCodemodeDescription(
	tools: readonly AgentTool<any>[],
	options: CodemodeDescriptionOptions = {},
): string {
	const sections = [DESCRIPTION_INTRO];
	if (options.hasDeferredTools) sections.push(DEFERRED_TOOLS_GUIDANCE);
	const declarations = getCodemodeCallableTools(tools).map(toCodemodeDeclaration);
	if (declarations.some((declaration) => mcpStructuredContentSchema(declaration.outputSchema) !== undefined)) {
		sections.push(`Shared MCP Types:\n\`\`\`ts\n${MCP_TYPESCRIPT_PREAMBLE}\n\`\`\``);
	}
	if (options.models) {
		const noop = () => undefined;
		const models = renderDeclarations({
			globals: MODEL_GLOBAL_DECLARATIONS.map((global) => ({ ...global, execute: noop })),
		});
		sections.push(`Model API:\n\`\`\`ts\n${MODEL_TYPES}\n\n${models}\n\`\`\``);
	}

	const toolSections: string[] = [];
	const groups = new Map<string, { namespace: ToolNamespace; declarations: Omit<CodemodeTool, "execute">[] }>();
	for (const declaration of declarations) {
		const namespace = options.namespaces?.get(declaration.name);
		if (!namespace) {
			toolSections.push(renderToolSection(declaration));
			continue;
		}
		const group = groups.get(namespace.name) ?? { namespace, declarations: [] };
		groups.set(namespace.name, group);
		group.declarations.push(declaration);
	}
	for (const { namespace, declarations: grouped } of groups.values()) {
		const description = namespace.description?.trim();
		if (description) toolSections.push(`## ${namespace.name}\n${description}`);
		for (const declaration of grouped) toolSections.push(renderToolSection(declaration));
	}
	if (toolSections.length > 0) sections.push(toolSections.join("\n\n"));
	return sections.join("\n\n");
}

export function createCodemodeToolDefinition(
	options: CodemodeToolOptions = {},
): ToolDefinition<typeof codemodeSchema, CodemodeToolDetails | undefined> {
	return {
		name: CODEMODE_TOOL_NAME,
		label: CODEMODE_TOOL_NAME,
		// Replaced with the declarations of the callable tools when the tool is activated.
		description: createCodemodeDescription([], { models: options.models !== undefined }),
		promptSnippet: codemodeToolSystemPromptContribution.snippet,
		promptGuidelines: [...codemodeToolSystemPromptContribution.guidelines],
		parameters: codemodeSchema,
		// Scripts must not start other scripts.
		exposure: "model-only",
		// Capable models write the script as raw text instead of a JSON-escaped string.
		constrainedSampling: { type: "grammar", variants: { openai_lark: CODEMODE_SOURCE_GRAMMAR } },
		// The sandbox (worker, QuickJS wasm) loads on the first call, not at startup.
		execute: async (toolCallId, params, signal, onUpdate, ctx) =>
			(await loadCodemodeExecutor()).executeCodemode(toolCallId, params, signal, onUpdate, ctx, options),
		...codemodeRenderers,
	};
}

/**
 * Create the exec tool as an AgentTool. The description lists the given tools; the script can
 * call whatever tools the agent loop provides at execution time.
 */
export function createCodemodeTool(
	tools: readonly AgentTool<any>[] = [],
	options: CodemodeToolOptions = {},
): AgentTool<typeof codemodeSchema> {
	const definition = createCodemodeToolDefinition(options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		description: createCodemodeDescription(tools, { models: options.models !== undefined }),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
