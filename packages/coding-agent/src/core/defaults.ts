import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PackageSource } from "./settings-manager.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Paquetes que vienen activos por defecto en HanniPI. No se persisten en
 * settings.json: se fusionan en tiempo de lectura (getEffectivePackages) para
 * que una versión nueva del harness pueda actualizarlos sin tocar el archivo.
 * Un paquete por defecto se puede desactivar añadiéndolo a `disabledDefaultPackages`.
 */
export const DEFAULT_PACKAGES: readonly PackageSource[] = [
	"npm:pi-mcp-adapter",
	"npm:pi-subagents",
	"npm:pi-web-access",
];
