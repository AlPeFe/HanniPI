import type { Component, TuiMouseEvent, TuiMouseEventResult } from "../tui.ts";
import { applyBackgroundToLine, flattenLines, truncateToWidth, visibleWidth } from "../utils.ts";

/** Glyphs for each border style, in the order: top-left, top-right, bottom-left, bottom-right, horizontal, vertical. */
const BORDER_STYLES = {
	rounded: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	light: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│" },
	heavy: { topLeft: "┏", topRight: "┓", bottomLeft: "┗", bottomRight: "┛", horizontal: "━", vertical: "┃" },
	double: { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║" },
} as const;

export type PanelBorderStyle = keyof typeof BORDER_STYLES;

/**
 * `box` frames the child on all four sides (classic). `rule` draws a single top rule that carries
 * the title and the status, with no side or bottom borders: two lines cheaper and two columns wider,
 * which is what the compact density mode uses.
 */
export type PanelBorderMode = "box" | "rule";

type ColorFn = (text: string) => string;

export interface PanelOptions {
	/** Label drawn in the top border, after `╭─ `. */
	title?: string;
	/** Right-aligned label in the top border, e.g. a status. */
	status?: string;
	/** Label drawn in the bottom border, after `╰─ `. */
	caption?: string;
	/** Border glyphs. Defaults to `rounded`. */
	borderStyle?: PanelBorderStyle;
	/** Frame style. Defaults to `box`. */
	borderMode?: PanelBorderMode;
	/** Paints the border glyphs. Defaults to no styling. */
	borderColor?: ColorFn;
	/** Paints `title`. Defaults to `borderColor`. */
	titleColor?: ColorFn;
	/** Paints `status`. Defaults to `borderColor`. */
	statusColor?: ColorFn;
	/** Paints `caption`. Defaults to `borderColor`. */
	captionColor?: ColorFn;
	/** Paints the whole panel (borders included). Used for message backgrounds. */
	background?: ColorFn;
	/** Columns of padding between the vertical borders and the child. Defaults to 1. */
	paddingX?: number;
	/** Blank rows between the top border and the child, and between the child and the bottom border. */
	paddingY?: number;
}

/**
 * Container that draws a border around a child and puts its labels in that border:
 * `╭─ title ────── status ─╮` on top, `╰─ caption ────────────╯` below. Every line is padded to the
 * requested width, so a panel can be composed like any other block.
 */
export class Panel implements Component {
	private child: Component;
	private title: string;
	private status: string;
	private caption: string;
	private style: PanelBorderStyle;
	private borderMode: PanelBorderMode;
	private borderColor: ColorFn;
	private titleColor: ColorFn | undefined;
	private statusColor: ColorFn | undefined;
	private captionColor: ColorFn | undefined;
	private background: ColorFn | undefined;
	private paddingX: number;
	private paddingY: number;

	constructor(child: Component, options: PanelOptions = {}) {
		this.child = child;
		this.title = options.title ?? "";
		this.status = options.status ?? "";
		this.caption = options.caption ?? "";
		this.style = options.borderStyle ?? "rounded";
		this.borderMode = options.borderMode ?? "box";
		this.borderColor = options.borderColor ?? ((text) => text);
		this.titleColor = options.titleColor;
		this.statusColor = options.statusColor;
		this.captionColor = options.captionColor;
		this.background = options.background;
		this.paddingX = Math.max(0, options.paddingX ?? 1);
		this.paddingY = Math.max(0, options.paddingY ?? 0);
	}

	setChild(child: Component): void {
		this.child = child;
	}

	setTitle(title: string | undefined): void {
		this.title = title ?? "";
	}

	setStatus(status: string | undefined): void {
		this.status = status ?? "";
	}

	/** Switch between the boxed frame and the single-rule frame at render time. */
	setBorderMode(mode: PanelBorderMode): void {
		this.borderMode = mode;
	}

	setCaption(caption: string | undefined): void {
		this.caption = caption ?? "";
	}

	setBorderColor(borderColor: ColorFn): void {
		this.borderColor = borderColor;
	}

	setBackground(background: ColorFn | undefined): void {
		this.background = background;
	}

	invalidate(): void {
		this.child.invalidate?.();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const framed = this.borderMode === "rule" ? 0 : 1;
		const contentX = event.x - framed - this.paddingX;
		const contentY = event.y - framed - this.paddingY;
		const contentWidth = Math.max(1, event.width - framed * 2 - this.paddingX * 2);
		if (contentX < 0 || contentY < 0 || contentX >= contentWidth) return undefined;
		const lines = this.child.render(contentWidth);
		if (contentY >= lines.length) return undefined;
		return this.child.handleMouse?.({
			...event,
			x: contentX,
			y: contentY,
			width: contentWidth,
			height: lines.length,
		});
	}

	render(width: number): string[] {
		// Below four columns there is no room for two borders, one column of content, and the corners.
		if (width < 4) return [];

		const glyphs = BORDER_STYLES[this.style];
		if (this.borderMode === "rule") return this.renderRule(width, glyphs.horizontal);

		const innerWidth = width - 2;
		const contentWidth = Math.max(1, innerWidth - this.paddingX * 2);
		const childLines = this.child.render(contentWidth);

		const lines: string[] = [];
		lines.push(this.buildTopBorder(innerWidth, glyphs.horizontal));
		const leftPad = " ".repeat(this.paddingX);
		const blank = this.pad(leftPad + " ".repeat(contentWidth) + leftPad, innerWidth);
		for (let i = 0; i < this.paddingY; i++) {
			lines.push(this.frame(blank, glyphs.vertical));
		}
		for (const line of childLines) {
			lines.push(
				this.frame(this.pad(leftPad + this.clip(line, contentWidth) + leftPad, innerWidth), glyphs.vertical),
			);
		}
		for (let i = 0; i < this.paddingY; i++) {
			lines.push(this.frame(blank, glyphs.vertical));
		}
		lines.push(this.buildBottomBorder(innerWidth, glyphs.horizontal));

		flattenLines(lines);
		return lines;
	}

	private frame(content: string, vertical: string): string {
		return this.paint(this.borderColor(vertical) + content + this.borderColor(vertical));
	}

	/**
	 * Compact frame: one rule on top carrying the title and the status, then the child with no side
	 * borders. Saves the bottom border and both vertical borders (two lines and two columns) without
	 * dropping the title or the status.
	 */
	private renderRule(width: number, horizontal: string): string[] {
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const childLines = this.child.render(contentWidth);
		const leftPad = " ".repeat(this.paddingX);
		const lines: string[] = [this.buildRuleLine(width, horizontal)];
		for (const line of childLines) {
			lines.push(this.padLeft(leftPad + this.clip(line, contentWidth) + leftPad, width));
		}
		flattenLines(lines);
		return lines;
	}

	private buildRuleLine(width: number, horizontal: string): string {
		const dash = (count: number) => this.borderColor(horizontal.repeat(Math.max(0, count)));
		const title = this.buildLabel(this.title, this.titleColor);
		const status = this.buildLabel(this.status, this.statusColor);

		if (title && status) {
			const statusWidth = visibleWidth(status);
			const clippedTitle = truncateToWidth(title, Math.max(0, width - statusWidth - 6), "…");
			const titleWidth = visibleWidth(clippedTitle);
			const fill = width - titleWidth - statusWidth - 6;
			if (titleWidth > 0 && fill >= 1) {
				return this.paint(`${dash(1)} ${clippedTitle} ${dash(fill)} ${status} ${dash(1)}`);
			}
		}
		if (title) {
			const clipped = truncateToWidth(title, Math.max(0, width - 3), "…");
			const clippedWidth = visibleWidth(clipped);
			const fill = width - clippedWidth - 3;
			if (clippedWidth > 0 && fill >= 0) {
				return this.paint(`${dash(1)} ${clipped} ${dash(fill)}`);
			}
		}
		if (status) {
			const clippedStatus = truncateToWidth(status, Math.max(0, width - 3), "…");
			const clippedWidth = visibleWidth(clippedStatus);
			const fill = width - clippedWidth - 3;
			if (clippedWidth > 0 && fill >= 0) {
				return this.paint(`${dash(fill)} ${clippedStatus} ${dash(1)}`);
			}
		}
		return this.paint(dash(width));
	}

	private padLeft(content: string, width: number): string {
		const visible = visibleWidth(content);
		return visible >= width ? content : content + " ".repeat(width - visible);
	}

	private buildTopBorder(innerWidth: number, horizontal: string): string {
		const label = this.buildLabel(this.title, this.titleColor);
		const status = this.buildLabel(this.status, this.statusColor);
		const statusWidth = status ? visibleWidth(status) : 0;

		// Degrade label by label until the pieces fit with at least one dash of filler between them.
		if (label && status) {
			const title = truncateToWidth(label, Math.max(0, innerWidth - 7 - statusWidth), "…");
			const titleWidth = visibleWidth(title);
			const fill = innerWidth - titleWidth - statusWidth - 6;
			if (titleWidth > 0 && fill >= 1) {
				return this.borderLine(
					"top",
					`${horizontal} ${title} ${this.borderColor(horizontal.repeat(fill))} ${status} ${horizontal}`,
				);
			}
		}
		if (label) {
			const title = truncateToWidth(label, Math.max(0, innerWidth - 4), "…");
			const titleWidth = visibleWidth(title);
			const fill = innerWidth - titleWidth - 3;
			if (titleWidth > 0 && fill >= 1) {
				return this.borderLine("top", `${horizontal} ${title} ${this.borderColor(horizontal.repeat(fill))}`);
			}
		}
		if (status) {
			const clipped = truncateToWidth(status, Math.max(0, innerWidth - 4), "…");
			const clippedWidth = visibleWidth(clipped);
			const fill = innerWidth - clippedWidth - 3;
			if (clippedWidth > 0 && fill >= 1) {
				return this.borderLine("top", `${this.borderColor(horizontal.repeat(fill))} ${clipped} ${horizontal}`);
			}
		}
		return this.borderLine("top", this.borderColor(horizontal.repeat(innerWidth)));
	}

	private buildBottomBorder(innerWidth: number, horizontal: string): string {
		const caption = this.buildLabel(this.caption, this.captionColor);
		if (caption) {
			const clipped = truncateToWidth(caption, Math.max(0, innerWidth - 4), "…");
			const clippedWidth = visibleWidth(clipped);
			const fill = innerWidth - clippedWidth - 3;
			if (clippedWidth > 0 && fill >= 1) {
				return this.borderLine("bottom", `${horizontal} ${clipped} ${this.borderColor(horizontal.repeat(fill))}`);
			}
		}
		return this.borderLine("bottom", this.borderColor(horizontal.repeat(innerWidth)));
	}

	/** Wraps a border middle segment in its corner glyphs, paints it, and guarantees the requested width. */
	private borderLine(side: "top" | "bottom", middle: string): string {
		const glyphs = BORDER_STYLES[this.style];
		const corner = side === "top" ? glyphs.topLeft : glyphs.bottomLeft;
		const rightCorner = side === "top" ? glyphs.topRight : glyphs.bottomRight;
		return this.paint(this.borderColor(corner) + middle + this.borderColor(rightCorner));
	}

	private buildLabel(text: string, color: ColorFn | undefined): string {
		if (!text) return "";
		return color ? color(text) : text;
	}

	private clip(line: string, contentWidth: number): string {
		return visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth, "", true) : line;
	}

	private pad(content: string, innerWidth: number): string {
		const visible = visibleWidth(content);
		return visible >= innerWidth ? content : content + " ".repeat(innerWidth - visible);
	}

	private paint(line: string): string {
		if (!this.background) return line;
		return applyBackgroundToLine(line, visibleWidth(line), this.background);
	}
}
