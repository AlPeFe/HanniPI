import { type Component, HStack, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

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
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
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
		return { transcript, root: main };
	}

	const rightRailWidth = options.rightRailWidth ?? 34;
	const rightRailMinTerminalWidth = options.rightRailMinTerminalWidth ?? 110;
	const rightRailVisible = options.rightRailVisible ?? (() => true);
	const rightRail = options.rightRail;

	return {
		transcript,
		root: new HStack([
			{ component: main, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{
				component: rightRail,
				basis: rightRailWidth,
				grow: 0,
				shrink: 0,
				minSize: 0,
				visible: (viewport) => viewport.width >= rightRailMinTerminalWidth && rightRailVisible(),
			},
		]),
	};
}
