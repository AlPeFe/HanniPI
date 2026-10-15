import { describe, expect, it } from "vitest";
import { emptyMemTurnSummary, formatMemoryLine } from "../src/extensions/hanniorq/index.ts";

describe("línea de memoria de fin de turno", () => {
	it("no pinta nada si la memoria no se tocó", () => {
		expect(formatMemoryLine(emptyMemTurnSummary())).toBeUndefined();
	});

	it("resume altas, updates, borrados y lecturas en una línea", () => {
		expect(formatMemoryLine({ created: 2, updated: 1, deleted: 1, summaries: 1, reads: 3 })).toBe(
			"hannigram → memory: +2 nuevo · ~1 update · +1 resumen · -1 borrado · ≫3 leído",
		);
	});

	it("solo muestra lo que pasó de verdad", () => {
		expect(formatMemoryLine({ ...emptyMemTurnSummary(), reads: 4 })).toBe("hannigram → memory: ≫4 leído");
		expect(formatMemoryLine({ ...emptyMemTurnSummary(), created: 1 })).toBe("hannigram → memory: +1 nuevo");
		expect(formatMemoryLine({ ...emptyMemTurnSummary(), deleted: 2 })).toBe("hannigram → memory: -2 borrado");
	});
});
