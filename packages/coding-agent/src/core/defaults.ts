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
 *
 * Vacío a propósito: subagentes, web y MCP ya no son tools fijos del prompt.
 * La orquestación de subagentes es externa (orquestador) y los tools pesados
 * (web_search, mcp, ...) inflaban ~12k prompt tokens por turno sin ser usados.
 * Si en el futuro se necesita alguno, reintroducirlo aquí o vía `packages`
 * bajo demanda en settings.json.
 */
export const DEFAULT_PACKAGES: readonly PackageSource[] = [];
