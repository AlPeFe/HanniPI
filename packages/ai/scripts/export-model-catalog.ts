#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type ModelCatalog, readModelCatalog, validateGeneratedModelData } from "./model-data.ts";

/** Serialize a typed catalog exactly as the published `models.all.json`. */
export function serializeModelCatalog(catalog: ModelCatalog): string {
	return `${JSON.stringify(catalog)}\n`;
}

/**
 * Export the existing build snapshot as `models.all.json` plus the legacy
 * chat-only `models.json`, never regenerating or fetching model data.
 */
export function exportModelCatalog(packageRoot: string, outputDir: string): void {
	validateGeneratedModelData(packageRoot);
	const catalog = readModelCatalog(join(packageRoot, "src", "providers", "data"));
	const chatCatalog = Object.fromEntries(
		Object.entries(catalog).map(([provider, models]) => [
			provider,
			Object.fromEntries(models.filter((model) => model.type === "chat").map((model) => [model.id, model])),
		]),
	);
	mkdirSync(outputDir, { recursive: true });
	writeFileSync(join(outputDir, "models.all.json"), serializeModelCatalog(catalog));
	writeFileSync(join(outputDir, "models.json"), `${JSON.stringify(chatCatalog)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 3) throw new Error("Usage: node export-model-catalog.ts <output-dir>");
	exportModelCatalog(join(dirname(fileURLToPath(import.meta.url)), ".."), resolve(process.argv[2]));
}
