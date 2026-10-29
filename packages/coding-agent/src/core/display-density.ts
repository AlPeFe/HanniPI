/**
 * Densidad visual de la TUI (SPEC-007).
 *
 * El tamaño de fuente lo pone la terminal, así que «más pequeña» significa aquí menos huella
 * vertical y jerarquía más fina: cabeceras de una línea, reglas en vez de cajas completas, sin
 * líneas en blanco de relleno y metadatos secundarios en la misma línea del título.
 *
 * Vive como singleton de módulo, igual que `theme`: los componentes lo leen en cada `render()` y
 * `interactive-mode` lo sincroniza con `display.density` de settings. `normal` reproduce el layout
 * clásico byte a byte.
 */

export type DisplayDensity = "compact" | "normal";

const DEFAULT_DENSITY: DisplayDensity = "compact";

let density: DisplayDensity = DEFAULT_DENSITY;

export function setDisplayDensity(next: DisplayDensity): void {
	density = next === "normal" ? "normal" : DEFAULT_DENSITY;
}

export function getDisplayDensity(): DisplayDensity {
	return density;
}

/** True en el layout compacto (por defecto). */
export function isCompactDensity(): boolean {
	return density === DEFAULT_DENSITY;
}

/** Líneas en blanco entre bloques: ninguna en compacto. */
export function blockGap(): number {
	return isCompactDensity() ? 0 : 1;
}
