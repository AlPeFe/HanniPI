import {
	type Component,
	HStack,
	ScrollView,
	type ScrollViewScrollbar,
	type StackChild,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@earendil-works/pi-tui";
import { RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from "../../core/settings-manager.ts";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	/** Right-side status rail. Hidden below rightRailMinTerminalWidth columns, or when rightRailVisible() is false. */
	readonly rightRail?: Component;
	/** Fixed column width for the right rail (default 34). */
	readonly rightRailWidth?: number;
	/** Hide the right rail when the terminal is narrower than this (default 110). */
	readonly rightRailMinTerminalWidth?: number;
	/** Dynamic gate: return false to hide the rail (e.g. when it has no content). */
	readonly rightRailVisible?: () => boolean;
	/** Drag handle between the transcript and the rail. */
	readonly railResize?: RailResizeOptions;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

/** Callbacks for resizing the right rail by dragging its left border with the mouse. */
export interface RailResizeOptions {
	/** Current rail width in columns. */
	readonly getRailWidth: () => number;
	/** Proposed width while the pointer moves (already clamped); must not persist it. */
	readonly onResize: (width: number) => void;
	/** Proposed width when the drag ends (already clamped). */
	readonly onResizeEnd: (width: number) => void;
	/** Renders the one-column drag strip. */
	readonly renderLine: () => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
	/** Resize the right rail column (no-op when the viewport has no rail), e.g. when the user resizes it. */
	readonly setRightRailWidth: (width: number) => void;
	/** The mouse drag handle between the transcript and the rail, when enabled. */
	readonly railResizeHandle: RailResizeHandleComponent | undefined;
}

/** Component with mouse handling, so tests can drive drag gestures directly. */
export interface RailResizeHandleComponent extends Component {
	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined;
}

/**
 * HStack whose rail column width can be changed without rebuilding the tree.
 * `Stack` keeps the entry objects it lays out, so mutating `basis` applies on the next render.
 */
class ResizableHStack extends HStack {
	setBasis(component: Component, basis: number): void {
		const entry = this.entries.find((candidate) => candidate.component === component);
		if (entry) entry.basis = basis;
	}
}

/** Rows the drag strip paints; padded rows below stay blank when the terminal is taller. */
const RESIZE_HANDLE_LINES = 300;

function clampRailWidth(width: number): number {
	if (!Number.isFinite(width)) return RAIL_MIN_WIDTH;
	return Math.round(Math.max(RAIL_MIN_WIDTH, Math.min(RAIL_MAX_WIDTH, width)));
}

/**
 * One-column strip between the transcript and the right rail. Press it and drag to change the
 * rail width: the left border of the rail follows the pointer. A press result with `capture`
 * keeps drag and release events arriving even when the pointer leaves the strip.
 */
class RailResizeHandle implements RailResizeHandleComponent {
	private readonly options: RailResizeOptions;
	private pressScreenX: number | undefined;
	private pressRailWidth: number | undefined;
	private dragMoved = false;

	constructor(options: RailResizeOptions) {
		this.options = options;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		const line = this.options.renderLine();
		return Array.from({ length: RESIZE_HANDLE_LINES }, () => line);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button !== "left") return undefined;
		switch (event.type) {
			case "press": {
				this.pressScreenX = event.screenX;
				this.pressRailWidth = this.options.getRailWidth();
				this.dragMoved = false;
				return { handled: true, capture: true };
			}
			case "drag": {
				if (this.pressScreenX === undefined || this.pressRailWidth === undefined) return undefined;
				this.dragMoved = true;
				const proposed = clampRailWidth(this.pressRailWidth + (this.pressScreenX - event.screenX));
				this.options.onResize(proposed);
				return { handled: true, capture: true };
			}
			case "release": {
				if (this.pressScreenX === undefined || this.pressRailWidth === undefined) return undefined;
				const moved = this.dragMoved;
				const proposed = clampRailWidth(this.pressRailWidth + (this.pressScreenX - event.screenX));
				this.pressScreenX = undefined;
				this.pressRailWidth = undefined;
				this.dragMoved = false;
				// Sin arrastre (solo pulso) no se confirma nada; el click apenas limpia el gesto.
				if (moved) this.options.onResizeEnd(proposed);
				return { handled: true };
			}
			case "click": {
				this.pressScreenX = undefined;
				this.pressRailWidth = undefined;
				this.dragMoved = false;
				return { handled: true };
			}
			default:
				return undefined;
		}
	}

	invalidate(): void {
		// Sin cache: la franja se renderiza en cada frame.
	}
}

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const main = new VStack([
		{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
		{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
	]);

	if (options.rightRail === undefined) {
		return { transcript, root: main, setRightRailWidth: () => {}, railResizeHandle: undefined };
	}

	const rightRailWidth = options.rightRailWidth ?? 34;
	const rightRailMinTerminalWidth = options.rightRailMinTerminalWidth ?? 110;
	const rightRailVisible = options.rightRailVisible ?? (() => true);
	const rightRail = options.rightRail;
	const railGate = (viewport: { width: number; height: number }): boolean =>
		viewport.width >= rightRailMinTerminalWidth && rightRailVisible();
	const railHandle: RailResizeHandleComponent | undefined = options.railResize
		? new RailResizeHandle(options.railResize)
		: undefined;

	const stackChildren: StackChild[] = [{ component: main, basis: 0, grow: 1, shrink: 1, minSize: 1 }];
	if (railHandle !== undefined) {
		stackChildren.push({ component: railHandle, basis: 1, grow: 0, shrink: 0, minSize: 0, visible: railGate });
	}
	stackChildren.push({
		component: rightRail,
		basis: rightRailWidth,
		grow: 0,
		shrink: 0,
		minSize: 0,
		visible: railGate,
	});
	const root = new ResizableHStack(stackChildren);

	return {
		transcript,
		root,
		setRightRailWidth: (width: number) => root.setBasis(rightRail, Math.max(0, Math.floor(width))),
		railResizeHandle: railHandle,
	};
}
