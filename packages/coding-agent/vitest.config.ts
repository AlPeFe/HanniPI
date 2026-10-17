import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: {
				PI_OFFLINE: "1",
				// Aisla la memoria del usuario: sin esto, los tests hablaban con el daemon HanniGram real de
				// 127.0.0.1:8765 y le dejaban proyectos temporales, observaciones y ADRs de prueba en la BD
				// (visto: 33 proyectos basura en el host de desarrollo). Puerto muerto a proposito; un test e2e
				// de verdad lo abre pasando HANNIGRAM_E2E=1 y HANNIGRAM_URL=http://127.0.0.1:8765.
				HANNIGRAM_URL: process.env.HANNIGRAM_URL ?? "http://127.0.0.1:9",
				HANNIGRAM_URLS: process.env.HANNIGRAM_URLS ?? "http://127.0.0.1:9",
			},
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
