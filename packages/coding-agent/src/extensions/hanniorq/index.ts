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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionFactory, ExtensionUIContext } from "../../core/extensions/types.ts";

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

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
	return { ok: r.status === 0, out: (r.stdout || r.stderr || "").trim() };
}

function currentBranch(cwd: string): string {
	return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).out || "?";
}

function lastCommit(cwd: string): string {
	return git(cwd, ["log", "-1", "--format=%h %s"]).out || "ninguno";
}

// ---------------------------------------------------------------------------
// HanniGram helpers (daemon HTTP 127.0.0.1:8765, BD ~/.hannigram/hannigram.db)
// ---------------------------------------------------------------------------

const HANNIGRAM_BASE = process.env.HANNIGRAM_URL ?? "http://127.0.0.1:8765";

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
async function recentObservations(cwd: string): Promise<Array<{ id: number; title: string; topicKey?: string; type?: string }>> {
	return (await hannigram<Array<{ id: number; title: string; topicKey?: string; type?: string }>>(
		`/api/observations?${new URLSearchParams({ cwd, limit: "10" })}`,
	)) ?? [];
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

/** Guarda el resumen de sesión. */
async function saveSessionSummary(cwd: string, summary: string): Promise<boolean> {
	const ok = await hannigram<{ ok?: boolean }>(`/api/sessions/end?${new URLSearchParams({ cwd })}`, {
		method: "POST",
		body: JSON.stringify({ sessionId: `hanniorq-${Date.now().toString(36)}`, summary }),
	});
	return ok !== undefined;
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
		lines.push(`- Leído: ${opts.observations.length} observaciones recientes [#${opts.observations.map((o) => o.id).join(", #")}].`);
	}
	lines.push(`- Espejo de la ficha: topic odd/${opts.slug}/tasks → ${opts.mirrorId ? `#${opts.mirrorId}` : "PENDIENTE (daemon no disponible)"}.`);
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
		const lines = [...fleet.values()].map((a, i) => {
			const icon = a.status === "running" ? `${SPIN[(now / 80) % SPIN.length | 0]}` : a.status === "error" ? "✗" : "✓";
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
	// Extensión
	// ---------------------------------------------------------------------------

	export function createHanniorqExtension(): ExtensionFactory {
		return (pi) => {
			// Flota de subagentes: cada llamada a la tool `subagent` es un worker.
			// sODD: sODD (el agente) decide cuándo delegar según la ficha; si el
			// usuario escribe "delega", se fuerza. Aquí solo se observa y se pinta.
			pi.on("tool_execution_start", (event, ctx) => {
				if (event.toolName !== "subagent") return;
				const task = typeof (event.args as { task?: unknown })?.task === "string" ? (event.args as { task: string }).task : "?";
				fleet.set(event.toolCallId, { id: event.toolCallId, task, status: "running", startedAt: Date.now() });
				startFleetTimer(ctx.ui);
				renderFleet(ctx.ui);
			});
			pi.on("tool_execution_end", (event, ctx) => {
				if (event.toolName !== "subagent") return;
				const agent = fleet.get(event.toolCallId);
				if (agent) {
					agent.status = event.isError ? "error" : "done";
					renderFleet(ctx.ui);
				}
			});
			pi.registerCommand("hanniorq", {
				description: "Orquestador sODD: on|off|status|plan|run|watch|close|resume",
				handler: async (args, ctx) => {
					const [sub, ...rest] = args;
					const cwd = ctx.cwd ?? process.cwd();
					const taskPath = getActiveTaskPath(cwd);
					const oddDir = getOddDir(cwd);

					switch (sub) {
						case "on": {
							state.on = true;
							ctx.ui.notify("hanniorq activado. Clasifico cada petición: trivial → inline (sin ficha/resumen); sustancial → ficha sODD.", "info");
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
							(a) => `  ${a.status === "running" ? "▶" : a.status === "error" ? "✗" : "✓"} ${a.id.slice(0, 8)}: ${a.task.slice(0, 90)}`,
						);
						const fleetRows = fleetLines.length ? `subagentes en vuelo:\n${fleetLines.join("\n")}` : "subagentes en vuelo: ninguno";
						ctx.ui.notify(`hanniorq watch — en qué se trabaja:\n${rows}\n${fleetRows}\n(Cada ficha vive en odd/tasks/<slug>.md; el agente la actualiza por paso.)`, "info");
						return;
					}
					case "close": {
							if (!taskPath) {
								ctx.ui.notify("No hay ficha activa — nada que resumir. (sODD: los cambios triviales no generan resumen.)", "info");
								return;
							}
							const slug = getActiveSlug(cwd)!;
							const content = readFileSync(taskPath, "utf-8");
							const branch = currentBranch(cwd);
							const commit = lastCommit(cwd);
							const observations = await recentObservations(cwd);
							const mirrorId = await mirrorTask(cwd, slug, content);
							const sessionSaved = await saveSessionSummary(cwd, `Trabajo completado: ${slug}. Rama: ${branch}. Commit: ${commit}.`);
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
						default:
							ctx.ui.notify("Uso: /hanniorq on|off|status|plan|run|watch|close|resume", "warning");
					}
				},
			});
		};
	}
	export default createHanniorqExtension();

