#!/usr/bin/env node

import { resolve } from "node:path";
import { wireConsumer } from "./local-package-install.mjs";
import { readArtifactSet } from "./package-artifacts.mjs";

function printUsage() {
	console.log(`Usage: node scripts/use-local-packages.mjs --manifest <path> --consumer <dir> --package <name> [--package <name> ...]

Updates an external npm project's package.json to use direct packages and all
transitive Pi packages from a local package artifact set.
`);
}

const options = { packageNames: [] };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
	const arg = args[i];
	if (arg === "--help") {
		printUsage();
		process.exit(0);
	}
	if (arg !== "--manifest" && arg !== "--consumer" && arg !== "--package") throw new Error(`Unknown option: ${arg}`);
	const value = args[i + 1];
	if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
	i++;
	if (arg === "--manifest") options.manifest = value;
	else if (arg === "--consumer") options.consumer = value;
	else options.packageNames.push(value);
}
if (!options.manifest) throw new Error("--manifest is required");
if (!options.consumer) throw new Error("--consumer is required");
if (options.packageNames.length === 0) throw new Error("At least one --package is required");

const artifactSet = readArtifactSet(resolve(options.manifest));
const consumerDirectory = resolve(options.consumer);
wireConsumer({ artifactSet, consumerDirectory, packageNames: options.packageNames });

console.log(`Updated ${consumerDirectory}/package.json from ${artifactSet.manifestPath}`);
console.log("Run npm install --ignore-scripts in the consumer project.");
