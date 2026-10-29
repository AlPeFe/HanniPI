/**
 * Espaciado del rail derecho (SPEC-008), independiente de `display.density`.
 *
 * La densidad sigue gobernando el resto de la TUI; el rail tiene su propio eje porque los dos
 * extremos que ya existían no servían: `tight` (el compacto de siempre) dejaba las secciones
 * pegadas y `roomy` (el normal de siempre) gastaba cajas y altura. `cozy`, el defecto, recupera
 * el aire entre secciones sin volver a las cajas: regla de una línea atenuada y 32 columnas.
 *
 * | nivel | entre secciones | separador | ancho |
 * |-------|-----------------|-----------|-------|
 * | tight | 0 líneas        | regla     | 28    |
 * | cozy  | 1 línea         | regla ↵   | 32    |
 * | roomy | 1 línea         | caja      | 34    |
 *
 * Vive como singleton de módulo, igual que `theme` y `display-density`: `RailContent` lo lee en
 * cada `render()` e `interactive-mode` lo sincroniza con `display.railSpacing` de settings.
 */

export type RailSpacing = "tight" | "cozy" | "roomy";

/** El defecto de SPEC-008: la mezcla entre el compacto y el normal. */
export const DEFAULT_RAIL_SPACING: RailSpacing = "cozy";

/** Ancho de columna del rail para cada nivel (SPEC-008). */
export const TIGHT_RAIL_WIDTH = 28;
export const COZY_RAIL_WIDTH = 32;
export const ROOMY_RAIL_WIDTH = 34;

let spacing: RailSpacing = DEFAULT_RAIL_SPACING;

/** Normaliza cualquier valor de settings/JSON a un nivel válido (desconocido ⇒ defecto). */
export function normalizeRailSpacing(value: unknown): RailSpacing {
	return value === "tight" || value === "roomy" || value === "cozy" ? value : DEFAULT_RAIL_SPACING;
}

export function setRailSpacing(next: RailSpacing | undefined): void {
	spacing = normalizeRailSpacing(next);
}

export function getRailSpacing(): RailSpacing {
	return spacing;
}

/** Ancho de columna del rail para un nivel (`railSpacingWidth()` usa el nivel activo). */
export function railSpacingWidth(level: RailSpacing = spacing): number {
	if (level === "tight") return TIGHT_RAIL_WIDTH;
	if (level === "roomy") return ROOMY_RAIL_WIDTH;
	return COZY_RAIL_WIDTH;
}

/** Líneas en blanco entre secciones del rail: sólo `tight` las pega. */
export function railSectionGap(level: RailSpacing = spacing): number {
	return level === "tight" ? 0 : 1;
}

/** `tight` y `cozy` dibujan una regla de una línea; `roomy` conserva la caja completa. */
export function railUsesRule(level: RailSpacing = spacing): boolean {
	return level !== "roomy";
}

/**
 * `cozy` es la regla atenuada: el separador va con el token `dim` para que se lea como aire y no
 * como un borde más; `tight` mantiene el `borderMuted` del compacto clásico.
 */
export function railIsAttenuated(level: RailSpacing = spacing): boolean {
	return level === "cozy";
}
