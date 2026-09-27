/**
 * Codemode source format: JavaScript, optionally preceded by one pragma line. The format matches
 * the `exec` tool of OpenAI Codex, so models trained on it can use it unchanged; `timeout_ms` is
 * an addition.
 *
 * ```js
 * // @exec: {"max_output_tokens": 2000, "timeout_ms": 30000}
 * const text = await tools.read({ path: "package.json" });
 * text(JSON.parse(text).name);
 * ```
 */

export const CODEMODE_PRAGMA_PREFIX = "// @exec:";

const SUPPORTED_FIELDS = ["yield_time_ms", "max_output_tokens", "timeout_ms"] as const;
const SUPPORTED_FIELDS_TEXT = "`yield_time_ms`, `max_output_tokens`, and `timeout_ms`";
/** Largest delay `setTimeout` supports, which bounds `timeout_ms`. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Lark grammar for providers with grammar-constrained tool input, identical to Codex's `exec`
 * grammar. It only fixes the shape of the pragma line; the pragma JSON and the code are checked by
 * {@link parseCodemodeSource}.
 */
export const CODEMODE_SOURCE_GRAMMAR = String.raw`
start: pragma_source | plain_source
pragma_source: PRAGMA_LINE NEWLINE SOURCE
plain_source: SOURCE

PRAGMA_LINE: /[ \t]*\/\/ @exec:[^\r\n]*/
NEWLINE: /\r?\n/
SOURCE: /[\s\S]+/
`;

export interface CodemodeSourceOptions {
	/** Codex: return early if the script is still running after this long. Parsed, not acted on here. */
	yieldTimeMs?: number;
	/** Token budget for the script's output. */
	maxOutputTokens?: number;
	/** Hard deadline for the whole script in milliseconds, including tool calls. */
	timeoutMs?: number;
}

export interface ParsedCodemodeSource {
	/** The script with the pragma line replaced by an empty line, so line numbers are unchanged. */
	code: string;
	options: CodemodeSourceOptions;
}

export class CodemodeSourceError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodemodeSourceError";
	}
}

function isSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parsePragma(directive: string): CodemodeSourceOptions {
	if (directive === "") {
		throw new CodemodeSourceError(`exec pragma must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	let value: unknown;
	try {
		value = JSON.parse(directive);
	} catch (error) {
		throw new CodemodeSourceError(
			`exec pragma must be valid JSON with supported fields ${SUPPORTED_FIELDS_TEXT}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new CodemodeSourceError(`exec pragma must be a JSON object with supported fields ${SUPPORTED_FIELDS_TEXT}`);
	}
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields)) {
		if (!(SUPPORTED_FIELDS as readonly string[]).includes(key)) {
			throw new CodemodeSourceError(`exec pragma only supports ${SUPPORTED_FIELDS_TEXT}; got \`${key}\``);
		}
	}
	const options: CodemodeSourceOptions = {};
	const { yield_time_ms, max_output_tokens, timeout_ms } = fields;
	if (yield_time_ms !== undefined) {
		if (!isSafeInteger(yield_time_ms)) {
			throw new CodemodeSourceError("exec pragma field `yield_time_ms` must be a non-negative safe integer");
		}
		options.yieldTimeMs = yield_time_ms;
	}
	if (max_output_tokens !== undefined) {
		if (!isSafeInteger(max_output_tokens)) {
			throw new CodemodeSourceError("exec pragma field `max_output_tokens` must be a non-negative safe integer");
		}
		options.maxOutputTokens = max_output_tokens;
	}
	if (timeout_ms !== undefined) {
		if (!isSafeInteger(timeout_ms) || timeout_ms === 0 || timeout_ms > MAX_TIMEOUT_MS) {
			throw new CodemodeSourceError(
				`exec pragma field \`timeout_ms\` must be a positive integer up to ${MAX_TIMEOUT_MS}`,
			);
		}
		options.timeoutMs = timeout_ms;
	}
	return options;
}

/**
 * Split an optional first-line `// @exec: {...}` pragma from the script. Throws
 * {@link CodemodeSourceError} for empty input and invalid pragmas.
 */
export function parseCodemodeSource(input: string): ParsedCodemodeSource {
	if (input.trim() === "") {
		throw new CodemodeSourceError(
			'exec expects raw JavaScript source text (non-empty). Provide JS only, optionally with first-line `// @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}`.',
		);
	}
	const newline = input.indexOf("\n");
	const firstLine = (newline === -1 ? input : input.slice(0, newline)).replace(/\r$/, "");
	const trimmed = firstLine.trimStart();
	if (!trimmed.startsWith(CODEMODE_PRAGMA_PREFIX)) return { code: input, options: {} };
	const code = newline === -1 ? "" : input.slice(newline);
	if (code.trim() === "") {
		throw new CodemodeSourceError("exec pragma must be followed by JavaScript source on subsequent lines");
	}
	return { code, options: parsePragma(trimmed.slice(CODEMODE_PRAGMA_PREFIX.length).trim()) };
}
