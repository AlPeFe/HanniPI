import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "codemode", factory: codemodeExtension, hidden: true },
	{ name: "tool-search", factory: toolSearchExtension, hidden: true },
	{ name: "mcp", factory: mcpExtension, hidden: true },
];
