/**
 * Cache Keepalive
 *
 * Why: a prompt cache is only cheap on a *read*; after its TTL expires the next real
 * request re-writes the prefix at full price (measured on this install: every gap over
 * one hour between two requests to the same model produced a cold request). pi's own
 * cache warmer keeps only the model of the current run warm and stops 30 minutes into
 * an idle stretch, so a model that served earlier and is still going to serve again
 * goes cold.
 *
 * What this extension does:
 *  1. On `before_provider_request` it stores, per `provider|model`, the complete outgoing
 *     payload as a JSON string, its sha256, the timestamp, and the cache TTL taken from
 *     the payload's own `cache_control` markers.
 *  2. A 60 s ticker, quiet for at least 10 s with no request of the session's own
 *     streaming, replays that payload with `max_tokens: 1` through
 *     `ctx.modelRegistry.streamSimple`,
 *     the provider transport a real request uses. `onPayload` returns the captured bytes
 *     and the Anthropic OAuth wrapper shapes them last, so the wire request is exactly
 *     `shape(capture)` — the same prefix the real request cached. Raw
 *     `@earendil-works/pi-ai/compat` is never used: it bypasses that wrapper.
 *  3. Any real request for a model replaces its capture and resets its gap counters.
 *
 * Three guards refuse a *write* before sending:
 *  - Liveness: a model is warmed only while `now - lastConfirmedAt < ttl × 0.95`, where
 *    `lastConfirmedAt` is the later of its last real request and its last successful warm.
 *    Once that window is missed (process asleep, agent busy, a skipped tick, a failed
 *    warm), the model is `expired` for the rest of the idle gap and is never warmed again;
 *    only a real request clears `expired`. A warm after expiry would re-write the prefix.
 *  - Prefix validity: the capture records the branch entry id it was taken at. Any
 *    `compaction`, `context_edit` or `branch_summary` appended since then drops the capture
 *    (`skipped:rewritten`). Plain message appends (assistant, tool result, user) only
 *    extend the prefix, so they do not drop it.
 *  - Byte integrity: the capture records the sha256 of its `max_tokens: 1` replay. Before
 *    every send the replay is rebuilt and re-hashed; a byte difference logs
 *    `skipped:render-drift` with both hashes and sends nothing. A missing transport logs
 *    `skipped:no-transport`. Both expire the model for the gap.
 *
 * The warm's own usage is measured after the fact: `cacheWrite > 0` means the byte
 * guarantee did not hold. That warm is not counted as a success and the model expires
 * with `warm-wrote-cache`, so a second write cannot follow.
 *
 * One input the pre-send guards cannot see is the OAuth wrapper's own shaping: if the
 * Claude Code billing version it resolves changes between capture and warm, `shape(capture)`
 * differs from the original wire request. `warm-wrote-cache` detects that after one write
 * and stops the gap; it is not pre-empted.
 *
 * What the guards cannot see: Magic Context rewrites its injected `m[0]/m[1]` block inside
 * the `context` hook without appending a session entry. That rewrite is invisible here, so
 * a warm taken after it replays a stale prefix. The liveness guard bounds the damage to
 * one cache *read* (the entry is still alive); the subsequent cache bust is Magic
 * Context's rewrite, not this extension's. No detection is claimed for it.
 *
 * Budget: API rates derived at runtime from the model's own `cost` metadata, never a
 * hardcoded price table. A warm costs `promptTokens × cost.cacheRead`; the cold start it
 * avoids costs `promptTokens × (cost.cacheWrite || cost.input)`. A gap stops warming once
 * cumulative warm spend reaches `maxWarmCostFraction` (default 0.25) of one such cold
 * start. The implied number of warms is derived, not configured:
 * `warmsAllowed = floor(maxWarmCostFraction / (warmCost / coldStartCost))` and shown in
 * status. Only when a model reports no `cost.cacheRead`, or neither `cost.cacheWrite` nor
 * `cost.input`, does a count backstop of six apply, labelled `count fallback` in status.
 *
 * The 5-hour window is instrumented, not budgeted: before and ~60 s after each keepalive
 * the extension samples `five_hour.utilization` (Anthropic) or
 * `primary_window.used_percent` (Codex) and records the delta on the audit entry as
 * `observed`. A delta of 0 or a window reset is recorded as `unknown`, never as free, and
 * it never gates anything.
 *
 * v1 supports the Anthropic messages wire only, detected by payload shape (string
 * `model`, array `system`, array `messages`). Every other wire is tracked and shown in
 * `/cache-keepalive status` as `skipped:wire-unsupported`; it is never sent. A model whose
 * registry entry is missing or whose api is not `anthropic-messages` is
 * `skipped:no-transport`; there is no compat fallback.
 *
 * Fail open: every failure is logged and counted, never thrown into the session. One
 * attempt per schedule, `maxRetries: 0`.
 *
 * Config: ~/.pi/agent/cache-keepalive.json (all keys optional)
 *   enabled                default true
 *   warmAtFraction         default 0.85  (warm at this fraction of the cache TTL)
 *   maxWarmCostFraction    default 0.25  (warm spend cap as a fraction of one cold start)
 *   models                 default []    (empty: every Anthropic-messages model that served)
 *   maxIdleHours           default 8     (stop after this long continuously idle)
 *
 * Usage: /cache-keepalive status|on|off
 * Log:   /tmp/cache-keepalive.log (one line per warm and per state change; override with
 *        `PI_CACHE_KEEPALIVE_LOG` for test isolation)
 * Audit: one `custom` session entry per warm, `customType: "cache-keepalive"`.
 *
 * While a run is open but not streaming — a long tool, or `ask_user_question` waiting for
 * the user — the run is *blocked*, and that is the warm this extension was missing: `busy`
 * used to hold it dark for the whole wait, which is exactly the gap that outlives the TTL.
 * A blocked run is allowed (see `warmGate`); a streaming one is not, and neither is a
 * compaction.
 *
 * Note on pi's built-in warmer: it stops 60 minutes after the request that started it and
 * has no spend cap, so it covers one refresh and gives up. This extension is the one to run
 * when a wait can outlive that hour. Set `cacheWarming: "off"` so the two do not both warm
 * the same entry five minutes apart.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const CONFIG_DIR_ENV = "PI_CODING_AGENT_DIR";
/** Agent dir, honouring the same override pi itself uses. */
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
export const DEFAULT_CONFIG_PATH = join(AGENT_DIR, "cache-keepalive.json");
export const LOG_PATH = process.env.PI_CACHE_KEEPALIVE_LOG ?? "/tmp/cache-keepalive.log";
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export const TICK_MS = 60_000;
/** A keepalive is sent only this long after the last agent activity. */
export const QUIET_MS = 10_000;
/** Wait this long after a warm before sampling the window again. */
export const AFTER_PROBE_MS = 60_000;
const WARM_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 10_000;
export const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

export interface CacheKeepaliveConfig {
	enabled: boolean;
	warmAtFraction: number;
	maxWarmCostFraction: number;
	/**
	 * Hard cap on keepalives per gap. When set it owns the cap and `maxWarmCostFraction` is inert:
	 * the priced fraction allows only six on the Anthropic read/write ratio (0.25 ÷ (0.2 ÷ 5)),
	 * so asking for nine warms needs a count, not a budget. Unset keeps the priced policy.
	 */
	warmCount?: number;
	models: string[];
	maxIdleHours: number;
}

/** Count backstop used only when a model reports no usable price metadata. */
export const FALLBACK_WARMS_PER_GAP = 6;

export const DEFAULT_CONFIG: CacheKeepaliveConfig = {
	enabled: true,
	warmAtFraction: 0.85,
	warmCount: undefined,
	maxWarmCostFraction: 0.25,
	models: [],
	maxIdleHours: 8,
};

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env[CONFIG_DIR_ENV];
	return dir === undefined || dir === "" ? DEFAULT_CONFIG_PATH : join(dir, "cache-keepalive.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Validate and clamp a config object; every field falls back independently. */
export function parseConfig(raw: unknown): CacheKeepaliveConfig {
	const root = isRecord(raw) ? raw : {};
	const fraction = finite(root.warmAtFraction);
	const costFraction = finite(root.maxWarmCostFraction);
	const warms = finite(root.warmCount);
	const idle = finite(root.maxIdleHours);
	return {
		enabled: typeof root.enabled === "boolean" ? root.enabled : DEFAULT_CONFIG.enabled,
		// Below 0.1 the cache is still nearly fresh; above 1.0 a warm would arrive after expiry.
		warmAtFraction: fraction === undefined ? DEFAULT_CONFIG.warmAtFraction : Math.min(1, Math.max(0.1, fraction)),
		maxWarmCostFraction:
			costFraction === undefined || costFraction < 0 ? DEFAULT_CONFIG.maxWarmCostFraction : costFraction,
		warmCount: warms === undefined || warms < 1 ? undefined : Math.floor(warms),
		models: Array.isArray(root.models) ? root.models.filter((entry): entry is string => typeof entry === "string") : [],
		maxIdleHours: idle === undefined || idle <= 0 ? DEFAULT_CONFIG.maxIdleHours : idle,
	};
}

export function loadConfig(path = configPath()): CacheKeepaliveConfig {
	try {
		if (!existsSync(path)) return parseConfig({});
		return parseConfig(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		// A damaged config must never stop a session.
		return parseConfig({});
	}
}

/** The Anthropic messages wire, recognised by shape rather than by provider name. */
export function isAnthropicMessagesPayload(payload: unknown): payload is Record<string, unknown> {
	return (
		isRecord(payload) &&
		typeof payload.model === "string" &&
		payload.model.length > 0 &&
		Array.isArray(payload.system) &&
		Array.isArray(payload.messages) &&
		payload.messages.every(isRecord)
	);
}

export function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Replace only the top-level `max_tokens` value in the captured JSON string, leaving every
 * other byte untouched. The returned JSON is re-parsed and compared with the capture so a
 * key this function did not intend to touch cannot slip through.
 */
export function buildReplay(capturedJson: string): { ok: true; json: string; sha: string } | { ok: false; reason: string } {
	let captured: unknown;
	try {
		captured = JSON.parse(capturedJson);
	} catch {
		return { ok: false, reason: "payload-shape" };
	}
	if (!isRecord(captured) || typeof captured.max_tokens !== "number") return { ok: false, reason: "payload-shape" };
	const match = /"max_tokens":(\d+)/.exec(capturedJson);
	if (match === null || match.index === undefined) return { ok: false, reason: "payload-shape" };
	const json =
		capturedJson.slice(0, match.index) + '"max_tokens":1' + capturedJson.slice(match.index + match[0].length);
	let replayed: unknown;
	try {
		replayed = JSON.parse(json);
	} catch {
		return { ok: false, reason: "payload-shape" };
	}
	if (JSON.stringify(replayed) !== JSON.stringify({ ...captured, max_tokens: 1 })) return { ok: false, reason: "payload-shape" };
	return { ok: true, json, sha: sha256(json) };
}

export type RenderMatch =
	| { ok: true; sha: string }
	| { ok: false; capturedSha: string; renderedSha: string };

/**
 * Compare the payload that will be handed to the provider transport with the captured
 * payload, ignoring the one intentional difference (`max_tokens: 1`). Both sides go through
 * `buildReplay`, which replaces only the top-level `max_tokens` value, so a byte difference
 * anywhere else changes the sha. This is the pre-send check that refuses a drifted replay.
 */
export function renderMatches(capturedJson: string, renderedJson: string): RenderMatch {
	const captured = buildReplay(capturedJson);
	const rendered = buildReplay(renderedJson);
	if (!captured.ok || !rendered.ok) {
		return {
			ok: false,
			capturedSha: captured.ok ? captured.sha : "none",
			renderedSha: rendered.ok ? rendered.sha : "none",
		};
	}
	return captured.sha === rendered.sha ? { ok: true, sha: rendered.sha } : { ok: false, capturedSha: captured.sha, renderedSha: rendered.sha };
}

/** True when the captured payload can be replayed cheaply and safely. */
export function planCapture(payload: unknown): { ok: true; json: string; sha: string; renderSha: string; ttlMs: number } | { ok: false; reason: string } {
	if (!isAnthropicMessagesPayload(payload)) return { ok: false, reason: "wire-unsupported" };
	// Budget-based thinking derives its budget from max_tokens; a one-token replay would
	// either be rejected or change the cache key. Adaptive thinking is safe.
	const thinking = isRecord(payload.thinking) ? payload.thinking : undefined;
	if (thinking?.type === "enabled") return { ok: false, reason: "thinking-budget" };
	let json: string;
	try {
		json = JSON.stringify(payload);
	} catch {
		return { ok: false, reason: "payload-shape" };
	}
	const replay = buildReplay(json);
	if (!replay.ok) return { ok: false, reason: replay.reason };
	return { ok: true, json, sha: sha256(json), renderSha: replay.sha, ttlMs: ttlFromPayload(payload) };
}

/** Cache TTL from the payload's own markers: 1h when any marker asks for it, else 5m. */
export function ttlFromPayload(payload: unknown): number {
	let found = false;
	let oneHour = false;
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		if (!isRecord(value)) return;
		for (const [key, entry] of Object.entries(value)) {
			if (key === "cache_control" && isRecord(entry)) {
				found = true;
				if (entry.ttl === "1h") oneHour = true;
			} else {
				visit(entry);
			}
		}
	};
	visit(payload);
	if (!found) return 5 * 60_000;
	return oneHour ? 60 * 60_000 : 5 * 60_000;
}

export function warmAtMs(ttlMs: number, fraction: number): number {
	return Math.max(1, Math.floor(ttlMs * fraction));
}

export interface ModelCostRates {
	input: number;
	cacheRead: number;
	cacheWrite: number;
}

/** What one keepalive of this prompt costs at the model's own API rates. */
export function warmCostUsd(promptTokens: number, cost: ModelCostRates): number {
	return (promptTokens * cost.cacheRead) / 1_000_000;
}

/** What re-writing this prompt after a cache miss costs at the model's own API rates. */
export function coldStartUsd(promptTokens: number, cost: ModelCostRates): number {
	const rate = cost.cacheWrite > 0 ? cost.cacheWrite : cost.input;
	return (promptTokens * rate) / 1_000_000;
}

/** Warm spend allowed per idle gap: a fraction of one cold start. */
export function warmBudgetUsd(coldCostUsd: number, maxWarmCostFraction: number): number {
	return coldCostUsd > 0 ? coldCostUsd * maxWarmCostFraction : 0;
}

export type Wire = "anthropic-messages" | "unsupported";

export interface ModelTrack {
	key: string;
	modelId: string;
	provider?: string;
	wire: Wire;
	payloadJson?: string;
	payloadSha?: string;
	/** sha256 of the capture with `max_tokens` replaced by 1: the byte-integrity anchor. */
	renderSha?: string;
	capturedAt?: number;
	lastRequestAt: number;
	/** Later of the last real request and the last successful warm: the liveness anchor. */
	lastConfirmedAt: number;
	ttlMs: number;
	/** True once the liveness window was missed or a warm failed; only a real request clears it. */
	expired: boolean;
	/** Branch entry id the capture was taken at, for the rewrite guard. */
	captureEntryId?: string;
	captureEntryCount?: number;
	/** Set when a compaction/context_edit/branch_summary invalidated the capture. */
	rewritten: boolean;
	warmsThisGap: number;
	coldStartsAvoided: number;
	/** Cumulative keepalive spend this gap, from response usage. */
	warmCostUsd: number;
	/** One keepalive at this prompt size, derived from the model's cost metadata. */
	warmUnitCostUsd: number;
	/** One cold start at this prompt size, derived from the model's cost metadata. */
	coldStartUsd: number;
	/** Budget for this gap: `maxWarmCostFraction × coldStartUsd`, 0 when metadata is missing. */
	budgetUsd: number;
	/** Warms the price derivation allows in this gap; undefined until a warm measured them. */
	warmsAllowed?: number;
	/** Whether the model reported the price metadata the budget depends on. */
	priceMetadata: boolean;
	/** Prompt size of the last measured request, and of the previous gap's capture. */
	promptTokens?: number;
	capturedBytes?: number;
	avoidedUsd: number;
	observedPercent: number;
	failures: number;
	nextWarmAllowedAt: number;
	closedGap: boolean;
	skip?: string;
	lastResult?: string;
	lastDelta?: number | "unknown";
}

export type WarmDecision = { warm: true } | { warm: false; reason: string; nextWarmAt?: number };

/**
 * Pure scheduling decision for one tracked model.
 *
 * A model is warmed when the cache entry is old enough (`warmAtFraction` of its TTL), the
 * gap has budget and warms left, the idle limit has not passed, and the capture is still
 * replayable. Everything else returns a reason suitable for status/logs.
 */
export function decideWarm(track: ModelTrack, now: number, config: CacheKeepaliveConfig): WarmDecision {
	if (track.wire !== "anthropic-messages") return { warm: false, reason: "wire-unsupported" };
	if (track.payloadJson === undefined) return { warm: false, reason: track.skip ?? "payload-shape" };
	if (track.provider === undefined) return { warm: false, reason: "provider-unresolved" };
	if (track.expired) return { warm: false, reason: "expired" };
	if (track.rewritten) return { warm: false, reason: "rewritten" };
	if (track.closedGap) return { warm: false, reason: "max-idle" };
	if (now - track.lastRequestAt > config.maxIdleHours * 60 * 60_000) return { warm: false, reason: "max-idle" };
	// A warm after 95 % of the TTL is a cache *write*, not a read: refuse it for the gap.
	if (now - track.lastConfirmedAt >= track.ttlMs * 0.95) return { warm: false, reason: "expired" };
	if (!track.priceMetadata) {
		// No usable prices: the priced policy cannot run, so a count backstop applies.
		if (track.warmsThisGap >= (config.warmCount ?? FALLBACK_WARMS_PER_GAP)) {
			return { warm: false, reason: "count-fallback" };
		}
	} else if (
		(track.warmsAllowed !== undefined && track.warmsThisGap >= track.warmsAllowed) ||
		(track.budgetUsd > 0 && track.warmCostUsd >= track.budgetUsd)
	) {
		// The derived count and the spend cap are the same priced policy; whichever binds first.
		return { warm: false, reason: "cost-budget" };
	}
	if (now < track.nextWarmAllowedAt) return { warm: false, reason: "backoff", nextWarmAt: track.nextWarmAllowedAt };
	const warmAt = warmAtMs(track.ttlMs, config.warmAtFraction);
	const due = track.lastConfirmedAt + warmAt;
	if (now < due) return { warm: false, reason: "not-due", nextWarmAt: due };
	return { warm: true };
}

export interface WindowReading {
	percent?: number;
	source: string;
	error?: string;
}

/** `five_hour.utilization` from the Anthropic OAuth usage payload. */
export function parseAnthropicUtilization(payload: unknown): number | undefined {
	if (!isRecord(payload)) return undefined;
	const fiveHour = isRecord(payload.five_hour) ? payload.five_hour : undefined;
	const percent = finite(fiveHour?.utilization ?? fiveHour?.used_percentage);
	return percent === undefined || percent < 0 ? undefined : Math.min(percent, 100);
}

/** `rate_limit.primary_window.used_percent` from the ChatGPT Codex usage payload. */
export function parseCodexUtilization(payload: unknown): number | undefined {
	if (!isRecord(payload)) return undefined;
	const limits = isRecord(payload.rate_limit) ? payload.rate_limit : undefined;
	const primary = isRecord(limits?.primary_window) ? limits.primary_window : undefined;
	const percent = finite(primary?.used_percent);
	return percent === undefined || percent < 0 ? undefined : Math.min(percent, 100);
}

/** `chatgpt_account_id` from a Codex access-token JWT. */
function codexAccountId(token: string): string | undefined {
	const parts = token.split(".");
	if (parts.length !== 3 || parts[1] === undefined) return undefined;
	try {
		const claim = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		const namespace = isRecord(claim) && isRecord(claim["https://api.openai.com/auth"]) ? claim["https://api.openai.com/auth"] : undefined;
		const id = isRecord(namespace) ? namespace.chatgpt_account_id : undefined;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
	try {
		const response = await fetch(url, { headers, signal: controller.signal });
		if (!response.ok) throw new Error(`http-${response.status}`);
		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Provider window utilisation (percent of the 5-hour window), or a reason why it is
 * unknown. Never throws and never returns 0 for a missing answer.
 */
export async function readUtilization(provider: string | undefined, registry: ExtensionContext["modelRegistry"]): Promise<WindowReading> {
	if (provider === undefined) return { source: "none", error: "provider-unresolved" };
	try {
		if (provider === "anthropic") {
			const token = await registry.getApiKeyForProvider("anthropic");
			if (token === undefined || token === "") return { source: "anthropic", error: "no-token" };
			if (token.startsWith("sk-ant-api")) return { source: "anthropic", error: "api-key" };
			const payload = await fetchJson(ANTHROPIC_USAGE_URL, {
				Authorization: `Bearer ${token}`,
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": "claude-code/2.1",
			});
			const percent = parseAnthropicUtilization(payload);
			return percent === undefined ? { source: "anthropic", error: "unparsed" } : { source: "anthropic", percent };
		}
		if (provider === "openai-codex") {
			const token = await registry.getApiKeyForProvider("openai-codex");
			if (token === undefined || token === "") return { source: "openai-codex", error: "no-token" };
			const accountId = codexAccountId(token);
			const payload = await fetchJson(CODEX_USAGE_URL, {
				Authorization: `Bearer ${token}`,
				...(accountId === undefined ? {} : { "ChatGPT-Account-Id": accountId }),
			});
			const percent = parseCodexUtilization(payload);
			return percent === undefined ? { source: "openai-codex", error: "unparsed" } : { source: "openai-codex", percent };
		}
		return { source: provider, error: "no-collector" };
	} catch (error) {
		return { source: provider, error: error instanceof Error ? error.message : String(error) };
	}
}

/** Measured window delta, or `unknown` when either reading is missing or the window reset. */
export function windowDelta(before: WindowReading, after: WindowReading): { delta?: number; reason?: string } {
	if (before.percent === undefined) return { reason: before.error ?? "before-unavailable" };
	if (after.percent === undefined) return { reason: after.error ?? "after-unavailable" };
	if (after.percent < before.percent) return { reason: "window-reset" };
	if (after.percent === before.percent) return { reason: "no-change" };
	return { delta: after.percent - before.percent };
}

function rotateLog(): void {
	try {
		if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > MAX_LOG_BYTES) renameSync(LOG_PATH, `${LOG_PATH}.1`);
	} catch {
		// Observability must never break a request.
	}
}

function logLine(text: string): void {
	try {
		rotateLog();
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${text}\n`);
	} catch {
		// Observability must never break a request.
	}
}

function shortSha(value: string | undefined): string {
	return value === undefined ? "none" : value.slice(0, 12);
}

function ago(now: number, at: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	return `${Math.round(minutes / 60)}h ago`;
}

function inTime(now: number, at: number): string {
	const seconds = Math.round((at - now) / 1000);
	const clock = new Date(at).toISOString().slice(11, 16);
	if (seconds <= 0) return `now (${clock}Z)`;
	if (seconds < 3600) return `in ${Math.round(seconds / 60)}m (${clock}Z)`;
	return `in ${Math.round(seconds / 3600)}h (${clock}Z)`;
}

export function formatStatus(
	tracks: Iterable<ModelTrack>,
	now: number,
	config: CacheKeepaliveConfig,
	mode: "on" | "off",
	windows: Map<string, WindowReading>,
): string[] {
	const lines = [
		`Cache keepalive: ${mode}${config.enabled ? "" : " (config enabled=false)"} · warm at ${config.warmAtFraction}×TTL · ${config.warmCount === undefined ? `cost budget ${config.maxWarmCostFraction}× cold start/gap` : `${config.warmCount} warms/gap (count cap)`} · idle limit ${config.maxIdleHours}h`,
	];
	const windowText = [...windows.entries()]
		.map(([provider, reading]) => `${provider} ${reading.percent === undefined ? `unknown (${reading.error ?? "?"})` : `${reading.percent.toFixed(2)}%`}`)
		.join(" · ");
	if (windowText !== "") lines.push(`Window utilisation: ${windowText}`);
	let count = 0;
	for (const track of tracks) {
		count += 1;
		const name = `${track.provider ?? "?"}/${track.modelId}`;
		const spent = track.budgetUsd > 0 && track.warmCostUsd >= track.budgetUsd;
		const capped = !track.priceMetadata && track.warmsThisGap >= (config.warmCount ?? FALLBACK_WARMS_PER_GAP);
		const next =
			track.wire !== "anthropic-messages" || track.closedGap || track.provider === undefined
				? "—"
				: track.expired
					? "expired for this gap"
					: track.rewritten
						? "capture dropped"
						: capped
							? "count fallback spent"
							: spent
								? "budget spent"
								: inTime(now, Math.max(track.lastConfirmedAt + warmAtMs(track.ttlMs, config.warmAtFraction), track.nextWarmAllowedAt));
		const budgetText = track.priceMetadata
			? `spend $${track.warmCostUsd.toFixed(6)} of budget $${track.budgetUsd.toFixed(6)} (API rates, gating) · warmsAllowed ${track.warmsAllowed ?? "pending"} (derived)`
			: track.warmsThisGap === 0
				? "budget: pending first warm (price metadata derives on the first keepalive)"
				: `budget: count fallback (no price metadata) · warms ${track.warmsThisGap}/${config.warmCount ?? FALLBACK_WARMS_PER_GAP}`;
		lines.push(
			`${name} · ${track.wire === "anthropic-messages" ? "anthropic" : "unsupported"} · last real ${ago(now, track.lastRequestAt)} · warms ${track.warmsThisGap} · next warm ${next} · last: ${track.lastResult ?? "none"} · ${budgetText} · warm $${track.warmUnitCostUsd.toFixed(6)} (derived) · cold start $${track.coldStartUsd.toFixed(6)} × ${track.coldStartsAvoided} avoided · saved $${track.avoidedUsd.toFixed(6)} · window Δ observed: ${track.observedPercent.toFixed(2)}%${track.lastDelta === undefined ? "" : ` (last ${typeof track.lastDelta === "number" ? `${track.lastDelta.toFixed(2)}%` : track.lastDelta})`} (not gating)${track.skip === undefined ? "" : ` · ${track.skip}`}${track.payloadSha === undefined ? "" : ` · sha ${shortSha(track.payloadSha)}`}`,
		);
	}
	if (count === 0) lines.push("No model has served yet.");
	return lines;
}

/** `$0.013656` -> `$0.013656`; trailing zeros trimmed the way pi's own warm line trims them. */
function usd(value: number): string {
	return `$${value.toFixed(6).replace(/(\.\d{3}\d*?)0+$/, "$1")}`;
}

/**
 * One transcript line per warm, in the same shape as pi's own `Cache warmed: $<cost>`.
 * `warmCount` is shown as `n/N` when the count policy owns the cap.
 */
export function formatWarmNotice(data: Record<string, unknown>): string {
	const cost = Number(data.costUsd ?? 0);
	const tokens = Number(data.promptTokens ?? 0);
	const warms = Number(data.warmsThisGap ?? 0);
	const wrote = Number(data.cacheWrite ?? 0);
	const parts = [`${tokens.toLocaleString("en-US")} tokens`];
	if (warms > 0) parts.push(`warm ${warms}`);
	// A warm that wrote cache is a design failure; make it impossible to miss in the transcript.
	if (wrote > 0) parts.push(`WROTE ${wrote.toLocaleString("en-US")}`);
	return `Cache warmed: ${usd(cost)} · ${parts.join(" · ")}`;
}

/** The expanded body: what the warm avoided and where it came from. */
export function formatWarmDetails(data: Record<string, unknown>): string {
	const derived = (data.derived ?? {}) as Record<string, unknown>;
	const window = (data.window ?? {}) as Record<string, unknown>;
	const lines = [
		`model ${String(data.provider ?? "?")}/${String(data.model ?? "?")}`,
		`cold start ${usd(Number(derived.coldStartUsd ?? 0))} would have been billed`,
		`payload ${String(data.payloadSha ?? "?").slice(0, 12)} · window ${String(window.before ?? "?")} -> ${String(window.after ?? "?")}`,
	];
	return lines.join("\n");
}

/** The runtime state the gate reads. Split out so the rule can be tested without a session. */
export interface WarmGateState {
	/** A keepalive of our own is being sent. */
	inflight: boolean;
	/** The agent run is open (between `agent_start` and `agent_settled`). */
	busy: boolean;
	/** A provider request of the session's own is streaming. */
	streaming: boolean;
	/** `ctx.isIdle()`: no run, no compaction. */
	idle: boolean;
}

/**
 * Why a warm must not be sent right now, or undefined when it may.
 *
 * A run that is open but not streaming is *blocked*: on a tool, or on a question waiting for the
 * user. That is the gap this extension exists to cover — `busy` alone kept it dark for the whole
 * wait, which is where the cache was repeatedly lost. Nothing writes to the conversation while a
 * request is not streaming, so replaying the captured prefix is safe and lands as a cache read.
 *
 * Two states still refuse: a request of the session's own mid-stream, and a compaction (which is
 * neither a run nor idle).
 */
export function warmGate(state: WarmGateState): string | undefined {
	if (state.inflight) return "warm-inflight";
	if (state.streaming) return "request-streaming";
	if (!state.idle && !state.busy) return "compacting";
	return undefined;
}

/** Test seams; the warm path itself always uses the real `ctx.modelRegistry.streamSimple`. */
export interface CacheKeepaliveDeps {
	/** Overrides the provider-window readers; tests use it to make `observed` deterministic. */
	readUtilization: typeof readUtilization;
	/** Delay before the post-warm window reading and audit entry; tests set 0. */
	afterProbeMs: number;
}

export interface CacheKeepaliveHandle {
	tracks: Map<string, ModelTrack>;
	tick: () => Promise<void>;
}

export default function cacheKeepalive(
	pi: ExtensionAPI,
	deps: Partial<CacheKeepaliveDeps> = {},
): CacheKeepaliveHandle {
	const readWindow = deps.readUtilization ?? readUtilization;
	const afterProbeMs = deps.afterProbeMs ?? AFTER_PROBE_MS;
	const config = loadConfig();
	const mode: { current: "on" | "off" } = { current: config.enabled ? "on" : "off" };
	const tracks = new Map<string, ModelTrack>();
	const providerByModelId = new Map<string, string>();
	const windows = new Map<string, WindowReading>();
	let ctx: ExtensionContext | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let busy = false;
	let inflight = false;
	/** A request of the session's own is streaming; false while a tool or a question holds the run. */
	let streaming = false;
	let lastActivityAt = Date.now();
	let closed = false;
	let errors = 0;
	let warms = 0;
	const pendingAudits: Array<{ data: Record<string, unknown> }> = [];
	const auditTimers = new Set<ReturnType<typeof setTimeout>>();
	const warmTimers = new Map<string, ReturnType<typeof setTimeout>>();

	const active = () => !closed && config.enabled && mode.current === "on";

	function getTrack(key: string, modelId: string, provider: string | undefined): ModelTrack {
		let track = tracks.get(key);
		if (track === undefined) {
			const now = Date.now();
			track = {
				key,
				modelId,
				provider,
				wire: "unsupported",
				lastRequestAt: now,
				lastConfirmedAt: now,
				ttlMs: 5 * 60_000,
				expired: false,
				rewritten: false,
				warmsThisGap: 0,
				coldStartsAvoided: 0,
				warmCostUsd: 0,
				warmUnitCostUsd: 0,
				coldStartUsd: 0,
				budgetUsd: 0,
				priceMetadata: false,
				avoidedUsd: 0,
				observedPercent: 0,
				failures: 0,
				nextWarmAllowedAt: 0,
				closedGap: false,
			};
			tracks.set(key, track);
		}
		return track;
	}

	function resolveProvider(modelId: string, context: ExtensionContext): string | undefined {
		const selected = context.model;
		if (selected !== undefined && selected.id === modelId && selected.provider !== "router") return selected.provider;
		const learned = providerByModelId.get(modelId);
		if (learned !== undefined) return learned;
		const candidates = context.modelRegistry.getAll().filter((model) => model.id === modelId && model.api === "anthropic-messages");
		const authed = candidates.filter((model) => context.modelRegistry.hasConfiguredAuth(model));
		return authed.length === 1 ? authed[0].provider : undefined;
	}

	function learnFromMessage(message: { role?: string; provider?: unknown; model?: unknown }): void {
		if (message.role !== "assistant") return;
		if (typeof message.provider === "string" && typeof message.model === "string") {
			providerByModelId.set(message.model, message.provider);
		}
	}

	function trackName(track: ModelTrack): string {
		return `${track.provider ?? "?"}/${track.modelId}`;
	}

	function markExpired(track: ModelTrack, reason: string): void {
		if (track.expired) return;
		track.expired = true;
		logLine(`model=${trackName(track)} skipped:expired reason=${reason} warms=${track.warmsThisGap} spendUsd=${track.warmCostUsd.toFixed(6)}`);
	}

	/** A named refusal that must also stop warming this model for the gap. */
	function stopGap(track: ModelTrack, reason: string): void {
		track.skip = `skipped:${reason}`;
		if (track.expired) return;
		track.expired = true;
		logLine(`model=${trackName(track)} ${track.skip} gap-expired warms=${track.warmsThisGap} spendUsd=${track.warmCostUsd.toFixed(6)}`);
	}

	/** True when the branch gained a rewrite entry (or lost the captured point) since capture. */
	function prefixRewritten(track: ModelTrack, context: ExtensionContext): boolean {
		if (track.captureEntryId === undefined) return true;
		let branch: ReturnType<ExtensionContext["sessionManager"]["getBranch"]>;
		try {
			branch = context.sessionManager.getBranch();
		} catch {
			return true;
		}
		const index = branch.findIndex((entry) => entry.id === track.captureEntryId);
		if (index < 0) return true;
		for (let position = index + 1; position < branch.length; position += 1) {
			const type = branch[position].type;
			if (type === "compaction" || type === "context_edit" || type === "branch_summary") return true;
		}
		return false;
	}

	function schedule(track: ModelTrack, at: number): void {
		const existing = warmTimers.get(track.key);
		if (existing !== undefined) clearTimeout(existing);
		if (!active() || track.expired || track.rewritten || track.payloadJson === undefined) return;
		const timer = setTimeout(() => {
			warmTimers.delete(track.key);
			void runTrack(track);
		}, Math.max(0, at - Date.now()));
		timer.unref?.();
		warmTimers.set(track.key, timer);
	}

	/** One model's turn: honour the busy/quiet gates, then send or record why not. */
	async function runTrack(track: ModelTrack): Promise<void> {
		if (!active() || ctx === undefined || track.payloadJson === undefined) return;
		if (warmGate({ inflight, busy, streaming, idle: ctx.isIdle() }) !== undefined) return;
		const quietAt = lastActivityAt + QUIET_MS;
		if (Date.now() < quietAt) {
			schedule(track, quietAt + 25);
			return;
		}
		const decision = decideWarm(track, Date.now(), config);
		if (!decision.warm) {
			if (decision.reason === "expired") markExpired(track, "liveness-window-missed");
			else if (decision.reason === "rewritten") {
				track.rewritten = true;
				track.skip = "skipped:rewritten";
				logLine(`model=${trackName(track)} skipped:rewritten capture=${track.captureEntryId ?? "none"}`);
			} else if (decision.nextWarmAt !== undefined) {
				schedule(track, decision.nextWarmAt);
			}
			return;
		}
		if (prefixRewritten(track, ctx)) {
			track.rewritten = true;
			track.payloadJson = undefined;
			track.payloadSha = undefined;
			track.skip = "skipped:rewritten";
			logLine(`model=${trackName(track)} skipped:rewritten capture=${track.captureEntryId ?? "none"}`);
			return;
		}
		await warm(track);
	}

	async function warm(track: ModelTrack): Promise<void> {
		if (!active() || ctx === undefined) return;
		if (warmGate({ inflight, busy, streaming, idle: ctx.isIdle() }) !== undefined) return;
		const decision = decideWarm(track, Date.now(), config);
		if (!decision.warm) return;
		if (track.payloadJson === undefined || track.provider === undefined) return;
		const replay = buildReplay(track.payloadJson);
		if (!replay.ok) {
			track.skip = `skipped:${replay.reason}`;
			logLine(`model=${trackName(track)} skipped=${replay.reason}`);
			return;
		}
		const match = renderMatches(track.payloadJson, replay.json);
		const renderedSha = match.ok ? match.sha : match.renderedSha;
		if (!match.ok || track.renderSha === undefined || match.sha !== track.renderSha) {
			logLine(
				`model=${trackName(track)} skipped:render-drift expected=${shortSha(track.renderSha)} rendered=${shortSha(renderedSha)}`,
			);
			stopGap(track, "render-drift");
			return;
		}
		const context = ctx;
		const registry = context.modelRegistry;
		const model = registry.find(track.provider, track.modelId);
		if (model === undefined || model.api !== "anthropic-messages" || typeof registry.streamSimple !== "function") {
			stopGap(track, "no-transport");
			return;
		}
		inflight = true;
		const startedAt = Date.now();
		const before = await readWindow(track.provider, registry);
		windows.set(track.provider, before);
		try {
			// The transport renders from `context`; `onPayload` then replaces that payload
			// wholesale with the captured bytes (max_tokens 1). `maxTokens: 1` is kept for the
			// audit trail — the value that reaches the wire comes from the replay payload.
			const message = await registry
				.streamSimple(model, { messages: [] }, {
					maxTokens: 1,
					maxRetries: 0,
					timeoutMs: WARM_TIMEOUT_MS,
					onPayload: () => JSON.parse(replay.json) as unknown,
				})
				.result();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				throw new Error(message.errorMessage ?? message.stopReason);
			}
			const usage = message.usage;
			const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
			if (usage.cacheWrite > 0) {
				// The byte guarantee did not hold. This is not a success and must not extend the
				// liveness anchor; stop warming this model for the gap.
				errors += 1;
				track.failures += 1;
				track.warmCostUsd += usage.cost.total;
				track.promptTokens = promptTokens;
				track.lastResult = `wrote ${usage.cacheWrite} cache tokens`;
				logLine(
					`warm-wrote-cache model=${trackName(track)} payloadSha=${shortSha(track.payloadSha)} promptTokens=${promptTokens} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} input=${usage.input} output=${usage.output} costUsd=${usage.cost.total.toFixed(6)}`,
				);
				stopGap(track, "wrote-cache");
				return;
			}
			warms += 1;
			track.warmsThisGap += 1;
			track.lastConfirmedAt = startedAt;
			track.expired = false;
			const derivedWarm = warmCostUsd(promptTokens, model.cost);
			const derivedCold = coldStartUsd(promptTokens, model.cost);
			const hasPrices = model.cost.cacheRead > 0 && (model.cost.cacheWrite > 0 || model.cost.input > 0);
			track.priceMetadata = hasPrices;
			track.promptTokens = promptTokens;
			track.warmUnitCostUsd = derivedWarm;
			track.coldStartUsd = derivedCold;
			// A configured count owns the cap; the spend budget is then unused (zero), because N
			// warms cost exactly N × warm and the count already bounds the spend.
			track.budgetUsd =
				config.warmCount === undefined ? warmBudgetUsd(derivedCold, config.maxWarmCostFraction) : 0;
			track.warmsAllowed =
				config.warmCount ??
				(hasPrices && derivedWarm > 0 && derivedCold > 0
					? Math.floor(config.maxWarmCostFraction / (derivedWarm / derivedCold))
					: undefined);
			track.warmCostUsd += usage.cost.total;
			if (track.warmsThisGap === 1) {
				track.coldStartsAvoided += 1;
				track.avoidedUsd += derivedCold;
			}
			track.failures = 0;
			track.lastResult = `ok ${usage.cacheRead} read / ${usage.cacheWrite} write / ${usage.input} in`;
			logLine(
				`warm model=${trackName(track)} payloadSha=${shortSha(track.payloadSha)} promptTokens=${promptTokens} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} input=${usage.input} output=${usage.output} costUsd=${usage.cost.total.toFixed(6)} derivedWarmUsd=${derivedWarm.toFixed(6)} derivedColdUsd=${derivedCold.toFixed(6)} budgetUsd=${track.budgetUsd.toFixed(6)} warmsAllowed=${track.warmsAllowed ?? "count-fallback"} warms=${track.warmsThisGap} before=${before.percent === undefined ? `unknown(${before.error ?? "?"})` : before.percent.toFixed(2)}`,
			);
			scheduleAudit(track, { before, usage, promptTokens, derivedWarm, derivedCold, budgetUsd: track.budgetUsd, warmsThisGap: track.warmsThisGap });
			schedule(track, track.lastConfirmedAt + warmAtMs(track.ttlMs, config.warmAtFraction));
		} catch (error) {
			errors += 1;
			track.failures += 1;
			track.lastResult = `error: ${error instanceof Error ? error.message : String(error)}`;
			// A failed warm may have consumed the liveness window (or written nothing at
			// all); never retry it in this gap. Only a real request clears `expired`.
			markExpired(track, "warm-failed");
			logLine(`warm-error model=${trackName(track)} error=${track.lastResult} failures=${track.failures}`);
		} finally {
			inflight = false;
			lastActivityAt = Date.now();
		}
	}

	interface WarmRecord {
		before: WindowReading;
		usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } };
		promptTokens: number;
		derivedWarm: number;
		derivedCold: number;
		budgetUsd: number;
		warmsThisGap: number;
	}

	function scheduleAudit(track: ModelTrack, warm: WarmRecord): void {
		const timer = setTimeout(() => {
			auditTimers.delete(timer);
			void finishAudit(track, warm);
		}, afterProbeMs);
		timer.unref?.();
		auditTimers.add(timer);
	}

	async function finishAudit(track: ModelTrack, warm: WarmRecord): Promise<void> {
		let after: WindowReading = { source: track.provider ?? "none", error: "not-sampled" };
		if (ctx !== undefined && track.provider !== undefined) {
			after = await readWindow(track.provider, ctx.modelRegistry);
			windows.set(track.provider, after);
		}
		const measured = windowDelta(warm.before, after);
		const delta: number | "unknown" = measured.delta ?? "unknown";
		track.lastDelta = delta;
		if (measured.delta !== undefined) track.observedPercent += measured.delta;
		const data = {
			model: track.modelId,
			provider: track.provider,
			payloadSha: track.payloadSha,
			promptTokens: warm.promptTokens,
			cacheRead: warm.usage.cacheRead,
			cacheWrite: warm.usage.cacheWrite,
			input: warm.usage.input,
			output: warm.usage.output,
			costUsd: Number(warm.usage.cost.total.toFixed(6)),
			derived: {
				warmUsd: Number(warm.derivedWarm.toFixed(6)),
				coldStartUsd: Number(warm.derivedCold.toFixed(6)),
				budgetUsd: Number(warm.budgetUsd.toFixed(6)),
			},
			warmsThisGap: warm.warmsThisGap,
			window: {
				before: warm.before.percent ?? "unknown",
				after: after.percent ?? "unknown",
				delta,
				source: measured.delta === undefined ? `unknown:${measured.reason ?? "?"}` : "observed",
			},
			result: "ok",
		};
		if (closed) {
			pendingAudits.push({ data });
			return;
		}
		appendAudit(data);
	}

	let appendAudit: (data: Record<string, unknown>) => void = () => undefined;

	function startTicker(): void {
		if (ticker !== undefined) return;
		ticker = setInterval(() => void tick(), TICK_MS);
		ticker.unref?.();
	}

	function stopTicker(): void {
		if (ticker !== undefined) {
			clearInterval(ticker);
			ticker = undefined;
		}
	}

	async function tick(): Promise<void> {
		if (!active() || ctx === undefined) return;
		if (warmGate({ inflight, busy, streaming, idle: ctx.isIdle() }) !== undefined) return;
		if (Date.now() - lastActivityAt < QUIET_MS) return;
		const now = Date.now();
		for (const track of tracks.values()) {
			const decision = decideWarm(track, now, config);
			if (!decision.warm) {
				if (decision.reason === "expired") {
					markExpired(track, "liveness-window-missed");
				} else if (decision.reason === "rewritten") {
					track.rewritten = true;
					track.skip = "skipped:rewritten";
				} else if (decision.reason === "max-idle" && !track.closedGap) {
					track.closedGap = true;
					logLine(`model=${trackName(track)} skipped=max-idle warms=${track.warmsThisGap} spendUsd=${track.warmCostUsd.toFixed(6)}`);
				}
				continue;
			}
			await runTrack(track);
			// One keepalive per sweep keeps a burst of idle models from competing for the window.
			break;
		}
	}

	pi.on("session_start", async (_event, context) => {
		ctx = context;
		closed = false;
		appendAudit = (data) => pi.appendEntry("cache-keepalive", data);
		try {
			for (const entry of context.sessionManager.getBranch()) {
				if (entry.type === "message") learnFromMessage(entry.message as { role?: string; provider?: unknown; model?: unknown });
			}
		} catch {
			// Learning from history is best effort.
		}
		startTicker();
	});

	pi.on("session_shutdown", async () => {
		closed = true;
		stopTicker();
		for (const timer of auditTimers) clearTimeout(timer);
		auditTimers.clear();
		for (const timer of warmTimers.values()) clearTimeout(timer);
		warmTimers.clear();
		for (const pending of pendingAudits.splice(0)) {
			try {
				pi.appendEntry("cache-keepalive", pending.data);
			} catch {
				// Shutdown must not throw.
			}
		}
	});

	pi.on("agent_start", async () => {
		busy = true;
		lastActivityAt = Date.now();
	});

	pi.on("agent_settled", async () => {
		busy = false;
		streaming = false;
		lastActivityAt = Date.now();
		// The agent was the reason a warm was deferred; re-arm every live model.
		for (const track of tracks.values()) {
			if (track.payloadJson !== undefined && !track.expired && !track.rewritten) {
				schedule(track, lastActivityAt + QUIET_MS + 25);
			}
		}
	});

	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; provider?: unknown; model?: unknown };
		// The assistant message ends the response the request was streaming. The tool calls in it
		// are what holds the run next, and a warm is allowed while they run.
		if (message.role === "assistant") streaming = false;
		learnFromMessage(message);
	});

	pi.on("before_provider_request", async (event, context) => {
		try {
			lastActivityAt = Date.now();
			streaming = true;
			if (!active()) return event.payload;
			const payload = event.payload;
			if (!isRecord(payload) || typeof payload.model !== "string") return event.payload;
			const modelId = payload.model;
			const provider = resolveProvider(modelId, context);
			const key = `${provider ?? "?"}|${modelId}`;
			const track = getTrack(key, modelId, provider);
			if (provider !== undefined) track.provider = provider;
			const plan = planCapture(payload);
			const now = Date.now();
			if (config.models.length > 0) {
				const wanted = config.models.includes(modelId) || (provider !== undefined && config.models.includes(`${provider}/${modelId}`));
				if (!wanted) {
					track.wire = "unsupported";
					track.payloadJson = undefined;
					track.skip = "skipped:not-selected";
					return event.payload;
				}
			}
			// A real request always resets the gap; a material prompt-size change (compaction)
			// moves both derived prices, so it is called out even though the reset covers it.
			const nextBytes = plan.ok ? plan.json.length : 0;
			const resized =
				track.capturedBytes !== undefined && nextBytes > 0 && track.capturedBytes > 0
					? nextBytes / track.capturedBytes
					: undefined;
			if (resized !== undefined && (resized < 0.75 || resized > 1.33)) {
				logLine(
					`prompt-resized model=${trackName(track)} bytesBefore=${track.capturedBytes} bytesAfter=${nextBytes} ratio=${resized.toFixed(2)} gap-reset`,
				);
			}
			track.lastRequestAt = now;
			track.lastConfirmedAt = now;
			track.warmsThisGap = 0;
			track.failures = 0;
			track.nextWarmAllowedAt = 0;
			track.closedGap = false;
			track.expired = false;
			track.rewritten = false;
			track.lastResult = undefined;
			try {
				const branch = context.sessionManager.getBranch();
				track.captureEntryId = branch.length === 0 ? undefined : branch[branch.length - 1].id;
				track.captureEntryCount = branch.length;
			} catch {
				track.captureEntryId = undefined;
				track.captureEntryCount = undefined;
			}
			if (plan.ok) {
				track.wire = "anthropic-messages";
				track.payloadJson = plan.json;
				track.payloadSha = plan.sha;
				track.renderSha = plan.renderSha;
				track.capturedAt = now;
				track.capturedBytes = nextBytes;
				track.ttlMs = plan.ttlMs;
				track.skip = undefined;
			} else {
				track.wire = plan.reason === "wire-unsupported" ? "unsupported" : "anthropic-messages";
				track.payloadJson = undefined;
				track.payloadSha = undefined;
				track.renderSha = undefined;
				track.capturedBytes = undefined;
				track.skip = `skipped:${plan.reason}`;
			}
			logLine(
				`capture model=${trackName(track)} wire=${track.wire} sha=${shortSha(track.payloadSha)} renderSha=${shortSha(track.renderSha)} bytes=${plan.ok ? plan.json.length : 0} ttlMs=${plan.ok ? plan.ttlMs : 0} entry=${track.captureEntryId ?? "none"}${plan.ok ? "" : ` reason=${plan.reason}`}`,
			);
			if (plan.ok) schedule(track, now + warmAtMs(track.ttlMs, config.warmAtFraction));
		} catch (error) {
			errors += 1;
			logLine(`capture-error error=${error instanceof Error ? error.message : String(error)}`);
		}
		return event.payload;
	});

	// Equal to pi's built-in warm line: a dim one-liner in the transcript, with the cost. Without a
	// renderer the audit entry stays invisible, which made a warm indistinguishable from a bust.
	pi.registerEntryRenderer<Record<string, unknown>>("cache-keepalive", (entry, options, theme) => {
		const data = (entry.data ?? {}) as Record<string, unknown>;
		const text = options.expanded
			? `${formatWarmNotice(data)}\n${formatWarmDetails(data)}`
			: formatWarmNotice(data);
		return new Text(theme.fg("dim", text), 1, 0);
	});

	pi.registerCommand("cache-keepalive", {
		description: "Prompt-cache keepalive: /cache-keepalive status|on|off",
		getArgumentCompletions: (prefix) => {
			const options = ["status", "on", "off"].filter((option) => option.startsWith(prefix));
			return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, context) => {
			ctx = context;
			const command = args.trim();
			if (command === "on" || command === "off") {
				mode.current = command;
				if (command === "on") startTicker();
				logLine(`mode=${command}`);
				context.ui.notify(`Cache keepalive: ${command}${command === "on" && !config.enabled ? " (config enabled=false)" : ""}`, "info");
				return;
			}
			if (command !== "" && command !== "status") {
				context.ui.notify("Usage: /cache-keepalive status|on|off", "warning");
				return;
			}
			const now = Date.now();
			const lines = formatStatus(tracks.values(), now, config, mode.current, windows);
			lines.push(`Totals: ${warms} warm(s) · ${errors} error(s) · in flight ${inflight ? "yes" : "no"} · agent ${busy ? "busy" : "idle"}`);
			context.ui.notify(lines.join("\n"), "info");
			logLine(`status ${lines.join(" | ")}`);
		},
	});

	return { tracks, tick };
}
