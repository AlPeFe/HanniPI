import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type DumpObservation,
	EXTRACT_DOCS,
	existingDocs,
	parseMemoryBoards,
	projectFacts,
	versionedDocs,
} from "../src/extensions/hanniorq/index.ts";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "hanniorq-extract-"));
}

function touch(dir: string, name: string): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, name), "x");
}

function obs(topicKey: string, content: string): Pick<DumpObservation, "topicKey" | "content"> {
	return { topicKey, content };
}

const SHEET = ["## Pasos", "- [x] S1 explorar — a1b2c3d", "- [ ] S2 escribir (verify: true)"].join("\n");

describe("/extract: no pisar documentos existentes", () => {
	it("sin nada en el directorio, los nombres son los canónicos", () => {
		const dir = tempDir();
		expect(existingDocs(dir)).toEqual([]);
		expect(versionedDocs(dir)).toEqual(EXTRACT_DOCS.map((doc) => doc.replace(".md", "-v2.md")));
	});

	it("detecta los documentos que ya existen", () => {
		const dir = tempDir();
		touch(dir, "architecture.md");
		touch(dir, "stack.md");
		expect(existingDocs(dir)).toEqual(["architecture.md", "stack.md"]);
	});

	it("sube la versión hasta el primer N libre", () => {
		const dir = tempDir();
		touch(dir, "architecture-v2.md");
		touch(dir, "design-v2.md");
		const names = versionedDocs(dir);
		expect(names).toContain("architecture-v3.md");
		expect(names).toContain("README-v3.md");
	});
});

describe("origen de las tareas del rail", () => {
	it("lee los pasos de la ficha espejada bajo odd/<slug>/tasks", () => {
		const boards = parseMemoryBoards([obs("odd/rail-origen/tasks", SHEET)]);
		expect(boards.get("rail-origen")).toEqual([
			{ done: true, text: "S1 explorar — a1b2c3d" },
			{ done: false, text: "S2 escribir (verify: true)" },
		]);
	});

	it("ignora topics que no son fichas y contenidos sin pasos", () => {
		const boards = parseMemoryBoards([
			obs("hannipi/memoria/cache-prefijo", "- [ ] no es una ficha"),
			obs("odd/sin-pasos/tasks", "texto sin checkboxes"),
			obs("handoff/actual", SHEET),
		]);
		expect([...boards.keys()]).toEqual([]);
	});

	it("sin sección ## Pasos acepta los checkboxes sueltos", () => {
		const boards = parseMemoryBoards([obs("odd/suelta/tasks", "- [ ] uno\n- [x] dos")]);
		expect(boards.get("suelta")).toHaveLength(2);
	});
});

describe("hechos del proyecto para /extract", () => {
	it("lee manifiestos, scripts y dependencias del disk sin reexplorar", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, "package.json"),
			JSON.stringify({ name: "demo", scripts: { check: "tsc" }, dependencies: { zod: "^1.0.0" } }),
		);
		writeFileSync(join(dir, "tsconfig.json"), "{}");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");

		const facts = projectFacts(dir);
		expect(facts).toContain("manifiestos: package.json, tsconfig.json");
		expect(facts).toContain("package: demo");
		expect(facts).toContain("scripts: check");
		expect(facts).toContain("zod@^1.0.0");
		expect(facts).toContain(".ts:1");
	});

	it("no revienta si el directorio no existe", () => {
		expect(projectFacts(join(tempDir(), "no-existe"))).toContain("no se pudo leer");
	});
});
