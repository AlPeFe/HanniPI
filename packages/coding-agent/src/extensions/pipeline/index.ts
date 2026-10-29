/**
 * pipeline: cola secuencial de roles sobre la tool `subagent` (SPEC-006, fase 1).
 *
 * La captura de referencia no es un kanban: es un banco de trabajo donde un prompt se
 * reparte en una secuencia de roles visibles, con una tarjeta por rol y un estado por
 * tarjeta. Esto es lo que añade esta extensión, y nada más:
 *
 *  - Lista declarativa de roles (explorer → builder → reviewer), configurable en
 *    `settings.json` (`pipeline.roles`) y, por defecto, esa terna.
 *  - Ejecución ESTRICTAMENTE secuencial: un solo rol en vuelo; el resto en `queued` con
 *    el subestado humano "Waiting its turn". No hay un segundo mecanismo de agentes: el
 *    rol se lanza pidiendo al agente una llamada a la tool `subagent` que ya existe, y la
 *    cola no libera el siguiente rol hasta que esa llamada termina. Además, mientras hay
 *    un rol en vuelo, cualquier otra llamada a `subagent` se bloquea (`tool_call`), así
 *    que la invariante "nunca dos roles a la vez" no depende de la buena voluntad del modelo.
 *  - Estado por tarjeta queued → running → done | error | cancelled.
 *  - Degradación limpia: la tool `subagent` no es built-in. Si el runtime no la expone, la
 *    cola se queda entera en `queued` con un aviso visible ("subagent no instalado") en el
 *    widget: no se pide ningún turno, no se lanza nada y no se espera el timeout.
 *  - `renderPipeline` generaliza el `renderFleet` de hanniorq: pinta TAMBIÉN las tarjetas
 *    en cola (antes sólo se pintaban las que ya habían arrancado), con rol y estado.
 *  - Cancelar una tarjeta la saca de la cola; si está corriendo, aborta ese subagente y
 *    deja el pipeline cancelado sin arrastrar a los siguientes a un estado de error.
 *  - El handoff se guarda en la ficha sODD activa (`odd/tasks/<slug>.md`, sección
 *    "## Pipeline" entre marcadores), no en un store nuevo: si se corta la sesión, la cola
 *    se reconstruye de la ficha con `/pipeline resume`.
 *
 * Coste de tokens: CERO. No registra tools ni toca el system prompt; es UI + reuso.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Key } from "@earendil-works/pi-tui";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ExtensionUIContext,
} from "../../core/extensions/types.ts";
import type { Settings } from "../../core/settings-manager.ts";

// ---------------------------------------------------------------------------
// Roles (configuración, no superficie de esquema)
// ---------------------------------------------------------------------------

export interface PipelineRole {
	/** Id estable: se guarda en la ficha y es el `agent` que se le pasa a `subagent`. */
	id: string;
	/** Nombre visible en la tarjeta. */
	label: string;
	/** Icono de rol (binoculares / cubo / lupa en la captura). */
	icon: string;
	/** Qué hace el rol. Se antepone a la tarea en el prompt del subagente. */
	prompt: string;
}

/** La terna por defecto de la captura: leer y mapear, implementar, revisar el diff. */
export const DEFAULT_ROLES: readonly PipelineRole[] = [
	{
		id: "explorer",
		label: "Explorer",
		icon: "◎",
		prompt:
			"Explora y mapea: lee los ficheros relevantes y devuelve un mapa breve (rutas, símbolos, riesgos). No edites nada.",
	},
	{
		id: "builder",
		label: "Builder",
		icon: "▣",
		prompt: "Implementa el cambio mínimo que cumple la tarea. Edita sólo lo necesario y di qué tocaste.",
	},
	{
		id: "reviewer",
		label: "Reviewer",
		icon: "⌕",
		prompt: "Revisa el diff resultante contra la tarea: bugs, casos límite y tokens de prompt. No edites nada.",
	},
];

/** Icono por defecto cuando el rol configurado no trae uno. */
const FALLBACK_ICON = "◇";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lee los roles de `settings.pipeline.roles`. Cualquier entrada inválida se ignora y, si no
 * queda ninguna, se usa la terna por defecto: un settings roto no puede dejar sin pipeline.
 */
export function resolveRoles(settings: Pick<Settings, "pipeline"> | undefined): PipelineRole[] {
	const raw = settings?.pipeline?.roles;
	if (!Array.isArray(raw)) return [...DEFAULT_ROLES];
	const roles: PipelineRole[] = [];
	for (const entry of raw) {
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" ? entry.id.trim() : "";
		if (!id || !/^[A-Za-z0-9_-]+$/.test(id)) continue;
		if (roles.some((role) => role.id === id)) continue;
		const known = DEFAULT_ROLES.find((role) => role.id === id);
		const label = typeof entry.label === "string" && entry.label.trim() ? entry.label.trim() : (known?.label ?? id);
		const icon =
			typeof entry.icon === "string" && entry.icon.trim() ? entry.icon.trim() : (known?.icon ?? FALLBACK_ICON);
		const prompt = typeof entry.prompt === "string" ? entry.prompt : (known?.prompt ?? "");
		roles.push({ id, label, icon, prompt });
	}
	return roles.length > 0 ? roles : [...DEFAULT_ROLES];
}

/** El rol de una tarjeta; si los ajustes cambiaron a mitad, se inventa uno legible. */
export function roleFor(roles: readonly PipelineRole[], id: string): PipelineRole {
	return roles.find((role) => role.id === id) ?? { id, label: id, icon: FALLBACK_ICON, prompt: "" };
}

// ---------------------------------------------------------------------------
// Tarjetas y cola
// ---------------------------------------------------------------------------

export type CardStatus = "queued" | "running" | "done" | "error" | "cancelled";

const CARD_STATUSES: readonly CardStatus[] = ["queued", "running", "done", "error", "cancelled"];

export interface PipelineCard {
	/** Número de tarjeta dentro del pipeline: "1", "2", "3"… */
	id: string;
	/** Id del rol. */
	role: string;
	status: CardStatus;
	/** Subestado humano / motivo (error, "interrumpido", "no arrancada"…). */
	note?: string;
}

/** Una transición de estado, con la foto de qué estaba en vuelo justo después. */
export interface QueueEvent {
	seq: number;
	at: number;
	card: string;
	type: CardStatus;
	/** Ids de las tarjetas `running` tras la transición. La invariante es `length <= 1`. */
	running: string[];
}

export interface PipelineState {
	task: string;
	stoppedAt?: string;
	updatedAt: string;
	cards: PipelineCard[];
}

export interface PipelineQueueInit {
	task: string;
	cards: Array<{ role: string; status?: CardStatus; note?: string }>;
	stoppedAt?: string;
}

function isCardStatus(value: string): value is CardStatus {
	return (CARD_STATUSES as readonly string[]).includes(value);
}

/**
 * Cola de tarjetas: el único sitio donde viven los estados. No sabe nada de IO, de TUI ni de
 * subagentes, así que los tests la miran directamente (los eventos de `history` son el
 * "assert sobre los eventos de la cola" de la spec).
 */
export class PipelineQueue {
	readonly task: string;
	/** Transiciones, en orden. Cada evento lleva cuántas tarjetas había en vuelo. */
	readonly history: QueueEvent[] = [];
	private readonly cards: PipelineCard[];
	private stopped: string | undefined;
	private seq = 0;
	private readonly now: () => number;

	constructor(init: PipelineQueueInit, options: { now?: () => number } = {}) {
		this.task = init.task;
		this.stopped = init.stoppedAt;
		this.now = options.now ?? (() => Date.now());
		this.cards = init.cards.map((card, index) => ({
			id: `${index + 1}`,
			role: card.role,
			status: card.status ?? "queued",
			...(card.note ? { note: card.note } : {}),
		}));
	}

	get all(): readonly PipelineCard[] {
		return this.cards;
	}

	find(idOrRole: string): PipelineCard | undefined {
		return this.cards.find((card) => card.id === idOrRole) ?? this.cards.find((card) => card.role === idOrRole);
	}

	runningCards(): PipelineCard[] {
		return this.cards.filter((card) => card.status === "running");
	}

	/** La siguiente tarjeta en cola, o undefined si no queda trabajo. */
	nextQueued(): PipelineCard | undefined {
		return this.cards.find((card) => card.status === "queued");
	}

	get stoppedAt(): string | undefined {
		return this.stopped;
	}

	markRunning(id: string): PipelineCard {
		const card = this.expect(id);
		if (card.status === "queued") {
			card.status = "running";
			delete card.note;
			this.record(card);
		}
		return card;
	}

	markDone(id: string, note?: string): void {
		const card = this.expect(id);
		// Una tarjeta cancelada no vuelve a "done": la cancelación manda.
		if (card.status !== "running" && card.status !== "queued") return;
		card.status = "done";
		if (note) card.note = note;
		else delete card.note;
		this.record(card);
	}

	markError(id: string, note?: string): void {
		const card = this.expect(id);
		if (card.status === "cancelled") return;
		card.status = "error";
		if (note) card.note = note;
		this.record(card);
	}

	/**
	 * Devuelve una tarjeta a `queued` con una nota. Se usa cuando el rol no llegó a
	 * lanzarse (falta la tool `subagent`): `queued` es el estado honesto, no `error`.
	 * Una tarjeta cancelada no resucita.
	 */
	requeue(id: string, note?: string): void {
		const card = this.expect(id);
		if (card.status === "cancelled") return;
		card.status = "queued";
		if (note) card.note = note;
		else delete card.note;
		this.record(card);
	}

	/**
	 * Deja toda la cola pendiente en `queued` con el mismo aviso, sin mover estados: es la
	 * degradación por falta de `subagent`, donde nadie debe quedar en `error` ni en vuelo.
	 */
	holdAll(note: string): void {
		for (const card of this.cards) {
			if (card.status !== "queued") continue;
			card.note = note;
		}
	}

	/**
	 * Cancela una tarjeta. Si estaba en cola, sólo sale ella. Si estaba corriendo, aborta el
	 * pipeline: ella y todo lo que quedaba en cola pasan a `cancelled` y se anota por dónde se
	 * quedó (para la ficha). `aborted` es la señal para abortar el subagente en vuelo.
	 */
	cancel(idOrRole: string): { aborted: boolean; cancelled: string[] } {
		const card = this.find(idOrRole);
		if (!card || (card.status !== "queued" && card.status !== "running")) {
			return { aborted: false, cancelled: [] };
		}
		const cancelled: string[] = [];
		const running = card.status === "running";
		card.status = "cancelled";
		card.note = running ? "cancelada en vuelo" : "cancelada en cola";
		cancelled.push(card.id);
		this.record(card);
		if (running) {
			this.stopped = `${card.id} · ${card.role}`;
			for (const other of this.cards) {
				if (other.status !== "queued") continue;
				other.status = "cancelled";
				other.note = "no arrancada: pipeline cancelado";
				cancelled.push(other.id);
				this.record(other);
			}
		}
		return { aborted: running, cancelled };
	}

	snapshot(): PipelineState {
		return {
			task: this.task,
			...(this.stopped ? { stoppedAt: this.stopped } : {}),
			updatedAt: new Date(this.now()).toISOString(),
			cards: this.cards.map((card) => ({ ...card })),
		};
	}

	private expect(id: string): PipelineCard {
		const card = this.cards.find((candidate) => candidate.id === id);
		if (!card) throw new Error(`tarjeta desconocida: ${id}`);
		return card;
	}

	private record(card: PipelineCard): void {
		this.history.push({
			seq: ++this.seq,
			at: this.now(),
			card: card.id,
			type: card.status,
			running: this.runningCards().map((running) => running.id),
		});
	}
}

// ---------------------------------------------------------------------------
// Runner: estrictamente secuencial
// ---------------------------------------------------------------------------

export interface PipelineDispatchInput {
	card: PipelineCard;
	role: PipelineRole;
	/** Tarea base de la pipeline (la misma para todos los roles). */
	task: string;
	/** Posición de la tarjeta ("2" de 3) y total, para el mensaje de turno. */
	position: number;
	total: number;
	signal: AbortSignal;
}

export interface PipelineDispatchResult {
	ok: boolean;
	note?: string;
	/**
	 * El rol no se pudo ni intentar (falta la tool `subagent`). La tarjeta vuelve a `queued`
	 * y la cola se para: no es un error del trabajo, es un prerrequisito ausente.
	 */
	blocked?: boolean;
}

/**
 * Aviso único de degradación. Va en la nota de cada tarjeta y en el widget, así que el
 * usuario ve por qué la cola no avanza sin leer logs.
 */
export const SUBAGENT_MISSING = "subagent no instalado";

/** Lo mínimo que hace falta del runtime para saber si la tool está instalada. */
export interface ToolSource {
	getAllTools?: () => ReadonlyArray<{ name: string } | undefined> | undefined;
}

/**
 * ¿Está `subagent` entre las tools del runtime? La pipeline la reusa; en HanniPI no es
 * built-in (es `examples/extensions/subagent`), así que puede faltar. Si el runtime no
 * expone `getAllTools`, se asume disponible: no se rompe nada por no poder comprobarlo.
 */
export function subagentAvailable(source: ToolSource | undefined): boolean {
	if (typeof source?.getAllTools !== "function") return true;
	try {
		return (source.getAllTools() ?? []).some((tool) => tool?.name === "subagent");
	} catch {
		return true;
	}
}

/** Lanza un rol. La implementación real pide la llamada a `subagent` y espera a que acabe. */
export type PipelineDispatch = (input: PipelineDispatchInput) => Promise<PipelineDispatchResult>;

export interface PipelineRunnerOptions {
	queue: PipelineQueue;
	roles: readonly PipelineRole[];
	dispatch: PipelineDispatch;
	/** Se llama tras cada transición (repintar el widget, persistir la ficha). */
	onChange?: () => void;
}

/**
 * Bucle de turnos: una tarjeta en vuelo como máximo. El siguiente rol no se marca `running`
 * hasta que `dispatch` del anterior ha resuelto, y si el pipeline quedó cancelado no se
 * libera nada más.
 */
export class PipelineRunner {
	readonly queue: PipelineQueue;
	private readonly roles: readonly PipelineRole[];
	private readonly dispatch: PipelineDispatch;
	private readonly onChange: (() => void) | undefined;
	private readonly controller = new AbortController();
	/** Verdadero mientras el bucle está vivo (evita dos `run()` solapados). */
	running = false;

	constructor(options: PipelineRunnerOptions) {
		this.queue = options.queue;
		this.roles = options.roles;
		this.dispatch = options.dispatch;
		this.onChange = options.onChange;
	}

	async run(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			for (;;) {
				const card = this.queue.nextQueued();
				if (!card) break;
				const role = roleFor(this.roles, card.role);
				this.queue.markRunning(card.id);
				this.onChange?.();
				let result: PipelineDispatchResult;
				try {
					result = await this.dispatch({
						card,
						role,
						task: this.queue.task,
						position: Number(card.id),
						total: this.queue.all.length,
						signal: this.controller.signal,
					});
				} catch (error) {
					result = { ok: false, note: error instanceof Error ? error.message : String(error) };
				}
				// Si la cancelación llegó mientras estaba en vuelo, la tarjeta ya es `cancelled`
				// y no se toca: el estado que puso el usuario manda.
				if (card.status === "running") {
					if (result.blocked) {
						// Prerrequisito ausente: la tarjeta vuelve a la cola con el aviso, no a error.
						this.queue.requeue(card.id, result.note ?? SUBAGENT_MISSING);
					} else if (result.ok) this.queue.markDone(card.id);
					else this.queue.markError(card.id, result.note);
				}
				this.onChange?.();
				if (result.blocked) {
					// Nadie más arranca: los pendientes se quedan en `queued` con el mismo aviso.
					this.queue.holdAll(result.note ?? SUBAGENT_MISSING);
					this.onChange?.();
					break;
				}
				if (this.queue.stoppedAt) break;
			}
		} finally {
			this.running = false;
			this.onChange?.();
		}
	}

	/** Cancela una tarjeta; si estaba corriendo, aborta el subagente en vuelo. */
	cancel(idOrRole: string): { aborted: boolean; cancelled: string[] } {
		const outcome = this.queue.cancel(idOrRole);
		if (outcome.aborted) this.controller.abort();
		this.onChange?.();
		return outcome;
	}
}

// ---------------------------------------------------------------------------
// Persistencia en la ficha sODD activa
// ---------------------------------------------------------------------------

const PIPELINE_BEGIN = "<!-- pipeline:begin -->";
const PIPELINE_END = "<!-- pipeline:end -->";
const PIPELINE_TITLE = "## Pipeline";
const MAX_TASK_CHARS = 2_000;

/** Una línea: la ficha es markdown de una entrada por tarjeta, nada de saltos dentro. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function renderPipelineSection(state: PipelineState): string {
	const lines = [
		PIPELINE_TITLE,
		"",
		PIPELINE_BEGIN,
		`pipeline_updated: ${state.updatedAt}`,
		`pipeline_task: ${oneLine(state.task).slice(0, MAX_TASK_CHARS)}`,
	];
	if (state.stoppedAt) lines.push(`pipeline_stopped_at: ${oneLine(state.stoppedAt)}`);
	for (const card of state.cards) {
		const note = card.note ? ` · ${oneLine(card.note)}` : "";
		lines.push(`- [${card.status}] ${card.id} · ${card.role}${note}`);
	}
	lines.push(PIPELINE_END);
	return lines.join("\n");
}

/**
 * Escribe (o sustituye) la sección `## Pipeline` de la ficha. El resto de la ficha queda
 * intacto: la ficha es la fuente de verdad de sODD y aquí sólo se le añade un bloque.
 */
export function upsertPipelineSection(text: string, state: PipelineState): string {
	const section = renderPipelineSection(state);
	const begin = text.indexOf(PIPELINE_BEGIN);
	const end = text.indexOf(PIPELINE_END);
	if (begin !== -1 && end > begin) {
		let head = text.slice(0, begin);
		const title = head.lastIndexOf(PIPELINE_TITLE);
		if (title !== -1 && head.slice(title).trim() === PIPELINE_TITLE) head = head.slice(0, title);
		const tail = text.slice(end + PIPELINE_END.length).replace(/^\s*\n/, "");
		const joined = `${head.replace(/\s*$/, "")}\n\n${section}${tail ? `\n\n${tail.replace(/\s*$/, "")}` : ""}`;
		return `${joined.replace(/\s*$/, "")}\n`;
	}
	return `${text.replace(/\s*$/, "")}\n\n${section}\n`;
}

/** Lee la sección `## Pipeline` de una ficha. `undefined` si la ficha no tiene pipeline. */
export function parsePipelineSection(text: string): PipelineState | undefined {
	const begin = text.indexOf(PIPELINE_BEGIN);
	const end = text.indexOf(PIPELINE_END);
	if (begin === -1 || end === -1 || end < begin) return undefined;
	const body = text.slice(begin + PIPELINE_BEGIN.length, end);
	let task = "";
	let updatedAt = "";
	let stoppedAt: string | undefined;
	const rawCards: Array<{ id: string; role: string; status: CardStatus; note?: string }> = [];
	for (const raw of body.split("\n")) {
		const line = raw.trim();
		const field = /^(pipeline_[a-z_]+):\s*(.*)$/.exec(line);
		if (field) {
			const [, key, value] = field;
			if (key === "pipeline_task") task = value ?? "";
			else if (key === "pipeline_updated") updatedAt = value ?? "";
			else if (key === "pipeline_stopped_at") stoppedAt = value || undefined;
			continue;
		}
		const card = /^- \[([a-z]+)\] (\S+) · ([A-Za-z0-9_-]+)(?: · (.*))?$/.exec(line);
		if (card && isCardStatus(card[1])) {
			rawCards.push({
				id: card[2],
				role: card[3],
				status: card[1],
				...(card[4] ? { note: card[4] } : {}),
			});
		}
	}
	if (rawCards.length === 0 && !task) return undefined;
	return { task, updatedAt, stoppedAt, cards: rawCards };
}

function getOddDir(cwd: string): string {
	return join(cwd, "odd");
}

/** Slug de la ficha activa (`odd/.active`), con la misma regla que sODD. */
export function activeSheetSlug(cwd: string): string | undefined {
	const activePath = join(getOddDir(cwd), ".active");
	if (!existsSync(activePath)) return undefined;
	const slug = readFileSync(activePath, "utf-8").trim();
	return slug && basename(slug) === slug ? slug : undefined;
}

export function activeSheetPath(cwd: string, slug = activeSheetSlug(cwd)): string | undefined {
	return slug ? join(getOddDir(cwd), "tasks", `${slug}.md`) : undefined;
}

/** Estado del pipeline guardado en la ficha activa (o `undefined` si no hay ficha/pipeline). */
export function readPipelineFromSheet(cwd: string): { slug: string; state: PipelineState } | undefined {
	const slug = activeSheetSlug(cwd);
	const path = activeSheetPath(cwd, slug);
	if (!slug || !path || !existsSync(path)) return undefined;
	const state = parsePipelineSection(readFileSync(path, "utf-8"));
	return state ? { slug, state } : undefined;
}

/** Persiste el estado en la ficha activa. Devuelve el slug, o undefined si no hay ficha. */
export function writePipelineToSheet(cwd: string, state: PipelineState): string | undefined {
	const slug = activeSheetSlug(cwd);
	const path = activeSheetPath(cwd, slug);
	if (!slug || !path || !existsSync(path)) return undefined;
	writeFileSync(path, upsertPipelineSection(readFileSync(path, "utf-8"), state));
	return slug;
}

/**
 * Reconstruye la cola desde un estado guardado. Una tarjeta `running` en la ficha es una
 * sesión que se cortó a mitad: vuelve a `queued` (nada está en vuelo tras un reinicio).
 */
export function restoreQueue(state: PipelineState, options: { now?: () => number } = {}): PipelineQueue {
	// `stoppedAt` se deja atrás a propósito: reanudar es seguir, no volver a pararse en el
	// mismo sitio. El "por dónde se quedó" queda escrito en las notas de las tarjetas.
	return new PipelineQueue(
		{
			task: state.task,
			cards: state.cards.map((card) => ({
				role: card.role,
				status: card.status === "running" ? "queued" : card.status,
				note: card.status === "running" ? "interrumpido: se reanuda" : card.note,
			})),
		},
		options,
	);
}

// ---------------------------------------------------------------------------
// Render: el renderFleet de hanniorq, generalizado
// ---------------------------------------------------------------------------

export interface PipelineRow {
	/** Etiqueta corta a la izquierda ("1", "a1f3c2e"…). */
	id: string;
	role: string;
	label: string;
	icon: string;
	status: CardStatus;
	/** Texto de la tarea/unidad de trabajo, si la fila tiene uno propio. */
	task?: string;
	startsAt?: number;
	note?: string;
}

const STATUS_LABEL: Record<CardStatus, string> = {
	queued: "Queued",
	running: "Running",
	done: "Done",
	error: "Error",
	cancelled: "Cancelled",
};

/** Subestado humano de la captura: en cola se dice "Waiting its turn". */
const STATUS_NOTE: Record<CardStatus, string> = {
	queued: "Waiting its turn",
	running: "",
	done: "",
	error: "",
	cancelled: "",
};

/** Fila de guiones: el indicador de progreso de cada tarjeta de la captura. */
const PROGRESS: Record<CardStatus, string> = {
	queued: "╌╌╌╌╌",
	running: "━━╌╌╌",
	done: "━━━━━",
	error: "━━━✗╌",
	cancelled: "×××××",
};

function clip(text: string, width: number): string {
	if (width <= 1) return "";
	return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

function substateOf(row: PipelineRow, now: number): string {
	if (row.status === "running" && row.startsAt !== undefined) {
		return `${Math.max(0, Math.round((now - row.startsAt) / 1000))}s`;
	}
	return row.note ?? STATUS_NOTE[row.status];
}

/**
 * Líneas del widget. Pintar las tarjetas en COLA es el cambio respecto al `renderFleet`
 * anterior: antes sólo aparecían las que ya habían arrancado, y una cola invisible no se
 * puede ni cancelar ni entender.
 */
export function pipelineLines(
	rows: readonly PipelineRow[],
	options: {
		now?: number;
		title?: string;
		task?: string;
		width?: number;
		footer?: boolean;
		/** Aviso de degradación (p.ej. "subagent no instalado"): se pinta bajo el título. */
		notice?: string;
	} = {},
): string[] {
	const now = options.now ?? Date.now();
	const width = options.width ?? 0;
	const trimToWidth = (line: string) => (width > 0 ? clip(line, width) : line);
	const header = ["─", options.title ?? "pipeline", "─"].join(" ");
	const lines = [trimToWidth(header)];
	if (options.notice) lines.push(trimToWidth(`⚠ ${options.notice}: los roles siguen en cola`));
	if (options.task) lines.push(trimToWidth(`◆ ${clip(oneLine(options.task), width > 0 ? width - 2 : 90)}`));
	for (const row of rows) {
		const state = STATUS_LABEL[row.status];
		const substate = substateOf(row, now);
		const parts = [`${row.icon} ${row.id} ${row.label}`.trim(), state];
		if (substate) parts.push(substate);
		const task = row.task ? ` · ${oneLine(row.task)}` : "";
		lines.push(trimToWidth(`${parts.join(" · ")}${task}  ${PROGRESS[row.status]}`));
	}
	if (rows.length === 0) lines.push("(sin tarjetas)");
	if (options.footer !== false && rows.some((row) => row.status === "queued" || row.status === "running")) {
		lines.push(trimToWidth("× /pipeline cancel <n|rol> · ctrl+alt+x cancela el rol en curso"));
	}
	return lines;
}

/**
 * Pinta la cola. `key` identifica el widget: hanniorq usa "hanniorq-fleet" (flota + cola) y
 * esta extensión "pipeline" (sólo la cola de roles). Sin filas, oculta el widget.
 */
export function renderPipeline(
	ui: ExtensionUIContext,
	key: string,
	rows: readonly PipelineRow[],
	options: {
		now?: number;
		title?: string;
		task?: string;
		width?: number;
		footer?: boolean;
		notice?: string;
	} = {},
): void {
	if (rows.length === 0) {
		ui.setWidget(key, undefined);
		return;
	}
	ui.setWidget(key, pipelineLines(rows, { ...options, width: options.width ?? 0 }));
}

// ---------------------------------------------------------------------------
// Extensión
// ---------------------------------------------------------------------------

export const PIPELINE_SHORTCUT = Key.ctrlAlt("x");
const WIDGET_KEY = "pipeline";
const DEFAULT_DISPATCH_TIMEOUT_MS = 15 * 60 * 1000;

export interface PipelineExtensionOptions {
	/** Roles inyectados (tests). Por defecto salen de `settings.pipeline.roles`. */
	roles?: readonly PipelineRole[];
	/** Lanzador inyectado (tests). Por defecto pide la llamada a `subagent` y espera a que acabe. */
	dispatch?: PipelineDispatch;
	now?: () => number;
	dispatchTimeoutMs?: number;
}

/** Mensaje de turno: pide UNA llamada a la tool `subagent` para el rol, con su prompt. */
export function dispatchMessage(input: { role: PipelineRole; task: string; position: number; total: number }): string {
	const { role, task, position, total } = input;
	const body = `${role.prompt}\n\nTarea: ${task}`;
	return [
		`[pipeline ${position}/${total} · ${role.label}]`,
		`Lanza exactamente UNA llamada a la tool \`subagent\` con task=${JSON.stringify(body)} y agent=${JSON.stringify(role.id)}.`,
		`Si no existe un agente con ese nombre, usa los que liste el error y elige el más afín (exploración para explorer, implementación para builder, revisión para reviewer).`,
		"No hagas el trabajo tú y no encadenes otros roles: la cola los libera de uno en uno.",
	].join("\n");
}

export function createPipelineExtension(options: PipelineExtensionOptions = {}): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const now = options.now ?? (() => Date.now());
		const timeoutMs = options.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
		let roles: PipelineRole[] = options.roles ? [...options.roles] : [...DEFAULT_ROLES];
		let queue: PipelineQueue | undefined;
		let runner: PipelineRunner | undefined;
		let cwd = process.cwd();
		let lastUi: ExtensionUIContext | undefined;
		/** Motivo de degradación vivo (tool `subagent` ausente); se pinta en el widget. */
		let blockedReason: string | undefined;
		/** La llamada a `subagent` que la cola está esperando (una como máximo). */
		let pending:
			| { toolCallId?: string; claimed: boolean; finish: (result: PipelineDispatchResult) => void }
			| undefined;

		function repaint(ui: ExtensionUIContext | undefined): void {
			const target = ui ?? lastUi;
			if (!target) return;
			if (!queue) {
				target.setWidget(WIDGET_KEY, undefined);
				return;
			}
			const rows: PipelineRow[] = queue.all.map((card) => {
				const role = roleFor(roles, card.role);
				if (card.status === "running" && !startedAt.has(card.id)) startedAt.set(card.id, now());
				return {
					id: card.id,
					role: card.role,
					label: role.label,
					icon: role.icon,
					status: card.status,
					...(card.status === "running" ? { startsAt: startedAt.get(card.id) ?? now() } : {}),
					...(card.note ? { note: card.note } : {}),
				};
			});
			renderPipeline(target, WIDGET_KEY, rows, {
				now: now(),
				title: `pipeline · ${roles.map((role) => role.label).join(" → ")}`,
				task: queue.task,
				...(blockedReason ? { notice: blockedReason } : {}),
			});
		}

		const startedAt = new Map<string, number>();

		function persist(): void {
			if (!queue) return;
			try {
				writePipelineToSheet(cwd, queue.snapshot());
			} catch {
				// La ficha es un extra: si no se puede escribir, la cola vive en memoria.
			}
		}

		function changed(): void {
			persist();
			repaint(lastUi);
		}

		/** Lanzador real: pide la llamada a `subagent` y espera su `tool_execution_end`. */
		const defaultDispatch: PipelineDispatch = (input) => {
			// Prerrequisito ausente: se resuelve AL INSTANTE, sin pedir turno ni armar el
			// temporizador (antes: 15 min de espera y una tarjeta en `error` por rol).
			if (!subagentAvailable(pi)) {
				return Promise.resolve<PipelineDispatchResult>({ ok: false, blocked: true, note: SUBAGENT_MISSING });
			}
			return new Promise<PipelineDispatchResult>((resolve) => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const finish = (result: PipelineDispatchResult): void => {
					if (timer !== undefined) clearTimeout(timer);
					input.signal.removeEventListener("abort", onAbort);
					if (pending?.finish === finish) pending = undefined;
					resolve(result);
				};
				const onAbort = (): void => finish({ ok: false, note: "cancelado" });
				if (input.signal.aborted) {
					resolve({ ok: false, note: "cancelado" });
					return;
				}
				timer = setTimeout(
					() => finish({ ok: false, note: `sin respuesta del subagente en ${Math.round(timeoutMs / 1000)}s` }),
					timeoutMs,
				);
				input.signal.addEventListener("abort", onAbort, { once: true });
				pending = { claimed: false, finish };
				startedAt.set(input.card.id, now());
				pi.sendUserMessage(dispatchMessage(input), { deliverAs: "followUp" });
			});
		};

		const dispatch = options.dispatch ?? defaultDispatch;

		/**
		 * Generación del pipeline vivo. Cada `startRun` la sube; un runner anterior que aún
		 * estuviera esperando su subagente queda silenciado y no pisa la ficha ni el widget.
		 */
		let generation = 0;

		/**
		 * Arranca la cola. Si la tool `subagent` no está instalada NO se lanza nada: la cola
		 * entera se queda en `queued` con el aviso, que es lo que la captura debe mostrar
		 * (una tarjeta "esperando su turno" honesta, no tres errores por timeout).
		 * Devuelve la promesa del bucle (o `undefined` si la cola no arrancó): los modos sin
		 * TUI la esperan, porque allí el proceso muere en cuanto el comando retorna.
		 */
		function startRun(ui: ExtensionUIContext | undefined, targetCwd: string): Promise<void> | undefined {
			if (!queue) return undefined;
			cwd = targetCwd;
			lastUi = ui;
			if (!subagentAvailable(pi)) {
				blockedReason = SUBAGENT_MISSING;
				queue.holdAll(SUBAGENT_MISSING);
				// `changed()` persiste en la ficha y repinta con el aviso.
				changed();
				return undefined;
			}
			blockedReason = undefined;
			const mine = ++generation;
			runner = new PipelineRunner({
				queue,
				roles,
				dispatch,
				onChange: () => {
					if (mine !== generation) return;
					changed();
				},
			});
			const done = runner.run();
			// Los errores ya quedan en la tarjeta; aquí sólo se evita un rechazo sin dueño.
			void done.catch(() => {});
			return done;
		}

		/**
		 * Espera a que la cola termine cuando NO hay TUI. `pi -p` / `--mode json` ejecutan el
		 * comando y cierran el proceso acto seguido: sin esto, el turno del rol 1 se queda a
		 * medias y no hay quien libere el 2. La TUI no espera (el usuario manda turnos).
		 */
		async function settleIfHeadless(run: Promise<void> | undefined, mode: string | undefined): Promise<void> {
			if (!run || (mode !== "print" && mode !== "json")) return;
			await run;
		}

		/** Para el pipeline anterior antes de arrancar otro: cancela su tarjeta y lo silencia. */
		function stopPreviousRun(): void {
			const previous = runner;
			if (!previous?.running) return;
			const card = previous.queue.runningCards()[0] ?? previous.queue.nextQueued();
			if (card) previous.cancel(card.id);
			generation++;
		}

		/** Estado textual de la cola para `/pipeline status` y los avisos. */
		function summary(target: PipelineQueue): string[] {
			return target.all.map((card) => {
				const role = roleFor(roles, card.role);
				const note = card.note ?? STATUS_NOTE[card.status];
				return `${role.icon} ${card.id} ${role.label} · ${STATUS_LABEL[card.status]}${note ? ` · ${note}` : ""}`;
			});
		}

		pi.on("session_start", (_event, ctx) => {
			cwd = ctx.cwd ?? process.cwd();
			lastUi = ctx.ui;
			roles = options.roles ? [...options.roles] : resolveRoles(pi.getSettings());
			const saved = readPipelineFromSheet(cwd);
			if (!saved) {
				repaint(ctx.ui);
				return;
			}
			queue = restoreQueue(saved.state, { now });
			// Tras reiniciar, si quedan roles pendientes y la tool no está, el aviso debe seguir viéndose.
			if (!subagentAvailable(pi) && queue.all.some((card) => card.status === "queued")) {
				blockedReason = SUBAGENT_MISSING;
			}
			const pendingCount = queue.all.filter((card) => card.status === "queued").length;
			repaint(ctx.ui);
			if (pendingCount > 0) {
				ctx.ui.notify(
					`pipeline reconstruido de odd/tasks/${saved.slug}.md: ${pendingCount} rol(es) pendientes (/pipeline resume)`,
				);
			}
		});

		pi.on("session_shutdown", () => {
			pending?.finish({ ok: false, note: "sesión cerrada" });
			pending = undefined;
		});

		// Correlación con la tool `subagent`. Se reclama la llamada en `tool_call` (antes de que
		// empiece) para que dos llamadas en paralelo del mismo turno no pasen las dos: la primera
		// es el turno del rol y la segunda se bloquea.
		pi.on("tool_call", (event) => {
			if (event.toolName !== "subagent") return;
			if ((queue?.runningCards().length ?? 0) === 0) return;
			if (!pending || pending.claimed) {
				return { block: true, reason: "pipeline: ya hay un rol en vuelo (cola secuencial, SPEC-006)" };
			}
			pending.claimed = true;
			pending.toolCallId = event.toolCallId;
		});

		pi.on("tool_execution_end", (event) => {
			if (event.toolName !== "subagent" || !pending || pending.toolCallId !== event.toolCallId) return;
			pending.finish(event.isError ? { ok: false, note: "el subagente falló" } : { ok: true });
		});

		pi.registerCommand("pipeline", {
			description: "Cola secuencial de roles (explorer → builder → reviewer) sobre la tool subagent",
			handler: async (args, ctx) => {
				cwd = ctx.cwd ?? process.cwd();
				lastUi = ctx.ui;
				roles = options.roles ? [...options.roles] : resolveRoles(pi.getSettings());
				const [sub = "", ...rest] = args.trim().split(/\s+/);
				switch (sub) {
					case "start": {
						const task = rest.join(" ").trim();
						if (!task) {
							ctx.ui.notify("Uso: /pipeline start <tarea>", "warning");
							return;
						}
						const slug = activeSheetSlug(cwd);
						stopPreviousRun();
						queue = new PipelineQueue({ task, cards: roles.map((role) => ({ role: role.id })) }, { now });
						startedAt.clear();
						const run = startRun(ctx.ui, cwd);
						if (!slug) {
							ctx.ui.notify(
								"Sin ficha sODD activa: la cola no se guardará (crea una con /task new <slug>)",
								"warning",
							);
						}
						if (!run) {
							ctx.ui.notify(
								`pipeline: ${SUBAGENT_MISSING} · la cola queda en Queued (instala la extensión en ~/.pi/agent/extensions/subagent)`,
								"warning",
							);
							return;
						}
						ctx.ui.notify(`pipeline: ${roles.map((role) => role.label).join(" → ")} en cola`);
						await settleIfHeadless(run, ctx.mode);
						return;
					}
					case "resume": {
						const saved = readPipelineFromSheet(cwd);
						if (!saved) {
							ctx.ui.notify("No hay pipeline guardado en la ficha activa", "warning");
							return;
						}
						stopPreviousRun();
						queue = restoreQueue(saved.state, { now });
						startedAt.clear();
						const run = startRun(ctx.ui, cwd);
						if (!run) {
							ctx.ui.notify(`pipeline: ${SUBAGENT_MISSING} · la cola queda en Queued`, "warning");
							return;
						}
						ctx.ui.notify(`pipeline reanudado desde odd/tasks/${saved.slug}.md`);
						await settleIfHeadless(run, ctx.mode);
						return;
					}
					case "cancel": {
						const activeRunner = runner;
						if (!queue || !activeRunner) {
							ctx.ui.notify("No hay pipeline en marcha", "warning");
							return;
						}
						const target = rest[0];
						if (!target) {
							ctx.ui.notify("Uso: /pipeline cancel <n|rol|all>", "warning");
							return;
						}
						if (target === "all") {
							const running = queue.runningCards()[0];
							const outcome = running
								? activeRunner.cancel(running.id)
								: { aborted: false, cancelled: [] as string[] };
							const queued = queue.all.filter((card) => card.status === "queued");
							const rest2 = queued.flatMap((card) => activeRunner.cancel(card.id).cancelled);
							const total = [...new Set([...outcome.cancelled, ...rest2])];
							ctx.ui.notify(total.length > 0 ? `canceladas: ${total.join(", ")}` : "no había nada que cancelar");
							return;
						}
						const outcome = activeRunner.cancel(target);
						if (outcome.cancelled.length === 0) {
							ctx.ui.notify(`no se puede cancelar "${target}" (¿ya terminó?)`, "warning");
							return;
						}
						ctx.ui.notify(
							`cancelada ${outcome.cancelled.join(", ")}${outcome.aborted ? " (abortado el subagente en vuelo)" : ""}`,
						);
						return;
					}
					case "status": {
						if (!queue) {
							ctx.ui.notify("No hay pipeline en marcha");
							return;
						}
						ctx.ui.notify(summary(queue).join("\n"));
						return;
					}
					default:
						ctx.ui.notify("Uso: /pipeline start <tarea> | status | cancel <n|rol|all> | resume", "warning");
				}
			},
		});

		// Atajo: cancela el rol en curso (si no hay, la primera tarjeta en cola).
		pi.registerShortcut(PIPELINE_SHORTCUT, {
			description: "pipeline: cancelar el rol en curso",
			handler: (ctx: ExtensionContext) => {
				if (!queue || !runner) return;
				const target = queue.runningCards()[0] ?? queue.nextQueued();
				if (!target) return;
				const outcome = runner.cancel(target.id);
				ctx.ui.notify(
					outcome.cancelled.length > 0
						? `pipeline: cancelada ${outcome.cancelled.join(", ")}${outcome.aborted ? " (subagente abortado)" : ""}`
						: "pipeline: nada que cancelar",
				);
			},
		});
	};
}

export default createPipelineExtension();
