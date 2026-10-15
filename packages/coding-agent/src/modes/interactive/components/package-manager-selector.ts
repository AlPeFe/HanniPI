import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { PiPackageSummary } from "../../../core/package-catalog.ts";
import { toNpmSource } from "../../../core/package-catalog.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/**
 * Gestor de paquetes/extensiones de HanniPI.
 * Lista los paquetes efectivos (configurados + defaults), muestra si hay
 * update disponible, permite instalar/actualizar/eliminar y buscar en el
 * catálogo de paquetes nativos de Pi (`pi.dev/packages` → npm `pi-package`).
 */

export interface PackageEntry {
	source: string;
	scope: "user" | "project" | "default";
	installed: boolean;
	updateAvailable: boolean;
}

/** Búsqueda en el catálogo; inyectada para poder testear sin red. */
export type PackageCatalogSearch = (query: string, signal?: AbortSignal) => Promise<PiPackageSummary[]>;

/** Retardo del filtrado mientras se escribe, para no golpear el registro npm. */
const CATALOG_DEBOUNCE_MS = 300;
const CATALOG_LIMIT = 12;

export class PackageManagerSelector extends Container implements Focusable {
	private entries: PackageEntry[] = [];
	private mode: "list" | "catalog" | "install" = "list";
	private selectedIndex = 0;
	private catalogIndex = 0;
	private catalogQuery = "";
	private catalogResults: PiPackageSummary[] = [];
	private catalogState: "idle" | "searching" | "error" = "idle";
	private catalogError = "";
	private catalogRequest = 0;
	private catalogAbort: AbortController | undefined;
	private catalogTimer: ReturnType<typeof setTimeout> | undefined;
	/** Fuentes instaladas desde este selector: el listado se refresca al reabrir. */
	private readonly installedNow = new Set<string>();
	private onClose: () => void;
	private requestRender: () => void;
	private onInstall: (source: string) => Promise<void>;
	private onUpdate: (source?: string) => Promise<void>;
	private onRemove: (source: string) => Promise<void>;
	private readonly searchCatalog: PackageCatalogSearch;
	private installInput = new Input();
	private catalogInput = new Input();
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.installInput.focused = value && this.mode === "install";
		this.catalogInput.focused = value && this.mode === "catalog";
	}

	constructor(
		entries: PackageEntry[],
		onClose: () => void,
		requestRender: () => void,
		onInstall: (source: string) => Promise<void>,
		onUpdate: (source?: string) => Promise<void>,
		onRemove: (source: string) => Promise<void>,
		searchCatalog?: PackageCatalogSearch,
	) {
		super();
		this.entries = entries;
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.onInstall = onInstall;
		this.onUpdate = onUpdate;
		this.onRemove = onRemove;
		this.searchCatalog = searchCatalog ?? (async () => []);
		this.buildLayout();
	}

	/** El listado se reconstruye cuando el llamador conoce los updates disponibles. */
	setEntries(entries: PackageEntry[]): void {
		this.entries = entries;
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, entries.length - 1));
		this.requestRender();
	}

	private buildLayout(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.bold(theme.fg("accent", this.mode === "catalog" ? "Catálogo de paquetes" : "Paquetes / Extensiones")),
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.renderBody());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("dim", this.hintLine())));
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private hintLine(): string {
		if (this.mode === "catalog") {
			return "escribir para filtrar · ↑↓ navegar · enter instalar · esc volver";
		}
		if (this.mode === "install") {
			return "fuente npm:... · git:... · ruta local · enter instalar · esc cancelar";
		}
		return "↑↓ navegar · c catálogo · i instalar por fuente · u actualizar · U todos · d eliminar · esc cerrar";
	}

	/** ¿Este paquete ya está configurado (o se acaba de instalar aquí)? */
	private isConfigured(name: string): boolean {
		const source = toNpmSource(name);
		if (this.installedNow.has(source)) return true;
		return this.entries.some((e) => e.source === source || e.source.startsWith(`${source}@`));
	}

	private renderBody(): Component {
		if (this.mode === "install") {
			const box = new Container();
			box.addChild(new Text(theme.fg("dim", "Fuente a instalar (npm:... o git:...):")));
			box.addChild(this.installInput);
			return box;
		}
		if (this.mode === "catalog") return this.renderCatalog();

		const lines: string[] = [];
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i]!;
			const marker = i === this.selectedIndex ? "› " : "  ";
			const scopeTag =
				e.scope === "default"
					? theme.fg("accent", "[default]")
					: e.scope === "project"
						? theme.fg("dim", "[proyecto]")
						: theme.fg("dim", "[global]");
			const status = e.updateAvailable
				? theme.fg("error", "↑ update")
				: e.installed
					? theme.fg("accent", "● activo")
					: theme.fg("muted", "○ no instalado");
			lines.push(`${marker}${truncateToWidth(e.source, 40)}  ${scopeTag}  ${status}`);
		}
		if (lines.length === 0) {
			lines.push(theme.fg("dim", "(sin paquetes)"));
		}
		lines.push("", theme.fg("dim", "c → buscar en el catálogo de paquetes de Pi (pi.dev/packages)"));
		return new Text(lines.join("\n"));
	}

	private renderCatalog(): Component {
		const box = new Container();
		box.addChild(new Text(theme.fg("dim", "Buscar en el catálogo (npm, keyword pi-package):")));
		box.addChild(this.catalogInput);

		const lines: string[] = [];
		if (this.catalogState === "searching") {
			lines.push(theme.fg("muted", "buscando…"));
		} else if (this.catalogState === "error") {
			lines.push(theme.fg("error", this.catalogError));
		} else if (this.catalogResults.length === 0) {
			lines.push(theme.fg("muted", "sin resultados"));
		} else {
			for (let i = 0; i < this.catalogResults.length; i++) {
				const pkg = this.catalogResults[i]!;
				const marker = i === this.catalogIndex ? "› " : "  ";
				const installed = this.isConfigured(pkg.name) ? theme.fg("accent", " [instalado]") : "";
				const downloads =
					pkg.monthlyDownloads === undefined
						? ""
						: theme.fg("muted", ` ${Math.round(pkg.monthlyDownloads / 1000)}k/mes`);
				lines.push(
					truncateToWidth(
						`${marker}${theme.bold(pkg.name)} ${theme.fg("dim", pkg.version)}${installed}${downloads}`,
						100,
					),
				);
				if (pkg.description) {
					const pad = " ".repeat(Math.min(4, visibleWidth(marker)));
					lines.push(theme.fg("muted", truncateToWidth(`${pad}${pkg.description}`, 100)));
				}
			}
		}
		box.addChild(new Text(lines.join("\n")));
		return box;
	}

	/** Abre el catálogo y lanza la búsqueda inicial (paquetes destacados). */
	private openCatalog(): void {
		this.mode = "catalog";
		this.catalogIndex = 0;
		this.catalogInput = new Input({ placeholder: "p. ej. mcp, memoria, web" });
		if (this.catalogQuery) this.catalogInput.setValue(this.catalogQuery);
		this.focused = this._focused;
		void this.runCatalogSearch(this.catalogQuery);
		this.requestRender();
	}

	private scheduleCatalogSearch(): void {
		if (this.catalogTimer) clearTimeout(this.catalogTimer);
		this.catalogTimer = setTimeout(() => {
			this.catalogTimer = undefined;
			void this.runCatalogSearch(this.catalogQuery);
		}, CATALOG_DEBOUNCE_MS);
	}

	private async runCatalogSearch(query: string): Promise<void> {
		// Una búsqueda vieja no puede pisar el resultado de la nueva.
		this.catalogAbort?.abort();
		const controller = new AbortController();
		this.catalogAbort = controller;
		const request = ++this.catalogRequest;
		this.catalogState = "searching";
		this.catalogError = "";
		this.requestRender();
		try {
			const results = await this.searchCatalog(query, controller.signal);
			if (request !== this.catalogRequest) return;
			this.catalogResults = results.slice(0, CATALOG_LIMIT);
			this.catalogIndex = Math.min(this.catalogIndex, Math.max(0, this.catalogResults.length - 1));
			this.catalogState = "idle";
		} catch (error) {
			if (request !== this.catalogRequest || controller.signal.aborted) return;
			this.catalogResults = [];
			this.catalogState = "error";
			this.catalogError = error instanceof Error ? error.message : String(error);
		}
		this.requestRender();
	}

	private installFromCatalog(): void {
		const pkg = this.catalogResults[this.catalogIndex];
		if (!pkg) return;
		const source = toNpmSource(pkg.name);
		this.installedNow.add(source);
		void this.onInstall(source).finally(() => this.requestRender());
		this.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (this.mode === "install") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.mode = "list";
				this.installInput = new Input();
				this.focused = this._focused;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const source = this.installInput.getValue().trim();
				this.mode = "list";
				this.installInput = new Input();
				if (source) {
					void this.onInstall(source).finally(() => this.requestRender());
				}
				this.requestRender();
				return;
			}
			this.installInput.handleInput(data);
			this.requestRender();
			return;
		}

		if (this.mode === "catalog") {
			if (kb.matches(data, "tui.select.cancel")) {
				this.catalogAbort?.abort();
				this.mode = "list";
				this.catalogInput = new Input();
				this.focused = this._focused;
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.up")) {
				this.catalogIndex = Math.max(0, this.catalogIndex - 1);
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.down")) {
				this.catalogIndex = Math.min(Math.max(0, this.catalogResults.length - 1), this.catalogIndex + 1);
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				this.installFromCatalog();
				return;
			}
			this.catalogInput.handleInput(data);
			const next = this.catalogInput.getValue();
			if (next !== this.catalogQuery) {
				this.catalogQuery = next;
				this.scheduleCatalogSearch();
			}
			this.requestRender();
			return;
		}

		if (kb.matches(data, "tui.select.cancel")) {
			this.onClose();
			return;
		}
		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.requestRender();
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
			this.requestRender();
			return;
		}
		if (data === "c") {
			this.openCatalog();
			return;
		}
		if (data === "u") {
			const e = this.entries[this.selectedIndex];
			if (e) {
				void this.onUpdate(e.source).finally(() => {
					this.requestRender();
				});
			}
			return;
		}
		if (data === "U") {
			void this.onUpdate().finally(() => {
				this.requestRender();
			});
			return;
		}
		if (data === "i") {
			this.mode = "install";
			this.installInput = new Input();
			this.focused = this._focused;
			this.requestRender();
			return;
		}
		if (data === "d") {
			const e = this.entries[this.selectedIndex];
			if (e && e.scope !== "default") {
				void this.onRemove(e.source).finally(() => {
					this.requestRender();
				});
			}
			return;
		}
	}

	render(width: number): string[] {
		this.buildLayout();
		return super.render(width);
	}
}
