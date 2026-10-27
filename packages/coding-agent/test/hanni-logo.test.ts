import { describe, expect, it } from "vitest";
import { hanniLogoLines, hanniWordmark } from "../src/modes/interactive/components/hanni-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

/** El logo lleva colores ANSI; para medir el dibujo se quitan. */
function strip(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("logo de Hanni", () => {
	it("es un bloque cuadrado: todas las filas miden lo mismo", () => {
		initTheme("dark");
		const lines = hanniLogoLines().map(strip);
		expect(lines).toHaveLength(11);
		const widths = new Set(lines.map((line) => [...line].length));
		expect([...widths]).toEqual([16]);
	});

	it("lleva el conejito (ojos y boca) y el nombre", () => {
		initTheme("dark");
		const text = hanniLogoLines().map(strip).join("\n");
		expect(text).toContain("◕");
		expect(text).toContain("♥");
		expect(text).toContain("h a n n i");
		expect(text).toContain("♥");
	});

	it("el fallback de una línea mantiene la marca", () => {
		initTheme("dark");
		const wordmark = strip(hanniWordmark());
		expect(wordmark).toBe("hanni♥");
	});
});
