import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { isCompactDensity } from "../../../core/display-density.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { formatCwdForFooter, formatTokens, truncateCwdForDensity } from "./footer.ts";
import { hanniWordmark } from "./hanni-logo.ts";

/** Sanitize text for display in a single-line status. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Cells of the context meter drawn in the top bar. */
const CONTEXT_METER_CELLS = 10;

/**
 * Compact header fallbacks, widest first. The render picks the first one that fits the terminal, so a
 * wide terminal keeps the version and the cache columns and a 120-column one keeps the rest of the
 * identity. The last entry never drops the directory, the branch, the session name or the spend.
 */
const COMPACT_VARIANTS: ReadonlyArray<UsageLabelVariant> = [
	{ version: true, cache: true, meterCells: CONTEXT_METER_CELLS, window: true },
	{ version: false, cache: false, meterCells: 5, window: false },
	{ version: false, cache: false, meterCells: 0, window: false },
];

/** Which secondary columns the compact header keeps; the classic bar always draws all of them. */
interface UsageLabelVariant {
	/** Wordmark version suffix (compact only). */
	version?: boolean;
	/** Cache read/write columns and the cache hit rate. */
	cache?: boolean;
	/** Context meter cells; `0` hides the meter. */
	meterCells?: number;
	/** Context window size next to the percentage (`12%/200k`). */
	window?: boolean;
}

interface SessionStats {
	session: AgentSession;
	sessionId: string;
	leafId: string | null;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
}

/**
 * Fixed identity bar at the top of the interface: where the session lives and what it is spending.
 *
 * Line 1 is the identity (wordmark, version, working directory, branch, session name) with the model
 * it is talking to on the right. Line 2 is the resource line: extension statuses on the left, token
 * usage and context meter on the right. The mode and the shortcuts live in the status bar at the
 * bottom (`StatusBarComponent`), so nothing here competes with the input.
 */
export class TopBarComponent implements Component {
	private session: AgentSession;
	private footerData: ReadonlyFooterDataProvider;
	private version: string;
	private sessionStats?: SessionStats;

	constructor(session: AgentSession, footerData: ReadonlyFooterDataProvider, version: string) {
		this.session = session;
		this.footerData = footerData;
		this.version = version;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setVersion(version: string): void {
		this.version = version;
	}

	invalidate(): void {
		// Git branch and extension statuses are read on every render; only the usage scan is cached,
		// and `getSessionStats` keys that cache on the session, its leaf, and its entry count.
	}

	/**
	 * Usage totals and context usage scan the whole session, and the bar renders on every frame.
	 * Entries are append-only and every append moves the leaf, so the results only change with the
	 * session, leaf, entry count, or the model whose context window applies.
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const leafId = sessionManager.getLeafId();
		const limitsModel = this.session.routedModel?.model ?? this.session.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.leafId === leafId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;
		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "usage") {
				addUsageToTotals(usageTotals, entry.usage);
			} else if (entry.type === "message" && entry.message.role === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);
				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
		}

		this.sessionStats = {
			session: this.session,
			sessionId,
			leafId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage: this.session.getContextUsage(),
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (isCompactDensity()) return [this.renderCompactLine(width)];
		return [this.renderIdentityLine(width), this.renderResourceLine(width)];
	}

	/**
	 * Compact header: identity, extension statuses, spend and context on a single dim line, with the
	 * model on the right.
	 *
	 * The two classic lines do not fit in one at 120 columns, so the line degrades in a fixed order
	 * instead of letting `composeLine` eat the left side: first the version, then the cache columns
	 * and the context window size, and last the context meter. The directory, the branch, the session
	 * name, the spend and the context percentage are never dropped — they are what the bar is for.
	 */
	private renderCompactLine(width: number): string {
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		let last = { left: "", right: "" };
		for (const variant of COMPACT_VARIANTS) {
			last = {
				left: this.compactIdentityLabel(variant.version === true),
				right: [
					this.usageLabel(usageTotals, latestCacheHitRate, contextUsage, variant),
					this.modelLabel(this.session.state),
				]
					.filter(Boolean)
					.join(theme.fg("dim", " · ")),
			};
			if (visibleWidth(last.left) + visibleWidth(last.right) + 2 <= width) break;
		}
		return this.composeLine(last.left, last.right, width);
	}

	/** Wordmark, directory, branch, session name and extension statuses: the left half of the bar. */
	private compactIdentityLabel(showVersion: boolean): string {
		const cwd = truncateCwdForDensity(
			formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
		);
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();
		const identity = [
			showVersion ? `${hanniWordmark()} ${theme.fg("dim", `v${this.version}`)}` : hanniWordmark(),
			theme.fg("text", cwd),
			branch ? theme.fg("dim", `(${branch})`) : "",
			sessionName ? theme.fg("muted", `• ${sessionName}`) : "",
		]
			.filter(Boolean)
			.join(" ");
		const statuses = Array.from(this.footerData.getExtensionStatuses().values())
			.map((text) => theme.fg("muted", sanitizeStatusText(text)))
			.join(theme.fg("dim", " · "));
		const separator = theme.fg("dim", " · ");
		return [identity, statuses].filter(Boolean).join(separator);
	}

	private renderIdentityLine(width: number): string {
		const state = this.session.state;
		const cwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
		const branch = this.footerData.getGitBranch();
		const sessionName = this.session.sessionManager.getSessionName();
		const location = [
			theme.fg("text", cwd),
			branch ? theme.fg("dim", `(${branch})`) : "",
			sessionName ? theme.fg("muted", `• ${sessionName}`) : "",
		]
			.filter(Boolean)
			.join(" ");
		const left = `${hanniWordmark()} ${theme.fg("dim", `v${this.version}`)}  ${location}`;
		return this.composeLine(left, this.modelLabel(state), width);
	}

	private modelLabel(state: AgentSession["state"]): string {
		// The agent keeps an "unknown" placeholder until a model is selected (HanniPI pide elegir
		// uno al arrancar); pintarlo como "no-model" evita un nombre técnico que no existe.
		const unknown = state.model?.provider === "unknown" && state.model.id === "unknown";
		const modelName = unknown ? "no-model" : state.model?.id || "no-model";
		const thinking = !unknown && state.model?.reasoning ? ` • ${state.thinkingLevel || "off"}` : "";
		let label = `${modelName}${thinking}`;
		if (!unknown && state.model && this.footerData.getAvailableProviderCount() > 1) {
			label = `(${state.model.provider}) ${label}`;
		}
		const routed = this.session.routedModel;
		if (routed) {
			label += ` → ${routed.model.id}${routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : ""}`;
		}
		return theme.fg("muted", label);
	}

	private renderResourceLine(width: number): string {
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const statuses = Array.from(this.footerData.getExtensionStatuses().values())
			.map((text) => theme.fg("muted", sanitizeStatusText(text)))
			.join(theme.fg("dim", " · "));
		return this.composeLine(statuses, this.usageLabel(usageTotals, latestCacheHitRate, contextUsage), width);
	}

	private usageLabel(
		usageTotals: UsageTotals,
		latestCacheHitRate: number | undefined,
		contextUsage: ContextUsage | undefined,
		variant: UsageLabelVariant = {},
	): string {
		const state = this.session.state;
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const percent = contextUsage?.percent ?? 0;
		const showCache = variant.cache ?? true;
		const showWindow = variant.window ?? true;
		const meterCells = variant.meterCells ?? CONTEXT_METER_CELLS;

		const parts: string[] = [];
		if (usageTotals.input) parts.push(theme.fg("muted", `↑${formatTokens(usageTotals.input)}`));
		if (usageTotals.output) parts.push(theme.fg("muted", `↓${formatTokens(usageTotals.output)}`));
		if (showCache && usageTotals.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(usageTotals.cacheRead)}`));
		if (showCache && usageTotals.cacheWrite) parts.push(theme.fg("dim", `W${formatTokens(usageTotals.cacheWrite)}`));
		if (showCache && (usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			parts.push(theme.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`));
		}
		// Kimi Coding is subscription-backed despite using API-key authentication.
		const usingSubscription = state.model
			? state.model.provider === "kimi-coding" || this.session.modelRuntime.isUsingSubscription(state.model.provider)
			: false;
		if (usageTotals.cost || usingSubscription) {
			parts.push(theme.fg("muted", `$${usageTotals.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
		}

		const percentColor = percent > 90 ? "error" : percent > 70 ? "warning" : "accent";
		const auto = this.autoCompactSuffix();
		const percentText = contextUsage?.percent !== null && contextUsage !== undefined ? `${percent.toFixed(0)}%` : "?";
		const windowSuffix = showWindow ? theme.fg("dim", `/${formatTokens(contextWindow)}${auto}`) : "";
		if (meterCells > 0) {
			const filled = Math.round((percent / 100) * meterCells);
			const meter = theme.fg(percentColor, "▰".repeat(filled)) + theme.fg("dim", "▱".repeat(meterCells - filled));
			parts.push(`${theme.fg("dim", "ctx")} ${meter} ${theme.fg("muted", percentText)}${windowSuffix}`);
		} else {
			parts.push(`${theme.fg("dim", "ctx")} ${theme.fg("muted", percentText)}${windowSuffix}`);
		}
		if (areExperimentalFeaturesEnabled()) parts.push(theme.fg("warning", "xp"));
		return parts.join(" ");
	}

	private autoCompactSuffix(): string {
		return this.session.autoCompactionEnabled ? " (auto)" : "";
	}

	/** Right-aligns the right side of a bar line, truncating the left side first when there is no room. */
	private composeLine(left: string, right: string, width: number): string {
		const rightWidth = visibleWidth(right);
		if (!right) return pad(truncateToWidth(left, width, "…"), width);
		if (rightWidth >= width - 4) return pad(truncateToWidth(right, width, "…"), width);
		const leftBudget = width - rightWidth - 2;
		const clippedLeft = truncateToWidth(left, leftBudget, "…");
		const gap = Math.max(2, width - visibleWidth(clippedLeft) - rightWidth);
		return pad(clippedLeft + " ".repeat(gap) + right, width);
	}
}

function pad(line: string, width: number): string {
	const missing = width - visibleWidth(line);
	return missing > 0 ? line + " ".repeat(missing) : line;
}
