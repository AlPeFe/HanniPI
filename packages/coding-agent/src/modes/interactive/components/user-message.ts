import { Container, Markdown, type MarkdownTheme, Panel } from "@earendil-works/pi-tui";
import { isCompactDensity } from "../../../core/display-density.ts";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		// Compact density: the name lives in a dim one-line rule, without side or bottom borders.
		const compact = isCompactDensity();
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output. The panel adds the frame: its title names who is talking, and its background
		// keeps the user block tinted from edge to edge.
		this.addChild(
			new Panel(
				new Markdown(
					this.text,
					this.outputPad,
					1,
					this.markdownTheme,
					{
						color: (content: string) => theme.fg("userMessageText", content),
						bgColor: (content: string) => theme.bg("userMessageBg", content),
					},
					{
						preserveOrderedListMarkers: true,
						preserveBackslashEscapes: true,
						transform: createMarkdownTransform("user", false, this.markdownTransformers),
					},
				),
				{
					title: theme.fg(compact ? "muted" : "accent", "tú"),
					borderColor: (text: string) => theme.fg("borderMuted", text),
					borderMode: compact ? "rule" : "box",
					paddingX: 0,
					background: (text: string) => theme.bg("userMessageBg", text),
				},
			),
		);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
