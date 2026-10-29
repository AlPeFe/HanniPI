import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	DEFAULT_RAIL_SPACING,
	getRailSpacing,
	railSectionGap,
	railSpacingWidth,
	railUsesRule,
	setRailSpacing,
} from "../src/core/rail-spacing.ts";
import {
	DEFAULT_COMPACT_RAIL_WIDTH,
	DEFAULT_COZY_RAIL_WIDTH,
	DEFAULT_RAIL_WIDTH,
	SettingsManager,
} from "../src/core/settings-manager.ts";
import { RailContent } from "../src/extensions/hanniorq/index.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/**
 * SPEC-008 A: el rail tiene su propio espaciado (`display.railSpacing`), independiente de
 * `display.density`. `tight` y `roomy` son el compacto y el normal de antes byte a byte (fixtures
 * generados con el código de HEAD); `cozy` es la mezcla: una línea en blanco entre secciones,
 * ninguna dentro de cada sección, regla de una línea atenuada y 32 columnas.
 */
const RAIL_SECTIONS = [
	{ title: "proyecto", lines: ["HanniPI", "rama main"] },
	{ title: "tareas (1/3)", lines: ["▸ preparar la charla", "· revisar el rail", "etc"] },
	{ title: "memoria", lines: ["✓ ON · 2.1k", "≫ ultima sesion"] },
	{ title: "contexto", lines: ["12% de 200k · compacta en 160k"] },
	{ title: "cambios (2)", lines: ["· src/a.ts", "· src/b.ts"] },
];

interface RailGolden {
	width: number;
	lines: string[];
}

function fixture(name: string): RailGolden {
	return JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8")) as RailGolden;
}

function renderRail(width: number): string[] {
	return new RailContent(
		() => RAIL_SECTIONS,
		() => theme,
	).render(width);
}

function visibleLength(line: string): number {
	return visibleWidth(line);
}

/** Secciones separadas por al menos una línea en blanco: 5 secciones ⇒ 4 huecos. */
function blankGaps(lines: string[]): number[] {
	const gaps: number[] = [];
	let run = 0;
	for (const line of lines) {
		if (stripAnsi(line).trim() === "") {
			run += 1;
			continue;
		}
		if (run > 0) gaps.push(run);
		run = 0;
	}
	return gaps;
}

describe("display.railSpacing (SPEC-008 A)", () => {
	let tempDir: string;

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterAll(() => {
		setRailSpacing(DEFAULT_RAIL_SPACING);
	});

	test("tight es el compacto de antes, byte a byte", () => {
		const golden = fixture("spec008-rail-tight-render.json");
		setRailSpacing("tight");

		const lines = renderRail(golden.width);
		expect(lines).toEqual(golden.lines);
		// El compacto clásico: sin aire entre secciones y todo dentro del ancho del rail.
		expect(blankGaps(lines)).toEqual([]);
		for (const line of lines) expect(visibleLength(line)).toBeLessThanOrEqual(golden.width);
	});

	test("roomy es el normal de antes, byte a byte", () => {
		const golden = fixture("spec008-rail-roomy-render.json");
		setRailSpacing("roomy");

		const lines = renderRail(golden.width);
		expect(lines).toEqual(golden.lines);
		// El layout clásico: una línea en blanco entre cada par de secciones.
		expect(blankGaps(lines)).toEqual([1, 1, 1, 1]);
	});

	test("cozy deja exactamente 4 líneas en blanco con 5 secciones, 0 dentro de cada sección y 32 columnas", () => {
		setRailSpacing("cozy");
		const lines = renderRail(railSpacingWidth("cozy"));

		expect(RAIL_SECTIONS).toHaveLength(5);
		const gaps = blankGaps(lines);
		expect(gaps).toEqual([1, 1, 1, 1]);
		expect(gaps.reduce((total, gap) => total + gap, 0)).toBe(4);

		// Ancho exacto: la regla y las líneas de contenido se rellenan a las 32 columnas.
		for (const line of lines) {
			expect(line === "" || visibleLength(line) === DEFAULT_COZY_RAIL_WIDTH).toBe(true);
		}

		// Los items de cada sección siguen pegados: cada sección ocupa una regla + sus líneas.
		const plain = lines.map((line) => stripAnsi(line));
		let index = 0;
		for (const section of RAIL_SECTIONS) {
			expect(plain[index]).toContain(section.title);
			for (const [offset, text] of section.lines.entries()) {
				expect(plain[index + 1 + offset]).toContain(text);
			}
			index += 1 + section.lines.length;
			if (index < plain.length) {
				expect(plain[index]).toBe("");
				index += 1;
			}
		}

		// Regla de una línea atenuada (SGR dim), no cajas ni reglas con el borde clásico.
		const rules = lines.filter((line) => stripAnsi(line).startsWith("─"));
		expect(rules).toHaveLength(5);
		for (const rule of rules) expect(rule).toContain("\x1b[2m");
		expect(plain.some((line) => line.startsWith("╭") || line.startsWith("│"))).toBe(false);
	});

	test("cozy no pierde ni trunca datos frente a roomy", () => {
		const cozy = renderRail(railSpacingWidth("cozy")).map((line) => stripAnsi(line).trimEnd());
		setRailSpacing("roomy");
		const roomy = renderRail(DEFAULT_RAIL_WIDTH).map((line) => stripAnsi(line).trimEnd());

		for (const section of RAIL_SECTIONS) {
			expect(cozy.some((line) => line.includes(section.title))).toBe(true);
			expect(roomy.some((line) => line.includes(section.title))).toBe(true);
			for (const text of section.lines) {
				expect(cozy.some((line) => line.includes(text.trim()))).toBe(true);
			}
		}
	});

	test("el nivel se normaliza y el ancho por defecto sigue al espaciado", () => {
		expect(DEFAULT_RAIL_SPACING).toBe("cozy");
		expect(railSpacingWidth("tight")).toBe(DEFAULT_COMPACT_RAIL_WIDTH);
		expect(railSpacingWidth("cozy")).toBe(DEFAULT_COZY_RAIL_WIDTH);
		expect(railSpacingWidth("roomy")).toBe(DEFAULT_RAIL_WIDTH);
		expect(railSectionGap("tight")).toBe(0);
		expect(railSectionGap("cozy")).toBe(1);
		expect(railSectionGap("roomy")).toBe(1);
		expect(railUsesRule("tight")).toBe(true);
		expect(railUsesRule("cozy")).toBe(true);
		expect(railUsesRule("roomy")).toBe(false);

		setRailSpacing("roomy");
		expect(getRailSpacing()).toBe("roomy");
		// Un valor desconocido en settings.json cae al defecto.
		setRailSpacing("enorme" as never);
		expect(getRailSpacing()).toBe(DEFAULT_RAIL_SPACING);
	});

	test("el ajuste persiste y no lo mueve la densidad visual", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-rail-spacing-"));
		const manager = SettingsManager.create(tempDir, join(tempDir, "agent"));

		expect(manager.getRailSpacing()).toBe("cozy");
		expect(manager.getRailWidth()).toBe(DEFAULT_COZY_RAIL_WIDTH);

		manager.setDensity("normal");
		expect(manager.getRailWidth()).toBe(DEFAULT_COZY_RAIL_WIDTH);

		manager.setRailSpacing("tight");
		await manager.flush();
		expect(JSON.parse(readFileSync(join(tempDir, "agent", "settings.json"), "utf-8")).display.railSpacing).toBe(
			"tight",
		);
		expect(SettingsManager.create(tempDir, join(tempDir, "agent")).getRailSpacing()).toBe("tight");

		writeFileSync(join(tempDir, "agent", "settings.json"), JSON.stringify({ display: { railSpacing: "anchote" } }));
		expect(SettingsManager.create(tempDir, join(tempDir, "agent")).getRailSpacing()).toBe("cozy");

		rmSync(tempDir, { recursive: true, force: true });
	});
});
