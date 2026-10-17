import { describe, expect, it } from "vitest";
import { summarizeThinking } from "../src/modes/interactive/components/thinking-summary.ts";

describe("summarizeThinking", () => {
	it("quita los bloques de codigo y deja un aviso con su tamaño", () => {
		const text = "Primero miro el archivo.\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nLuego decido.";
		const summary = summarizeThinking(text);
		expect(summary).toContain("Primero miro el archivo.");
		expect(summary).toContain("código oculto: 2 líneas");
		expect(summary).not.toContain("const a = 1");
		expect(summary).toContain("Luego decido.");
	});

	it("cierra un bloque sin cerrar (streaming cortado)", () => {
		expect(summarizeThinking("pienso\n```\nx=1")).toContain("código oculto: 1 línea");
	});

	it("colapsa las lineas vacias repetidas", () => {
		expect(summarizeThinking("uno\n\n\n\ndos")).toBe("uno\n\ndos");
	});

	it("recorta a las primeras lineas y lo dice", () => {
		const text = Array.from({ length: 20 }, (_, index) => `linea ${index}`).join("\n");
		const summary = summarizeThinking(text);
		expect(summary).toContain("linea 0");
		expect(summary).toContain("linea 7");
		expect(summary).not.toContain("linea 8");
		expect(summary).toContain("… (+12 líneas)");
	});

	it("recorta una sola linea muy larga sin dejarla vacia", () => {
		const summary = summarizeThinking("x".repeat(5000));
		expect(summary.length).toBeLessThanOrEqual(701);
		expect(summary.endsWith("…")).toBe(true);
	});
});
