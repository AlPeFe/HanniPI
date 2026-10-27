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
 *  - La memoria va primera: al arrancar la sesión se lee HanniGram UNA vez y se inyecta un briefing
 *    (decisiones + última sesión + trabajo en curso) en el system prompt. Así una sesión nueva —o el
 *    mismo repo días después— no empieza a ciegas reexplorando ficheros: la memoria dice qué estaba
 *    decidido y en curso, y el repo se lee para lo que la memoria no cubre.
 */

import { spawnSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Component, Key, Panel, ScrollView, Spacer, type StackChild, Text, VStack } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type {
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
	ToolDefinition,
} from "../../core/extensions/types.ts";
import type { Settings } from "../../core/settings-manager.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.ts";
import { loadMcpConfig } from "../mcp/config.ts";
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
/** Uso de memoria del turno en curso (se resetea en cada turn_start). */
let memTurn: MemTurnSummary = emptyMemTurnSummary();
let harnessTodos: HarnessTodo[] = [];
/** Hay un turno en curso: sODD esta "working" mientras el agente trabaja. */
let soddWorking = false;
/** Máximo de pasos listados en el rail; el resto se resume con "+N". */
const MAX_RAIL_TODOS = 8;
/**
 * Skills en juego en la sesión. El estado distingue lo que el usuario pide ver: `using` mientras el
 * run en curso las está usando (o las acaba de cargar), `activated` cuando ya se cargaron antes y el
 * run terminó. La clave es el nombre del skill tal y como lo conoce el system prompt.
 */
interface SkillUse {
	name: string;
	state: "using" | "activated";
	/** Orden de activación (para listar primero lo más reciente). */
	seq: number;
}
const skillUses = new Map<string, SkillUse>();
/** Catálogo de skills del system prompt (nombre + fichero): permite mapear una lectura a su skill. */
let sessionSkills: Array<{ name: string; filePath: string }> = [];
let skillSeq = 0;
/** Máximo de skills listados en el rail; el resto se resume con "+N". */
const MAX_RAIL_SKILLS = 4;
/** Ancho por defecto de la columna del rail; el usuario lo cambia con ctrl+alt+←/→ o /hanniorq rail <n>. */
export const RAIL_WIDTH = 34;
/** Líneas máximas por tarea: se envuelve el texto en varias líneas en vez de recortarlo. Con los
 *  paneles del rail el ancho de contenido baja ~4 columnas, así que una tarea larga necesita una
 *  línea más para verse entera. */
const MAX_TODO_LINES = 4;
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

/** Resumen del uso de memoria en el turno, para la línea de fin de turno. */
export interface MemTurnSummary {
	/** `mem_save` que creó una observación. */
	created: number;
	/** `mem_save` que actualizó una existente (mismo topic_key). */
	updated: number;
	deleted: number;
	summaries: number;
	reads: number;
}

export function emptyMemTurnSummary(): MemTurnSummary {
	return { created: 0, updated: 0, deleted: 0, summaries: 0, reads: 0 };
}

/**
 * Línea de memoria de fin de turno: `hannigram → memory: +1 nuevo · ≫2 leído`.
 * Solo con lo que pasó de verdad (nada de ceros) y `undefined` si la memoria no se tocó.
 */
export function formatMemoryLine(stats: MemTurnSummary): string | undefined {
	const parts: string[] = [];
	if (stats.created > 0) parts.push(`+${stats.created} nuevo`);
	if (stats.updated > 0) parts.push(`~${stats.updated} update`);
	if (stats.summaries > 0) parts.push(`+${stats.summaries} resumen`);
	if (stats.deleted > 0) parts.push(`-${stats.deleted} borrado`);
	if (stats.reads > 0) parts.push(`≫${stats.reads} leído`);
	if (parts.length === 0) return undefined;
	return `hannigram → memory: ${parts.join(" · ")}`;
}

/**
 * Texto plano del resultado de una tool, venga como `{ content: [{ text }] }` (lo normal),
 * un array de partes o un string. Se usa para saber si `mem_save` creó o actualizó.
 */
function toolResultText(result: unknown): string {
	const parts: string[] = [];
	const pushText = (value: unknown) => {
		if (typeof value === "string") parts.push(value);
		else if (isPlainObject(value) && typeof value.text === "string") parts.push(value.text);
	};
	if (Array.isArray(result)) {
		for (const item of result) pushText(item);
	} else if (isPlainObject(result)) {
		pushText(result);
		if (Array.isArray(result.content)) for (const item of result.content) pushText(item);
	}
	return parts.join(" ");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
	// /skipmemory: HanniGram fuera del juego. Ni una petición — tampoco /health —, así que ni el
	// briefing, ni el handoff, ni el registro de sesión salen de aquí.
	if (memorySkipped()) return undefined;
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

// ---------------------------------------------------------------------------
// /dumpgram — volcado de la memoria del proyecto a ficheros .md legibles
// ---------------------------------------------------------------------------

/** Observación tal y como la devuelve `/api/observations` (camelCase). */
export interface DumpObservation {
	id: number;
	title: string;
	content: string;
	topicKey?: string;
	type?: string;
	what?: string;
	why?: string;
	where?: string;
	learned?: string;
	createdAtUtc?: string;
	updatedAtUtc?: string;
	state?: string;
}

interface DumpFile {
	name: string;
	title: string;
	intro: string;
	types: string[];
}

/** Un fichero por concepto. Un tipo que no esté en ninguna lista cae en `contexto.md`. */
const DUMP_FILES: DumpFile[] = [
	{
		name: "decisiones.md",
		title: "Decisiones y convenciones",
		intro: "Lo que está decidido y hay que respetar al tocar el repo.",
		types: ["adr", "decision"],
	},
	{
		name: "hecho.md",
		title: "Qué se ha hecho",
		intro: "Trabajo cerrado: arreglos, features y releases, con el porqué.",
		types: ["bugfix", "feature", "release"],
	},
	{
		name: "sesiones.md",
		title: "Sesiones y estado en curso",
		intro: "Handoffs y resúmenes de sesión: en qué se quedó el trabajo.",
		types: ["handoff", "session_summary", "summary"],
	},
	{
		name: "contexto.md",
		title: "Descubrimientos, patrones y contexto",
		intro: "Hallazgos, patrones y notas que no son ni decisiones ni trabajo cerrado.",
		types: [],
	},
];

const KNOWN_DUMP_TYPES = new Set(DUMP_FILES.flatMap((file) => file.types));

function dumpDay(value?: string): string {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** Observaciones vivas, de la más reciente a la más antigua (por actualización). */
function sortDumpObservations(observations: DumpObservation[]): DumpObservation[] {
	return observations
		.filter((o) => o.state !== "archived")
		.sort((a, b) => (b.updatedAtUtc ?? "").localeCompare(a.updatedAtUtc ?? "") || b.id - a.id);
}

function renderDumpObservation(o: DumpObservation): string {
	const meta = [
		o.type ?? "obs",
		o.topicKey ? `\`${o.topicKey}\`` : undefined,
		dumpDay(o.updatedAtUtc) || undefined,
		`#${o.id}`,
	]
		.filter(Boolean)
		.join(" · ");
	const parts = [`### ${o.title}`, "", meta, "", o.content.trim()];
	for (const [label, value] of [
		["Qué", o.what],
		["Por qué", o.why],
		["Dónde", o.where],
		["Aprendido", o.learned],
	] as const) {
		if (value?.trim()) parts.push("", `**${label}:** ${value.trim()}`);
	}
	return parts.join("\n");
}

function dumpHeader(title: string, intro: string, options: MemoryDumpOptions, count: number): string {
	return [
		`# ${title}`,
		"",
		intro,
		"",
		`_${options.project} · ${dumpDay(options.generatedAt.toISOString())} · ${count} ${count === 1 ? "observación" : "observaciones"} · volcado de la memoria del proyecto con \`/dumpgram\`, no editar a mano._`,
	].join("\n");
}

export interface MemoryDumpOptions {
	project: string;
	/** Directorio de salida, relativo al repo (solo informativo en el contenido). */
	dir: string;
	generatedAt: Date;
}

/**
 * Volcado determinista de la memoria del proyecto: observaciones → ficheros .md.
 * Sin LLM y sin red, para que el resultado sea fiel y repetible.
 */
export function renderMemoryDump(
	observations: DumpObservation[],
	options: MemoryDumpOptions,
): Array<{ name: string; content: string }> {
	const sorted = sortDumpObservations(observations);
	const files = DUMP_FILES.map((file) => {
		const picked = sorted.filter((o) =>
			file.types.length > 0 ? file.types.includes(o.type ?? "") : !KNOWN_DUMP_TYPES.has(o.type ?? ""),
		);
		const body =
			picked.length > 0
				? picked.map(renderDumpObservation).join("\n\n---\n\n")
				: "_No hay observaciones de este tipo._";
		return {
			name: file.name,
			file,
			picked,
			content: `${dumpHeader(file.title, file.intro, options, picked.length)}\n\n${body}\n`,
		};
	});

	// El handoff más reciente abre el índice: es lo que un recién llegado necesita primero.
	const latest = sorted.find((o) => DUMP_FILES.find((f) => f.name === "sesiones.md")?.types.includes(o.type ?? ""));
	const index = [
		`# Memoria del proyecto — ${options.project}`,
		"",
		"Volcado de la memoria del proyecto generado por `/dumpgram`: qué se ha decidido, qué se ha hecho y en qué se quedó el trabajo. Está pensado para que una persona (o un agente sin acceso a la base de datos) entienda el repo leyendo estos ficheros.",
		"",
		`_Generado el ${dumpDay(options.generatedAt.toISOString())} desde la memoria de HanniGram · ${sorted.length} ${sorted.length === 1 ? "observación" : "observaciones"} · no editar a mano: se regenera con \`/dumpgram\`._`,
		"",
		"## Estado en curso",
		"",
		latest ? `${renderDumpObservation(latest)}` : "_Sin handoff guardado: revisa `hecho.md` y `contexto.md`._",
		"",
		"## Ficheros",
		"",
		"| Fichero | Contenido | Observaciones |",
		"| --- | --- | --- |",
		...files.map((f) => `| [\`${options.dir}/${f.name}\`](${f.name}) | ${f.file.title} | ${f.picked.length} |`),
		"",
		"## Índice de temas",
		"",
	];
	const topics = new Map<string, DumpObservation[]>();
	let untopiced = 0;
	for (const o of sorted) {
		if (!o.topicKey) {
			untopiced += 1;
			continue;
		}
		topics.set(o.topicKey, [...(topics.get(o.topicKey) ?? []), o]);
	}
	if (topics.size === 0) {
		index.push("_Sin observaciones con tema._");
	} else {
		index.push("| Tema | Última observación | Observaciones |");
		index.push("| --- | --- | --- |");
		for (const [topic, list] of topics) {
			const target = files.find((f) => f.picked.some((o) => o.id === list[0]?.id));
			index.push(`| \`${topic}\` | ${list[0]?.title ?? ""} | ${list.length}${target ? ` → ${target.name}` : ""} |`);
		}
	}
	if (untopiced > 0)
		index.push("", `_Además hay ${untopiced} ${untopiced === 1 ? "observación" : "observaciones"} sin tema._`);

	return [
		{ name: "README.md", content: `${index.join("\n")}\n` },
		...files.map((f) => ({ name: f.name, content: f.content })),
	];
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
// Briefing de memoria: lo que el harness ya sabe del proyecto antes de empezar.
//
// Motivo: una sesión nueva (o la misma, días después) arrancaba a ciegas. La
// memoria de HanniGram solo se usaba si al modelo se le ocurría consultarla, así
// que volvía a explorar el repo para reconstruir lo ya decidido y lo que quedó a
// medias. Ahora se lee UNA vez al arrancar y se inyecta en el system prompt
// (sección `memoria`): memoria primero, repo para lo que la memoria no cubre.
// ---------------------------------------------------------------------------

interface BriefingSession {
	goal?: string;
	summary?: string;
	nextSteps?: string;
	startedAtUtc?: string;
	endedAtUtc?: string;
}

interface BriefingObservation {
	title?: string;
	content?: string;
	topicKey?: string;
	type?: string;
	createdAtUtc?: string;
}

/** TopicKey de la observacion "en que estaba": una sola fila por proyecto, actualizada sola. */
const HANDOFF_TOPIC = "handoff/actual";

interface MemoryBriefing {
	/** Texto que entra en el system prompt (sección `memoria`). */
	text: string;
	/** Resumen de una línea para avisar al arrancar que hay memoria que retomar. */
	headline: string;
}

/** Guideline que el prompt se lleva cuando hay briefing (se añade una sola vez). */
const MEMORY_GUIDELINE =
	"La memoria del proyecto (HanniGram) va primero: consulta `mem_context`/`mem_search` antes de explorar el repo. El repo manda para el código; la memoria, para lo decidido, lo aprendido y lo que quedó en curso. Al acabar trabajo sustancial guarda el handoff con `mem_session_summary` y las decisiones o patrones con `mem_save`.";

let briefing: { cwd: string; value: MemoryBriefing } | undefined;

/**
 * cwd en el que ya se inyectó el briefing en el system prompt. Se inyecta UNA vez por sesión:
 * reinyectarlo cuando cambia la memoria (cada `mem_save` mueve el contador del briefing) reescribe
 * el system prompt y tira la caché de prefijo del proveedor, así que el siguiente turno paga el
 * contexto entero a precio de entrada. El modelo conserva el briefing en el contexto y
 * `mem_search`/`mem_context` siguen ahí para lo que cambie después.
 */
let briefingInjectedFor: string | undefined;

function oneLine(text: string | undefined, max: number): string {
	const flat = (typeof text === "string" ? text : "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function briefingWhen(iso: string | undefined): string {
	return typeof iso === "string" ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "fecha desconocida";
}

async function fetchMemoryBriefing(cwd: string): Promise<MemoryBriefing | undefined> {
	const [rawObservations, rawSessions] = await Promise.all([
		hannigram<BriefingObservation[]>(`/api/observations?${new URLSearchParams({ cwd, limit: "80" })}`),
		hannigram<BriefingSession[]>(`/api/sessions?${new URLSearchParams({ cwd, limit: "3" })}`),
	]);
	// Daemon caído: no se inventa memoria (el rail ya lo marca como OFF) y no se cachea nada.
	if (rawObservations === undefined && rawSessions === undefined) return undefined;
	// El daemon es otro proceso: una respuesta con otra forma no puede tumbar la sesión.
	const observations = Array.isArray(rawObservations) ? rawObservations : [];
	const sessions = Array.isArray(rawSessions) ? rawSessions : [];

	const lines: string[] = [];
	const resumeBits: string[] = [];
	const last = sessions[0];
	if (last) {
		lines.push(
			`última sesión (${briefingWhen(last.endedAtUtc ?? last.startedAtUtc)}): ${oneLine(last.goal, 140) || "sin objetivo"}`,
		);
		if (last.summary) lines.push(`  hecho: ${oneLine(last.summary, 420)}`);
		if (last.nextSteps) lines.push(`  siguiente: ${oneLine(last.nextSteps, 320)}`);
		resumeBits.push(`última sesión ${briefingWhen(last.endedAtUtc ?? last.startedAtUtc)}`);
	} else {
		// Sin resumen de sesión, el estado lo mantiene el handoff rodante (saveRollingHandoff).
		const handoff = observations.find((o) => o.topicKey === HANDOFF_TOPIC || o.type === "handoff");
		if (handoff) {
			lines.push(`último estado guardado (${briefingWhen(handoff.createdAtUtc)}):`);
			for (const line of (typeof handoff.content === "string" ? handoff.content : "").split("\n")) {
				if (line.trim()) lines.push(`  ${oneLine(line, 200)}`);
			}
			resumeBits.push(`estado guardado ${briefingWhen(handoff.createdAtUtc)}`);
		}
	}

	const decisions = observations.filter((o) => o.type === "adr" || o.type === "pattern");
	if (decisions.length > 0) {
		lines.push("decisiones y convenciones guardadas:");
		for (const decision of decisions.slice(0, 6)) {
			lines.push(`- ${oneLine(decision.title, 110)}${decision.topicKey ? ` [${decision.topicKey}]` : ""}`);
		}
		if (decisions.length > 6) lines.push(`- … y ${decisions.length - 6} más (mem_search)`);
	}

	const slug = getActiveSlug(cwd) ?? sheetWithStatusActive(cwd);
	const steps = slug ? todoSteps(cwd) : [];
	if (slug && steps.length > 0) {
		const done = steps.filter((step) => step.done).length;
		lines.push(`trabajo en curso: odd/tasks/${slug}.md (${done}/${steps.length} pasos hechos)`);
		for (const step of steps.slice(0, 6)) lines.push(`- [${step.done ? "x" : " "}] ${oneLine(step.text, 120)}`);
		if (steps.length > 6) lines.push(`- … y ${steps.length - 6} pasos más (lee la ficha)`);
		resumeBits.push(`en curso odd/tasks/${slug}.md (${done}/${steps.length})`);
	}

	if (lines.length === 0) {
		lines.push(
			"sin memoria todavía para este proyecto: al acabar trabajo sustancial guarda el handoff con `mem_session_summary` y las decisiones con `mem_save` (o construye la primera con /explore).",
		);
	} else {
		lines.push(
			`memoria del proyecto: ${observations.length} ${observations.length === 1 ? "observación" : "observaciones"} recientes (${HANNIGRAM_BASE}).`,
		);
	}

	const headline =
		resumeBits.length > 0
			? `Memoria: ${resumeBits.join(" · ")}`
			: `Memoria: ${observations.length} observaciones del proyecto`;
	return { text: lines.join("\n"), headline };
}

/**
 * Lee (una vez por sesión) el briefing de memoria del proyecto. Solo se cachea con
 * contenido: si el daemon aún no responde el siguiente turno lo reintenta, en vez de
 * dejar la sesión entera sin memoria.
 */
async function loadMemoryBriefing(cwd: string): Promise<MemoryBriefing | undefined> {
	if (briefing?.cwd === cwd) return briefing.value;
	const value = await fetchMemoryBriefing(cwd);
	if (value !== undefined) briefing = { cwd, value };
	return value;
}

/** Descarta el briefing cacheado (cambio de sesión o /skipmemory): el siguiente turno lo relee. */
function invalidateMemoryBriefing(): void {
	briefing = undefined;
}

// ---------------------------------------------------------------------------
// Handoff rodante: "en qué estaba", sin depender de que el agente se acuerde de
// guardarlo. Si un turno deja trabajo (cambios en el árbol o ficha sODD activa) y
// no se guardó un resumen de sesión, se actualiza UNA observación del proyecto
// (topic handoff/actual). Así cerrar la terminal no deja la próxima sesión —quizá
// días después— sin punto de partida.
// ---------------------------------------------------------------------------

interface SessionWork {
	/** Primera petición de la sesión: el objetivo del handoff. */
	goal?: string;
}

const sessionWork: SessionWork = {};
/** El agente ya guardó un mem_session_summary: el handoff rodante sobra. */
let handoffSuperseded = false;

async function saveRollingHandoff(cwd: string): Promise<void> {
	const slug = soddIndicator(cwd)?.slug;
	const files = visibleWorktreeFiles(cwd, modifiedFilesCache.get(cwd) ?? []);
	// Sin objetivo no hay sesion que retomar (solo se leyo o se pregunto): no se escribe nada, para no
	// llenar la memoria de handoffs vacios.
	if (!sessionWork.goal) return;
	// Sin trabajo, no hay nada que contar: el turno fue una pregunta o una lectura.
	if (!slug && files.length === 0) return;

	const steps = slug ? todoSteps(cwd) : [];
	const pending = steps.filter((step) => !step.done);
	const commit = existsSync(join(cwd, ".git")) ? oneLine(lastCommit(cwd), 160) : "(sin repositorio git)";
	const lines = [
		`objetivo: ${oneLine(sessionWork.goal, 200)}`,
		`hecho: ${commit || "(sin commits en esta sesión)"}`,
		files.length > 0 ? `ficheros: ${files.slice(0, 8).join(", ")}` : "ficheros: (árbol sin cambios)",
		slug
			? `en curso: odd/tasks/${slug}.md (${steps.filter((step) => step.done).length}/${steps.length} pasos)`
			: "en curso: (sin ficha sODD activa)",
		pending.length > 0
			? `siguiente: ${pending
					.slice(0, 3)
					.map((step) => oneLine(step.text, 80))
					.join(" | ")}`
			: "siguiente: revisar los cambios pendientes",
	];

	await hannigram(`/api/observations?${new URLSearchParams({ cwd })}`, {
		method: "POST",
		body: JSON.stringify({
			title: `handoff: ${projectName(cwd)}`,
			content: lines.join("\n"),
			topicKey: HANDOFF_TOPIC,
			type: "handoff",
		}),
	});
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

const modifiedFilesCache = new Map<string, string[]>();
const modifiedFilesRefresh = new Map<string, Promise<void>>();

/** Cache del estado de la memoria HanniGram (daemon arriba/abajo). */
let memoryCache: { up: boolean; checked: boolean; skipped: boolean } = {
	up: false,
	checked: false,
	skipped: false,
};

function clip(s: string, n: number): string {
	return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Envuelve el texto en líneas de `width` columnas (corte por palabras) con un máximo de
 * `maxLines`; si no cabe, la última línea termina en "…". Así una tarea larga se lee entera
 * en varias líneas en vez de recortarse a una sola.
 */
function wrapLines(text: string, width: number, maxLines: number): string[] {
	const limit = Math.max(4, width);
	const words = text.split(/\s+/).filter(Boolean);
	const all: string[] = [];
	let current = "";
	for (const word of words) {
		let candidate = current ? `${current} ${word}` : word;
		if (candidate.length <= limit) {
			current = candidate;
			continue;
		}
		if (current) {
			all.push(current);
			candidate = word;
		}
		// Palabra sola más larga que la columna (una URL, un hash): se parte.
		while (candidate.length > limit) {
			all.push(candidate.slice(0, limit));
			candidate = candidate.slice(limit);
		}
		current = candidate;
	}
	if (current) all.push(current);
	if (all.length === 0) return [""];
	if (all.length <= maxLines) return all;
	const kept = all.slice(0, maxLines);
	kept[maxLines - 1] = clip(kept[maxLines - 1]!, limit);
	return kept;
}

/** Patrones `extensions` de los ajustes vigentes; los expone el factory desde `pi.getSettings()`. */
let readExtensionOverrides: () => string[] = () => [];

/** Ajustes efectivos (incluye compactación); los expone el factory desde `pi.getSettings()`. */
let readSettings: () => Settings | undefined = () => undefined;

/**
 * HanniGram está omitido (`/skipmemory`): ni briefing, ni `mem_*`, ni daemon. Va contra los ajustes
 * vivos (no contra una copia), así que el comando surte efecto en el acto y persiste entre sesiones.
 */
function memorySkipped(): boolean {
	return readSettings()?.skipMemory === true;
}

/** Margen con el que se avisa de que la compactación está cerca (tokens y puntos porcentuales). */
const COMPACT_NEAR_TOKENS = 20_000;
const COMPACT_NEAR_PERCENT = 8;

/**
 * Último contexto de extensión visto (el `ctx` de los eventos): el uso de contexto solo está ahí,
 * no en el `ui` del widget, así que el rail lo recuerda en cada evento de sesión/turno/tool.
 */
let latestContext: ExtensionContext | undefined;

/** Recuerda el contexto del evento para que el rail pueda leer el uso de contexto. */
function trackContext(ctx: ExtensionContext): void {
	latestContext = ctx;
}

/**
 * Aviso de compactación: cuánto contexto queda y a qué umbral se dispara sola.
 * El umbral es el mismo del motor: `contextWindow - reserveTokens` (16k por defecto).
 * No lleva cabecera propia: el título del panel del rail ya dice "contexto".
 */
export function contextRailLines(theme: ExtensionUIContext["theme"], width: number): string[] {
	// El `ctx` de los tests (y de algunos modos) puede no traer el uso de contexto: sin él, no se pinta.
	const readUsage = latestContext?.getContextUsage;
	const usage = typeof readUsage === "function" ? latestContext?.getContextUsage() : undefined;
	if (!usage) return [];
	const compaction = readSettings()?.compaction;
	const autoEnabled = compaction?.enabled !== false;
	const reserve = compaction?.reserveTokens ?? 16_384;
	const window = usage.contextWindow;
	const thresholdTokens = Math.max(0, window - reserve);
	const thresholdPercent = window > 0 ? (thresholdTokens / window) * 100 : 0;

	const lines: string[] = [];
	if (usage.tokens === null) {
		lines.push(theme.fg("muted", clip("— se estima tras la próxima respuesta", width)));
		return lines;
	}
	const tokens = usage.tokens;
	const percent = usage.percent ?? (window > 0 ? (tokens / window) * 100 : 0);
	const usageText = `${percent.toFixed(0)}% (${formatTokensShort(tokens)}/${formatTokensShort(window)})`;
	const reached = autoEnabled && tokens > thresholdTokens;
	const near =
		autoEnabled &&
		!reached &&
		(tokens >= thresholdTokens - COMPACT_NEAR_TOKENS || percent >= thresholdPercent - COMPACT_NEAR_PERCENT);
	lines.push(theme.fg(reached ? "error" : near ? "warning" : "text", clip(usageText, width)));

	if (!autoEnabled) {
		lines.push(theme.fg("warning", clip("auto-compact off", width)));
	} else if (reached) {
		lines.push(theme.fg("error", clip("compactación inminente", width)));
	} else if (near) {
		lines.push(theme.fg("warning", clip(`▸ compacta a ${formatTokensShort(thresholdTokens)}`, width)));
	} else {
		lines.push(theme.fg("muted", clip(`compacta a ${thresholdPercent.toFixed(0)}%`, width)));
	}
	return lines;
}

/** `148000` → `148k` (el rail no tiene sitio para más detalle). */
function formatTokensShort(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * ¿Sigue activada la extensión built-in `id`? Misma semántica que el resource loader para los casos
 * documentados: `-builtin:<id>` y `!builtin:<id>` la desactivan, `+builtin:<id>` la fuerza.
 */
export function builtinExtensionEnabled(patterns: readonly string[], id: string): boolean {
	const target = `builtin:${id}`;
	let enabled = true;
	for (const raw of patterns) {
		const pattern = raw.trim();
		if (pattern === `-${target}` || pattern === `!${target}`) enabled = false;
		else if (pattern === `+${target}`) enabled = true;
	}
	return enabled;
}

/** Presentación (icono, color y etiqueta) de un estado MCP. */
function mcpStatePresentation(state: string): {
	icon: string;
	color: "success" | "warning" | "error" | "muted";
	label: string;
} {
	switch (state) {
		case "connected":
			return { icon: "✓", color: "success", label: "conectado" };
		case "connecting":
		case "starting":
			return { icon: "◌", color: "muted", label: "conectando" };
		case "needs-auth":
			return { icon: "!", color: "warning", label: "login pendiente" };
		case "failed":
		case "closed":
			return { icon: "✗", color: "error", label: "caído" };
		case "disabled":
			return { icon: "·", color: "muted", label: "desactivado" };
		default:
			return { icon: "·", color: "muted", label: "sin conectar" };
	}
}

/**
 * Servidores MCP a pintar: los configurados en `mcp.json` (global + proyecto) con su estado vivo si
 * la extensión MCP los ha conectado, más los que haya registrado una extensión sin estar en el JSON.
 */
export function mcpRailServers(cwd: string): Array<{ name: string; state: string }> {
	const live = new Map(getMcpConnectionStatuses().map((status) => [status.name, status.state as string]));
	const seen = new Set<string>();
	const out: Array<{ name: string; state: string }> = [];
	for (const server of loadMcpConfig({ agentDir: getAgentDir(), cwd, projectTrusted: false }).servers) {
		const state = live.get(server.name) ?? (server.config.enabled === false ? "disabled" : "unavailable");
		out.push({ name: server.name, state });
		seen.add(server.name);
	}
	for (const [name, state] of live) {
		if (!seen.has(name)) out.push({ name, state });
	}
	return out;
}

/** Un servicio que el harness tiene escuchando en un puerto: qué es y en qué puerto. */
export interface RailService {
	name: string;
	port: number;
	/** Para qué lo usa el harness: "memoria", "MCP"… */
	kind: string;
}

/** Puerto explícito de una URL (`http://host:8765`); sin puerto en la URL no hay puerto que enseñar. */
function explicitPort(raw: string): number | undefined {
	try {
		const url = new URL(raw);
		if (!url.port) return undefined;
		const port = Number(url.port);
		return Number.isInteger(port) && port > 0 ? port : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Puertos que el harness tiene abiertos ahora mismo: el daemon de memoria HanniGram (si está
 * arriba) y los servidores MCP por HTTP conectados (el puerto sale de su URL en `mcp.json`).
 * Es información de lo activo: un servicio caído no se pinta como si siguiera escuchando.
 */
export function railServices(cwd: string): RailService[] {
	const out: RailService[] = [];
	if (memoryCache.up && !memoryCache.skipped) {
		const port = explicitPort(HANNIGRAM_BASE);
		if (port !== undefined) out.push({ name: "HanniGram", port, kind: "memoria" });
	}
	const live = new Map(getMcpConnectionStatuses().map((status) => [status.name, status.state as string]));
	for (const server of loadMcpConfig({ agentDir: getAgentDir(), cwd, projectTrusted: false }).servers) {
		if (!("url" in server.config) || live.get(server.name) !== "connected") continue;
		const port = explicitPort(server.config.url);
		if (port === undefined) continue;
		out.push({ name: server.name, port, kind: "MCP" });
	}
	return out.sort((a, b) => a.port - b.port);
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

/** Consulta el daemon HanniGram (health) y refresca la cache. */ async function checkMemory(): Promise<void> {
	if (memorySkipped()) {
		// Omitida a propósito: no se pregunta al daemon ni se pinta como caído.
		memoryCache = { up: false, checked: true, skipped: true };
		return;
	}
	try {
		const health = await hannigram<{ status?: string }>("/health");
		memoryCache = { up: health?.status === "ok", checked: true, skipped: false };
	} catch {
		memoryCache = { up: false, checked: true, skipped: false };
	}
}

/** Estado de la memoria de la sesión: si se añadió algo, se borró, o quedó igual. */ function memoryDelta(): {
	label: string;
	color: "muted" | "success" | "error" | "warning";
} {
	const added = memActivity.some((m) => m.op === "add");
	const deleted = memActivity.some((m) => m.op === "del");
	if (added && deleted) return { label: "nuevo + borrado", color: "warning" };
	if (added) return { label: "nuevo", color: "success" };
	if (deleted) return { label: "borrado", color: "error" };
	return { label: "igual", color: "muted" };
}

/** De dónde sale cada tarea que pinta el panel `tareas` del rail. */
export type TaskSource = "todo" | "sheet" | "db";

/** Icono por origen: `≡` lista del turno, `▤` ficha del proyecto, `⛁` HanniGram. */
const TASK_SOURCE_ICON: Record<TaskSource, string> = { todo: "≡", sheet: "▤", db: "⛁" };

/** Una tarea del panel: lo que se pinta más su origen. */
export interface RailTask {
	done: boolean;
	text: string;
	current: boolean;
	source: TaskSource;
}

/** Pasos de las fichas espejadas en HanniGram, por slug (`odd/<slug>/tasks`). */
const memoryBoards = new Map<string, Array<{ done: boolean; text: string }>>();

/**
 * `slug → pasos` a partir de las observaciones del espejo (`odd/<slug>/tasks`). Pura: se testea sin
 * daemon. Las observaciones que no son de una ficha (otro topic, sin contenido, sin pasos) se ignoran.
 */
export function parseMemoryBoards(
	observations: ReadonlyArray<Pick<DumpObservation, "topicKey" | "content">>,
): Map<string, Array<{ done: boolean; text: string }>> {
	const boards = new Map<string, Array<{ done: boolean; text: string }>>();
	for (const obs of observations) {
		const slug = obs.topicKey?.match(/^odd\/(.+)\/tasks$/)?.[1];
		if (!slug || typeof obs.content !== "string") continue;
		const lines = obs.content.split("\n");
		const pasos = collectTodos(lines, true);
		const steps = pasos.length > 0 ? pasos : collectTodos(lines, false);
		if (steps.length > 0) boards.set(slug, steps);
	}
	return boards;
}

/**
 * Refresca el espejo de las fichas en HanniGram: una lectura de la BD por sesión (el rail se pinta
 * de forma síncrona, así que no puede consultar la BD en cada frame). Con `/skipmemory` no se toca nada.
 */
async function refreshMemoryBoards(cwd: string): Promise<void> {
	if (memorySkipped()) return;
	const observations = await hannigram<DumpObservation[]>(
		`/api/observations?${new URLSearchParams({ cwd, limit: "200" })}`,
	);
	memoryBoards.clear();
	if (!observations) return;
	for (const [slug, steps] of parseMemoryBoards(observations)) memoryBoards.set(slug, steps);
}

/**
 * Tareas del rail, con su origen: la lista del harness (`todo`), los pasos de la ficha `odd/tasks` o,
 * si no hay ficha local, el espejo que la BD guardó con ese slug (otro worktree, clon limpio).
 */
function railTodos(cwd: string): RailTask[] {
	if (harnessTodos.length > 0) {
		const hasInProgress = harnessTodos.some((t) => t.status === "in_progress");
		const firstPending = harnessTodos.findIndex((t) => t.status === "pending");
		return harnessTodos.map((t, i) => ({
			done: t.status === "completed",
			text: t.text,
			current: t.status === "in_progress" || (!hasInProgress && i === firstPending),
			source: "todo",
		}));
	}
	const steps = todoSteps(cwd);
	const localCurrent = steps.findIndex((t) => !t.done);
	if (steps.length > 0) {
		return steps.map((t, i) => ({ ...t, current: i === localCurrent, source: "sheet" }));
	}
	const slug = getActiveSlug(cwd);
	const mirrored = slug ? memoryBoards.get(slug) : undefined;
	if (!mirrored || mirrored.length === 0) return [];
	const dbCurrent = mirrored.findIndex((t) => !t.done);
	return mirrored.map((t, i) => ({ ...t, current: i === dbCurrent, source: "db" }));
}

/** Una sección del rail: el título vive en el borde del panel y estas líneas dentro. */
interface RailSection {
	title: string;
	lines: string[];
}

/**
 * Nombre del skill al que pertenece un fichero leído, o `undefined` si esa lectura no es un skill.
 * Solo cuentan las rutas del catálogo del system prompt (así una ficha `odd/tasks/x.md` no se toma
 * por un skill) y, si el catálogo aún no llegó, la convención `<dir>/SKILL.md`.
 */
function skillFromRead(path: string): string | undefined {
	const normalized = normalizeSkillPath(path);
	const known = sessionSkills.find((skill) => normalizeSkillPath(skill.filePath) === normalized);
	if (known) return known.name;
	const parts = normalized.split("/");
	if (parts[parts.length - 1] !== "skill.md") return undefined;
	return parts[parts.length - 2];
}

/** Rutas comparables en Windows (barras y mayúsculas dan igual). */
function normalizeSkillPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

/** Marca un skill como en uso en el run actual. Devuelve `true` si el rail cambia. */
function markSkillUsed(name: string): boolean {
	const previous = skillUses.get(name);
	skillUses.set(name, { name, state: "using", seq: previous?.seq ?? ++skillSeq });
	return previous?.state !== "using";
}

/** Un prompt nuevo (o el final del run) cierra el ciclo: "en uso" pasa a "activado". */
function deactivateSkillsInUse(): boolean {
	let changed = false;
	for (const use of skillUses.values()) {
		if (use.state !== "using") continue;
		use.state = "activated";
		changed = true;
	}
	return changed;
}

/** Líneas del panel `skills`: en uso primero (`▸`) y luego los ya activados (`✓`). */
function skillRailLines(theme: ExtensionUIContext["theme"], width: number): string[] {
	const uses = [...skillUses.values()].sort((a, b) =>
		a.state === b.state ? b.seq - a.seq : a.state === "using" ? -1 : 1,
	);
	const lines: string[] = [];
	for (const use of uses.slice(0, MAX_RAIL_SKILLS)) {
		const icon = use.state === "using" ? theme.fg("warning", "▸") : theme.fg("success", "✓");
		const state = use.state === "using" ? theme.fg("warning", "en uso") : theme.fg("muted", "activado");
		lines.push(`${icon} ${clip(use.name, Math.max(8, width - 13))} · ${state}`);
	}
	if (uses.length > MAX_RAIL_SKILLS) lines.push(theme.fg("muted", `… +${uses.length - MAX_RAIL_SKILLS}`));
	return lines;
}

/**
 * Secciones del rail derecho (coloreadas con el tema vivo vía ui.theme) al ancho de contenido dado.
 * Cada sección es un panel propio: el rail deja de ser una lista corrida de bloques y cada concepto
 * (proyecto, memoria, contexto, sODD, tareas, MCP, cambios) se lee como una tarjeta.
 */
function railSections(ui: ExtensionUIContext, cwd: string, width: number = RAIL_WIDTH): RailSection[] {
	const theme = ui.theme;
	const W = Math.max(16, width);
	const sections: RailSection[] = [];

	// Proyecto
	sections.push({
		title: "proyecto",
		lines: [
			theme.bold(theme.fg("text", clip(projectName(cwd), W))),
			theme.fg("dim", `rama ${clip(currentBranch(cwd), W - 5)}`),
		],
	});

	// Goal: el objetivo que se está ejecutando y, si hay bucle, por dónde va. Va justo debajo de
	// proyecto porque es la intención de la sesión; los pasos concretos viven en `tareas`.
	const goal = activeGoal(cwd);
	if (goal) {
		const goalLines: string[] = wrapLines(goal.sheet.goal ?? "", W - 2, 2).map((line) => theme.fg("text", line));
		const stateBits = [
			goal.sheet.autonomy === "guarded" ? theme.fg("success", "guarded") : theme.fg("muted", "off"),
			`${goal.done}/${goal.total} pasos`,
		];
		goalLines.push(theme.fg("muted", stateBits.join(" · ")));
		if (autoRun) {
			const tokens = sessionTokens - autoRun.tokensAtStart;
			goalLines.push(
				`${theme.fg("warning", `auto ${autoRun.stepsRun}/${autoRun.maxSteps}`)} ${theme.fg("muted", `· ${formatTokensShort(tokens)}/${formatTokensShort(autoRun.maxTokens)} tok · idle ${autoRun.idle}/${autoRun.maxIdle}`)}`,
			);
		}
		sections.push({ title: "goal", lines: goalLines });
	}

	// Tareas — lo primero que se ve (justo debajo de proyecto): es el trabajo en curso, y con los
	// paneles por concepto el rail ya no cabe entero, así que lo importante tiene que ir arriba (el
	// rail muestra el principio; ver `follow` en renderRail). Las define el harness (tool `todo`) para
	// el turno actual; si no, se muestran los pasos de la ficha sODD. La que está "en curso" va con ▸.
	// Se pliegan con la tecla del rail o /hanniorq tasks.
	const todos = railTodos(cwd);
	if (todos.length > 0) {
		const doneTodos = todos.filter((t) => t.done).length;
		const taskLines: string[] = [];
		if (ui.getRailTasksCollapsed()) {
			taskLines.push(theme.fg("muted", `plegadas · ${RAIL_TASKS_KEY}`));
		} else {
			todos.slice(0, MAX_RAIL_TODOS).forEach((t) => {
				const mark = t.done
					? theme.fg("success", "✓")
					: t.current
						? theme.fg("warning", "▸")
						: theme.fg("muted", "·");
				// Origen de la tarea: ≡ lista del turno · ▤ ficha odd/tasks del proyecto · ⛁ HanniGram.
				const origin = theme.fg("dim", TASK_SOURCE_ICON[t.source]);
				wrapLines(t.text, W - 4, MAX_TODO_LINES).forEach((line, index) => {
					taskLines.push(`${index === 0 ? `${origin} ${mark} ` : "    "}${line}`);
				});
			});
			if (todos.length > MAX_RAIL_TODOS) {
				taskLines.push(theme.fg("muted", `… +${todos.length - MAX_RAIL_TODOS}`));
			}
		}
		sections.push({ title: `tareas (${doneTodos}/${todos.length})`, lines: taskLines });
	}

	// Skills: qué skills usa la sesión y en qué estado — `en uso` mientras el run en curso los está
	// usando (el modelo al leer su fichero, o el usuario con `/skill:<nombre>`), `activado` cuando ya
	// se cargaron antes. Va arriba, junto a las tareas, porque es "qué está haciendo ahora mismo".
	// Sin skills usados no se pinta: el panel informa, no recuerda que existen.
	if (skillUses.size > 0) {
		const total = sessionSkills.length > 0 ? `/${sessionSkills.length}` : "";
		sections.push({ title: `skills (${skillUses.size}${total})`, lines: skillRailLines(theme, W) });
	}

	// Memoria HanniGram: ON/OFF + si en la sesión se añadió o borró algo.
	const memoryLines: string[] = [];
	if (memoryCache.skipped) {
		memoryLines.push(
			`${theme.fg("warning", "⏭")} ${theme.fg("text", "omitida")} · ${theme.fg("muted", "/skipmemory off")}`,
		);
	} else if (!memoryCache.checked) {
		memoryLines.push(theme.fg("muted", "comprobando…"));
	} else if (memoryCache.up) {
		const delta = memoryDelta();
		memoryLines.push(`${theme.fg("success", "✓")} ${theme.fg("text", "ON")} · ${theme.fg(delta.color, delta.label)}`);
	} else {
		memoryLines.push(`${theme.fg("error", "✗")} ${theme.fg("text", "OFF")} (daemon caído)`);
	}
	// Actividad de la sesión: qué se leyó (≫) o guardó (✎) en la memoria.
	for (const m of memActivity.slice(-4).reverse()) {
		const icon = m.kind === "write" ? theme.fg("success", "✎") : theme.fg("muted", "≫");
		memoryLines.push(`${icon} ${clip(m.detail, W - 4)}`);
	}
	sections.push({ title: "memoria", lines: memoryLines });

	// Servicios: qué tiene abierto el harness y en qué puerto (daemon de memoria, MCP por HTTP).
	// Solo aparece con algo escuchando: el panel informa de lo activo, no de lo que podría estarlo.
	const services = railServices(cwd);
	if (services.length > 0) {
		const serviceLines = services.map((service) => {
			const portText = `:${service.port}`;
			const tail = `${portText} · ${service.kind}`;
			const name = clip(service.name, Math.max(8, W - 3 - tail.length));
			return `${theme.fg("success", "●")} ${name} ${theme.fg("accent", portText)} · ${theme.fg("muted", service.kind)}`;
		});
		sections.push({ title: `servicios (${services.length})`, lines: serviceLines });
	}

	// Contexto y compactación: cuánto queda y cuándo se dispara sola.
	const contextLines = contextRailLines(theme, W);
	if (contextLines.length > 0) sections.push({ title: "contexto", lines: contextLines });

	// sODD: solo si hay ficha. Sin ficha (p.ej. una pregunta trivial del código) no aplica y no se
	// pinta nada, en vez de un "inactivo" que no significa nada.
	const ind = soddIndicator(cwd);
	if (ind) {
		const state = soddWorking ? theme.fg("warning", "working") : theme.fg("muted", "not working");
		sections.push({
			title: "sODD",
			lines: [
				`${theme.fg("success", "●")} activo · ${state}`,
				theme.fg("muted", `${clip(ind.slug, 16)} (${ind.done}/${ind.total})`),
			],
		});
	}

	// MCP: siempre se pinta algo útil. Los estados vivos los publica la extensión MCP; si no corre
	// (desactivada o aún sin conectar) se muestran los servidores del mcp.json. Así el rail explica
	// por qué no hay nada, en vez de desaparecer en silencio.
	const mcpServers = mcpRailServers(cwd);
	const mcpEnabled = builtinExtensionEnabled(readExtensionOverrides(), "mcp");
	const mcpLines: string[] = [];
	if (mcpServers.length === 0) {
		mcpLines.push(theme.fg("muted", mcpEnabled ? "sin servidores" : "desactivado (-builtin:mcp)"));
		if (mcpEnabled) mcpLines.push(theme.fg("dim", clip("hanni mcp add <nombre>", W - 2)));
	} else {
		if (!mcpEnabled) mcpLines.push(theme.fg("warning", "built-in mcp desactivado"));
		for (const server of mcpServers.slice(0, 6)) {
			const presented = mcpStatePresentation(server.state);
			mcpLines.push(
				`${theme.fg(presented.color, presented.icon)} ${clip(server.name, W - 16)} ${theme.fg("muted", clip(presented.label, W - 8))}`,
			);
		}
		if (mcpServers.length > 6) mcpLines.push(theme.fg("muted", `… +${mcpServers.length - 6} MCP`));
	}
	sections.push({ title: "MCP", lines: mcpLines });

	// Cambios: compacto (máx. 3 rutas) para que no se acumule y empuje al resto.
	const files = visibleWorktreeFiles(cwd, modifiedFilesCache.get(cwd) ?? []);
	const changeLines: string[] = [];
	for (const file of files.slice(0, 3)) changeLines.push(`${theme.fg("muted", "·")} ${clip(file, W - 2)}`);
	if (files.length > 3) changeLines.push(theme.fg("muted", `… +${files.length - 3}`));
	if (changeLines.length === 0) changeLines.push(theme.fg("muted", "sin cambios"));
	sections.push({ title: `cambios (${files.length})`, lines: changeLines });

	return sections;
}

/** Ancho que los bordes y el padding de cada panel le quitan al rail (2 bordes + 1 de padding por lado). */
const RAIL_PANEL_CHROME = 4;

/**
 * Componente del rail: apila un panel por sección. Rehace el árbol cuando cambia el ancho (las tareas
 * se envuelven al ancho real) o cuando el harness lo invalida por contenido nuevo.
 */
class RailContent implements Component {
	private readonly build: (contentWidth: number) => RailSection[];
	private readonly getTheme: () => ExtensionUIContext["theme"];
	private readonly minWidth: number;
	private builtWidth = -1;
	private dirty = true;
	private stack: VStack = new VStack([]);

	constructor(
		build: (contentWidth: number) => RailSection[],
		getTheme: () => ExtensionUIContext["theme"],
		minWidth = 16,
	) {
		this.build = build;
		this.getTheme = getTheme;
		this.minWidth = minWidth;
	}

	invalidate(): void {
		this.dirty = true;
	}

	render(width: number): string[] {
		const contentWidth = Math.max(this.minWidth, width - RAIL_PANEL_CHROME);
		if (this.dirty || contentWidth !== this.builtWidth) {
			this.builtWidth = contentWidth;
			this.dirty = false;
			this.stack = this.buildStack(contentWidth);
		}
		return this.stack.render(Math.max(1, width));
	}

	private buildStack(contentWidth: number): VStack {
		const theme = this.getTheme();
		const children: StackChild[] = [];
		for (const section of this.build(contentWidth)) {
			if (children.length > 0) children.push({ component: new Spacer(1) });
			children.push({
				component: new Panel(new Text(section.lines.join("\n"), 0, 0), {
					title: theme.fg("accent", section.title),
					borderColor: (text) => theme.fg("borderMuted", text),
				}),
			});
		}
		return new VStack(children);
	}
}

/** Widget del rail por instancia de ui (WeakMap): persiste el scroll entre refrescos sin
 *  contaminar otras sesiones (p.ej. un refresco asíncrono diferido de otra ui). */
interface RailWidget {
	cwd: string;
	content: RailContent;
	scroll: ScrollView;
}
const railWidgets = new WeakMap<ExtensionUIContext, RailWidget>();

/** Renderiza el rail derecho (widget "hanniorq-rail", placement rightRail). */
function renderRail(ui: ExtensionUIContext, cwd: string): void {
	// El componente del rail se crea una vez por (ui, cwd): si `setWidget` recreara el widget en
	// cada refresco (memoria, MCP, git…), el ScrollView reiniciaría su posición de scroll.
	let widget = railWidgets.get(ui);
	if (widget === undefined || widget.cwd !== cwd) {
		const content = new RailContent(
			(contentWidth) => railSections(ui, cwd, contentWidth),
			() => ui.theme,
		);
		const scroll = new ScrollView(content, {
			// Sin follow: el rail muestra su principio (proyecto + tareas). Con follow "end" el rail
			// saltaba al final en cada refresco y, al crecer el contenido (un panel por concepto, con
			// bordes), las tareas quedaban fuera de la vista.
			follow: "none",
			overscroll: "contain",
			scrollbar: "auto",
			scrollbarTrackStyle: (line) => ui.theme.fg("scrollbarTrack", line),
			scrollbarThumbStyle: (line) => ui.theme.fg("scrollbarThumb", line),
		});
		widget = { cwd, content, scroll };
		railWidgets.set(ui, widget);
		ui.setWidget(
			"hanniorq-rail",
			() => {
				return scroll;
			},
			{ placement: "rightRail" },
		);
	} else {
		// Contenido nuevo con el mismo componente: fuerza la reconstrucción en el próximo frame.
		widget.content.invalidate();
	}
}

/** Pliega/despliega los pasos sODD del rail y avisa (tecla RAIL_TASKS_KEY o /hanniorq tasks). */
function toggleRailTasks(ui: ExtensionUIContext, cwd: string): void {
	const collapsed = !ui.getRailTasksCollapsed();
	ui.setRailTasksCollapsed(collapsed);
	renderRail(ui, cwd);
	ui.notify(collapsed ? "Pasos sODD plegados en el rail." : "Pasos sODD desplegados en el rail.", "info");
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
// /extract — retrato del proyecto en .md por tipología, para que otro harness
// (sin esta conversación y sin HanniGram) trabaje sin reexplorar. El comando
// recoge los hechos baratos del disco y la redacción la hace el agente; si ya
// existen los documentos NO se toca nada: el usuario decide sobrescribir
// (--overwrite) o crear una versión nueva (--version).
// ---------------------------------------------------------------------------

/** Documentos que produce `/extract`, en orden de lectura recomendada. */
export const EXTRACT_DOCS: readonly string[] = [
	"README.md",
	"architecture.md",
	"stack.md",
	"design.md",
	"conventions.md",
];

/** Qué debe contener cada documento (se le pasa al agente tal cual). */
const EXTRACT_DOC_DESCRIPTIONS: Record<string, string> = {
	"README.md": "índice: qué es, cómo se levanta y se verifica, y tabla de qué doc leer para qué.",
	"architecture.md":
		"capas y módulos, entry points, flujos, datos, límites y deps internas (diagrama ASCII si aclara).",
	"stack.md": "tecnologías y versiones, librerías relevantes (para qué están), build/test/lint y plataformas.",
	"design.md":
		"UI: pantallas y componentes, sistema visual (color/tipografía/espaciado, dónde viven los tokens), estados vacío/carga/error y atajos. Sin UI: dilo en dos líneas.",
	"conventions.md":
		"patrones que se repiten: naming, estructura de ficheros, forma de errores/config/tests y reglas del repo que un agente debe respetar.",
};

/** Manifiestos que delatan el stack sin abrir media docena de ficheros. */
const MANIFESTS: readonly string[] = [
	"package.json",
	"pnpm-workspace.yaml",
	"tsconfig.json",
	"pyproject.toml",
	"requirements.txt",
	"Cargo.toml",
	"go.mod",
	"composer.json",
	"pubspec.yaml",
	"Gemfile",
	"pom.xml",
	"build.gradle",
];

/** Directorios que no aportan al retrato y sí cuestan tiempo. */
const FACTS_SKIP = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"out",
	"coverage",
	"target",
	"vendor",
	".venv",
	"venv",
	".next",
	".turbo",
	".cache",
	".idea",
	".vscode",
]);

/** Docs de `EXTRACT_DOCS` que ya existen en `dir` (lo que dispara el aviso de conflicto). */
export function existingDocs(dir: string, docs: readonly string[] = EXTRACT_DOCS): string[] {
	return docs.filter((doc) => existsSync(join(dir, doc)));
}

/** Nombres versionados (`architecture-v2.md`, ...) con el primer N libre: nunca pisa lo existente. */
export function versionedDocs(dir: string, docs: readonly string[] = EXTRACT_DOCS): string[] {
	const forVersion = (version: number): string[] => docs.map((doc) => `${doc.replace(/\.md$/i, "")}-v${version}.md`);
	let version = 2;
	while (forVersion(version).some((name) => existsSync(join(dir, name)))) version++;
	return forVersion(version);
}

/** Cuenta ficheros por extensión (los más comunes primero) para dar idea del tamaño del proyecto. */
function countFilesByExtension(root: string, limit: number, maxDepth = 6): Array<[string, number]> {
	const counts = new Map<string, number>();
	let seen = 0;
	const walk = (dir: string, depth: number): void => {
		if (seen >= limit || depth > maxDepth) return;
		let entries: Dirent[];
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (seen >= limit) return;
			if (entry.isDirectory()) {
				if (!FACTS_SKIP.has(entry.name)) walk(join(dir, entry.name), depth + 1);
				continue;
			}
			if (!entry.isFile()) continue;
			seen++;
			const dot = entry.name.lastIndexOf(".");
			const ext = dot > 0 ? `.${entry.name.slice(dot + 1).toLowerCase()}` : "(sin extensión)";
			counts.set(ext, (counts.get(ext) ?? 0) + 1);
		}
	};
	walk(root, 0);
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
}

/**
 * Hechos que se leen del disco (manifiestos, scripts, deps, estructura, tamaño) para que el agente no
 * gaste tokens explorando lo que ya está aquí. Determinista: sin red, sin LLM.
 */
export function projectFacts(cwd: string): string {
	const lines: string[] = [];
	let root: string[] = [];
	try {
		root = readdirSync(cwd);
	} catch {
		return "(no se pudo leer el directorio)";
	}
	const projectFiles = root.filter((name) => /\.(csproj|sln|fsproj|vbproj)$/i.test(name));
	const manifests = MANIFESTS.filter((name) => existsSync(join(cwd, name)));
	lines.push(`manifiestos: ${[...manifests, ...projectFiles].join(", ") || "ninguno"}`);
	lines.push(
		`raíz: ${
			root
				.filter((name) => !name.startsWith("."))
				.slice(0, 24)
				.join(", ") || "vacía"
		}`,
	);
	const packagesDir = join(cwd, "packages");
	if (existsSync(packagesDir)) {
		try {
			const packages = readdirSync(packagesDir).filter((name) => !name.startsWith("."));
			if (packages.length > 0) lines.push(`packages/: ${packages.slice(0, 20).join(", ")}`);
		} catch {
			/* packages/ ilegible: no aporta */
		}
	}
	const pkgPath = join(cwd, "package.json");
	if (existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
				name?: string;
				scripts?: Record<string, string>;
				dependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			lines.push(`package: ${pkg.name ?? "?"}`);
			const scripts = Object.keys(pkg.scripts ?? {});
			if (scripts.length > 0) lines.push(`scripts: ${scripts.join(", ")}`);
			const deps = Object.entries({ ...pkg.devDependencies, ...pkg.dependencies });
			if (deps.length > 0) {
				const shown = deps.slice(0, 30).map(([name, version]) => `${name}@${version}`);
				const rest = deps.length - shown.length;
				lines.push(`dependencias (${deps.length}): ${shown.join(", ")}${rest > 0 ? ` … +${rest}` : ""}`);
			}
		} catch {
			lines.push("package.json: JSON inválido, no se pudo leer");
		}
	}
	const counts = countFilesByExtension(cwd, 2000);
	if (counts.length > 0) {
		lines.push(`ficheros por extensión: ${counts.map(([ext, total]) => `${ext}:${total}`).join(", ")}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Autonomía acotada: goal en la ficha + `/hanniorq auto`.
//
// El estado de ejecución vive en el frontmatter de `odd/tasks/<slug>.md`:
//   goal, done_when, verify, autonomy, max_iterations, max_idle, max_tokens
// El bucle SOLO ejecuta pasos ya escritos en `## Pasos`: no planifica, no añade
// trabajo y no se auto-evalúa. Si un paso no deja rastro (commit o [x]), cuenta
// como iteración sin progreso y para.
// ---------------------------------------------------------------------------

/** Límites duros de una ejecución desatendida. */
export interface GoalLimits {
	/** Techo de pasos por invocación (`max_iterations`). */
	maxIterations?: number;
	/** Iteraciones seguidas sin commit nuevo ni paso marcado (por defecto 1). */
	maxIdle: number;
	/** Tokens que puede gastar la invocación entera (por defecto 200k). */
	maxTokens: number;
}

/** Lo que la ficha declara sobre el objetivo que se está ejecutando. */
export interface GoalSheet {
	goal?: string;
	doneWhen: string[];
	verify: string[];
	autonomy: "off" | "guarded";
	limits: GoalLimits;
}

/** Pasos por defecto de una invocación de `/hanniorq auto`. */
const AUTO_DEFAULT_STEPS = 3;
/** Techo absoluto de pasos por invocación, pase lo que pase en la ficha. */
const AUTO_MAX_STEPS = 10;
const AUTO_DEFAULT_MAX_TOKENS = 200_000;
const AUTO_DEFAULT_MAX_IDLE = 1;

/** Texto sin comillas (JSON o simples) o tal cual. */
function unquoteScalar(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			return String(JSON.parse(trimmed));
		} catch {
			return trimmed.slice(1, -1);
		}
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}

/**
 * Frontmatter de la ficha como pares clave → escalar o lista. Subconjunto de YAML a propósito: claves
 * planas, `clave: valor`, `clave: [a, b]` y listas de bloque (`- item`). Cualquier otra línea se ignora.
 */
export function parseFrontmatter(text: string): Map<string, string | string[]> {
	const fields = new Map<string, string | string[]>();
	const lines = text.split("\n");
	if (lines[0]?.trim() !== "---") return fields;
	let current: string | undefined;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (line.trim() === "---") break;
		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && current) {
			const list = fields.get(current);
			if (Array.isArray(list)) list.push(unquoteScalar(item[1] ?? ""));
			continue;
		}
		const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const key = pair[1] ?? "";
		const rest = (pair[2] ?? "").trim();
		current = key;
		if (rest === "") {
			fields.set(key, []);
			continue;
		}
		if (rest.startsWith("[") && rest.endsWith("]")) {
			const inner = rest.slice(1, -1).trim();
			fields.set(key, inner === "" ? [] : inner.split(",").map(unquoteScalar));
			continue;
		}
		fields.set(key, unquoteScalar(rest));
	}
	return fields;
}

/** Una clave del frontmatter como texto ("" si no está). */
function frontmatterScalar(fields: Map<string, string | string[]>, key: string): string {
	const value = fields.get(key);
	if (typeof value === "string") return value.trim();
	return Array.isArray(value) && value.length > 0 ? (value[0] ?? "").trim() : "";
}

/** Una clave del frontmatter como lista (vacía si no está o está vacía). */
function frontmatterList(fields: Map<string, string | string[]>, key: string): string[] {
	const value = fields.get(key);
	const list = Array.isArray(value) ? value : typeof value === "string" && value.trim() !== "" ? [value] : [];
	return list.map((item) => item.trim()).filter((item) => item !== "");
}

/** Lee `goal`, criterios, verificación, autonomía y límites del frontmatter de la ficha. */
export function parseGoalSheet(text: string): GoalSheet {
	const fields = parseFrontmatter(text);
	const number = (key: string): number | undefined => {
		const parsed = Number.parseInt(frontmatterScalar(fields, key), 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
	};
	return {
		goal: frontmatterScalar(fields, "goal") || undefined,
		doneWhen: frontmatterList(fields, "done_when"),
		verify: frontmatterList(fields, "verify"),
		autonomy: frontmatterScalar(fields, "autonomy").toLowerCase() === "guarded" ? "guarded" : "off",
		limits: {
			maxIterations: number("max_iterations"),
			maxIdle: number("max_idle") ?? AUTO_DEFAULT_MAX_IDLE,
			maxTokens: number("max_tokens") ?? AUTO_DEFAULT_MAX_TOKENS,
		},
	};
}

/** Un valor de frontmatter: texto plano si es seguro, JSON entre comillas si no. */
function formatFrontmatterValue(value: string): string {
	return /^[A-Za-z0-9_./-][^#:\n]*$/.test(value) ? value : JSON.stringify(value);
}

/** Una clave y su valor como líneas de frontmatter. */
function renderFrontmatterField(key: string, value: string | string[]): string[] {
	if (!Array.isArray(value)) return [`${key}: ${formatFrontmatterValue(value)}`];
	if (value.length === 0) return [`${key}: []`];
	return [`${key}:`, ...value.map((item) => `  - ${formatFrontmatterValue(item)}`)];
}

/**
 * Reescribe campos del frontmatter conservando el resto del fichero (y su orden). Si la ficha no tiene
 * frontmatter, lo crea delante. Un valor `undefined` borra la clave.
 */
export function setSheetFields(text: string, fields: Record<string, string | string[] | undefined>): string {
	const lines = text.split("\n");
	let block: string[] = [];
	let rest = lines;
	if (lines[0]?.trim() === "---") {
		const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (end > 0) {
			block = lines.slice(1, end);
			rest = lines.slice(end + 1);
		}
	}
	const entries: Array<{ key?: string; lines: string[] }> = [];
	for (const line of block) {
		const pair = /^([A-Za-z0-9_-]+):/.exec(line);
		if (pair) entries.push({ key: pair[1], lines: [line] });
		else if (entries.length > 0) entries[entries.length - 1]?.lines.push(line);
		else entries.push({ lines: [line] });
	}
	for (const [key, value] of Object.entries(fields)) {
		const replacement = value === undefined ? [] : renderFrontmatterField(key, value);
		const existing = entries.find((entry) => entry.key === key);
		if (existing) {
			if (replacement.length === 0) entries.splice(entries.indexOf(existing), 1);
			else existing.lines = replacement;
			continue;
		}
		if (replacement.length > 0) entries.push({ key, lines: replacement });
	}
	return ["---", ...entries.flatMap((entry) => entry.lines), "---", ...rest].join("\n");
}

/** Un paso de `## Pasos`: id (`S1`), estado y texto. */
export interface SheetStep {
	id: string;
	done: boolean;
	text: string;
}

/** Pasos de la sección `## Pasos`, con su id y estado. Una ficha sin esa sección no tiene pasos. */
export function sheetSteps(text: string): SheetStep[] {
	const steps: SheetStep[] = [];
	let inPasos = false;
	for (const line of text.split("\n")) {
		if (line.startsWith("## ")) {
			inPasos = line.startsWith("## Pasos");
			continue;
		}
		if (!inPasos) continue;
		const match = /^-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
		if (!match) continue;
		const body = (match[2] ?? "").trim();
		steps.push({
			done: (match[1] ?? " ") !== " ",
			id: /^([A-Za-z]+\d+)\b/.exec(body)?.[1] ?? `S${steps.length + 1}`,
			text: body,
		});
	}
	return steps;
}

/** Foto de la ejecución desatendida que decide si el bucle sigue o para. */
export interface AutoProgress {
	stepsRun: number;
	maxSteps: number;
	idle: number;
	maxIdle: number;
	tokens: number;
	maxTokens: number;
	pending: number;
}

/**
 * Decide el siguiente movimiento del bucle y por qué. Pura (sin sesión ni daemon) para poder testear el
 * orden de las guardas: plan terminado > pasos de la invocación > sin progreso > presupuesto.
 */
export function autoOutcome(progress: AutoProgress): { stop: boolean; reason: string } {
	if (progress.pending === 0) return { stop: true, reason: "plan terminado: no quedan pasos pendientes" };
	if (progress.stepsRun >= progress.maxSteps) {
		return { stop: true, reason: `hecho: ${progress.stepsRun} de ${progress.maxSteps} pasos de esta invocación` };
	}
	if (progress.idle >= progress.maxIdle) {
		const times = progress.idle === 1 ? "iteración" : "iteraciones";
		return { stop: true, reason: `sin progreso en ${progress.idle} ${times} (ni commit ni paso marcado)` };
	}
	if (progress.tokens >= progress.maxTokens) {
		return {
			stop: true,
			reason: `presupuesto agotado (${formatTokensShort(progress.tokens)}/${formatTokensShort(progress.maxTokens)} tok)`,
		};
	}
	return { stop: false, reason: "" };
}

/** Ejecución desatendida en curso (una por sesión). */
interface AutoRun {
	slug: string;
	maxSteps: number;
	stepsRun: number;
	idle: number;
	tokensAtStart: number;
	maxTokens: number;
	maxIdle: number;
	lastSha: string;
	lastDone: number;
	goal?: string;
}

let autoRun: AutoRun | undefined;
/** El siguiente `before_agent_start` es nuestro, no del usuario (para no cancelar el bucle). */
let autoSending = false;
/** El último turno se abortó (Esc): el bucle no debe reenviarse. */
let autoAborted = false;
/** Tokens acumulados en la sesión (todas las respuestas del modelo). */
let sessionTokens = 0;

/** Tokens de una respuesta del modelo (input + output + caché). */
function usageTokens(usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }): number {
	return (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** Ficha activa con su goal (para el rail y para `status`). */
function activeGoal(cwd: string): { sheet: GoalSheet; slug: string; done: number; total: number } | undefined {
	const slug = getActiveSlug(cwd);
	const path = getActiveTaskPath(cwd);
	if (!slug || !path || !existsSync(path)) return undefined;
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	const sheet = parseGoalSheet(text);
	if (!sheet.goal) return undefined;
	const steps = sheetSteps(text);
	return { sheet, slug, done: steps.filter((step) => step.done).length, total: steps.length };
}

/** Prompt del paso que toca: autocontenido y con las reglas de la ejecución desatendida. */
function autoPrompt(options: {
	slug: string;
	sheet: GoalSheet;
	step: SheetStep;
	iteration: number;
	maxSteps: number;
	tokensLeft: number;
}): string {
	const { slug, sheet, step, iteration, maxSteps, tokensLeft } = options;
	const stepVerify = /verify:\s*([^)]+)/.exec(step.text)?.[1]?.trim();
	const verify = stepVerify ?? sheet.verify[0] ?? "la que corresponda al paso (proporcionada, sin ceremonia)";
	return [
		`[hanniorq auto · iteración ${iteration}/${maxSteps}] Ejecuta SOLO el siguiente paso pendiente de la ficha \`odd/tasks/${slug}.md\`: «${step.text}».`,
		"",
		"Reglas de esta ejecución desatendida:",
		`1. Implementa el paso. Nada de trabajo extra, nada de reescribir el plan ni de reordenar pasos.`,
		`2. Verifica con \`${verify}\`. Si falla, arréglalo (máximo 2 intentos).`,
		"3. Commit atómico siguiendo la convención del repo.",
		`4. En la ficha: marca \`- [x] ${step.id} … — <sha7>\` y reescribe \`## Siguiente\` con el paso siguiente exacto.`,
		"5. Si el paso no es ejecutable, el verify sigue fallando o hay que decidir algo de diseño: PARA, no lo inventes y explica el bloqueo en dos líneas.",
		"",
		`Objetivo: ${sheet.goal ?? "(sin goal en la ficha)"}. Presupuesto restante de esta invocación: ${formatTokensShort(tokensLeft)} tok.`,
	].join("\n");
}

/** Para el bucle y deja el goal abierto (la ficha sigue en `active`). */
function cancelAuto(ui: ExtensionUIContext, cwd: string, reason: string): void {
	const run = autoRun;
	autoRun = undefined;
	autoSending = false;
	if (!run) return;
	const finished = /^(hecho|plan terminado)/.test(reason);
	const next = finished
		? "\nSi el plan está terminado: revisa `done_when`, verifica lo que falte y /hanniorq close."
		: "\nLa ficha y su goal siguen abiertos: retoma con /hanniorq auto cuando lo hayas revisado.";
	ui.notify(`auto detenido (${run.slug}): ${reason}.${next}`, finished ? "info" : "warning");
	renderRail(ui, cwd);
}

/**
 * Divide argumentos respetando comillas (`/hanniorq goal "arreglar el rail" --verify "npm run check"`).
 * Sin esto, un goal con espacios llegaba troceado al parser de flags.
 */
export function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: string | undefined;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current !== "") args.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (current !== "") args.push(current);
	return args;
}

/** Argumentos de `/hanniorq goal`. */
export interface GoalArgs {
	goal: string;
	doneWhen: string[];
	verify: string[];
	/** Pide al agente que escriba los pasos (no los ejecuta). */
	plan: boolean;
	maxIterations?: number;
	maxIdle?: number;
	maxTokens?: number;
}

/** Parsea `/hanniorq goal "<objetivo>" [--done <cond>] [--verify <cmd>] [--max-iterations N] [--max-tokens N]`. */
export function parseGoalArgs(input: string): GoalArgs {
	const words: string[] = [];
	const doneWhen: string[] = [];
	const verify: string[] = [];
	let plan = false;
	let maxIterations: number | undefined;
	let maxIdle: number | undefined;
	let maxTokens: number | undefined;
	const tokens = splitArgs(input);
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		const value = (): string => tokens[++index] ?? "";
		const positive = (): number | undefined => {
			const parsed = Number.parseInt(value(), 10);
			return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
		};
		switch (token) {
			case "--done": {
				const item = value();
				if (item) doneWhen.push(item);
				break;
			}
			case "--verify": {
				const item = value();
				if (item) verify.push(item);
				break;
			}
			case "--plan":
				plan = true;
				break;
			case "--max-iterations":
				maxIterations = positive();
				break;
			case "--max-idle":
				maxIdle = positive();
				break;
			case "--max-tokens":
				maxTokens = positive();
				break;
			default:
				if (!token.startsWith("--")) words.push(token);
		}
	}
	return { goal: words.join(" ").trim(), doneWhen, verify, plan, maxIterations, maxIdle, maxTokens };
}

/**
 * Prompt de `/hanniorq goal … --plan`: propone el plan en `## Pasos` y no implementa nada. El humano
 * revisa y lanza `auto`, así que planificar aquí no le quita el control al bucle.
 */
function goalPlanPrompt(options: { slug: string; sheet: GoalSheet; cwd: string }): string {
	const { slug, sheet, cwd } = options;
	const verify =
		sheet.verify.length > 0 ? sheet.verify.join(" · ") : "(sin verify global: el que corresponda a cada paso)";
	return [
		`[hanniorq plan] Escribe el plan del goal en la ficha \`odd/tasks/${slug}.md\` (${cwd}). No implementes nada.`,
		"",
		`Objetivo: ${sheet.goal ?? "(sin goal)"}`,
		`Criterios (done_when): ${sheet.doneWhen.length > 0 ? sheet.doneWhen.join(" · ") : "(no definidos)"}`,
		`Verificación (verify): ${verify}`,
		"",
		"Haz solo esto:",
		"1. Lee lo mínimo para planificar: la ficha y los ficheros que el goal toca.",
		"2. Escribe entre 3 y 6 pasos atómicos en `## Pasos`, con id (`S1`, `S2`, …) y, cuando aplique, su `(verify: <comando>)`.",
		"3. Cada paso debe ser ejecutable y verificable por separado; nada de pasos que se pisen entre sí.",
		"4. Rellena `## Siguiente` con el primer paso exacto.",
		"5. No ejecutes verify, no hagas commits y no toques código.",
		"",
		"Al acabar, resume en dos líneas los pasos propuestos. Yo los reviso y lanzo `/hanniorq auto`.",
	].join("\n");
}

/** Plantilla de ficha nueva cuando `/hanniorq goal` crea el fichero. */
function goalSheetTemplate(options: {
	slug: string;
	goal: string;
	project: string;
	base: string;
	args: GoalArgs;
}): string {
	const { slug, goal, project, base, args } = options;
	const sheet: GoalSheet = {
		goal,
		doneWhen: args.doneWhen,
		verify: args.verify,
		autonomy: "off",
		limits: {
			maxIterations: args.maxIterations,
			maxIdle: args.maxIdle ?? AUTO_DEFAULT_MAX_IDLE,
			maxTokens: args.maxTokens ?? AUTO_DEFAULT_MAX_TOKENS,
		},
	};
	const front = setSheetFields("", {
		topic_key: `${project}/feat/${slug}`,
		status: "active",
		base,
		goal: sheet.goal ?? "",
		done_when: sheet.doneWhen,
		verify: sheet.verify,
		autonomy: sheet.autonomy,
		max_iterations: args.maxIterations !== undefined ? String(args.maxIterations) : undefined,
		max_idle: String(sheet.limits.maxIdle),
		max_tokens: String(sheet.limits.maxTokens),
	});
	return `${front}# ${slug}\nObjetivo: ${goal}\nAlcance: (pendiente) · Fuera: (pendiente)\nVerify: ${args.verify[0] ?? "(pendiente)"}\n\n## Pasos\n\n## Siguiente\nEscribe los pasos en \`## Pasos\` (uno por linea, \`- [ ] S1 …\`) y después /hanniorq autonomy on + /hanniorq auto.\n`;
}

/**
 * Un paso del bucle desatendido: mira el progreso real (commit nuevo o paso marcado) y las guardas, y
 * o reenvía el turno siguiente o para. Nunca decide el plan: solo encadena pasos ya escritos.
 */
async function autoSettle(pi: Parameters<ExtensionFactory>[0], ctx: ExtensionContext): Promise<void> {
	const run = autoRun;
	if (!run) return;
	const cwd = ctx.cwd ?? process.cwd();
	if (autoAborted) {
		cancelAuto(ctx.ui, cwd, "turno abortado");
		return;
	}
	run.stepsRun++;
	let text: string;
	try {
		text = readFileSync(join(getOddDir(cwd), "tasks", `${run.slug}.md`), "utf-8");
	} catch {
		cancelAuto(ctx.ui, cwd, "la ficha desapareció");
		return;
	}
	const steps = sheetSteps(text);
	const done = steps.filter((step) => step.done).length;
	const head = git(cwd, ["rev-parse", "--short", "HEAD"]).out;
	const progressed = head !== run.lastSha || done > run.lastDone;
	run.idle = progressed ? 0 : run.idle + 1;
	run.lastSha = head;
	run.lastDone = done;
	const tokens = sessionTokens - run.tokensAtStart;
	const pending = steps.filter((step) => !step.done);
	const outcome = autoOutcome({
		stepsRun: run.stepsRun,
		maxSteps: run.maxSteps,
		idle: run.idle,
		maxIdle: run.maxIdle,
		tokens,
		maxTokens: run.maxTokens,
		pending: pending.length,
	});
	if (outcome.stop) {
		cancelAuto(ctx.ui, cwd, outcome.reason);
		return;
	}
	const sheet = parseGoalSheet(text);
	const next = pending[0];
	if (!next) {
		cancelAuto(ctx.ui, cwd, "no quedan pasos pendientes");
		return;
	}
	autoSending = true;
	pi.sendUserMessage(
		autoPrompt({
			slug: run.slug,
			sheet,
			step: next,
			iteration: run.stepsRun + 1,
			maxSteps: run.maxSteps,
			tokensLeft: Math.max(0, run.maxTokens - tokens),
		}),
	);
	renderRail(ctx.ui, cwd);
}

// ---------------------------------------------------------------------------
// /helpme — lista de comandos. La PRESENCIA la mandan el registro de extensiones
// y `BUILTIN_SLASH_COMMANDS` (core); `COMMAND_USAGE` solo añade el uso resumido,
// así que un comando nuevo aparece en la lista aunque no esté en ese mapa.
// ---------------------------------------------------------------------------

/** Uso resumido para el listado; un comando sin entrada se muestra como `/nombre`. */
const COMMAND_USAGE: Record<string, string> = {
	helpme: "/helpme",
	hanniorq: "/hanniorq goal|autonomy|auto|stop|on|off|status|plan|new|run|watch|close|resume|rail|tasks|clear",
	hannigram: "/hannigram init|status|adr <título>",
	skipmemory: "/skipmemory [on|off]",
	hannidump: "/hannidump [ruta]",
	dumpgram: "/dumpgram [ruta]",
	extract: "/extract [--dir <ruta>] [--overwrite|--version]",
	explore: "/explore",
	task: "/task new|list|plan <petición>",
};

/** Una fila del listado de `/helpme`. */
export interface HelpRow {
	cmd: string;
	desc: string;
}

/**
 * Filas de `/helpme`: comandos de extensión (los que hay realmente en la sesión) y de core. Pura, para
 * poder comprobar en un test que ningún comando registrado se queda fuera del listado.
 */
export function helpRows(
	extensionCommands: ReadonlyArray<{ name: string; description?: string }>,
	builtins: ReadonlyArray<{ name: string; description: string; argumentHint?: string }> = BUILTIN_SLASH_COMMANDS,
): { hannipi: HelpRow[]; core: HelpRow[] } {
	const hannipi = extensionCommands
		.map((command) => ({ cmd: COMMAND_USAGE[command.name] ?? `/${command.name}`, desc: command.description ?? "" }))
		.sort((a, b) => a.cmd.localeCompare(b.cmd));
	// `/helpme` primero: es la puerta de entrada al resto.
	const entry = hannipi.findIndex((row) => row.cmd.startsWith("/helpme"));
	if (entry > 0) hannipi.unshift(...hannipi.splice(entry, 1));
	const core = builtins
		.map((command) => ({
			cmd: `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`,
			desc: command.description,
		}))
		.sort((a, b) => a.cmd.localeCompare(b.cmd));
	return { hannipi, core };
}

// ---------------------------------------------------------------------------
// Extensión
// ---------------------------------------------------------------------------

export function createHanniorqExtension(
	options: { ensureDaemon?: typeof ensureHanniGramDaemon } = {},
): ExtensionFactory {
	return (pi) => {
		readExtensionOverrides = () => pi.getSettings().extensions ?? [];
		readSettings = () => pi.getSettings();
		let unsubscribeMcpStatus: (() => void) | undefined;
		/** mem_* que quedaron fuera del conjunto activo al omitir la memoria (para restaurarlas). */
		let memoryToolsHidden: string[] = [];

		/**
		 * Saca las `mem_*` del conjunto activo: el modelo deja de verlas en el prompt, no solo se le
		 * prohíbe llamarlas. Se recuerdan para volver a activarlas con `/skipmemory off`.
		 */
		function hideMemoryTools(): void {
			const active = pi.getActiveTools();
			const hidden = active.filter((name) => name.startsWith("mem_"));
			if (hidden.length === 0) return;
			memoryToolsHidden = [...new Set([...memoryToolsHidden, ...hidden])];
			pi.setActiveTools(active.filter((name) => !name.startsWith("mem_")));
		}

		/** Devuelve al conjunto activo las `mem_*` que la omisión había quitado. */
		function restoreMemoryTools(): void {
			if (memoryToolsHidden.length === 0) return;
			const active = pi.getActiveTools();
			pi.setActiveTools([...active, ...memoryToolsHidden.filter((name) => !active.includes(name))]);
			memoryToolsHidden = [];
		}

		/** Aviso común de los comandos que necesitan memoria cuando está omitida. */
		function memoryBlocked(ui: ExtensionUIContext): boolean {
			if (!memorySkipped()) return false;
			ui.notify(
				"Memoria omitida con /skipmemory: HanniGram no se toca. Usa /skipmemory off para volver a usarla.",
				"warning",
			);
			return true;
		}

		// Estado del turno actual: tools usadas, escrituras de memoria, si se
		// tocó sODD. Se resetea en turn_start y se resume en turn_end como un
		// widget pequeñito (abajo), estilo "updated skill" de Hermes.
		let turnTools = new Set<string>();
		let turnSoddTouched = false;

		pi.on("turn_start", (_event, ctx) => {
			trackContext(ctx);
			turnTools = new Set<string>();
			memTurn = emptyMemTurnSummary();
			turnSoddTouched = false;
			soddWorking = true;
			autoAborted = false;
			renderRail(ctx.ui, ctx.cwd ?? process.cwd());
		});

		pi.on("tool_execution_start", (event, ctx) => {
			trackContext(ctx);
			turnTools.add(event.toolName);
			if (event.toolName === "task" || event.toolName === "hanniorq" || event.toolName === "hannigram") {
				turnSoddTouched = true;
			}
			if (MEM_READ_TOOLS.has(event.toolName)) memTurn.reads++;
			// Skill en uso: el modelo lo activa leyendo su fichero (SKILL.md o uno del catálogo).
			if (event.toolName === "read") {
				const path = (event.args as { path?: unknown } | undefined)?.path;
				const skill = typeof path === "string" ? skillFromRead(path) : undefined;
				if (skill && markSkillUsed(skill)) renderRail(ctx.ui, ctx.cwd ?? process.cwd());
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
			// Contadores del turno: nuevo vs update se distinguen por el resultado de `mem_save`
			// ("Saved observation …" / "Updated observation …").
			if (MEM_WRITE_TOOLS.has(event.toolName) && !event.isError) {
				if (event.toolName === "mem_delete") memTurn.deleted++;
				else if (event.toolName === "mem_session_summary") memTurn.summaries++;
				else if (/\bUpdated observation\b/i.test(toolResultText(event.result))) memTurn.updated++;
				else memTurn.created++;
				// Un resumen de sesión de verdad deja el handoff rodante sin papel.
				if (event.toolName === "mem_session_summary") handoffSuperseded = true;
				// El briefing ya inyectado NO se refresca aquí a propósito: cambiar el system prompt
				// a mitad de sesión invalida la caché de prefijo del proveedor (ver briefingInjectedFor).
			}
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
		// /skipmemory — HanniGram fuera del juego, entero: sin briefing en el system prompt, sin tools
		// mem_* (se quitan del conjunto activo y además se bloquean sus llamadas), sin arrancar el
		// daemon y sin lecturas ni escrituras. Persiste entre sesiones, así que una sesión nueva sigue
		// omitida hasta que se apague con /skipmemory off.
		pi.registerCommand("skipmemory", {
			description: "Omitir HanniGram por completo: briefing, tools mem_* y daemon (on|off)",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const mode = args.trim().toLowerCase();
				if (mode !== "" && mode !== "on" && mode !== "off") {
					ctx.ui.notify("Uso: /skipmemory [on|off] (sin argumento alterna)", "warning");
					return;
				}
				const skip = mode === "on" ? true : mode === "off" ? false : !ctx.ui.getSkipMemory();
				ctx.ui.setSkipMemory(skip);
				if (skip) {
					hideMemoryTools();
					memoryCache = { up: false, checked: true, skipped: true };
				} else {
					restoreMemoryTools();
					memoryCache = { up: false, checked: false, skipped: false };
				}
				invalidateMemoryBriefing();
				briefingInjectedFor = undefined;
				refreshRail(ctx.ui, cwd);
				ctx.ui.notify(
					skip
						? "Memoria omitida: HanniGram no se leerá ni se escribirá en esta sesión (ni el briefing, ni las tools mem_*, ni el daemon). Persiste entre sesiones; /skipmemory off para volver."
						: "Memoria de HanniGram activada otra vez.",
					"info",
				);
			},
		});

		// Cinturón y tirantes: aunque otra extensión reactive las mem_*, ninguna llamada pasa.
		pi.on("tool_call", (event) => {
			if (!memorySkipped() || !event.toolName.startsWith("mem_")) return undefined;
			return {
				block: true,
				reason: "memoria omitida con /skipmemory (usa /skipmemory off para volver a usarla)",
			};
		});

		pi.registerCommand("hannigram", {
			description: "Memoria del proyecto: init|status|adr (HanniGram)",
			handler: async (args, ctx) => {
				const [sub, ...rest] = args.trim().split(/\s+/);
				const cwd = ctx.cwd ?? process.cwd();
				if (memoryBlocked(ctx.ui)) return;
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
		pi.on("turn_end", (event, ctx) => {
			trackContext(ctx);
			const cwd = ctx.cwd ?? process.cwd();
			// Presupuesto de la autonomía: tokens reales de cada respuesta del modelo.
			const message = event.message as {
				role?: string;
				usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
				stopReason?: string;
			};
			if (message.role === "assistant") {
				if (message.usage) sessionTokens += usageTokens(message.usage);
				if (message.stopReason === "aborted") autoAborted = true;
			}
			soddWorking = false;
			const ind = soddIndicator(cwd);
			const parts: string[] = [];
			if (turnTools.size > 0) parts.push(`tools: ${[...turnTools].join(", ")}`);
			if (ind) parts.push(`sODD: activo (${ind.done}/${ind.total})`);
			else if (turnSoddTouched) parts.push("sODD: activo");
			// Cierre del turno: tools + sODD en una línea y el resumen de memoria en la última,
			// para ver de un vistazo si se usó la memoria y qué cambió.
			const lines: string[] = [];
			if (parts.length > 0) lines.push(`▸ ${parts.join(" · ")}`);
			const memoryLine = formatMemoryLine(memTurn);
			if (memoryLine) lines.push(`  ${memoryLine}`);
			ctx.ui.setWidget("hanniorq-turn", lines.length > 0 ? lines : undefined);
			updateSoddIndicator(ctx.ui, cwd);
			refreshRail(ctx.ui, cwd);
			void refreshModifiedFiles(pi, ctx.ui, cwd);
			// El turno dejó trabajo y no hubo resumen de sesión: se actualiza "en qué estaba".
			if (!handoffSuperseded && memTurn.summaries === 0) void saveRollingHandoff(cwd);
		});

		pi.on("tool_execution_end", (_event, ctx) => {
			void refreshModifiedFiles(pi, ctx.ui, ctx.cwd ?? process.cwd());
		});

		// Briefing de memoria: al empezar el turno, lo que HanniGram ya sabe del proyecto entra en el
		// system prompt (sección `memoria`) para que el agente retome en vez de reexplorar. La lectura
		// se cachea por sesión, así que no cuesta una petición por turno.
		pi.on("before_agent_start", async (event, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			// Autonomía: el prompt que manda el bucle consume el flag; si escribes tú, el bucle se corta.
			if (autoSending) autoSending = false;
			else if (autoRun) cancelAuto(ctx.ui, cwd, "has escrito tú");
			if (!sessionWork.goal) sessionWork.goal = oneLine(event.prompt, 200) || undefined;
			// Skills: catálogo del system prompt, y el ciclo de uso — un prompt nuevo cierra el anterior
			// (`en uso` → `activado`), y si el prompt es `/skill:<nombre>` ese skill empieza en uso.
			const catalog = event.systemPromptOptions?.skills;
			if (Array.isArray(catalog)) {
				sessionSkills = catalog.map((skill) => ({ name: skill.name, filePath: skill.filePath }));
			}
			deactivateSkillsInUse();
			const invoked = /<skill\s+name="([^"]+)"/.exec(event.prompt)?.[1];
			if (invoked) markSkillUsed(invoked);
			// /skipmemory: ni briefing ni guideline de memoria. El resto del handler (skills) sigue.
			if (memorySkipped()) return;
			if (briefingInjectedFor !== cwd) {
				const memory = await loadMemoryBriefing(cwd);
				if (memory) {
					event.systemPromptOptions.sections.memoria = memory.text;
					briefingInjectedFor = cwd;
				}
			}
			const guidelines = event.systemPromptOptions.promptGuidelines;
			if (!guidelines.includes(MEMORY_GUIDELINE)) guidelines.push(MEMORY_GUIDELINE);
		});

		// El run terminó: lo que estaba en uso queda como activado (ya se cargó en esta sesión).
		pi.on("agent_settled", (_event, ctx) => {
			if (deactivateSkillsInUse()) renderRail(ctx.ui, ctx.cwd ?? process.cwd());
			void autoSettle(pi, ctx);
		});

		// Indicador sODD: pinta si hay ficha activa (al iniciar la sesión,
		// que es cuando la ficha se retoma).
		pi.on("session_start", (_event, ctx) => {
			trackContext(ctx);
			const cwd = ctx.cwd ?? process.cwd();
			// Sesion nueva: la actividad de memoria y las tareas del harness son de la sesion.
			memActivity.length = 0;
			harnessTodos = [];
			memoryBoards.clear();
			skillUses.clear();
			sessionSkills = [];
			soddWorking = false;
			sessionWork.goal = undefined;
			handoffSuperseded = false;
			briefingInjectedFor = undefined;
			invalidateMemoryBriefing();
			if (memorySkipped()) hideMemoryTools();
			updateSoddIndicator(ctx.ui, cwd);
			refreshRail(ctx.ui, cwd);
			void refreshModifiedFiles(pi, ctx.ui, cwd);
			unsubscribeMcpStatus?.();
			unsubscribeMcpStatus = subscribeMcpConnectionStatuses(() => renderRail(ctx.ui, cwd));
			// Con la memoria omitida no se arranca el daemon: HanniGram no se toca en toda la sesión.
			if (memorySkipped()) return;
			void (options.ensureDaemon ?? ensureHanniGramDaemon)({ cwd, baseUrl: HANNIGRAM_BASE }).then(
				async (started) => {
					if (!started) return;
					await checkMemory();
					await refreshMemoryBoards(cwd);
					renderRail(ctx.ui, cwd);
					// Con el daemon ya arriba: briefing listo y aviso de lo que se retoma.
					const memory = await loadMemoryBriefing(cwd);
					if (memory) ctx.ui.notify(memory.headline, "info");
				},
			);
		});
		pi.on("session_shutdown", () => {
			unsubscribeMcpStatus?.();
			unsubscribeMcpStatus = undefined;
		});

		pi.registerCommand("hanniorq", {
			description:
				"Orquestador sODD: help|goal|autonomy|auto|stop|on|off|status|plan|new|run|watch|close|resume|rail|tasks|clear",
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
								cmd: '/hanniorq goal "<objetivo>"',
								desc: "Pone el objetivo en la ficha (frontmatter: goal, done_when, verify, límites) y la crea si no hay ninguna activa. No ejecuta nada. Con --plan, el agente propone los pasos (sin implementarlos).",
							},
							{
								cmd: "/hanniorq autonomy on|off|status",
								desc: "Enciende/apaga la ejecución desatendida de ESA ficha (autonomy: guarded|off) y muestra su estado.",
							},
							{
								cmd: "/hanniorq auto [n]",
								desc: "Encadena hasta n pasos YA escritos en la ficha, con verify y commit entre cada uno; para sin progreso o al agotar presupuesto. No planifica.",
							},
							{
								cmd: "/hanniorq stop",
								desc: "Corta la ejecución automática en curso; la ficha y su goal quedan abiertos.",
							},
							{
								cmd: "/hanniorq status",
								desc: "Estado del orquestador: activo/inactivo, ficha activa, goal, autonomía, límites y, si corre, iteración y tokens.",
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
								cmd: "/hanniorq rail [n]",
								desc: "Muestra u oculta el rail derecho; con un número fija su ancho en columnas (20-100) para leer las tareas enteras. También con ctrl+alt+←/→.",
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
								cmd: "/skipmemory [on|off]",
								desc: "Omitir HanniGram por completo: sin briefing en el prompt, sin tools mem_* y sin arrancar el daemon. Persiste entre sesiones hasta /skipmemory off.",
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
						const lines = [
							`hanniorq: ${state.on ? "ON" : "OFF"}${slug ? ` · ficha activa: odd/tasks/${slug}.md` : " · sin ficha activa"}`,
						];
						const goal = activeGoal(cwd);
						if (goal) {
							lines.push(`goal: ${goal.sheet.goal}`);
							lines.push(
								`autonomía: ${goal.sheet.autonomy === "guarded" ? "guarded" : "off"} · pasos ${goal.done}/${goal.total} · límites ${goal.sheet.limits.maxIterations ?? AUTO_MAX_STEPS} pasos · ${formatTokensShort(goal.sheet.limits.maxTokens)} tok · idle ${goal.sheet.limits.maxIdle}`,
							);
							if (goal.sheet.doneWhen.length > 0) lines.push(`done_when: ${goal.sheet.doneWhen.join(" · ")}`);
						} else if (slug) {
							lines.push('sin goal en la ficha: /hanniorq goal "<objetivo>"');
						}
						if (autoRun) {
							const tokens = sessionTokens - autoRun.tokensAtStart;
							lines.push(
								`auto: ${autoRun.stepsRun}/${autoRun.maxSteps} pasos · ${formatTokensShort(tokens)}/${formatTokensShort(autoRun.maxTokens)} tok · idle ${autoRun.idle}/${autoRun.maxIdle}`,
							);
						}
						ctx.ui.notify(lines.join("\n"), "info");
						return;
					}
					case "goal": {
						// El goal y sus criterios viven en el frontmatter de la ficha: una sola verdad, diffable.
						const goalArgs = parseGoalArgs(args.trim().replace(/^goal\s*/, ""));
						if (!goalArgs.goal) {
							ctx.ui.notify(
								'Uso: /hanniorq goal "<objetivo>" [--plan] [--done "<condición>"] [--verify "<comando>"] [--max-iterations N] [--max-tokens N] [--max-idle N]',
								"warning",
							);
							return;
						}
						let path = taskPath;
						let slug = getActiveSlug(cwd);
						let created = false;
						if (!path || !existsSync(path)) {
							// Sin ficha activa: se crea una con el goal dentro (los pasos los escribe el usuario).
							const base = slugify(goalArgs.goal).slice(0, 48) || "goal";
							slug = base;
							const tasksDir = join(oddDir, "tasks");
							let suffix = 2;
							while (existsSync(join(tasksDir, `${slug}.md`))) slug = `${base}-${suffix++}`;
							path = join(tasksDir, `${slug}.md`);
							mkdirSync(tasksDir, { recursive: true });
							writeFileSync(
								path,
								goalSheetTemplate({
									slug,
									goal: goalArgs.goal,
									project: projectName(cwd),
									base: git(cwd, ["rev-parse", "--short", "HEAD"]).out || "?",
									args: goalArgs,
								}),
							);
							writeFileSync(join(oddDir, ".active"), slug);
							created = true;
						} else {
							// Ficha existente: solo se tocan los campos indicados (los límites, si se pasan).
							const fields: Record<string, string | string[] | undefined> = { goal: goalArgs.goal };
							if (goalArgs.doneWhen.length > 0) fields.done_when = goalArgs.doneWhen;
							if (goalArgs.verify.length > 0) fields.verify = goalArgs.verify;
							if (goalArgs.maxIterations !== undefined) fields.max_iterations = String(goalArgs.maxIterations);
							if (goalArgs.maxIdle !== undefined) fields.max_idle = String(goalArgs.maxIdle);
							if (goalArgs.maxTokens !== undefined) fields.max_tokens = String(goalArgs.maxTokens);
							writeFileSync(path, setSheetFields(readFileSync(path, "utf-8"), fields));
						}
						const sheet = parseGoalSheet(readFileSync(path, "utf-8"));
						const steps = sheetSteps(readFileSync(path, "utf-8"));
						const pending = steps.filter((step) => !step.done).length;
						// `--plan`: el agente escribe los pasos (plan propuesto), pero no implementa nada. Así
						// `goal --plan` → revisar → `auto` es el flujo completo sin editar el fichero a mano.
						const willPlan = goalArgs.plan && pending === 0;
						ctx.ui.notify(
							[
								`goal en odd/tasks/${slug}.md${created ? " (ficha nueva)" : ""}: ${goalArgs.goal}`,
								`autonomía: ${sheet.autonomy === "guarded" ? "guarded" : "off (enciéndela con /hanniorq autonomy on)"}`,
								pending > 0
									? `${pending} pasos pendientes: lánzalos con /hanniorq auto`
									: willPlan
										? "pidiendo el plan al agente (no implementa nada); revísalo y luego /hanniorq auto"
										: "sin pasos pendientes todavía: escríbelos en `## Pasos` (o usa --plan) y vuelve a /hanniorq auto",
							].join("\n"),
							"info",
						);
						if (willPlan) {
							const planSheet = parseGoalSheet(readFileSync(path, "utf-8"));
							// El slug puede venir de la ficha activa o del nombre del fichero (ficha sin `.active`).
							const planSlug =
								slug ?? (path.replace(/\\/g, "/").split("/").pop() ?? "ficha").replace(/\.md$/, "");
							pi.sendUserMessage(goalPlanPrompt({ slug: planSlug, sheet: planSheet, cwd }));
						}
						renderRail(ctx.ui, cwd);
						return;
					}
					case "autonomy": {
						const mode = (rest[0] ?? "status").toLowerCase();
						if (!taskPath || !existsSync(taskPath)) {
							ctx.ui.notify('No hay ficha activa: /hanniorq goal "<objetivo>" primero.', "warning");
							return;
						}
						const text = readFileSync(taskPath, "utf-8");
						const sheet = parseGoalSheet(text);
						if (mode === "status") {
							ctx.ui.notify(
								`autonomía: ${sheet.autonomy === "guarded" ? "guarded (solo ejecuta pasos ya escritos)" : "off"}${autoRun ? ` · en curso ${autoRun.stepsRun}/${autoRun.maxSteps}` : ""}`,
								"info",
							);
							return;
						}
						if (mode !== "on" && mode !== "off") {
							ctx.ui.notify("Uso: /hanniorq autonomy on|off|status", "warning");
							return;
						}
						writeFileSync(taskPath, setSheetFields(text, { autonomy: mode === "on" ? "guarded" : "off" }));
						if (mode === "off" && autoRun) cancelAuto(ctx.ui, cwd, "autonomía apagada");
						ctx.ui.notify(
							mode === "on"
								? "autonomía guarded: /hanniorq auto ejecutará solo los pasos escritos en la ficha, con verify y commit por paso. Para con /hanniorq stop."
								: "autonomía off: /hanniorq auto no ejecuta nada.",
							"info",
						);
						renderRail(ctx.ui, cwd);
						return;
					}
					case "auto": {
						if (!taskPath || !existsSync(taskPath)) {
							ctx.ui.notify('No hay ficha activa: /hanniorq goal "<objetivo>" primero.', "warning");
							return;
						}
						if (autoRun) {
							ctx.ui.notify(
								"Ya hay una ejecución automática en curso (/hanniorq stop para cortarla).",
								"warning",
							);
							return;
						}
						const text = readFileSync(taskPath, "utf-8");
						const sheet = parseGoalSheet(text);
						if (!sheet.goal) {
							ctx.ui.notify('La ficha no tiene goal: /hanniorq goal "<objetivo>"', "warning");
							return;
						}
						if (sheet.autonomy === "off") {
							ctx.ui.notify(
								"Autonomía apagada en la ficha (autonomy: off). Enciéndela con /hanniorq autonomy on.",
								"warning",
							);
							return;
						}
						const steps = sheetSteps(text);
						const pending = steps.filter((step) => !step.done);
						if (pending.length === 0) {
							ctx.ui.notify(
								"No quedan pasos pendientes en la ficha: revisa `done_when`, verifica y /hanniorq close.",
								"info",
							);
							return;
						}
						const requested = Number.parseInt(rest[0] ?? "", 10);
						const cap = sheet.limits.maxIterations ?? AUTO_MAX_STEPS;
						const maxSteps = Math.max(
							1,
							Math.min(
								Number.isFinite(requested) && requested > 0 ? requested : AUTO_DEFAULT_STEPS,
								cap,
								AUTO_MAX_STEPS,
							),
						);
						autoRun = {
							slug: getActiveSlug(cwd) ?? "ficha",
							maxSteps,
							stepsRun: 0,
							idle: 0,
							tokensAtStart: sessionTokens,
							maxTokens: sheet.limits.maxTokens,
							maxIdle: sheet.limits.maxIdle,
							lastSha: git(cwd, ["rev-parse", "--short", "HEAD"]).out,
							lastDone: steps.length - pending.length,
							goal: sheet.goal,
						};
						autoAborted = false;
						ctx.ui.notify(
							`auto: hasta ${maxSteps} pasos · ${formatTokensShort(sheet.limits.maxTokens)} tok · para si no hay progreso en ${sheet.limits.maxIdle}. /hanniorq stop lo corta.`,
							"info",
						);
						autoSending = true;
						pi.sendUserMessage(
							autoPrompt({
								slug: autoRun.slug,
								sheet,
								step: pending[0] as SheetStep,
								iteration: 1,
								maxSteps,
								tokensLeft: sheet.limits.maxTokens,
							}),
						);
						renderRail(ctx.ui, cwd);
						return;
					}
					case "stop": {
						if (!autoRun) {
							ctx.ui.notify("No hay ejecución automática en curso.", "info");
							return;
						}
						cancelAuto(ctx.ui, cwd, "detenido por ti");
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
						// Lista las fichas del proyecto (▤ odd/tasks), las que solo viven en la BD (⛁) y la flota.
						const tasksDir = join(getOddDir(cwd), "tasks");
						let local: string[] = [];
						try {
							local = readdirSync(tasksDir).filter((n) => n.endsWith(".md"));
						} catch {
							/* odd/tasks no existe aún */
						}
						const fichas = local
							.map((n) => {
								const text = readFileSync(join(tasksDir, n), "utf-8");
								const status = text.match(/^status: (.+)$/m)?.[1] ?? "?";
								const seen = text.match(/\[x\]|\[X\]/) ? "progreso ✔" : "sin pasos hechos";
								return `  ▤ ${n} · ${status} · ${seen}`;
							})
							.join("\n");
						await refreshMemoryBoards(cwd);
						const mirrored = [...memoryBoards.entries()]
							.filter(([slug]) => !local.includes(`${slug}.md`))
							.map(([slug, steps]) => {
								const done = steps.filter((step) => step.done).length;
								return `  ⛁ odd/${slug}/tasks · ${done}/${steps.length} pasos`;
							})
							.join("\n");
						const rows =
							[
								fichas ? `fichas (▤ odd/tasks):\n${fichas}` : "",
								mirrored ? `solo en HanniGram (⛁):\n${mirrored}` : "",
							]
								.filter(Boolean)
								.join("\n") || "sin tareas activas";
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
						if (memoryBlocked(ctx.ui)) return;
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
						if (memoryBlocked(ctx.ui)) return;
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
						// /hanniorq rail        → oculta/muestra el rail (persistido en settings)
						// /hanniorq rail <n>    → fija el ancho (columnas, 20-100) para leer mejor las tareas
						const requested = rest[0] ? Number.parseInt(rest[0], 10) : Number.NaN;
						if (Number.isFinite(requested)) {
							const applied = ctx.ui.setRailWidth(requested);
							ctx.ui.setRailHidden(false);
							renderRail(ctx.ui, cwd);
							ctx.ui.notify(`Rail derecho: ${applied} columnas.`, "info");
							return;
						}
						const hidden = !ctx.ui.getRailHidden();
						ctx.ui.setRailHidden(hidden);
						ctx.ui.notify(
							hidden
								? "Rail derecho oculto."
								: `Rail derecho visible (${ctx.ui.getRailWidth()} columnas). Cambia el ancho con ctrl+alt+←/→ o /hanniorq rail <n>, y arrastra su borde con el ratón.`,
							"info",
						);
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
							"Uso: /hanniorq goal|autonomy|auto|stop|on|off|status|plan|new <slug>|run|watch|close|resume|rail|tasks|clear",
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
		// Lista VIVA: los comandos de extensión salen del registro y los de
		// core del catálogo del autocompletado, así que un comando nuevo
		// aparece aquí sin tocar este handler y no se puede quedar fuera.
		// =================================================================
		pi.registerCommand("helpme", {
			description: "Lista los comandos de HanniPI y para qué sirven",
			handler: async (_args, ctx) => {
				const available = pi.getCommands();
				const { hannipi, core } = helpRows(available.filter((command) => command.source === "extension"));
				const extras = available.filter((command) => command.source !== "extension");
				const skills = extras.filter((command) => command.source === "skill").length;
				const prompts = extras.filter((command) => command.source === "prompt").length;
				const commands = [...hannipi, ...core];
				const row = (entry: { cmd: string; desc: string }) => `• ${entry.cmd}\n${entry.desc}`;
				const resourceLine = [
					skills > 0 ? `${skills} skills (/skill:<nombre>)` : "",
					prompts > 0 ? `${prompts} prompts` : "",
				]
					.filter(Boolean)
					.join(" · ");
				const text = [
					`Comandos de HanniPI (${hannipi.length} propios + ${core.length} de core):`,
					"",
					hannipi.map(row).join("\n\n"),
					"",
					"Core:",
					"",
					core.map(row).join("\n\n"),
					resourceLine ? `\n${resourceLine}` : "",
				]
					.join("\n")
					.trim();
				ctx.ui.notify(text, "info");
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
				if (memoryBlocked(ctx.ui)) return;
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
		// /dumpgram — volcado de la memoria del proyecto a ficheros .md del
		// repo, para que otra persona lo lea sin HanniGram. Determinista: lee
		// las observaciones del proyecto activo y las escribe tal cual, sin
		// resumir con el LLM (no hay invención ni coste de tokens).
		// =================================================================
		pi.registerCommand("dumpgram", {
			description: "Volcar la memoria del proyecto a docs/memoria/*.md para leerla sin HanniGram",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				if (memoryBlocked(ctx.ui)) return;
				const target = args.trim().split(/\s+/)[0] || "docs/memoria";
				const observations =
					(await hannigram<DumpObservation[]>(
						`/api/observations?${new URLSearchParams({ cwd, limit: "1000" })}`,
					)) ?? [];
				if (observations.length === 0) {
					ctx.ui.notify(
						"No hay memoria en HanniGram para este proyecto. Usa /explore para construirla.",
						"warning",
					);
					return;
				}
				const outDir = resolve(cwd, target);
				const files = renderMemoryDump(observations, {
					project: projectName(cwd),
					dir: target.replace(/\\/g, "/").replace(/\/+$/, ""),
					generatedAt: new Date(),
				});
				try {
					mkdirSync(outDir, { recursive: true });
					for (const file of files) writeFileSync(join(outDir, file.name), file.content);
				} catch (e) {
					ctx.ui.notify(
						`No pude escribir el dump en ${target}: ${e instanceof Error ? e.message : String(e)}`,
						"error",
					);
					return;
				}
				ctx.ui.notify(
					`Dump de memoria: ${files.length} ficheros en ${target}/ (${observations.length} observaciones del proyecto).`,
					"info",
				);
			},
		});

		// =================================================================
		// /extract — retrato del proyecto en .md por tipología (README,
		// architecture, stack, design, conventions) para que OTRO harness lo
		// lea sin reexplorar. Nunca pisa documentos existentes: sin flags solo
		// avisa; --overwrite regenera encima y --version crea -vN.
		// =================================================================
		pi.registerCommand("extract", {
			description:
				"Extrae el proyecto a docs/proyecto/*.md (arquitectura, stack, diseño, convenciones) para otros harness",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const tokens = args.trim().split(/\s+/).filter(Boolean);
				const wantsOverwrite = tokens.includes("--overwrite");
				const wantsVersion = tokens.includes("--version");
				const dirFlag = tokens.indexOf("--dir");
				const target = dirFlag >= 0 ? tokens[dirFlag + 1] : "docs/proyecto";
				if (!target || target.startsWith("--")) {
					ctx.ui.notify("Uso: /extract [--dir <ruta>] [--overwrite | --version]", "warning");
					return;
				}
				if (wantsOverwrite && wantsVersion) {
					ctx.ui.notify(
						"/extract: elige una opción, no las dos — --overwrite (regenerar encima) o --version (crear -vN).",
						"warning",
					);
					return;
				}
				const outDir = resolve(cwd, target);
				const existing = existingDocs(outDir);
				// Nada de pisar trabajo previo sin permiso: primero se avisa y se listan las salidas.
				if (existing.length > 0 && !wantsOverwrite && !wantsVersion) {
					ctx.ui.notify(
						`/extract: ya existen ${existing.length} de ${EXTRACT_DOCS.length} docs en ${target}/ (${existing.join(", ")}). No he tocado nada. Elige: /extract --overwrite (regenerarlos), /extract --version (nuevos -vN, sin tocar los actuales) o bórralos a mano para empezar de cero.`,
						"warning",
					);
					return;
				}
				const names = wantsVersion ? versionedDocs(outDir) : EXTRACT_DOCS;
				const docs = names
					.map((name) => {
						const base = name.replace(/-v\d+\.md$/, ".md");
						return `- \`${name}\` — ${EXTRACT_DOC_DESCRIPTIONS[base] ?? "retrato del proyecto"}`;
					})
					.join("\n");
				const facts = projectFacts(cwd);
				ctx.ui.notify(`/extract: ${names.length} docs en ${target}/ (explora primero, luego escribe).`, "info");
				pi.sendUserMessage(
					`Genera el retrato de este proyecto en \`${target}/\` para que OTROS harnesses y agentes (sin esta conversación y sin HanniGram) trabajen sin reexplorar. Directorio de trabajo: ${cwd}.\n\n` +
						`Fase 1 — explora en solo lectura (read/bash), sin pasarte: README y docs/*.md, AGENTS.md/CONTRIBUTING, manifiestos del stack, estructura de directorios, entry points, configuración, y una muestra de 2-4 ficheros por área grande (UI/estilos, datos/estado, tests, build).\n\n` +
						`Fase 2 — escribe EXACTAMENTE estos ${names.length} ficheros (tool write, bajo \`${target}/\`); nada más:\n${docs}\n\n` +
						`Reglas:\n` +
						`- Rutas reales del proyecto (\`ruta:línea\` cuando ayude). No inventes: si algo no se puede determinar, escribe "no determinado" y por qué.\n` +
						`- Nada de secretos ni valores de .env/tokens: solo la forma y los nombres.\n` +
						`- No toques código ni ningún otro fichero.\n` +
						`- Sin relleno: frases cortas, listas y tablas; cada doc se entiende de un vistazo.\n\n` +
						`Hechos ya leídos del disco (no hace falta reexplorar esto):\n${facts}`,
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
				if (memoryBlocked(ctx.ui)) return;
				ctx.ui.notify("Explorando el proyecto para construir su memoria inicial (vía LLM).", "info");
				pi.sendUserMessage(
					`Explora este proyecto para construir su memoria inicial en HanniGram (primera vez). Directorio de trabajo: ${cwd}.\n\nHaz:\n1. Lee los ficheros informativos: README, *.md, AGENTS.md, CONTRIBUTING.md, docs/, package.json (o equivalente) y la estructura de directorios.\n2. Identifica: qué es el proyecto, stack/tecnología, decisiones de arquitectura y convenciones/estilo (naming, estructura, patrones).\n3. Guarda la memoria: para cada decisión usa la tool \`mem_save\` con \`type=adr\` y \`topicKey=adr/<slug>\`; para el contexto general usa topics descriptivos. Si \`mem_save\` no está disponible, ejecuta por bash: \`hannigram save "<título>" --content "<texto>" --type adr --topic adr/<slug> --cwd "${cwd}"\`.\n4. No inventes nada que no esté en el proyecto.\n\nEmpieza listando la raíz del proyecto.`,
				);
			},
		});
	};
}
export default createHanniorqExtension();
