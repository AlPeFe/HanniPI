/**
 * hanni-sodd: Small ODD (Organic Driven Development) para HanniPI.
 *
 * Aporta:
 *  - Comandos `/task new|status|next|done|promote` para gestionar la ficha activa.
 *  - Reinyección de la ficha activa al contexto antes de compactar
 *    (hook `session_before_compact`), recortada a "Pasos" y "Siguiente".
 *
 * La ficha vive en `odd/tasks/<slug>.md`; `odd/.active` apunta al slug activo.
 * El protocolo completo está en `.pi/skills/sodd/SKILL.md`.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function createSoddExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerCommand("task", {
			description: "Gestiona la ficha sODD activa (new|status|next|done|promote)",
			handler: async (args, ctx) => {
				const [sub, ...rest] = args;
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
						const tasksDir = join(oddDir, "tasks");
						writeFileSync(join(tasksDir, `${slug}.md`), `---\ntopic_key: ${slug}\nstatus: active\nbase: \n---\n# ${slug}\nObjetivo: \nAlcance: \nVerify: \n\n## Pasos\n- [ ] S1 \n\n## Siguiente\nS1: \n`, { flag: "wx" });
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
						const next = content.split("## Siguiente")[1]?.split("\n").filter((l) => l.trim()).slice(0, 3).join("\n") ?? "";
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
						const base = taskPath ? readFileSync(taskPath, "utf-8").match(/^base: (S+)/m)?.[1] : undefined;
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
						ctx.ui.notify(r.status === 0 ? `✓ verify OK: ${verifyCmd}` : `✗ verify falló (${r.status}): ${r.stderr || r.stdout}`);
						return;
					}
					case "commit": {
						const msg = rest.join(" ");
						if (!msg) {
							ctx.ui.notify("Uso: /task commit <mensaje>", "warning");
							return;
						}
						const r = spawnSync("git", ["add", "-A"], { cwd, encoding: "utf-8" });
						if (r.status !== 0) {
							ctx.ui.notify(r.stderr || "git add falló", "error");
							return;
						}
						const c = spawnSync("git", ["commit", "-m", msg], { cwd, encoding: "utf-8" });
						ctx.ui.notify(c.stdout || c.stderr || "commit hecho");
						return;
					}
					default:
						ctx.ui.notify("Uso: /task new|status|next|done|promote", "warning");
				}
			},
		});

		// Reinyección de la ficha activa antes de compactar.
		pi.on("session_before_compact", (event) => {
			const cwd = process.cwd();
			const taskPath = getActiveTaskPath(cwd);
			if (!taskPath || !existsSync(taskPath)) return;
			const full = readFileSync(taskPath, "utf-8");
			const compact = compactTask(full);
			if (compact.trim()) {
				event.customInstructions = `${event.customInstructions ?? ""}\n\n[sODD ficha activa]\n${compact}\n[/sODD]`;
			}
		});

		// P0-4: inyectar las observaciones recientes de HanniGram del proyecto actual
		// como mensaje de sistema, solo cuando hay ficha sODD activa (para no inflar tokens).
		pi.on("context", (event) => {
			const cwd = process.cwd();
			if (!getActiveSlug(cwd)) return;
			const dbPath = join(homedir(), ".hannigram", "hannigram.db");
			if (!existsSync(dbPath)) return;
			try {
				const db = new DatabaseSync(dbPath, { readOnly: true });
				const rows = db
					.prepare(
						"SELECT title, topic_key, learned FROM observations ORDER BY updated_at_utc DESC LIMIT 5",
					)
					.all() as Array<{ title: string; topic_key: string | null; learned: string | null }>;
				db.close();
				if (rows.length === 0) return;
				const text = rows
					.map((r) => `- ${r.title}${r.topic_key ? ` (${r.topic_key})` : ""}${r.learned ? `: ${r.learned}` : ""}`)
					.join("\n");
				event.messages.push({
					role: "system",
					content: `[HanniGram memoria reciente]\n${text}\n[/HanniGram]`,
					timestamp: Date.now(),
				});
			} catch {
				// BD no disponible: no inyectar nada.
			}
		});
	};
}

export default createSoddExtension();
