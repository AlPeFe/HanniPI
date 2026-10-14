/**
 * hanniorq: orquestador sODD para HanniPI.
 *
 * Capa de coordinación sobre `/task` (sODD). NO duplica el almacenamiento:
 * usa la misma ficha `odd/tasks/<slug>.md` y `odd/.active`.
 *
 * Filosofía sODD (Small ODD) — la diferencia con ODD adulto:
 *  - No todo es investigación. Un cambio pequeño y entendido se hace inline,
 *    sin ficha, sin subagentes y sin resumen.
 *  - No todo requiere tests. Solo se testea/verifica lo que tiene un check
 *    aplicable y un resultado esperado; si no, se hace verificación funcional
 *    proporcionada o se declara "sin check".
 *  - No todo requiere resumen. El resumen (con la sección de memoria HanniGram)
 *    solo se genera en `/hanniorq close` y solo si hubo ficha.
 *  - Orgánico pero pequeño: la ficha es la fuente de verdad; HanniGram es un
 *    índice/espejo, no un duplicado.
 *  - Delegación CONDICIONAL: si la ficha activa es grande (2+ pasos, varios archivos/paquetes) y spliteable (partes independientes), delega cada parte con la tool subagent pasándole la ficha como contexto; si es un solo bloque, hazlo inline.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionFactory, ExtensionUIContext, ToolDefinition } from "../../core/extensions/types.ts";
import { ThemedText } from "../../modes/interactive/components/themed-text.ts";
import { getMcpConnectionStatuses, subscribeMcpConnectionStatuses } from "../mcp/status.ts";
import { ensureHanniGramDaemon } from "./hannigram-daemon.ts";

function getOddDir(cwd: string): string {
	return join(cwd, "odd");
}

function getActiveSlug(cwd: string): string | undefined {
	const activePath = join(getOddDir(cwd), ".active");
	if (!existsSync(activePath)) return undefined;
	return readFileSync(activePath, "utf-8").trim() || undefined;
}

function getActiveTaskPath(cwd: string): string | undefined {
	const slug = getActiveSlug(cwd);
	if (!slug) return undefined;
	return join(getOddDir(cwd), "tasks", `${slug}.md`);
}

/** Registro de memoria de la sesión: qué se leyó/guardó en HanniGram. */
interface MemRecord {
	kind: "read" | "saved" | "mirror" | "session";
	detail: string;
}

/** Estado del orquestador en la sesión actual. */
interface OrqState {
	on: boolean;
	memLog: MemRecord[];
}

const state: OrqState = { on: false, memLog: [] };

/** Subagentes en vuelo (flota). key = toolCallId de la tool subagent. */
interface FleetAgent {
	id: string;
	task: string;
	status: "running" | "done" | "error";
	startedAt: number;
}
const fleet = new Map<string, FleetAgent>();
let fleetWidgetTimer: ReturnType<typeof setInterval> | undefined;

// Actividad de memoria de la sesión (lecturas/escrituras). Permite ver qué se
// consultó o guardó y, si un trabajo queda a medias, recuperar el contexto.
interface MemActivity {
	kind: "read" | "write";
	detail: string;
	/** Para escrituras: si añadió (`add`) o borró (`del`) un registro. */
	op?: "add" | "del";
}
const memActivity: MemActivity[] = [];
/** Lista de tareas del turno actual, definida por el harness vía la tool `todo`.
 *  Cada llamada reemplaza la lista entera (una lista nueva limpia la anterior). */
interface HarnessTodo {
	text: string;
	status: "pending" | "in_progress" | "completed";
}
let harnessTodos: HarnessTodo[] = [];
/** Hay un turno en curso: sODD esta "working" mientras el agente trabaja. */
let soddWorking = false;
let railHidden = false;
/** Pasos sODD del rail plegados (toggle: tecla RAIL_TASKS_KEY o /hanniorq tasks). */
let railTasksHidden = false;
/** Máximo de pasos listados en el rail; el resto se resume con "+N". */
const MAX_RAIL_TODOS = 8;
/** Tecla que pliega/despliega los pasos sODD del rail. */
const RAIL_TASKS_KEY = Key.ctrlAlt("t");

/** Tools mem_* que son LECTURA de memoria (no modifican la BD). */
const MEM_READ_TOOLS = new Set([
	"mem_search",
	"mem_context",
	"mem_timeline",
	"mem_get_observation",
	"mem_current_project",
	"mem_suggest_topic_key",
]);

/** Tools mem_* que ESCRIBEN en memoria. */
const MEM_WRITE_TOOLS = new Set(["mem_save", "mem_delete", "mem_session_summary"]);

/** Detalle legible de una llamada mem_* para el log de actividad del rail. */
function memDetail(toolName: string, args: Record<string, unknown> | undefined): string {
	const a = args ?? {};
	switch (toolName) {
		case "mem_save":
			return typeof a.title === "string" && a.title ? a.title : "observación";
		case "mem_search":
			return typeof a.query === "string" && a.query ? a.query : "búsqueda";
		case "mem_timeline":
			return typeof a.topicKey === "string" && a.topicKey ? a.topicKey : "timeline";
		case "mem_get_observation":
			return a.id !== undefined ? `#${a.id}` : "observación";
		case "mem_delete":
			return a.id !== undefined ? `#${a.id}` : "borrado";
		case "mem_context":
			return "contexto reciente";
		case "mem_current_project":
			return "proyecto actual";
		case "mem_suggest_topic_key":
			return "topic keys";
		case "mem_session_summary":
			return "resumen de sesión";
		default:
			return toolName;
	}
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
}

export function parseGitStatusPaths(output: string): string[] {
	const entries = output.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index] ?? "";
		if (entry.length < 4) continue;
		paths.push(entry.slice(3));
		if (entry.startsWith("R") || entry.startsWith("C") || entry[1] === "R" || entry[1] === "C") index++;
	}
	return paths;
}

function currentBranch(cwd: string): string {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
}

function visibleWorktreeFiles(cwd: string, files: readonly string[]): string[] {
	return files.filter((file) => {
		const relative = file.replace(/\\/g, "/");
		const atl = relative === ".atl" || relative.startsWith(".atl/");
		if (!atl) return true;
		return !existsSync(join(cwd, relative));
	});
}

function lastCommit(cwd: string): string {
	return git(cwd, ["log", "-1", "--format=%h %s"]).out || "ninguno";
}

// ---------------------------------------------------------------------------
// HanniGram helpers (daemon HTTP 127.0.0.1:8765, BD ~/.hannigram/hannigram.db)
// ---------------------------------------------------------------------------

const HANNIGRAM_BASE = process.env.HANNIGRAM_URL ?? "http://127.0.0.1:8765";

function slugify(s: string): string {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "adr"
	);
}

async function hannigram<T>(path: string, init?: RequestInit): Promise<T | undefined> {
	try {
		const res = await fetch(`${HANNIGRAM_BASE}${path}`, {
			...init,
			headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		});
		if (!res.ok) return undefined;
		return (await res.json()) as T;
	} catch {
		return undefined;
	}
}

/** Lee las observaciones recientes del proyecto (para el resumen). */
async function recentObservations(
	cwd: string,
): Promise<Array<{ id: number; title: string; topicKey?: string; type?: string }>> {
	return (
		(await hannigram<Array<{ id: number; title: string; topicKey?: string; type?: string }>>(
			`/api/observations?${new URLSearchParams({ cwd, limit: "10" })}`,
		)) ?? []
	);
}

/** Guarda el espejo de la ficha en HanniGram bajo topic odd/<slug>/tasks. */
async function mirrorTask(cwd: string, slug: string, content: string): Promise<number | undefined> {
	const obs = await hannigram<{ id: number }>(`/api/observations?${new URLSearchParams({ cwd })}`, {
		method: "POST",
		body: JSON.stringify({
			title: `odd/${slug}/tasks`,
			content,
			topicKey: `odd/${slug}/tasks`,
			type: "odd",
		}),
	});
	return obs?.id;
}

/** Guarda el resumen de sesión: crea la sesión (start) y la cierra (end) con el
 *  mismo id, para no dejar sesiones huérfanas ("ended" sin "started"). */
async function saveSessionSummary(cwd: string, summary: string): Promise<boolean> {
	const sessionId = `hanniorq-${Date.now().toString(36)}`;
	const started = await hannigram<Record<string, unknown>>(`/api/sessions/start?${new URLSearchParams({ cwd })}`, {
		method: "POST",
		body: JSON.stringify({ sessionId }),
	});
	if (started === undefined) return false;
	const ended = await hannigram<{ ok?: boolean }>(`/api/sessions/end?${new URLSearchParams({ cwd })}`, {
		method: "POST",
		body: JSON.stringify({ sessionId, summary }),
	});
	return ended !== undefined;
}

// ---------------------------------------------------------------------------
// Plantilla del resumen (solo se usa en /hanniorq close y solo si hubo ficha)
// ---------------------------------------------------------------------------

function buildSummary(opts: {
	cwd: string;
	slug: string;
	branch: string;
	commit: string;
	observations: Array<{ id: number; title: string; topicKey?: string; type?: string }>;
	mirrorId?: number;
	sessionSaved: boolean;
}): string {
	const lines: string[] = [];
	lines.push(`Trabajo completado: ${opts.slug}.`);
	lines.push("Incluye:");
	lines.push(`- Tareas documentadas en odd/tasks/${opts.slug}.md.`);
	lines.push(`- Rama: ${opts.branch}.`);
	lines.push(`- Commits: ${opts.commit}.`);
	lines.push("");
	lines.push("Verificado:");
	lines.push("- (solo checks ejecutados en esta sesión; si no hay, 'ninguno')");
	lines.push("");
	lines.push("Memoria (HanniGram):");
	if (opts.observations.length === 0) {
		lines.push("- Leído: ninguno.");
	} else {
		lines.push(
			`- Leído: ${opts.observations.length} observaciones recientes [#${opts.observations.map((o) => o.id).join(", #")}].`,
		);
	}
	lines.push(
		`- Espejo de la ficha: topic odd/${opts.slug}/tasks → ${opts.mirrorId ? `#${opts.mirrorId}` : "PENDIENTE (daemon no disponible)"}.`,
	);
	lines.push(`- Resumen de sesión: ${opts.sessionSaved ? "guardado" : "PENDIENTE (daemon no disponible)"}.`);
	lines.push("");
	lines.push("Riesgo: none.");
	lines.push("Pendiente / siguiente paso: ninguno.");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Widget de flota: representa los subagentes en paralelo (adaptación del
// fleet widget de pi-subagents a sODD — la ficha es la fuente de verdad y
// cada worker muestra la tarea que le toca).
// ---------------------------------------------------------------------------

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function renderFleet(ui: ExtensionUIContext): void {
	const running = [...fleet.values()].filter((a) => a.status === "running");
	if (fleet.size === 0) {
		ui.setWidget("hanniorq-fleet", undefined);
		return;
	}
	const now = Date.now();
	const lines = [...fleet.values()].map((a) => {
		const icon =
			a.status === "running" ? `${SPIN[((now / 80) % SPIN.length) | 0]}` : a.status === "error" ? "✗" : "✓";
		const age = Math.round((now - a.startedAt) / 1000);
		const task = a.task.length > 80 ? `${a.task.slice(0, 79)}…` : a.task;
		return `${icon} ${a.id.slice(0, 8)} ${a.status === "running" ? `▶ ${task}` : `${task} (${age}s)`}`;
	});
	ui.setWidget("hanniorq-fleet", ["─ hanniorq flota de subagentes ─", ...lines]);
	if (running.length === 0) {
		if (fleetWidgetTimer !== undefined) {
			clearInterval(fleetWidgetTimer);
			fleetWidgetTimer = undefined;
		}
	}
}

function startFleetTimer(ui: ExtensionUIContext): void {
	if (fleetWidgetTimer !== undefined) clearInterval(fleetWidgetTimer);
	fleetWidgetTimer = setInterval(() => renderFleet(ui), 100);
}

// ---------------------------------------------------------------------------
// Indicador sODD: cuando hay ficha activa, se muestra que el procedimiento
// sODD está en uso (slug + progreso). Se oculta cuando no hay ficha.
// ---------------------------------------------------------------------------

/** Slug de una ficha con `status: active` (fallback si `odd/.active` esta vacio). */
function sheetWithStatusActive(cwd: string): string | undefined {
	const dir = join(getOddDir(cwd), "tasks");
	try {
		const entries = readdirSync(dir)
			.filter((name) => name.endsWith(".md"))
			.map((name) => {
				const path = join(dir, name);
				return { slug: name.slice(0, -3), mtime: statSync(path).mtimeMs, text: readFileSync(path, "utf-8") };
			})
			.sort((a, b) => b.mtime - a.mtime);
		for (const entry of entries) {
			if (entry.text.match(/^status: (.+)$/m)?.[1]?.trim() === "active") return entry.slug;
		}
	} catch {
		// sin odd/tasks o sin fichas
	}
	return undefined;
}

function soddIndicator(cwd: string): { slug: string; done: number; total: number; status: string } | undefined {
	const slug = getActiveSlug(cwd) ?? sheetWithStatusActive(cwd);
	if (!slug) return undefined;
	const p = join(getOddDir(cwd), "tasks", `${slug}.md`);
	try {
		const text = readFileSync(p, "utf-8");
		const status = text.match(/^status: (.+)$/m)?.[1] ?? "?";
		const steps = text.match(/^- \[ \]/gm) ?? [];
		const doneSteps = text.match(/^- \[x\]/gim) ?? [];
		return { slug, done: doneSteps.length, total: steps.length + doneSteps.length, status };
	} catch {
		return { slug, done: 0, total: 0, status: "?" };
	}
}

function updateSoddIndicator(ui: ExtensionUIContext, cwd: string): void {
	const ind = soddIndicator(cwd);
	if (!ind) {
		ui.setWidget("hanniorq-sodd", undefined);
		return;
	}
	ui.setWidget("hanniorq-sodd", [`sODD activo ▸ ${ind.slug} · ${ind.status} · pasos ${ind.done}/${ind.total}`]);
}

// ---------------------------------------------------------------------------
// Rail derecho: estado del proyecto en el que se trabaja (proyecto · memoria
// HanniGram · sODD · tareas como TODO). Se pinta en la columna derecha de la
// TUI (placement "rightRail") y se refresca en cada evento de sesión/turno.
// ---------------------------------------------------------------------------

const RAIL_WIDTH = 32;
const modifiedFilesCache = new Map<string, string[]>();
const modifiedFilesRefresh = new Map<string, Promise<void>>();

/** Cache del estado de la memoria HanniGram (daemon arriba/abajo). */
let memoryCache: { up: boolean; checked: boolean } = { up: false, checked: false };

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Nombre del proyecto: owner/repo del git remote, o nombre del directorio. */
function projectName(cwd: string): string {
	const r = git(cwd, ["config", "--get", "remote.origin.url"]);
	if (r.ok && r.out) {
		let url = r.out.trim().replace(/\/+$/, "");
		if (url.toLowerCase().endsWith(".git")) url = url.slice(0, -4);
		const parts = url.split(/[:/]/).filter(Boolean);
		if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
		return url;
	}
	return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/**
 * Pasos de la ficha sODD activa como lista de TODOs.
 * Se leen de la sección `## Pasos` (formato canónico); si la ficha usa otra
 * (p.ej. `## Tasks`, `## P0/P1`), se aceptan los checkboxes de todo el fichero.
 */
export function todoSteps(cwd: string): Array<{ done: boolean; text: string }> {
	const p = getActiveTaskPath(cwd);
	if (!p) return [];
	try {
		const lines = readFileSync(p, "utf-8").split("\n");
		const pasos = collectTodos(lines, true);
		return pasos.length > 0 ? pasos : collectTodos(lines, false);
	} catch {
		return [];
	}
}

/** Checkboxes `- [ ]` / `- [x]`; con `onlyPasos`, solo la sección `## Pasos`. */
function collectTodos(lines: string[], onlyPasos: boolean): Array<{ done: boolean; text: string }> {
	const out: Array<{ done: boolean; text: string }> = [];
	let inPasos = !onlyPasos;
	for (const line of lines) {
		if (onlyPasos) {
			if (line.startsWith("## Pasos")) {
				inPasos = true;
				continue;
			}
			if (line.startsWith("## ")) {
				inPasos = false;
				continue;
			}
		}
		if (!inPasos) continue;
		const m = line.match(/^-\s*\[( |x|X)\]\s*(.*)$/);
		if (m) out.push({ done: m[1] !== " ", text: (m[2] ?? "").trim() });
	}
	return out;
}

/** Consulta el daemon HanniGram (health) y refresca la cache. */
async function checkMemory(): Promise<void> {
	try {
		const health = await hannigram<{ status?: string }>("/health");
		memoryCache = { up: health?.status === "ok", checked: true };
	} catch {
		memoryCache = { up: false, checked: true };
	}
}

/** Estado de la memoria de la sesión: si se añadió algo, se borró, o quedó igual. */
function memoryDelta(): { label: string; color: "muted" | "success" | "error" | "warning" } {
	const added = memActivity.some((m) => m.op === "add");
	const deleted = memActivity.some((m) => m.op === "del");
	if (added && deleted) return { label: "nuevo + borrado", color: "warning" };
	if (added) return { label: "nuevo", color: "success" };
	if (deleted) return { label: "borrado", color: "error" };
	return { label: "igual", color: "muted" };
}

/** Tareas del rail: la lista del harness (`todo`) si existe; si no, los pasos de la ficha sODD. */
function railTodos(cwd: string): Array<{ done: boolean; text: string; current: boolean }> {
	if (harnessTodos.length > 0) {
		const hasInProgress = harnessTodos.some((t) => t.status === "in_progress");
		const firstPending = harnessTodos.findIndex((t) => t.status === "pending");
		return harnessTodos.map((t, i) => ({
			done: t.status === "completed",
			text: t.text,
			current: t.status === "in_progress" || (!hasInProgress && i === firstPending),
		}));
	}
	const steps = todoSteps(cwd);
	const current = steps.findIndex((t) => !t.done);
	return steps.map((t, i) => ({ done: t.done, text: t.text, current: i === current }));
}

/** Líneas del rail derecho (coloreadas con el tema vivo vía ui.theme). */
function railLines(ui: ExtensionUIContext, cwd: string): string[] {
	const theme = ui.theme;
	const W = RAIL_WIDTH;
	const sep = theme.fg("border", "─".repeat(W));
	const lines: string[] = [];

	// Proyecto
	const project = projectName(cwd);
	lines.push(theme.bold(theme.fg("accent", clip(project, W))));
	lines.push(theme.fg("dim", `rama ${clip(currentBranch(cwd), W - 5)}`));
	lines.push(sep);

	// Memoria HanniGram: ON/OFF + si en la sesión se añadió o borró algo.
	lines.push(theme.fg("accent", "memoria"));
	if (!memoryCache.checked) {
		lines.push(theme.fg("muted", "comprobando…"));
	} else if (memoryCache.up) {
		const delta = memoryDelta();
		lines.push(`${theme.fg("success", "✓")} ${theme.fg("text", "ON")} · ${theme.fg(delta.color, delta.label)}`);
	} else {
		lines.push(`${theme.fg("error", "✗")} ${theme.fg("text", "OFF")} (daemon caído)`);
	}
	// Actividad de la sesión: qué se leyó (≫) o guardó (✎) en la memoria.
	if (memActivity.length > 0) {
		for (const m of memActivity.slice(-4).reverse()) {
			const icon = m.kind === "write" ? theme.fg("success", "✎") : theme.fg("muted", "≫");
			lines.push(`${icon} ${clip(m.detail, W - 4)}`);
		}
	}
	lines.push(sep);

	// sODD: solo si hay ficha. Sin ficha (p.ej. una pregunta trivial del codigo)
	// no aplica y no se pinta nada, en vez de un "inactivo" que no significa nada.
	// Dentro de "activo": working (turno en curso) o not working (en reposo).
	const ind = soddIndicator(cwd);
	if (ind) {
		lines.push(theme.fg("accent", "sODD"));
		const state = soddWorking ? theme.fg("warning", "working") : theme.fg("muted", "not working");
		lines.push(`${theme.fg("success", "●")} activo · ${state}`);
		lines.push(theme.fg("muted", `  ${clip(ind.slug, 16)} (${ind.done}/${ind.total})`));
		lines.push(sep);
	}

	// Tareas — las define el harness (tool `todo`) para el turno actual; si no,
	// se muestran los pasos de la ficha sODD. La que está "en curso" va con ▸.
	// Se pliegan/despliegan con la tecla del rail o /hanniorq tasks.
	const todos = railTodos(cwd);
	if (todos.length > 0) {
		const doneTodos = todos.filter((t) => t.done).length;
		lines.push(theme.fg("accent", `tareas (${doneTodos}/${todos.length})`));
		if (railTasksHidden) {
			lines.push(theme.fg("muted", `plegadas · ${RAIL_TASKS_KEY}`));
		} else {
			todos.slice(0, MAX_RAIL_TODOS).forEach((t) => {
				const mark = t.done
					? theme.fg("success", "✓")
					: t.current
						? theme.fg("warning", "▸")
						: theme.fg("muted", "·");
				lines.push(`${mark} ${clip(t.text, W - 3)}`);
			});
			if (todos.length > MAX_RAIL_TODOS) {
				lines.push(theme.fg("muted", `… +${todos.length - MAX_RAIL_TODOS}`));
			}
		}
	}

	const mcp = getMcpConnectionStatuses();
	if (mcp.length > 0) {
		lines.push(sep, theme.fg("accent", "MCP"));
		for (const server of mcp.slice(0, 6)) {
			const icon = server.state === "connected" ? "✓" : server.state === "disabled" ? "·" : "!";
			const color = server.state === "connected" ? "success" : server.state === "disabled" ? "muted" : "warning";
			lines.push(
				`${theme.fg(color, icon)} ${clip(server.name, W - 15)} ${theme.fg("muted", clip(server.state, 10))}`,
			);
		}
		if (mcp.length > 6) lines.push(theme.fg("muted", `… +${mcp.length - 6} MCP`));
	}

	// Cambios: compacto (máx. 3 rutas) para que no se acumule y empuje al resto.
	const files = visibleWorktreeFiles(cwd, modifiedFilesCache.get(cwd) ?? []);
	lines.push(sep, theme.fg("accent", `cambios (${files.length})`));
	if (files.length === 0) {
		lines.push(theme.fg("muted", "sin cambios"));
	} else {
		for (const file of files.slice(0, 3)) lines.push(`${theme.fg("muted", "·")} ${clip(file, W - 2)}`);
		if (files.length > 3) lines.push(theme.fg("muted", `… +${files.length - 3}`));
	}

	return lines;
}

/** Renderiza el rail derecho (widget "hanniorq-rail", placement rightRail). */
function renderRail(ui: ExtensionUIContext, cwd: string): void {
	if (railHidden) {
		ui.setWidget("hanniorq-rail", undefined);
		return;
	}
	ui.setWidget("hanniorq-rail", () => new ThemedText(() => railLines(ui, cwd).join("\n"), 1, 1), {
		placement: "rightRail",
	});
}

/** Pliega/despliega los pasos sODD del rail y avisa (tecla RAIL_TASKS_KEY o /hanniorq tasks). */
function toggleRailTasks(ui: ExtensionUIContext, cwd: string): void {
	railTasksHidden = !railTasksHidden;
	renderRail(ui, cwd);
	ui.notify(railTasksHidden ? "Pasos sODD plegados en el rail." : "Pasos sODD desplegados en el rail.", "info");
}

/** Render inmediato + refresco asíncrono de la memoria (re-render al completar). */
function refreshRail(ui: ExtensionUIContext, cwd: string): void {
	renderRail(ui, cwd);
	void checkMemory().then(() => renderRail(ui, cwd));
}

async function refreshModifiedFiles(
	pi: Parameters<ExtensionFactory>[0],
	ui: ExtensionUIContext,
	cwd: string,
): Promise<void> {
	const pending = modifiedFilesRefresh.get(cwd);
	if (pending) return pending;
	const refresh = (async () => {
		try {
			const result = await pi.exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd });
			if (result.code !== 0) return;
			modifiedFilesCache.set(cwd, parseGitStatusPaths(result.stdout));
			renderRail(ui, cwd);
		} catch {
			// A rail refresh is observational; failure must not interrupt the session.
		}
	})();
	modifiedFilesRefresh.set(cwd, refresh);
	try {
		await refresh;
	} finally {
		modifiedFilesRefresh.delete(cwd);
	}
}

// ---------------------------------------------------------------------------
// Tool `todo`: la lista de tareas del turno actual, definida por el harness.
// Se pinta en el rail derecho y cada llamada reemplaza la lista entera (así,
// al llegar un prompt con tareas nuevas, las anteriores se limpian).
// ---------------------------------------------------------------------------

const todoSchema = Type.Object({
	todos: Type.Array(
		Type.Object({
			text: Type.String({ description: "Descripción de la tarea." }),
			status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: "pending (sin empezar) | in_progress (en curso) | completed (hecha).",
			}),
		}),
		{ description: "Lista COMPLETA de tareas del turno actual, en orden." },
	),
});

export function createTodoToolDefinition(): ToolDefinition<typeof todoSchema, { count: number; done: number }> {
	return {
		name: "todo",
		label: "todo",
		description: `# Lista de tareas\n\nDeclara la lista de tareas de la petición actual para verla en el rail derecho. Llámala al empezar trabajo de varios pasos con la lista completa, y de nuevo con la lista completa cada vez que una tarea empiece o termine. Enviar una lista nueva reemplaza a la anterior.\n\nEstados: "pending" (sin empezar), "in_progress" (en curso), "completed" (hecha).`,
		promptSnippet: "Declara/actualiza la lista de tareas de la petición actual (se ve en el rail derecho)",
		promptGuidelines: [
			"En peticiones de varios pasos, llama a `todo` al principio con la lista completa de tareas (una entrada por tarea) y actualízala al avanzar; manda siempre la lista completa para que los estados cuadren.",
			"`todo` es para la petición actual: una lista nueva reemplaza a la anterior.",
		],
		parameters: todoSchema,
		async execute(_toolCallId, { todos }, _signal, _onUpdate, ctx) {
			harnessTodos = todos.map((t) => ({ text: t.text.trim(), status: t.status }));
			renderRail(ctx.ui, ctx.cwd ?? process.cwd());
			const done = harnessTodos.filter((t) => t.status === "completed").length;
			return {
				content: [{ type: "text", text: `Tareas (${done}/${harnessTodos.length}).` }],
				details: { count: harnessTodos.length, done },
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Extensión
// ---------------------------------------------------------------------------

export function createHanniorqExtension(
	options: { ensureDaemon?: typeof ensureHanniGramDaemon } = {},
): ExtensionFactory {
	return (pi) => {
		let unsubscribeMcpStatus: (() => void) | undefined;
		// Estado del turno actual: tools usadas, escrituras de memoria, si se
		// tocó sODD. Se resetea en turn_start y se resume en turn_end como un
		// widget pequeñito (abajo), estilo "updated skill" de Hermes.
		let turnTools = new Set<string>();
		let turnMemoryWrites = 0;
		let turnSoddTouched = false;

		pi.on("turn_start", (_event, ctx) => {
			turnTools = new Set<string>();
			turnMemoryWrites = 0;
			turnSoddTouched = false;
			soddWorking = true;
			renderRail(ctx.ui, ctx.cwd ?? process.cwd());
		});

		pi.on("tool_execution_start", (event, ctx) => {
			turnTools.add(event.toolName);
			if (
				event.toolName === "mem_save" ||
				event.toolName === "mem_session_summary" ||
				event.toolName === "mem_delete"
			) {
				turnMemoryWrites++;
			}
			if (event.toolName === "task" || event.toolName === "hanniorq" || event.toolName === "hannigram") {
				turnSoddTouched = true;
			}
			// Actividad de memoria: registra lecturas y escrituras para el rail.
			if (MEM_READ_TOOLS.has(event.toolName) || MEM_WRITE_TOOLS.has(event.toolName)) {
				const op: MemActivity["op"] =
					event.toolName === "mem_delete"
						? "del"
						: event.toolName === "mem_save" || event.toolName === "mem_session_summary"
							? "add"
							: undefined;
				memActivity.push({
					kind: MEM_WRITE_TOOLS.has(event.toolName) ? "write" : "read",
					detail: memDetail(event.toolName, event.args as Record<string, unknown> | undefined),
					op,
				});
				renderRail(ctx.ui, ctx.cwd ?? process.cwd());
			}
			if (event.toolName !== "subagent") return;
			const task =
				typeof (event.args as { task?: unknown })?.task === "string" ? (event.args as { task: string }).task : "?";
			fleet.set(event.toolCallId, { id: event.toolCallId, task, status: "running", startedAt: Date.now() });
			startFleetTimer(ctx.ui);
			renderFleet(ctx.ui);
		});

		pi.on("tool_execution_end", (event, ctx) => {
			// Refresca el rail derecho cuando cambia estado relevante (memoria/sODD/tareas).
			if (
				event.toolName === "mem_save" ||
				event.toolName === "mem_session_summary" ||
				event.toolName === "mem_delete" ||
				event.toolName === "task" ||
				event.toolName === "hanniorq" ||
				event.toolName === "hannigram"
			) {
				renderRail(ctx.ui, ctx.cwd ?? process.cwd());
			}
			if (event.toolName !== "subagent") return;
			const agent = fleet.get(event.toolCallId);
			if (agent) {
				agent.status = event.isError ? "error" : "done";
				renderFleet(ctx.ui);
			}
		});

		// =================================================================
		// /hannigram — memoria del proyecto (instancia BD + fichero local
		// exportado, crea ADR, consulta estado). Delega en el CLI del motor
		// (hannigram) o en el daemon HTTP; la fuente de verdad es la BD.
		// =================================================================
		pi.registerCommand("hannigram", {
			description: "Memoria del proyecto: init|status|adr (HanniGram)",
			handler: async (args, ctx) => {
				const [sub, ...rest] = args.trim().split(/\s+/);
				const cwd = ctx.cwd ?? process.cwd();
				const hgCli = process.env.HANNIGRAM_CLI ?? "hannigram";
				if (sub === "init") {
					ctx.ui.notify("Inicializando memoria del proyecto (BD + .hannigram/memory.md).", "info");
					const r = spawnSync(hgCli, ["init", "--cwd", cwd], { encoding: "utf-8" });
					if (r.status === 0) {
						ctx.ui.notify(`HanniGram iniciado: ${r.stdout.trim()}`, "info");
					} else {
						ctx.ui.notify(
							`No pude ejecutar '${hgCli} init' (${r.status ?? "no disponible"}). Instala HanniGram o define HANNIGRAM_CLI.`,
							"warning",
						);
					}
					return;
				}
				if (sub === "status") {
					const health = await hannigram<{ status?: string; db?: string }>("/health");
					if (!health) {
						ctx.ui.notify(
							`Daemon HanniGram NO disponible (${HANNIGRAM_BASE}). Define HANNIGRAM_DAEMON o inicia el daemon manualmente.`,
							"warning",
						);
						return;
					}
					const obs = await recentObservations(cwd);
					ctx.ui.notify(
						`HanniGram: ${health.status} · BD ${health.db ?? "?"} · observaciones recientes: ${obs.length}`,
						"info",
					);
					return;
				}
				if (sub === "adr") {
					const title = rest[0];
					const content = rest.slice(1).join(" ");
					if (!title) {
						ctx.ui.notify(
							"Uso: /hannigram adr <título> [contenido] — guarda una decisión (ADR) con topic adr/<slug>",
							"warning",
						);
						return;
					}
					const obs = await hannigram<{ id: number }>(`/api/observations?${new URLSearchParams({ cwd })}`, {
						method: "POST",
						body: JSON.stringify({ title, content, topicKey: `adr/${slugify(title)}`, type: "adr" }),
					});
					ctx.ui.notify(
						obs
							? `ADR guardada: ${title} → adr/${slugify(title)} (#${obs.id})`
							: "No pude guardar la ADR (daemon no disponible).",
						obs ? "info" : "warning",
					);
					return;
				}
				ctx.ui.notify("Uso: /hannigram init|status|adr <título> [contenido]", "warning");
			},
		});

		// Resumen de fin de turno: widget pequeñito (abajo) con tools usadas,
		// si sODD se usó y si se escribió en memoria de HanniGram — estilo
		// "updated skill" de Hermes.
		pi.on("turn_end", (_event, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			soddWorking = false;
			const ind = soddIndicator(cwd);
			const parts: string[] = [];
			if (turnTools.size > 0) parts.push(`tools: ${[...turnTools].join(", ")}`);
			if (ind) parts.push(`sODD: activo (${ind.done}/${ind.total})`);
			else if (turnSoddTouched) parts.push("sODD: activo");
			if (turnMemoryWrites > 0) parts.push(`memoria: +${turnMemoryWrites}`);
			if (parts.length > 0) ctx.ui.setWidget("hanniorq-turn", [`▸ ${parts.join(" · ")}`]);
			else ctx.ui.setWidget("hanniorq-turn", undefined);
			updateSoddIndicator(ctx.ui, cwd);
			refreshRail(ctx.ui, cwd);
			void refreshModifiedFiles(pi, ctx.ui, cwd);
		});

		pi.on("tool_execution_end", (_event, ctx) => {
			void refreshModifiedFiles(pi, ctx.ui, ctx.cwd ?? process.cwd());
		});

		// Indicador sODD: pinta si hay ficha activa (al iniciar la sesión,
		// que es cuando la ficha se retoma).
		pi.on("session_start", (_event, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			// Sesion nueva: la actividad de memoria y las tareas del harness son de la sesion.
			memActivity.length = 0;
			harnessTodos = [];
			soddWorking = false;
			updateSoddIndicator(ctx.ui, cwd);
			refreshRail(ctx.ui, cwd);
			void refreshModifiedFiles(pi, ctx.ui, cwd);
			unsubscribeMcpStatus?.();
			unsubscribeMcpStatus = subscribeMcpConnectionStatuses(() => renderRail(ctx.ui, cwd));
			void (options.ensureDaemon ?? ensureHanniGramDaemon)({ cwd, baseUrl: HANNIGRAM_BASE }).then((started) => {
				if (!started) return;
				void checkMemory().then(() => renderRail(ctx.ui, cwd));
			});
		});
		pi.on("session_shutdown", () => {
			unsubscribeMcpStatus?.();
			unsubscribeMcpStatus = undefined;
		});

		pi.registerCommand("hanniorq", {
			description: "Orquestador sODD: help|on|off|status|plan|new|run|watch|close|resume|rail|tasks|clear",
			handler: async (args, ctx) => {
				const [sub, ...rest] = args.trim().split(/\s+/);
				const cwd = ctx.cwd ?? process.cwd();
				const taskPath = getActiveTaskPath(cwd);
				const oddDir = getOddDir(cwd);

				switch (sub) {
					case "help": {
						const commands: Array<{ cmd: string; desc: string }> = [
							{
								cmd: "/task new <slug>",
								desc: "Crea una ficha sODD (Objetivo/Alcance/Verify/Pasos). El estándar para trabajo sustancial.",
							},
							{ cmd: "/task list", desc: "Lista las fichas sODD del proyecto (activas y cerradas)." },
							{
								cmd: "/task plan <petición>",
								desc: "Clasifica una petición: trivial → hágala inline (sin ficha); sustancial → crea la ficha. Decisión orgánica (sODD), no burocrática.",
							},
							{
								cmd: "/hanniorq on|off",
								desc: "Activa/desactiva la capa orquestadora: con on, cada petición se clasifica (trivial vs ficha).",
							},
							{
								cmd: "/hanniorq status",
								desc: "Estado del orquestador: activo/inactivo + ficha activa actual + resumen de lo que se está haciendo.",
							},
							{
								cmd: "/hanniorq new <slug>",
								desc: "Alias de /task new: crea la ficha sODD con ese nombre de archivo.",
							},
							{
								cmd: "/hanniorq plan <petición>",
								desc: "Igual que /task plan: clasifica y prepara el plan si merece ficha.",
							},
							{
								cmd: "/hanniorq run",
								desc: "Arranca el trabajo de la ficha activa paso a paso (check + commit atómico por paso).",
							},
							{
								cmd: "/hanniorq watch",
								desc: "Tablero 'en vivo': fichas sODD en disco (fuente de verdad) + subagentes activos. Muestra en qué se trabaja.",
							},
							{
								cmd: "/hanniorq close",
								desc: "Cierra la ficha activa con su resumen (sODD: los cambios triviales no generan resumen).",
							},
							{
								cmd: "/hanniorq resume",
								desc: "Reanuda el contexto de un proyecto: ¿hay memoria? (HanniGram) → índice ligero de decisiones + ficha activa. Sin releer todos los ficheros.",
							},
							{
								cmd: "/hannigram init",
								desc: "Instancia la memoria del proyecto: crea el proyecto en la BD de HanniGram + exporta .hannigram/memory.md local (para otros harness). Manual o cuando sODD lo considere (proyecto grande).",
							},
							{
								cmd: "/hannigram status",
								desc: "Estado de la memoria: daemon arriba/abajo, BD y observaciones recientes.",
							},
							{
								cmd: "/hannigram adr <título> [contenido]",
								desc: "Guarda una decisión de arquitectura (ADR) con topic adr/<slug>, tipo adr. Base de 'respetar estilos/convenciones' entre sesiones.",
							},
							{
								cmd: "delega <petición>",
								desc: "Fuerza la delegación a un subagente worker aunque sODD la hubiera hecho inline.",
							},
						];
						const chunks = commands.map((c) => `• ${c.cmd}\n${c.desc}`);
						ctx.ui.notify(`Comandos disponibles (hanniorq/HanniGram/sODD):\n\n${chunks.join("\n\n")}`, "info");
						// Submenú interactivo: elige un comando y verás su explicación.
						try {
							const picked = await ctx.ui.select(
								"Ayuda de comandos",
								commands.map((c) => `${c.cmd} — ${c.desc.split(".")[0]}.`),
							);
							if (picked) {
								const cmd =
									commands.find((c) => picked.startsWith(c.cmd.split(" ")[0]) || picked.includes(c.cmd)) ??
									commands[0];
								ctx.ui.notify(`${cmd.cmd}\n━━━━━━━━━━━━━━━━━━━━\n${cmd.desc}`, "info");
							}
						} catch {
							// select cancelado (o TUI sin soporte) — la lista ya se mostró arriba.
						}
						return;
					}
					case "on": {
						state.on = true;
						ctx.ui.notify(
							"hanniorq activado. Clasifico cada petición: trivial → inline (sin ficha/resumen); sustancial → ficha sODD.",
							"info",
						);
						return;
					}
					case "new": {
						// Alias de plan: pide el slug de la ficha a crear.
						const slug = rest[0];
						if (!slug) {
							ctx.ui.notify(
								"Uso: /hanniorq new <slug> — crea la ficha sODD (o /hanniorq plan <petición> para clasificar).",
								"warning",
							);
							return;
						}
						ctx.ui.notify(
							`Crea la ficha sODD: /task new ${slug} — con Objetivo, Alcance, Verify y Pasos. Trabaja por pasos con su check y commit atómico. Si mientras trabajas ves que es trivial, hazlo inline sin ficha.`,
							"info",
						);
						return;
					}
					case "off": {
						state.on = false;
						ctx.ui.notify("hanniorq desactivado. Vuelvo al comportamiento por defecto.", "info");
						return;
					}
					case "status": {
						const slug = getActiveSlug(cwd);
						ctx.ui.notify(
							`hanniorq: ${state.on ? "ON" : "OFF"}${slug ? ` · ficha activa: odd/tasks/${slug}.md` : " · sin ficha activa"}`,
							"info",
						);
						return;
					}
					case "plan": {
						const request = rest.join(" ");
						if (!request) {
							ctx.ui.notify("Uso: /hanniorq plan <petición>", "warning");
							return;
						}
						// sODD: clasificar. Si es trivial (1 paso, entendido, sin riesgo),
						// NO se crea ficha — se hace inline. Solo lo sustancial genera ficha.
						ctx.ui.notify(
							`Clasificando: "${request}". Si es un cambio pequeño y entendido, hazlo inline sin ficha ni resumen. Si es sustancial (2+ pasos, varios archivos, riesgo), crea la ficha con /task new <slug> y trabaja por pasos.`,
							"info",
						);
						return;
					}
					case "run": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa. Usa /hanniorq plan o /task new <slug> primero.", "warning");
							return;
						}
						const target = rest[0] ? ` (tarea ${rest[0]})` : "";
						// sODD: delegación CONDICIONAL — si la ficha activa es grande y spliteable
						// (pasos independientes), delega cada parte con la tool subagent pasándole
						// la ficha como contexto; los callbacks de estado llegan al log. Si es un
						// solo bloque, ejecútalo tú inline.
						const text = readFileSync(taskPath, "utf-8");
						const steps = (text.match(/^- \[ \]/gm) ?? []).length;
						const splitable = steps >= 2;
						const hint = splitable
							? `La ficha tiene ${steps} pasos — si son independientes, delega cada parte con la tool \`subagent\` (pásale la ficha + el paso concreto como contexto) y vigila con /hanniorq watch. Solo ejecuta inline lo que no sea spliteable.`
							: `Ejecuta la siguiente tarea${target} de la ficha, con su check si aplica, y haz commit por tarea.`;
						ctx.ui.notify(hint, "info");
						return;
					}
					case "watch": {
						// Lista las fichas activas (no-done) + los subagentes en vuelo, para ver en qué se trabaja.
						const tasksDir = join(getOddDir(cwd), "tasks");
						let rows = "sin tareas activas";
						try {
							const names = (await import("node:fs")).readdirSync(tasksDir).filter((n) => n.endsWith(".md"));
							const active = names
								.map((n) => {
									const p = join(tasksDir, n);
									const text = readFileSync(p, "utf-8");
									const status = text.match(/^status: (.+)$/m)?.[1] ?? "?";
									const seen = text.match(/\[x\]|\[X\]/) ? "progreso ✔" : "sin pasos hechos";
									return `  ${n} · ${status} · ${seen}`;
								})
								.join("\n");
							if (names.length) rows = `fichas:\n${active}`;
						} catch {
							/* odd/tasks no existe aún */
						}
						const fleetLines = [...fleet.values()].map(
							(a) =>
								`  ${a.status === "running" ? "▶" : a.status === "error" ? "✗" : "✓"} ${a.id.slice(0, 8)}: ${a.task.slice(0, 90)}`,
						);
						const fleetRows = fleetLines.length
							? `subagentes en vuelo:\n${fleetLines.join("\n")}`
							: "subagentes en vuelo: ninguno";
						ctx.ui.notify(
							`hanniorq watch — en qué se trabaja:\n${rows}\n${fleetRows}\n(Cada ficha vive en odd/tasks/<slug>.md; el agente la actualiza por paso.)`,
							"info",
						);
						return;
					}
					case "close": {
						if (!taskPath) {
							ctx.ui.notify(
								"No hay ficha activa — nada que resumir. (sODD: los cambios triviales no generan resumen.)",
								"info",
							);
							return;
						}
						const slug = getActiveSlug(cwd)!;
						const content = readFileSync(taskPath, "utf-8");
						const branch = currentBranch(cwd);
						const commit = lastCommit(cwd);
						const observations = await recentObservations(cwd);
						const mirrorId = await mirrorTask(cwd, slug, content);
						const sessionSaved = await saveSessionSummary(
							cwd,
							`Trabajo completado: ${slug}. Rama: ${branch}. Commit: ${commit}.`,
						);
						const summary = buildSummary({ cwd, slug, branch, commit, observations, mirrorId, sessionSaved });
						// Marcar done y limpiar .active
						writeFileSync(taskPath, content.replace(/^status: .*$/m, "status: done"));
						writeFileSync(join(oddDir, ".active"), "");
						ctx.ui.notify(summary, "info");
						return;
					}
					case "resume": {
						const slug = rest[0] ?? getActiveSlug(cwd);
						if (!slug) {
							ctx.ui.notify("No hay ficha activa ni slug indicado. Uso: /hanniorq resume [<slug>]", "warning");
							return;
						}
						const obs = await recentObservations(cwd);
						ctx.ui.notify(
							`Retomando ${slug}. Lee la ficha odd/tasks/${slug}.md, consulta mem_context/mem_search para recuperar contexto, y reconcilia antes de continuar. Observaciones recientes: ${obs.length}.`,
							"info",
						);
						return;
					}
					case "rail": {
						railHidden = !railHidden;
						renderRail(ctx.ui, cwd);
						ctx.ui.notify(railHidden ? "Rail derecho oculto." : "Rail derecho visible.", "info");
						return;
					}
					case "tasks": {
						toggleRailTasks(ctx.ui, cwd);
						return;
					}
					case "clear": {
						memActivity.length = 0;
						harnessTodos = [];
						renderRail(ctx.ui, cwd);
						ctx.ui.notify(
							"Actividad de memoria y tareas del rail limpiadas (la memoria en HanniGram no se toca).",
							"info",
						);
						return;
					}
					default:
						ctx.ui.notify(
							"Uso: /hanniorq on|off|status|plan|new <slug>|run|watch|close|resume|rail|tasks|clear",
							"warning",
						);
				}
			},
		});

		// Tecla del rail: pliega/despliega los pasos sODD (igual que /hanniorq tasks).
		pi.registerShortcut(RAIL_TASKS_KEY, {
			description: "Plegar/desplegar los pasos sODD del rail derecho",
			handler: (ctx) => {
				toggleRailTasks(ctx.ui, ctx.cwd ?? process.cwd());
			},
		});

		// Tool `todo`: el harness declara la lista de tareas del turno actual.
		pi.registerTool(createTodoToolDefinition());

		// =================================================================
		// /helpme — listado maestro de comandos HanniPI (qué hace cada uno).
		// =================================================================
		pi.registerCommand("helpme", {
			description: "Lista los comandos de HanniPI y para qué sirven",
			handler: async (_args, ctx) => {
				const commands: Array<{ cmd: string; desc: string }> = [
					{ cmd: "/helpme", desc: "Este listado de comandos." },
					{
						cmd: "/hannidump [ruta]",
						desc: "Genera un fichero agents.md (contexto + ADRs resumidos por el LLM) para harness externos que no usan HanniGram.",
					},
					{
						cmd: "/explore",
						desc: "Explora el proyecto (md, README, estructura) y construye su memoria inicial en HanniGram la primera vez.",
					},
					{
						cmd: "/task new|list|plan <petición>",
						desc: "Fichas sODD: crear/listar/clasificar trabajo (trivial → inline, sustancial → ficha).",
					},
					{
						cmd: "/hanniorq on|off|status|plan|new|run|watch|close|resume",
						desc: "Orquestador sODD: activa/desactiva, arranca por pasos, vigila subagentes, cierra con resumen.",
					},
					{
						cmd: "/hannigram init|status|adr <título>",
						desc: "Memoria del proyecto: instancia la BD + exporta .hannigram/memory.md, consulta estado, guarda ADRs.",
					},
					{ cmd: "/model", desc: "Seleccionar proveedor/modelo." },
					{ cmd: "/session", desc: "Info y estadísticas de la sesión actual." },
					{ cmd: "/new", desc: "Nueva sesión." },
					{ cmd: "/compact", desc: "Compactar manualmente el contexto." },
					{ cmd: "/reload", desc: "Recargar extensiones, skills, prompts y temas." },
					{ cmd: "/quit", desc: "Salir." },
				];
				const chunks = commands.map((c) => `• ${c.cmd}\n${c.desc}`);
				ctx.ui.notify(`Comandos de HanniPI:\n\n${chunks.join("\n\n")}`, "info");
				try {
					const picked = await ctx.ui.select(
						"Ayuda de comandos (HanniPI)",
						commands.map((c) => `${c.cmd} — ${c.desc.split(".")[0]}.`),
					);
					if (picked) {
						const cmd = commands.find((c) => picked.startsWith(c.cmd.split(" ")[0])) ?? commands[0];
						ctx.ui.notify(`${cmd.cmd}\n━━━━━━━━━━━━━━━━━━━━\n${cmd.desc}`, "info");
					}
				} catch {
					// select cancelado (o TUI sin soporte) — la lista ya se mostró.
				}
			},
		});

		// =================================================================
		// /hannidump — dump de contexto + ADRs a un fichero agents.md para
		// harness que NO usan HanniGram. Lee la memoria del daemon y pide al
		// LLM el resumen autocontenido (escribiendo el fichero con sus tools).
		// =================================================================
		pi.registerCommand("hannidump", {
			description: "Generar agents.md (contexto + ADRs) para harness externos sin HanniGram",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const target = args.trim().split(/\s+/)[0] || "agents.md";
				const obs =
					(await hannigram<
						Array<{ id: number; title: string; content: string; topicKey?: string; type?: string }>
					>(`/api/observations?${new URLSearchParams({ cwd, limit: "200" })}`)) ?? [];
				if (obs.length === 0) {
					ctx.ui.notify(
						"No hay memoria en HanniGram para este proyecto. Usa /explore primero para construirla.",
						"warning",
					);
					return;
				}
				const memBlock = obs
					.map(
						(o) =>
							`- [${o.type ?? "obs"}] ${o.title}${o.topicKey ? ` (${o.topicKey})` : ""}\n  ${o.content.replace(/\n/g, "\n  ")}`,
					)
					.join("\n");
				ctx.ui.notify(`Generando ${target} con ${obs.length} observaciones (vía LLM).`, "info");
				pi.sendUserMessage(
					`Genera el fichero \`${target}\` en la raíz del proyecto (${cwd}) para agentes/harnesses de IA que NO usan HanniGram, de modo que arranquen con contexto sin depender de este daemon.\n\nResume en ese fichero:\n- Qué es el proyecto y su stack/estructura.\n- Decisiones de arquitectura (ADR) y convenciones/estilos a respetar.\n- Reglas o patrones relevantes.\n\nEscribe \`${target}\` con el resultado. Sé conciso y no inventes nada que no esté en la memoria ni en el proyecto.\n\nMemoria de HanniGram (${obs.length} observaciones):\n${memBlock}`,
				);
			},
		});

		// =================================================================
		// /explore — primera vez en un proyecto: lee md/README/estructura y
		// construye la memoria inicial (ADR + contexto) vía el LLM.
		// =================================================================
		pi.registerCommand("explore", {
			description: "Explora el proyecto y construye su memoria inicial en HanniGram",
			handler: async (_args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				ctx.ui.notify("Explorando el proyecto para construir su memoria inicial (vía LLM).", "info");
				pi.sendUserMessage(
					`Explora este proyecto para construir su memoria inicial en HanniGram (primera vez). Directorio de trabajo: ${cwd}.\n\nHaz:\n1. Lee los ficheros informativos: README, *.md, AGENTS.md, CONTRIBUTING.md, docs/, package.json (o equivalente) y la estructura de directorios.\n2. Identifica: qué es el proyecto, stack/tecnología, decisiones de arquitectura y convenciones/estilo (naming, estructura, patrones).\n3. Guarda la memoria: para cada decisión usa la tool \`mem_save\` con \`type=adr\` y \`topicKey=adr/<slug>\`; para el contexto general usa topics descriptivos. Si \`mem_save\` no está disponible, ejecuta por bash: \`hannigram save "<título>" --content "<texto>" --type adr --topic adr/<slug> --cwd "${cwd}"\`.\n4. No inventes nada que no esté en el proyecto.\n\nEmpieza listando la raíz del proyecto.`,
				);
			},
		});
	};
}
export default createHanniorqExtension();
