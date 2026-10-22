import { describe, expect, it } from "vitest";
import { type DumpObservation, renderMemoryDump } from "../src/extensions/hanniorq/index.ts";

function obs(partial: Partial<DumpObservation> & { id: number; title: string }): DumpObservation {
	return { content: `contenido de ${partial.title}`, updatedAtUtc: "2026-10-20T10:00:00Z", ...partial };
}

const options = { project: "AlPeFe/HanniPI", dir: "docs/memoria", generatedAt: new Date("2026-10-21T09:00:00Z") };

function file(files: Array<{ name: string; content: string }>, name: string): string {
	return files.find((f) => f.name === name)?.content ?? "";
}

describe("dump de memoria (/dumpgram)", () => {
	const observations = [
		obs({ id: 1, title: "ADR caché", type: "adr", topicKey: "hannipi/memoria/cache-prefijo" }),
		obs({ id: 2, title: "Release 0.2.19", type: "release", updatedAtUtc: "2026-10-19T10:00:00Z" }),
		obs({
			id: 3,
			title: "Handoff actual",
			type: "handoff",
			topicKey: "handoff/actual",
			updatedAtUtc: "2026-10-18T10:00:00Z",
		}),
		obs({ id: 4, title: "Patrón sqlite", type: "pattern", updatedAtUtc: "2026-10-17T10:00:00Z" }),
		obs({ id: 5, title: "Tipo inventado", type: "inventado", updatedAtUtc: "2026-10-16T10:00:00Z" }),
		obs({ id: 6, title: "Descartada", type: "adr", state: "archived", updatedAtUtc: "2026-10-21T10:00:00Z" }),
	];

	it("reparte las observaciones por concepto y deja los tipos desconocidos en contexto", () => {
		const files = renderMemoryDump(observations, options);
		expect(files.map((f) => f.name)).toEqual([
			"README.md",
			"decisiones.md",
			"hecho.md",
			"sesiones.md",
			"contexto.md",
		]);
		expect(file(files, "decisiones.md")).toContain("### ADR caché");
		expect(file(files, "hecho.md")).toContain("### Release 0.2.19");
		expect(file(files, "sesiones.md")).toContain("### Handoff actual");
		expect(file(files, "contexto.md")).toContain("### Patrón sqlite");
		expect(file(files, "contexto.md")).toContain("### Tipo inventado");
	});

	it("no vuelca lo archivado y deja constancia del tipo vacío", () => {
		const files = renderMemoryDump([obs({ id: 7, title: "Solo", state: "archived" })], options);
		expect(file(files, "contexto.md")).toContain("_No hay observaciones de este tipo._");
		expect(file(files, "contexto.md")).not.toContain("Solo");
		expect(file(files, "README.md")).toContain("0 observaciones");
	});

	it("el índice abre con el handoff más reciente y enlaza los ficheros", () => {
		const readme = file(renderMemoryDump(observations, options), "README.md");
		expect(readme).toContain("## Estado en curso");
		expect(readme).toContain("### Handoff actual");
		expect(readme).toContain("[`docs/memoria/decisiones.md`](decisiones.md)");
		expect(readme).toContain("| `hannipi/memoria/cache-prefijo` | ADR caché | 1 → decisiones.md |");
		// la archivada no aparece en el índice de temas
		expect(readme).not.toContain("Descartada");
	});

	it("escribe el porqué y lo aprendido de cada observación", () => {
		const [fileEntry] = renderMemoryDump(
			[obs({ id: 8, title: "Bugfix X", type: "bugfix", learned: "mide antes de recortar", where: "src/x.ts" })],
			options,
		).filter((f) => f.name === "hecho.md");
		expect(fileEntry?.content).toContain("**Aprendido:** mide antes de recortar");
		expect(fileEntry?.content).toContain("**Dónde:** src/x.ts");
	});
});
