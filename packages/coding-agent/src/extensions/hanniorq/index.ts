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
import { join } from "node:path";
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

function soddIndicator(cwd: string): { slug: string; done: number; total: number; status: string } | undefined {
	const slug = getActiveSlug(cwd);
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
// Extensión
// ---------------------------------------------------------------------------

export function createHanniorqExtension(): ExtensionFactory {
	return (pi) => {
		// Estado del turno actual: tools usadas, escrituras de memoria, si se
		// tocó sODD. Se resetea en turn_start y se resume en turn_end como un
		// widget pequeñito (abajo), estilo "updated skill" de Hermes.
		let turnTools = new Set<string>();
		let turnMemoryWrites = 0;
		let turnSoddTouched = false;

		pi.on("turn_start", () => {
			turnTools = new Set<string>();
			turnMemoryWrites = 0;
			turnSoddTouched = false;
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
			if (event.toolName !== "subagent") return;
			const task =
				typeof (event.args as { task?: unknown })?.task === "string" ? (event.args as { task: string }).task : "?";
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
							"Daemon HanniGram NO disponible (127.0.0.1:8765). Arranca con: dotnet run -c Release --project src/HanniGram.Server",
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
			const ind = soddIndicator(cwd);
			const parts: string[] = [];
			if (turnTools.size > 0) parts.push(`tools: ${[...turnTools].join(", ")}`);
			parts.push(
				ind ? `sODD: ${ind.slug} (${ind.done}/${ind.total})` : turnSoddTouched ? "sODD: tocado" : "sODD: inline",
			);
			parts.push(turnMemoryWrites > 0 ? `mem: +${turnMemoryWrites}` : "mem: —");
			ctx.ui.setWidget("hanniorq-turn", [`▸ ${parts.join(" · ")}`]);
			updateSoddIndicator(ctx.ui, cwd);
		});

		// Indicador sODD: pinta si hay ficha activa (al iniciar la sesión,
		// que es cuando la ficha se retoma).
		pi.on("session_start", (_event, ctx) => {
			updateSoddIndicator(ctx.ui, ctx.cwd ?? process.cwd());
		});

		pi.registerCommand("hanniorq", {
			description: "Orquestador sODD: help|on|off|status|plan|new|run|watch|close|resume",
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
					default:
						ctx.ui.notify("Uso: /hanniorq on|off|status|plan|new <slug>|run|watch|close|resume", "warning");
				}
			},
		});
	};
}
export default createHanniorqExtension();
