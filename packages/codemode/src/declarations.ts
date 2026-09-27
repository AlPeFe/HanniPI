import type { CodemodeJsonSchema, CodemodeTool } from "./types.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const INDENT = "  ";

export interface RenderDeclarationsOptions {
	tools?: readonly CodemodeTool[];
	globals?: readonly CodemodeTool[];
}

/**
 * Render TypeScript declarations for the script-visible API, for use in a model-facing
 * description. Tools become members of `declare const tools`, globals become
 * `declare function` statements, and `ns.member` globals members of `declare const ns`. Descriptions become doc comments; schemas become types
 * (`unknown` where a schema is missing or uses features TypeScript cannot express, such as
 * recursive `$ref`s).
 *
 * ```ts
 * declare const tools: {
 *   /** Read a file. *\/
 *   read(args: {
 *     /** Path to the file *\/
 *     path: string;
 *     offset?: number;
 *   }): Promise<string>;
 * };
 * ```
 */
export function renderDeclarations(options: RenderDeclarationsOptions): string {
	const sections: string[] = [];
	const tools = options.tools ?? [];
	if (tools.length > 0) {
		const members = tools.map((tool) => renderFunction(propertyKey(tool.name), tool, INDENT));
		sections.push(`declare const tools: {\n${members.join("\n")}\n};`);
	}
	const namespaces = new Map<string, string[]>();
	for (const global of options.globals ?? []) {
		const dot = global.name.indexOf(".");
		if (dot === -1) {
			sections.push(renderFunction(`declare function ${global.name}`, global, ""));
			continue;
		}
		const namespace = global.name.slice(0, dot);
		const members = namespaces.get(namespace) ?? [];
		if (members.length === 0) namespaces.set(namespace, members);
		members.push(renderFunction(global.name.slice(dot + 1), global, INDENT));
	}
	for (const [namespace, members] of namespaces) {
		sections.push(`declare const ${namespace}: {\n${members.join("\n")}\n};`);
	}
	return sections.join("\n\n");
}

function renderFunction(head: string, tool: CodemodeTool, indent: string): string {
	if (tool.signature !== undefined) return `${docComment(tool.description, indent)}${indent}${head}${tool.signature};`;
	const input = tool.inputSchema === undefined ? "unknown" : schemaToType(tool.inputSchema, indent);
	const output = tool.outputSchema === undefined ? "unknown" : schemaToType(tool.outputSchema, indent);
	const optional = input === "unknown" || isEmptyObjectSchema(tool.inputSchema) ? "?" : "";
	return `${docComment(tool.description, indent)}${indent}${head}(args${optional}: ${input}): Promise<${output}>;`;
}

function docComment(description: string | undefined, indent: string): string {
	const text = description?.trim();
	if (!text) return "";
	const lines = text.replaceAll("*/", "*\\/").split(/\r?\n/);
	if (lines.length === 1) return `${indent}/** ${lines[0]} */\n`;
	return `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
}

function propertyKey(name: string): string {
	return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEmptyObjectSchema(schema: CodemodeJsonSchema | undefined): boolean {
	if (!isObject(schema) || schema.type !== "object") return false;
	const properties = schema.properties;
	return (!isObject(properties) || Object.keys(properties).length === 0) && !isObject(schema.additionalProperties);
}

/** Wrap unions and intersections so they can be used as array element types. */
function asElement(type: string): string {
	return /^[\w$.<>[\]"']+$/.test(type) || type.startsWith("{") ? type : `(${type})`;
}

function union(types: string[]): string {
	const unique = [...new Set(types)];
	if (unique.includes("unknown")) return "unknown";
	return unique.length === 0 ? "never" : unique.join(" | ");
}

/**
 * Convert a JSON Schema to a TypeScript type expression. `indent` is the indentation of the line
 * the type starts on; nested object members are indented one level deeper. Local references
 * (`#/$defs/...`, `#/definitions/...`) resolve against `schema` itself; recursive references and
 * references elsewhere render as `unknown`.
 */
export function schemaToType(schema: CodemodeJsonSchema, indent = ""): string {
	return toType(schema, indent, { root: schema, resolving: new Set() });
}

interface SchemaContext {
	root: CodemodeJsonSchema;
	/** References being expanded on the current path, to stop at recursive types. */
	resolving: Set<string>;
}

function resolveRef(ref: string, root: CodemodeJsonSchema): CodemodeJsonSchema | undefined {
	if (ref !== "#" && !ref.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const segment of ref.slice(2).split("/").filter(Boolean)) {
		const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
		if (!isObject(current) || !(key in current)) return undefined;
		current = current[key];
	}
	return typeof current === "boolean" || isObject(current) ? current : undefined;
}

function toType(schema: CodemodeJsonSchema, indent: string, context: SchemaContext): string {
	if (schema === true) return "unknown";
	if (schema === false) return "never";
	if (!isObject(schema)) return "unknown";
	if (typeof schema.$ref === "string") {
		const ref = schema.$ref;
		const target = context.resolving.has(ref) ? undefined : resolveRef(ref, context.root);
		if (target === undefined) return "unknown";
		context.resolving.add(ref);
		try {
			return toType(target, indent, context);
		} finally {
			context.resolving.delete(ref);
		}
	}

	if ("const" in schema) return JSON.stringify(schema.const) ?? "unknown";
	if (Array.isArray(schema.enum)) return union(schema.enum.map((value) => JSON.stringify(value) ?? "unknown"));

	const variants = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
	if (variants) return union(variants.map((variant) => toType(variant as CodemodeJsonSchema, indent, context)));
	if (Array.isArray(schema.allOf)) {
		const parts = schema.allOf.map((part) => toType(part as CodemodeJsonSchema, indent, context));
		const meaningful = parts.filter((part) => part !== "unknown");
		return meaningful.length === 0 ? "unknown" : meaningful.map(asElement).join(" & ");
	}

	const type = schema.type;
	if (Array.isArray(type)) {
		return union(type.map((entry) => toType({ ...schema, type: entry }, indent, context)));
	}
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array":
			return arrayType(schema, indent, context);
		case "object":
			return objectType(schema, indent, context);
		case undefined:
			if (isObject(schema.properties) || isObject(schema.additionalProperties)) {
				return objectType(schema, indent, context);
			}
			if (schema.items !== undefined || schema.prefixItems !== undefined) return arrayType(schema, indent, context);
			return "unknown";
		default:
			return "unknown";
	}
}

function arrayType(schema: Record<string, unknown>, indent: string, context: SchemaContext): string {
	const tuple = Array.isArray(schema.prefixItems)
		? schema.prefixItems
		: Array.isArray(schema.items)
			? schema.items
			: [];
	if (tuple.length > 0) {
		return `[${tuple.map((item) => toType(item as CodemodeJsonSchema, indent, context)).join(", ")}]`;
	}
	const items = schema.items;
	if (items === undefined || Array.isArray(items)) return "unknown[]";
	return `${asElement(toType(items as CodemodeJsonSchema, indent, context))}[]`;
}

function objectType(schema: Record<string, unknown>, indent: string, context: SchemaContext): string {
	const properties = isObject(schema.properties) ? schema.properties : {};
	const required = new Set(Array.isArray(schema.required) ? schema.required : []);
	const additional = schema.additionalProperties;
	const inner = indent + INDENT;
	const members: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const description = isObject(property) && typeof property.description === "string" ? property.description : "";
		const optional = required.has(name) ? "" : "?";
		const type = toType(property as CodemodeJsonSchema, inner, context);
		members.push(`${docComment(description, inner)}${inner}${propertyKey(name)}${optional}: ${type};`);
	}
	if (additional !== undefined && additional !== false) {
		const type = additional === true ? "unknown" : toType(additional as CodemodeJsonSchema, inner, context);
		members.push(`${inner}[key: string]: ${type};`);
	} else if (members.length === 0 && additional === undefined) {
		return "Record<string, unknown>";
	}
	if (members.length === 0) return "{}";
	return `{\n${members.join("\n")}\n${indent}}`;
}
