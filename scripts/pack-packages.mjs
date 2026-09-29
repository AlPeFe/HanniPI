#!/usr/bin/env node

import { resolve } from "node:path";
import { produceArtifactSet } from "./artifact-set.mjs";

function printUsage() {
	console.log(`Usage: node scripts/pack-packages.mjs --out <dir> [options]

Builds every public package and writes one coherent local artifact set.

Options:
  --out <dir>            Output directory; .artifacts/ is ignored by Git
  --force                Replace an existing output directory
  --offline-model-data   Build with already-hydrated model data
  --skip-build           Pack existing build output without rebuilding
  --help                 Show this help
`);
}

const options = { build: true, force: false, offlineModelData: false, outDir: undefined };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help") {
		printUsage();
		process.exit(0);
	}
	if (arg === "--force") options.force = true;
	else if (arg === "--offline-model-data") options.offlineModelData = true;
	else if (arg === "--skip-build") options.build = false;
	else if (arg === "--out") {
		const outDir = args[i + 1];
		if (!outDir || outDir.startsWith("--")) throw new Error("--out requires a directory");
		options.outDir = outDir;
		i++;
	}
	else throw new Error(`Unknown option: ${arg}`);
}
if (!options.outDir) throw new Error("--out is required");

const artifactSet = produceArtifactSet({ ...options, repoRoot: process.cwd() });
console.log(`\nLocal package artifacts created: ${artifactSet.artifactDirectory}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nConnect an external npm project with:");
console.log(
	`  node ${resolve("scripts/use-local-packages.mjs")} --manifest ${artifactSet.manifestPath} --consumer <project> --package <name>`,
);
