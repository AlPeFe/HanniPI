#!/usr/bin/env node
import { execFileSync } from "node:child_process";

import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installConsumer, packageConsumerDirectoryName, smokeTestNpmConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";
import { codingAgentName, smokeTestCodingAgent } from "./coding-agent-smoke.mjs";
import { execNpmSync } from "./npm-command.mjs";

function printUsage() {
	console.log(`Usage: node scripts/local-release.mjs [options]

Builds and packs the publishable packages, then installs the tarballs into
isolated directories outside the repository for local release testing.

Options:
  --out <dir>          Output directory. Defaults to a new directory under ${tmpdir()}
  --force              Remove --out first if it already exists
  --skip-check         Do not run npm run check before building
  --skip-test          Do not run ./test.sh after building
  --skip-install       Only create the artifact set; do not create isolated installs
  --skip-bun-install   Do not create the isolated Bun install
  --help               Show this help
`);
}

function parseArgs() {
	const options = {
		force: false,
		outDir: undefined,
		skipBunInstall: false,
		skipCheck: false,
		skipInstall: false,
		skipTest: false,
	};
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help") {
			printUsage();
			process.exit(0);
		}
		if (arg === "--force") options.force = true;
		else if (arg === "--skip-check") options.skipCheck = true;
		else if (arg === "--skip-test") options.skipTest = true;
		else if (arg === "--skip-install") options.skipInstall = true;
		else if (arg === "--skip-bun-install") options.skipBunInstall = true;
		else if (arg === "--out") {
			const outDir = args[i + 1];
			if (!outDir || outDir.startsWith("--")) throw new Error("--out requires a directory");
			options.outDir = outDir;
			i++;
		}
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function currentBinaryPlatform() {
	if (process.platform === "win32") return process.arch === "arm64" ? "windows-arm64" : "windows-x64";
	if (process.platform === "darwin") return process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
	if (process.platform === "linux") return process.arch === "arm64" ? "linux-arm64" : "linux-x64";
	throw new Error(`Unsupported binary platform: ${process.platform} ${process.arch}`);
}

function buildBunBinaryRelease(targetDirectory, archiveDirectory) {
	const platform = currentBinaryPlatform();
	const binaryBuildDirectory = join(archiveDirectory, "binary-build");
	execFileSync("bash", ["./scripts/build-binaries.sh",
		"--skip-install",
		"--skip-build",
		"--platform",
		platform,
		"--out",
		binaryBuildDirectory,
	], { stdio: "inherit" });
	rmSync(targetDirectory, { force: true, recursive: true });
	cpSync(join(binaryBuildDirectory, platform), targetDirectory, { recursive: true });
	const archiveName = platform.startsWith("windows-") ? `pi-${platform}.zip` : `pi-${platform}.tar.gz`;
	cpSync(join(binaryBuildDirectory, archiveName), join(archiveDirectory, archiveName));
	return platform;
}

const options = parseArgs();
const repoRoot = process.cwd();
const rootPackageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
if (rootPackageJson.name !== "pi-monorepo") throw new Error("Run this script from the repository root");

execNpmSync(["run", "generate:models"], { cwd: repoRoot, stdio: "inherit" });
if (!options.skipCheck) execNpmSync(["run", "check"], { cwd: repoRoot, stdio: "inherit" });

const artifactSet = produceArtifactSet({
	build: true,
	force: options.force,
	offlineModelData: true,
	outDir: options.outDir,
	repoRoot,
});
const outDir = artifactSet.artifactDirectory;

if (!options.skipTest) execFileSync("bash", ["./test.sh"], { cwd: repoRoot, stdio: "inherit" });

let binaryPlatform;
if (!options.skipInstall) {
	const binaryDirectory = join(outDir, "bun");
	binaryPlatform = buildBunBinaryRelease(binaryDirectory, outDir);
	const validationRoot = mkdtempSync(join(tmpdir(), "pi-local-release-consumers-"));
	try {
		for (const pkg of artifactSet.packages) {
			const directory = join(validationRoot, "npm", packageConsumerDirectoryName(pkg.name));
			installConsumer({ artifactSet, directory, packageNames: [pkg.name] });
			smokeTestNpmConsumer({ artifactSet, directory, packageName: pkg.name });
			if (pkg.name === codingAgentName) smokeTestCodingAgent(directory);
		}

		if (!options.skipBunInstall) {
			const bunDirectory = join(validationRoot, "bun", packageConsumerDirectoryName(codingAgentName));
			installConsumer({ artifactSet, directory: bunDirectory, packageManager: "bun", packageNames: [codingAgentName] });
			smokeTestCodingAgent(bunDirectory, "bun");
		}
	} finally {
		rmSync(validationRoot, { force: true, recursive: true });
	}
}

console.log(`\nLocal release artifacts created: ${outDir}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nTarballs:");
for (const pkg of artifactSet.packages) console.log(`  ${pkg.tarballPath}`);

if (!options.skipInstall) {
	const binaryDirectory = join(outDir, "bun");
	console.log("\nLocal Bun binary release:");
	console.log(`  ${binaryDirectory}`);
	console.log(`  ${join(outDir, `pi-${binaryPlatform}.${String(binaryPlatform).startsWith("windows-") ? "zip" : "tar.gz"}`)}`);
	console.log("\nRun the local Bun binary release from outside the repository:");
	console.log(`  ${join(binaryDirectory, String(binaryPlatform).startsWith("windows-") ? "pi.exe" : "pi")} --help`);
}
