/**
 * hanni-sodd: Small ODD (Organic Driven Development) para HanniPI.
 *
 * Aporta:
 *  - Comandos `/task new|status|next|done|promote|diff|verify|commit` para gestionar la ficha activa.
 *  - Reinyección de la ficha activa al contexto antes de compactar
 *    (hook `session_before_compact`), recortada a "Pasos" y "Siguiente".
 *
 * La ficha vive en `odd/tasks/<slug>.md`; `odd/.active` apunta al slug activo.
 * El protocolo completo está en `.pi/skills/sodd/SKILL.md`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExtensionFactory } from "../../core/extensions/types.ts";

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

function safeTaskSlug(slug: string): boolean {
	return slug.length > 0 && basename(slug) === slug && !slug.includes("\\") && slug !== "." && slug !== "..";
}

/** Recorta la ficha a las secciones Pasos y Siguiente (para reinyección compacta). */
function compactTask(full: string): string {
	const lines = full.split("\n");
	const out: string[] = [];
	let inPasos = false;
	let inSiguiente = false;
	for (const line of lines) {
		if (line.startsWith("## Pasos")) {
			inPasos = true;
			inSiguiente = false;
			out.push(line);
			continue;
		}
		if (line.startsWith("## Siguiente")) {
			inPasos = false;
			inSiguiente = true;
			out.push(line);
			continue;
		}
		if (line.startsWith("## ")) {
			inPasos = false;
			inSiguiente = false;
			continue;
		}
		if (inPasos || inSiguiente) {
			out.push(line);
		}
	}
	return out.join("\n");
}

/** Resuelve el nombre de proyecto (owner/repo del git remote, o nombre del
 *  directorio). Debe coincidir con ProjectResolver.Resolve del daemon HanniGram
 *  para que el scoping por proyecto sea consistente entre daemon y harness. */
function resolveProjectName(cwd: string): string | undefined {
	const r = spawnSync("git", ["config", "--get", "remote.origin.url"], { cwd, encoding: "utf-8" });
	if (r.status === 0 && r.stdout) {
		let url = r.stdout.trim().replace(/\/+$/, "");
		if (url.toLowerCase().endsWith(".git")) url = url.slice(0, -4);
		const parts = url.split(/[:/]/).filter(Boolean);
		if (parts.length >= 2) return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
		return url;
	}
	const dir = cwd.split(/[\\/]/).filter(Boolean).pop();
	return dir || undefined;
}

function fmtObs(r: { title: string; topic_key: string | null; learned: string | null }): string {
	return `- ${r.title}${r.topic_key ? ` (${r.topic_key})` : ""}${r.learned ? `: ${r.learned}` : ""}`;
}

/** Lee la memoria del proyecto actual (scope HanniGram) en DOS bloques:
 *  - decisiones/convenciones a RESPETAR (type='adr'): se inyectan siempre.
 *  - contexto/ideas en curso (el resto): índice ligero reciente (título + topic + learned).
 *  Nunca se devuelve contenido completo; el detalle se pide con mem_get_observation. */
function readProjectMemory(cwd: string): { adr: string[]; context: string[] } {
	const dbPath = join(homedir(), ".hannigram", "hannigram.db");
	if (!existsSync(dbPath)) return { adr: [], context: [] };
	const name = resolveProjectName(cwd);
	if (!name) return { adr: [], context: [] };
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return { adr: [], context: [] };
	}
	try {
		const adr = db
			.prepare(
				"SELECT o.title, o.topic_key, o.learned FROM observations o JOIN projects p ON p.id = o.project_id WHERE p.name = ? AND o.type = 'adr' ORDER BY o.updated_at_utc DESC LIMIT 12",
			)
			.all(name) as Array<{ title: string; topic_key: string | null; learned: string | null }>;
		const ctx = db
			.prepare(
				"SELECT o.title, o.topic_key, o.learned FROM observations o JOIN projects p ON p.id = o.project_id WHERE p.name = ? AND (o.type IS NULL OR o.type != 'adr') ORDER BY o.updated_at_utc DESC LIMIT 6",
			)
			.all(name) as Array<{ title: string; topic_key: string | null; learned: string | null }>;
		return { adr: adr.map(fmtObs), context: ctx.map(fmtObs) };
	} catch {
		return { adr: [], context: [] };
	} finally {
		db.close();
	}
}

export function createSoddExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("task", {
			description: "Gestiona la ficha sODD activa (new|status|next|done|promote)",
			handler: async (args, ctx) => {
				const [sub, ...rest] = args.trim().split(/\s+/);
				const cwd = ctx.cwd ?? process.cwd();
				const taskPath = getActiveTaskPath(cwd);
				const oddDir = getOddDir(cwd);

				switch (sub) {
					case "new": {
						const slug = rest[0];
						if (!slug) {
							ctx.ui.notify("Uso: /task new <slug>", "warning");
							return;
						}
						if (!safeTaskSlug(slug)) {
							ctx.ui.notify("El slug debe ser un nombre de ficha, no una ruta.", "warning");
							return;
						}
						const tasksDir = join(oddDir, "tasks");
						mkdirSync(tasksDir, { recursive: true });
						writeFileSync(
							join(tasksDir, `${slug}.md`),
							`---\ntopic_key: ${slug}\nstatus: active\nbase: \n---\n# ${slug}\nObjetivo: \nAlcance: \nVerify: \n\n## Pasos\n- [ ] S1 \n\n## Siguiente\nS1: \n`,
							{ flag: "wx" },
						);
						writeFileSync(join(oddDir, ".active"), slug);
						ctx.ui.notify(`Ficha creada: odd/tasks/${slug}.md`);
						return;
					}
					case "status": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa (odd/.active vacío)", "warning");
							return;
						}
						ctx.ui.notify(`Ficha activa: ${taskPath}`);
						return;
					}
					case "next": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa", "warning");
							return;
						}
						const content = readFileSync(taskPath, "utf-8");
						const next =
							content
								.split("## Siguiente")[1]
								?.split("\n")
								.filter((l) => l.trim())
								.slice(0, 3)
								.join("\n") ?? "";
						ctx.ui.notify(`Siguiente:\n${next}`);
						return;
					}
					case "done": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa", "warning");
							return;
						}
						const content = readFileSync(taskPath, "utf-8").replace(/^status: .*$/m, "status: done");
						writeFileSync(taskPath, content);
						writeFileSync(join(oddDir, ".active"), "");
						ctx.ui.notify("Ficha marcada como done. odd/.active limpiado.");
						return;
					}
					case "promote": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa", "warning");
							return;
						}
						const content = readFileSync(taskPath, "utf-8").replace(/^status: .*$/m, "status: promoted");
						writeFileSync(taskPath, content);
						ctx.ui.notify("Ficha marcada como promoted. Genera el feature document ODD a partir de ella.");
						return;
					}
					case "diff": {
						const base = taskPath ? readFileSync(taskPath, "utf-8").match(/^base: (\S+)/m)?.[1] : undefined;
						const r = spawnSync("git", ["diff", base ?? "HEAD", "--stat"], { cwd, encoding: "utf-8" });
						ctx.ui.notify(r.stdout || r.stderr || "(sin cambios)");
						return;
					}
					case "verify": {
						if (!taskPath) {
							ctx.ui.notify("No hay ficha activa", "warning");
							return;
						}
						const verifyCmd = readFileSync(taskPath, "utf-8").match(/^Verify: (.+)$/m)?.[1];
						if (!verifyCmd) {
							ctx.ui.notify("La ficha no tiene línea Verify:", "warning");
							return;
						}
						const r = spawnSync(verifyCmd, { cwd, encoding: "utf-8", shell: true });
						ctx.ui.notify(
							r.status === 0
								? `✓ verify OK: ${verifyCmd}`
								: `✗ verify falló (${r.status}): ${r.stderr || r.stdout}`,
						);
						return;
					}
					case "commit": {
						const msg = rest.join(" ");
						if (!msg) {
							ctx.ui.notify("Uso: /task commit <mensaje>", "warning");
							return;
						}
						const slug = getActiveSlug(cwd);
						if (!slug) {
							ctx.ui.notify("No hay ficha activa para commitear.", "warning");
							return;
						}
						const taskCommitPath = join(oddDir, "tasks", `${slug}.md`);
						const existingStaged = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
							cwd,
							encoding: "utf-8",
						});
						const taskRelativePath = taskCommitPath.replace(/\\/g, "/");
						if (
							existingStaged.status !== 0 ||
							existingStaged.stdout.split("\0").filter(Boolean).some((path) => path !== taskRelativePath)
						) {
							ctx.ui.notify("Hay otros cambios staged. Commitéalos aparte antes de /task commit.", "warning");
							return;
						}
						const r = spawnSync("git", ["add", "--", taskCommitPath], { cwd, encoding: "utf-8" });
						if (r.status !== 0) {
							ctx.ui.notify(r.stderr || "git add falló", "error");
							return;
						}
						const staged = spawnSync("git", ["diff", "--cached", "--name-only", "-z"], {
							cwd,
							encoding: "utf-8",
						});
						const stagedPaths = staged.stdout.split("\0").filter(Boolean);
						if (staged.status !== 0 || stagedPaths.some((path) => path !== taskRelativePath)) {
							ctx.ui.notify("Hay otros cambios staged. Commitéalos aparte antes de /task commit.", "warning");
							return;
						}
						const c = spawnSync("git", ["commit", "-m", msg], { cwd, encoding: "utf-8" });
						ctx.ui.notify(c.stdout || c.stderr || "commit hecho");
						return;
					}
					default:
						ctx.ui.notify("Uso: /task new|status|next|done|promote|diff|verify|commit", "warning");
				}
			},
		});

		// Reinyección de la ficha activa antes de compactar.
		pi.on("session_before_compact", (event, ctx) => {
			const cwd = ctx.cwd;
			const taskPath = getActiveTaskPath(cwd);
			if (!taskPath || !existsSync(taskPath)) return;
			const full = readFileSync(taskPath, "utf-8");
			const compact = compactTask(full);
			if (compact.trim()) {
				event.customInstructions = `${event.customInstructions ?? ""}\n\n[sODD ficha activa]\n${compact}\n[/sODD]`;
			}
		});

		// Inyectar la memoria de HanniGram del proyecto ACTUAL en cada llamada
		// (recall push, no pull). Escopada por proyecto (owner/repo del git remote)
		// con DOS bloques: decisiones/convenciones a respetar (type='adr', siempre)
		// y contexto reciente (índice ligero, sin contenido completo).
		pi.on("context", (event, ctx) => {
			const cwd = ctx.cwd;
			const hasSubagent = pi.getAllTools().some((tool) => tool.name === "subagent");
			const classification = [
				"[sODD guidance] Classify this request automatically; do not ask the user to run /task just to classify it.",
				"For a small, understood request that can be completed inline, work inline without creating a task sheet.",
				"Create or update odd/tasks/<slug>.md and odd/.active only when work is multi-step, multi-file, interruptible, or worth recovering; TODOs alone do not make work a feature task.",
				hasSubagent
					? "Delegate only when work is independent and the available subagent tool can make progress without conflicts; otherwise work inline."
					: "No subagent tool is available in this runtime; do not claim to delegate.",
			].join("\n");
			event.messages.push({ role: "system", content: classification, timestamp: Date.now() });
			const { adr, context } = readProjectMemory(cwd);
			if (adr.length === 0 && context.length === 0) return;
			const blocks: string[] = [];
			if (adr.length > 0) blocks.push(`[HanniGram · decisiones/convenciones — respeta esto]\n${adr.join("\n")}`);
			if (context.length > 0) blocks.push(`[HanniGram · contexto reciente]\n${context.join("\n")}`);
			event.messages.push({
				role: "system",
				content: `${blocks.join("\n\n")}\n[/HanniGram]`,
				timestamp: Date.now(),
			});
		});
	};
}

export default createSoddExtension();
