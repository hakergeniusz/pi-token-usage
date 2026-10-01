/**
 * Token Usage extension — global token & cost accounting for pi.
 *
 * Inspired by Claude Code's cost-tracker (`cost-tracker.ts` + `/cost` command):
 * - per-model usage breakdown (input / output / cache read / cache write / cost)
 * - formatted totals (compact `1.2k` / `3.45M` numbers, `$0.0234`-style costs)
 * - a `/tokens` command analogous to `/cost`.
 *
 * How it works in pi:
 * - Every assistant message carries `usage` ({ input, output, cacheRead,
 *   cacheWrite, totalTokens, cost }). We record it in `message_end`
 *   (also covers `toolResult` messages with nested LLM `usage`, and
 *   `session_compact` summaries).
 * - Session totals are kept live in memory; global totals (across ALL
 *   sessions/projects) persist in `~/.pi/agent/token-usage.json`.
 * - Resumed/reloaded sessions are backfilled exactly once per session id,
 *   so restarts never double-count.
 * - `/tokens rebuild` re-scans every session on disk via
 *   `SessionManager.listAll()` for a fully accurate global recount.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Structural subset of pi-ai `Usage` — defensive, all fields optional. */
interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	timestamp?: number;
}

interface Totals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	requests: number;
}

interface TokenUsageStore {
	version: 1;
	/** All-time totals across every tracked session. */
	total: Totals;
	/** Per-model breakdown, keyed `provider/model`. */
	byModel: Record<string, Totals>;
	/** Per-day breakdown, keyed `YYYY-MM-DD` (local time). */
	byDay: Record<string, Totals>;
	/** Last-seen session totals per session id (dedup / backfill marker). */
	sessions: Record<string, Totals>;
	/** First tracking timestamp (ms). */
	since: number;
	updatedAt: number;
}

interface TokenReportData {
	title: string;
	lines: string[];
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Store helpers
// ---------------------------------------------------------------------------

function storePath(): string {
	return join(homedir(), ".pi", "agent", "token-usage.json");
}

function zeroTotals(): Totals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, requests: 0 };
}

function freshStore(): TokenUsageStore {
	const now = Date.now();
	return {
		version: 1,
		total: zeroTotals(),
		byModel: {},
		byDay: {},
		sessions: {},
		since: now,
		updatedAt: now,
	};
}

function loadStore(): TokenUsageStore {
	try {
		const raw = readFileSync(storePath(), "utf8");
		const parsed = JSON.parse(raw) as Partial<TokenUsageStore>;
		const base = freshStore();
		return {
			...base,
			...parsed,
			total: { ...zeroTotals(), ...(parsed.total ?? {}) },
			byModel: parsed.byModel ?? {},
			byDay: parsed.byDay ?? {},
			sessions: parsed.sessions ?? {},
		};
	} catch {
		return freshStore();
	}
}

/** Atomic write (tmp + rename) so concurrent `pi` processes rarely corrupt it. */
function saveStore(store: TokenUsageStore): void {
	try {
		store.updatedAt = Date.now();
		const path = storePath();
		mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
		const tmp = `${path}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
		renameSync(tmp, path);
	} catch (err) {
		console.error(`[token-usage] failed to save store: ${err}`);
	}
}

function dayKey(ts: number): string {
	// Local YYYY-MM-DD (en-CA formats exactly that way).
	return new Date(ts).toLocaleDateString("en-CA");
}

function addInto(dst: Totals, src: Totals): void {
	dst.input += src.input;
	dst.output += src.output;
	dst.cacheRead += src.cacheRead;
	dst.cacheWrite += src.cacheWrite;
	dst.total += src.total;
	dst.cost += src.cost;
	dst.requests += src.requests;
}

function totalsFromUsage(usage: UsageLike): Totals {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const total = usage.totalTokens ?? input + output;
	return {
		input,
		output,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		total,
		cost: usage.cost?.total ?? 0,
		requests: 1,
	};
}

/**
 * Record one LLM call in the global store.
 * Reloads from disk first to reduce lost updates from concurrent processes.
 */
function recordUsage(usage: UsageLike, modelKey: string | undefined, ts: number): void {
	const store = loadStore();
	const delta = totalsFromUsage(usage);
	addInto(store.total, delta);
	if (modelKey) {
		store.byModel[modelKey] ??= zeroTotals();
		addInto(store.byModel[modelKey], delta);
	}
	const day = dayKey(ts);
	store.byDay[day] ??= zeroTotals();
	addInto(store.byDay[day], delta);
	saveStore(store);
}

/** Mark a session's totals as seen (backfill marker) without touching globals. */
function markSessionSeen(sessionId: string, totals: Totals): void {
	const store = loadStore();
	store.sessions[sessionId] = { ...totals };
	saveStore(store);
}

/**
 * Backfill a session exactly once: if this session id was never recorded,
 * add its full historical totals to the global buckets (day-attributed per
 * message timestamp) and snapshot it. Otherwise no-op.
 */
function backfillSessionOnce(
	sessionId: string,
	perCall: Array<{ usage: UsageLike; modelKey?: string; ts: number }>,
): Totals {
	const sessionTotals = zeroTotals();
	for (const call of perCall) addInto(sessionTotals, totalsFromUsage(call.usage));

	const store = loadStore();
	if (store.sessions[sessionId]) return store.sessions[sessionId];
	for (const call of perCall) {
		const delta = totalsFromUsage(call.usage);
		addInto(store.total, delta);
		if (call.modelKey) {
			store.byModel[call.modelKey] ??= zeroTotals();
			addInto(store.byModel[call.modelKey], delta);
		}
		const day = dayKey(call.ts);
		store.byDay[day] ??= zeroTotals();
		addInto(store.byDay[day], delta);
	}
	store.sessions[sessionId] = { ...sessionTotals };
	saveStore(store);
	return sessionTotals;
}

// ---------------------------------------------------------------------------
// Session scanning
// ---------------------------------------------------------------------------

interface ScannedCall {
	usage: UsageLike;
	modelKey?: string;
	ts: number;
}

/** Extract every LLM call (assistant + nested tool + compaction usage) from entries. */
function scanEntries(entries: any[]): ScannedCall[] {
	const calls: ScannedCall[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "message" && entry.message) {
			const msg = entry.message;
			if (msg.role === "assistant" && msg.usage) {
				const modelKey =
					msg.provider && msg.model ? `${msg.provider}/${msg.model}` : undefined;
				calls.push({ usage: msg.usage, modelKey, ts: msg.timestamp ?? Date.now() });
			} else if (msg.role === "toolResult" && msg.usage) {
				// Nested LLM work performed by a tool — counts toward spend,
				// but has no attributable model, so only global/day totals.
				calls.push({ usage: msg.usage, ts: msg.timestamp ?? Date.now() });
			}
		} else if (entry.type === "compaction" && (entry as any).usage) {
			const ts = (entry as any).timestamp;
			const tsMs = typeof ts === "number" ? ts : Date.parse(ts ?? "") || Date.now();
			calls.push({ usage: (entry as any).usage, ts: tsMs });
		}
	}
	return calls;
}

function sumCalls(calls: ScannedCall[]): Totals {
	const totals = zeroTotals();
	for (const call of calls) addInto(totals, totalsFromUsage(call.usage));
	return totals;
}

// ---------------------------------------------------------------------------
// Formatting (Claude Code style)
// ---------------------------------------------------------------------------

function formatTokens(n: number): string {
	if (!Number.isFinite(n)) return "0";
	if (n < 1000) return `${Math.round(n)}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatInt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

/** Claude Code's formatCost: 4 decimals under $0.50, else 2. */
function formatCost(cost: number): string {
	if (!Number.isFinite(cost)) return "$0.0000";
	return `$${cost > 0.5 ? cost.toFixed(2) : cost.toFixed(4)}`;
}

function formatTotalsLine(t: Totals): string {
	const parts = [`↑${formatInt(t.input)} in`, `↓${formatInt(t.output)} out`];
	if (t.cacheRead > 0 || t.cacheWrite > 0) {
		parts.push(`${formatInt(t.cacheRead)} cache-read`, `${formatInt(t.cacheWrite)} cache-write`);
	}
	parts.push(`${formatInt(t.total)} total`, formatCost(t.cost), `${t.requests} req`);
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Report building
// ---------------------------------------------------------------------------

function topEntries(map: Record<string, Totals>, limit: number): Array<[string, Totals]> {
	return Object.entries(map)
		.sort((a, b) => b[1].total - a[1].total)
		.slice(0, limit);
}

function buildSessionReport(
	session: Totals,
	modelKey: string | undefined,
	contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined,
): string[] {
	const lines = [formatTotalsLine(session)];
	if (modelKey) lines.push(`model: ${modelKey}`);
	if (contextUsage && contextUsage.percent !== null && contextUsage.percent !== undefined) {
		const used =
			contextUsage.tokens !== null && contextUsage.tokens !== undefined
				? formatInt(contextUsage.tokens)
				: "?";
		lines.push(
			`context: ${contextUsage.percent.toFixed(1)}% (${used} / ${formatInt(contextUsage.contextWindow)})`,
		);
	}
	return lines;
}

function buildGlobalReport(store: TokenUsageStore, days: number): string[] {
	const lines: string[] = [
		formatTotalsLine(store.total),
		`${Object.keys(store.sessions).length} sessions tracked since ${new Date(store.since).toLocaleDateString()}`,
	];
	const today = store.byDay[dayKey(Date.now())];
	if (today && today.requests > 0) lines.push(`today: ${formatTotalsLine(today)}`);

	const topModels = topEntries(store.byModel, 5);
	if (topModels.length > 0) {
		lines.push("top models:");
		for (const [model, t] of topModels) {
			lines.push(`  ${model}: ${formatTokens(t.input)} in · ${formatTokens(t.output)} out · ${formatCost(t.cost)}`);
		}
	}
	const dayKeys = Object.keys(store.byDay).sort().slice(-days);
	if (dayKeys.length > 0) {
		lines.push(`last ${dayKeys.length} days:`);
		for (const day of dayKeys) {
			const t = store.byDay[day];
			lines.push(`  ${day}: ${formatTokens(t.total)} · ${formatCost(t.cost)} · ${t.requests} req`);
		}
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Live in-memory totals for the current session instance.
	let liveSession = zeroTotals();
	let liveSessionId: string | undefined;

	pi.registerEntryRenderer<TokenReportData>("token-usage-report", (entry, { expanded }, theme) => {
		const data = entry.data ?? { title: "Token usage", lines: [], timestamp: Date.now() };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg("accent", "◈")} ${theme.bold(data.title)}`, 0, 0));
		for (const line of data.lines) {
			box.addChild(new Text(`  ${theme.fg("muted", line)}`, 0, 0));
		}
		if (expanded) {
			box.addChild(
				new Text(theme.fg("dim", `  updated ${new Date(data.timestamp).toLocaleString()}`), 0, 0),
			);
		}
		return box;
	});

	// --- lifecycle: rebuild live totals + backfill globals exactly once ---
	pi.on("session_start", async (_event, ctx) => {
		try {
			const sessionId = ctx.sessionManager.getSessionId();
			liveSessionId = sessionId;
			const calls = scanEntries(ctx.sessionManager.getEntries() as any[]);
			liveSession = backfillSessionOnce(sessionId, calls);
		} catch (err) {
			console.error(`[token-usage] session_start failed: ${err}`);
			liveSession = zeroTotals();
		}
	});

	// --- live tracking: one record per LLM call (Claude Code: addToTotalModelUsage) ---
	pi.on("message_end", async (event) => {
		try {
			const msg = (event as any).message;
			if (!msg || !msg.usage) return;
			const ts = msg.timestamp ?? Date.now();
			if (msg.role === "assistant") {
				const modelKey =
					msg.provider && msg.model ? `${msg.provider}/${msg.model}` : undefined;
				addInto(liveSession, totalsFromUsage(msg.usage));
				recordUsage(msg.usage, modelKey, ts);
				if (liveSessionId) markSessionSeenOnIncrement(liveSessionId);
			} else if (msg.role === "toolResult") {
				addInto(liveSession, totalsFromUsage(msg.usage));
				recordUsage(msg.usage, undefined, ts);
				if (liveSessionId) markSessionSeenOnIncrement(liveSessionId);
			}
		} catch (err) {
			console.error(`[token-usage] message_end failed: ${err}`);
		}
	});

	/** Fold the live in-memory session totals into the store's session snapshot. */
	function markSessionSeenOnIncrement(sessionId: string): void {
		try {
			const store = loadStore();
			store.sessions[sessionId] = { ...liveSession };
			saveStore(store);
		} catch {
			// ignore
		}
	}

	// --- compaction summaries also cost tokens (Claude Code counts them too) ---
	pi.on("session_compact", async (event) => {
		try {
			const usage = (event.compactionEntry as any)?.usage as UsageLike | undefined;
			if (usage) {
				addInto(liveSession, totalsFromUsage(usage));
				recordUsage(usage, undefined, Date.now());
				if (liveSessionId) markSessionSeenOnIncrement(liveSessionId);
			}
		} catch (err) {
			console.error(`[token-usage] session_compact failed: ${err}`);
		}
	});

	// --- full recount across every session on disk ---
	async function rebuildGlobals(): Promise<{ sessions: number; calls: number }> {
		const store = freshStore();
		store.since = loadStore().since;
		let sessionCount = 0;
		let callCount = 0;
		const infos = await SessionManager.listAll();
		for (const info of infos) {
			try {
				const sm = SessionManager.open(info.path);
				const calls = scanEntries(sm.getEntries() as any[]);
				const totals = sumCalls(calls);
				if (totals.requests === 0) continue;
				sessionCount++;
				callCount += totals.requests;
				store.sessions[sm.getSessionId()] = { ...totals };
				addInto(store.total, totals);
				for (const call of calls) {
					const delta = totalsFromUsage(call.usage);
					if (call.modelKey) {
						store.byModel[call.modelKey] ??= zeroTotals();
						addInto(store.byModel[call.modelKey], delta);
					}
					const day = dayKey(call.ts);
					store.byDay[day] ??= zeroTotals();
					addInto(store.byDay[day], delta);
				}
			} catch (err) {
				console.error(`[token-usage] rebuild skipped ${info.path}: ${err}`);
			}
		}
		saveStore(store);
		return { sessions: sessionCount, calls: callCount };
	}

	function showReport(ctx: any, title: string, lines: string[]): void {
		pi.appendEntry<TokenReportData>("token-usage-report", {
			title,
			lines,
			timestamp: Date.now(),
		});
		// Non-TUI modes can't render entry cards; print there instead
		// (never in json mode — stdout must stay machine-readable).
		if (ctx.mode === "print") {
			console.log(`\n${title}\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
		}
	}

	// --- /tokens command (cf. Claude Code's /cost) ---
	pi.registerCommand("tokens", {
		description: "Show token & cost usage (session + global). Args: global|models|days [n]|rebuild|reset|session",
		getArgumentCompletions: (prefix: string) => {
			const subs = ["global", "models", "days", "rebuild", "reset", "session"];
			const filtered = subs.filter((s) => s.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((s) => ({ value: s, label: s })) : null;
		},
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] ?? "").toLowerCase();
			const store = loadStore();
			const modelKey =
				ctx.model && (ctx.model as any).provider && (ctx.model as any).id
					? `${(ctx.model as any).provider}/${(ctx.model as any).id}`
					: undefined;

			if (sub === "rebuild") {
				ctx.ui.notify("Scanning all sessions…", "info");
				const { sessions, calls } = await rebuildGlobals();
				// Re-sync live session totals from the rebuilt snapshot.
				try {
					const fresh = loadStore();
					const snap = fresh.sessions[ctx.sessionManager.getSessionId()];
					if (snap) liveSession = { ...snap };
				} catch {
					// ignore
				}
				showReport(ctx, "Token usage — rebuilt", [
					`recounted ${calls} requests across ${sessions} sessions`,
					formatTotalsLine(loadStore().total),
				]);
				return;
			}

			if (sub === "reset") {
				if (ctx.hasUI) {
					const ok = await ctx.ui.confirm(
						"Reset global token usage?",
						"This clears all-time totals, per-model and per-day history.",
					);
					if (!ok) {
						ctx.ui.notify("Reset cancelled", "info");
						return;
					}
				}
				saveStore(freshStore());
				// Re-baseline the current session so its history isn't lost.
				try {
					const calls = scanEntries(ctx.sessionManager.getEntries() as any[]);
					liveSession = backfillSessionOnce(ctx.sessionManager.getSessionId(), calls);
				} catch {
					// ignore
				}
				ctx.ui.notify("Global token usage reset", "info");
				return;
			}

			if (sub === "global") {
				showReport(ctx, "Token usage — global", buildGlobalReport(store, 7));
				return;
			}

			if (sub === "models") {
				const top = topEntries(store.byModel, 20);
				showReport(
					ctx,
					"Token usage — by model",
					top.length > 0
						? top.map(([m, t]) => `${m}: ${formatTotalsLine(t)}`)
						: ["no model usage tracked yet"],
				);
				return;
			}

			if (sub === "days") {
				const n = Math.min(Math.max(parseInt(parts[1] ?? "14", 10) || 14, 1), 90);
				const dayKeys = Object.keys(store.byDay).sort().slice(-n);
				showReport(
					ctx,
					`Token usage — last ${dayKeys.length} days`,
					dayKeys.length > 0
						? dayKeys.map((d) => `${d}: ${formatTotalsLine(store.byDay[d])}`)
						: ["no daily usage tracked yet"],
				);
				return;
			}

			// Default: session + global summary (like /cost).
			showReport(ctx, "Token usage — session", [
				...buildSessionReport(liveSession, modelKey, ctx.getContextUsage?.()),
				`global: ${formatTotalsLine(store.total)} across ${Object.keys(store.sessions).length} sessions`,
			]);
		},
	});

	// --- tool so the agent itself can query usage ---
	pi.registerTool({
		name: "token_usage",
		label: "Token Usage",
		// Deferred: not declared in every request; tool_search finds and
		// activates it when the agent needs usage numbers. /token-usage still
		// covers the human path.
		exposure: "deferred",
		description: "Query token and cost usage for the current session or globally across all pi sessions.",
		parameters: Type.Object({
			scope: StringEnum(["session", "global", "models", "days"] as const, {
				description: "Which usage to report",
			}),
			days: Type.Optional(Type.Integer({ minimum: 1, maximum: 90, description: "Days of history for scope=days" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const store = loadStore();
			let text: string;
			switch (params.scope) {
				case "session": {
					const totals = sumCalls(scanEntries(ctx.sessionManager.getEntries() as any[]));
					text = `Session usage: ${formatTotalsLine(totals)}`;
					break;
				}
				case "global":
					text = `Global usage (${Object.keys(store.sessions).length} sessions): ${formatTotalsLine(store.total)}`;
					break;
				case "models": {
					const top = topEntries(store.byModel, 10);
					text =
						top.length > 0
							? `Usage by model:\n${top.map(([m, t]) => `- ${m}: ${formatTotalsLine(t)}`).join("\n")}`
							: "No model usage tracked yet.";
					break;
				}
				case "days": {
					const n = params.days ?? 7;
					const dayKeys = Object.keys(store.byDay).sort().slice(-n);
					text =
						dayKeys.length > 0
							? `Usage by day:\n${dayKeys.map((d) => `- ${d}: ${formatTotalsLine(store.byDay[d])}`).join("\n")}`
							: "No daily usage tracked yet.";
					break;
				}
			}
			return { content: [{ type: "text", text }], details: {} };
		},
	});
}
