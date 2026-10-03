import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/**
 * Explorador de la memoria HanniGram (~/.hannigram/hannigram.db).
 * Lee la BD en modo read-only con node:sqlite y navega por
 * Proyectos → Observaciones → Detalle, con búsqueda FTS5.
 * Modelado sobre SessionList (session-selector.ts).
 */

interface ProjectRow {
	id: number;
	name: string;
	n: number;
	last: string | null;
}

interface ObservationRow {
	id: number;
	title: string;
	topic_key: string | null;
	updated_at_utc: string;
}

interface SessionRow {
	id: number;
	started_at_utc: string;
	summary: string | null;
}

type View = "projects" | "observations" | "detail" | "sessions";

export class MemoryExplorer extends Container implements Focusable {
	private db: DatabaseSync;
	private view: View = "projects";
	private projects: ProjectRow[] = [];
	private observations: ObservationRow[] = [];
	private sessions: SessionRow[] = [];
	private selectedIndex = 0;
	private currentProjectId: number | null = null;
	private currentObservation: ObservationRow | null = null;
	private query = "";
	private searchInput = new Input();
	private searching = false;
	private onClose: () => void;
	private requestRender: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.searching;
	}

	constructor(db: DatabaseSync, onClose: () => void, requestRender: () => void) {
		super();
		this.db = db;
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.loadProjects();
		this.buildLayout();
	}

	private loadProjects(): void {
		this.projects = this.db
			.prepare(
				"SELECT p.id id, p.name name, COUNT(o.id) n, MAX(o.updated_at_utc) last FROM projects p LEFT JOIN observations o ON o.project_id = p.id GROUP BY p.id ORDER BY last DESC",
			)
			.all() as unknown as ProjectRow[];
	}

	private loadObservations(projectId: number): void {
		this.observations = this.db
			.prepare(
				"SELECT id, title, topic_key, updated_at_utc FROM observations WHERE project_id = ? ORDER BY updated_at_utc DESC LIMIT 100",
			)
			.all(projectId) as unknown as ObservationRow[];
	}

	private loadSessions(projectId: number): void {
		this.sessions = this.db
			.prepare(
				"SELECT id, started_at_utc, summary FROM sessions WHERE project_id = ? ORDER BY started_at_utc DESC LIMIT 100",
			)
			.all(projectId) as unknown as SessionRow[];
	}

	private searchObservations(): void {
		if (!this.query.trim()) {
			this.loadObservations(this.currentProjectId ?? 0);
			return;
		}
		// Escapar términos FTS5: envolver cada término entre comillas dobles.
		const escaped = this.query
			.trim()
			.split(/\s+/)
			.map((t) => `"${t.replace(/"/g, "")}"`)
			.join(" ");
		const projectId = this.currentProjectId;
		this.observations = this.db
			.prepare(
				"SELECT o.id id, o.title title, o.topic_key topic_key, o.updated_at_utc updated_at_utc FROM observations_fts JOIN observations o ON o.id = observations_fts.rowid WHERE observations_fts MATCH ? AND (? IS NULL OR o.project_id = ?) ORDER BY bm25(observations_fts) LIMIT 100",
			)
			.all(escaped, projectId, projectId) as unknown as ObservationRow[];
	}

	private buildLayout(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(this.renderHeader());
		this.addChild(new Spacer(1));
		this.addChild(this.renderBody());
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private renderHeader(): Component {
		const title =
			this.view === "projects"
				? "Memoria · Proyectos"
				: this.view === "observations"
					? `Memoria · Observaciones${this.query ? ` · ~${this.query}` : ""}`
					: this.view === "sessions"
						? "Memoria · Sesiones"
						: "Memoria · Detalle";
		return new Text(theme.bold(theme.fg("accent", title)));
	}

	private renderBody(): Component {
		const lines: string[] = [];
		if (this.view === "projects") {
			for (let i = 0; i < this.projects.length; i++) {
				const p = this.projects[i];
				const marker = i === this.selectedIndex ? "› " : "  ";
				lines.push(`${marker}${truncateToWidth(p.name, 40)}  (${p.n})  ${p.last ?? ""}`);
			}
		} else if (this.view === "observations") {
			for (let i = 0; i < this.observations.length; i++) {
				const o = this.observations[i];
				const marker = i === this.selectedIndex ? "› " : "  ";
				lines.push(`${marker}${truncateToWidth(o.title, 50)}  ${o.topic_key ?? ""}`);
			}
		} else if (this.view === "sessions") {
			for (let i = 0; i < this.sessions.length; i++) {
				const s = this.sessions[i];
				const marker = i === this.selectedIndex ? "› " : "  ";
				lines.push(`${marker}${s.started_at_utc}  ${truncateToWidth(s.summary ?? "", 50)}`);
			}
		} else if (this.view === "detail" && this.currentObservation) {
			const o = this.currentObservation;
			lines.push(theme.bold(o.title));
			lines.push("");
			lines.push(`${theme.fg("dim", "topic_key:")} ${o.topic_key ?? ""}`);
			lines.push(`${theme.fg("dim", "updated:")} ${o.updated_at_utc}`);
			lines.push("");
			const detail = this.getObservationDetail(o.id);
			lines.push(...detail.split("\n").slice(0, 20));
		}
		if (lines.length === 0) {
			lines.push(theme.fg("dim", "(vacío)"));
		}
		const body = new Text(lines.join("\n"));
		if (this.searching) {
			const searchBox = new Container();
			searchBox.addChild(this.searchInput);
			searchBox.addChild(new Spacer(1));
			searchBox.addChild(body);
			return searchBox;
		}
		return body;
	}

	private getObservationDetail(id: number): string {
		const row = this.db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		if (!row) return "";
		const parts: string[] = [];
		for (const key of ["what", "why", "where_", "learned", "content"]) {
			const v = row[key];
			if (v) parts.push(`${theme.fg("dim", `${key}:`)} ${String(v)}`);
		}
		return parts.join("\n");
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.searching) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.searching = false;
				this.query = "";
				this.searchInput = new Input();
				this.searchObservations();
				this.requestRender();
				return;
			}
			this.searchInput.handleInput(data);
			this.query = this.searchInput.getValue();
			this.searchObservations();
			this.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.cancel")) {
			if (this.view === "detail") {
				this.view = "observations";
			} else if (this.view === "observations" || this.view === "sessions") {
				this.view = "projects";
				this.currentProjectId = null;
			} else {
				this.onClose();
			}
			this.selectedIndex = 0;
			this.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			const len =
				this.view === "projects"
					? this.projects.length
					: this.view === "observations"
						? this.observations.length
						: this.view === "sessions"
							? this.sessions.length
							: 0;
			this.selectedIndex = Math.min(len - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.confirm")) {
			if (this.view === "projects") {
				const p = this.projects[this.selectedIndex];
				if (p) {
					this.currentProjectId = p.id;
					this.view = "observations";
					this.loadObservations(p.id);
					this.loadSessions(p.id);
					this.selectedIndex = 0;
				}
			} else if (this.view === "observations") {
				const o = this.observations[this.selectedIndex];
				if (o) {
					this.currentObservation = o;
					this.view = "detail";
				}
			}
			this.requestRender();
			return;
		}

		if (kb.matches(data, "tui.input.tab")) {
			if (this.view === "observations" || this.view === "sessions") {
				this.view = this.view === "observations" ? "sessions" : "observations";
				this.selectedIndex = 0;
				this.requestRender();
			}
			return;
		}

		if (data === "/") {
			this.searching = true;
			this.searchInput = new Input();
			this.requestRender();
			return;
		}
	}

	render(width: number): string[] {
		this.buildLayout();
		return super.render(width);
	}
}

/** Abre la BD de memoria y monta el explorador en la TUI. */
export function openMemoryExplorer(
	onClose: () => void,
	requestRender: () => void,
	showError: (msg: string) => void,
): { component: Component; focus: Component } | null {
	const dbPath = join(homedir(), ".hannigram", "hannigram.db");
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(dbPath, { readOnly: true });
	} catch (error) {
		showError(`BD de memoria no disponible (${dbPath}): ${error instanceof Error ? error.message : String(error)}`);
		return null;
	}
	const explorer = new MemoryExplorer(db, onClose, requestRender);
	return { component: explorer, focus: explorer };
}
