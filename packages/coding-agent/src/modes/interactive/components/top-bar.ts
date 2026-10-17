import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import { areExperimentalFeaturesEnabled } from "../../../core/experimental.ts";
import type { ContextUsage } from "../../../core/extensions/types.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../../../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";
import { formatCwdForFooter, formatTokens } from "./footer.ts";
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
		return [this.renderIdentityLine(width), this.renderResourceLine(width)];
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
		const modelName = state.model?.id || "no-model";
		const thinking = state.model?.reasoning ? ` • ${state.thinkingLevel || "off"}` : "";
		let label = `${modelName}${thinking}`;
		if (state.model && this.footerData.getAvailableProviderCount() > 1) {
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
	): string {
		const state = this.session.state;
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const percent = contextUsage?.percent ?? 0;

		const parts: string[] = [];
		if (usageTotals.input) parts.push(theme.fg("muted", `↑${formatTokens(usageTotals.input)}`));
		if (usageTotals.output) parts.push(theme.fg("muted", `↓${formatTokens(usageTotals.output)}`));
		if (usageTotals.cacheRead) parts.push(theme.fg("dim", `R${formatTokens(usageTotals.cacheRead)}`));
		if (usageTotals.cacheWrite) parts.push(theme.fg("dim", `W${formatTokens(usageTotals.cacheWrite)}`));
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
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
		const meter =
			theme.fg(percentColor, "▰".repeat(Math.round((percent / 100) * CONTEXT_METER_CELLS))) +
			theme.fg("dim", "▱".repeat(CONTEXT_METER_CELLS - Math.round((percent / 100) * CONTEXT_METER_CELLS)));
		const auto = this.autoCompactSuffix();
		const percentText = contextUsage?.percent !== null && contextUsage !== undefined ? `${percent.toFixed(0)}%` : "?";
		const context = `${theme.fg("dim", "ctx")} ${meter} ${theme.fg("muted", percentText)}${theme.fg("dim", `/${formatTokens(contextWindow)}${auto}`)}`;
		parts.push(context);
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
