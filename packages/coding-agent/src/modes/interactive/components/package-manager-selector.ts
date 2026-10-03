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
 * Gestor de paquetes/extensiones de HanniPI.
 * Lista los paquetes efectivos (configurados + defaults), muestra si hay
 * update disponible, y permite instalar/actualizar/eliminar.
 */

interface PackageEntry {
	source: string;
	scope: "user" | "project" | "default";
	installed: boolean;
	updateAvailable: boolean;
}

export class PackageManagerSelector extends Container implements Focusable {
	private entries: PackageEntry[] = [];
	private selectedIndex = 0;
	private onClose: () => void;
	private requestRender: () => void;
	private onInstall: (source: string) => Promise<void>;
	private onUpdate: (source?: string) => Promise<void>;
	private onRemove: (source: string) => Promise<void>;
	private installInput = new Input();
	private installingMode = false;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.installInput.focused = value && this.installingMode;
	}

	constructor(
		entries: PackageEntry[],
		onClose: () => void,
		requestRender: () => void,
		onInstall: (source: string) => Promise<void>,
		onUpdate: (source?: string) => Promise<void>,
		onRemove: (source: string) => Promise<void>,
	) {
		super();
		this.entries = entries;
		this.onClose = onClose;
		this.requestRender = requestRender;
		this.onInstall = onInstall;
		this.onUpdate = onUpdate;
		this.onRemove = onRemove;
		this.buildLayout();
	}

	private buildLayout(): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Paquetes / Extensiones"))));
		this.addChild(new Spacer(1));
		this.addChild(this.renderBody());
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					"↑↓ navegar · enter detalle · u actualizar · U todos · i instalar · d eliminar · esc cerrar",
				),
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	private renderBody(): Component {
		const lines: string[] = [];
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i];
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
		if (this.installingMode) {
			const box = new Container();
			box.addChild(new Text(theme.fg("dim", "Fuente a instalar (npm:... o git:...):")));
			box.addChild(this.installInput);
			box.addChild(new Text(lines.join("\n")));
			return box;
		}
		return new Text(lines.join("\n"));
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (this.installingMode) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.installingMode = false;
				this.installInput = new Input();
				this.requestRender();
				return;
			}
			if (kb.matches(data, "tui.select.confirm")) {
				const source = this.installInput.getValue().trim();
				this.installingMode = false;
				this.installInput = new Input();
				if (source) {
					void this.onInstall(source).finally(() => {
						this.requestRender();
					});
				}
				this.requestRender();
				return;
			}
			this.installInput.handleInput(data);
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
			this.installingMode = true;
			this.installInput = new Input();
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
