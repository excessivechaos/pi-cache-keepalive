import assert from "node:assert/strict";

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
/** PI_PI_DIR wins; otherwise the newest installed release, so an update does not strand the tests. */
function piDir() {
  if (process.env.PI_PI_DIR) return process.env.PI_PI_DIR;
  const base = join(homedir(), ".pi", "agent", "install", "releases");
  const versions = readdirSync(base).filter((v) => /^\d+\.\d+\.\d+$/.test(v));
  versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return join(base, versions.at(-1));
}
const PI_DIR = piDir();
const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
  "@earendil-works/pi-tui": `${PI_DIR}/node_modules/@earendil-works/pi-tui/dist/index.js`,
  typebox: `${PI_DIR}/node_modules/typebox/build/index.mjs` } });
const m = await j.import(new URL("../index.ts", import.meta.url).pathname);

let checks = 0;
const eq = (a, b, l) => { assert.deepEqual(a, b, l); checks++; };
const gate = (o = {}) => m.warmGate({ inflight: false, busy: false, streaming: false, idle: true, ...o });

// ---- the rule ---------------------------------------------------------------------------------
eq(gate(), undefined, "idle with nothing in flight warms");
eq(gate({ inflight: true }), "warm-inflight", "never two warms at once");
eq(gate({ streaming: true, busy: true, idle: false }), "request-streaming", "never during the session's own stream");
eq(gate({ streaming: true, busy: true, idle: true }), "request-streaming", "streaming wins over an idle-looking context");

// ---- the change: a blocked run is allowed -------------------------------------------------------
eq(gate({ busy: true, idle: false }), undefined, "BLOCKED run (tool or question) warms");
eq(gate({ busy: true, idle: false, streaming: false }), undefined, "blocked and quiet warms");
eq(gate({ busy: true, idle: false, inflight: true }), "warm-inflight", "a blocked run still cannot warm twice");

// ---- compaction: not a run, not idle ------------------------------------------------------------
eq(gate({ busy: false, idle: false }), "compacting", "compaction is refused");
eq(gate({ busy: false, idle: false, streaming: true }), "request-streaming", "the summariser stream is refused first");

// ---- regression: the busy flag alone must no longer block a warm --------------------------------
const src = (await import("node:fs")).readFileSync(new URL("../index.ts", import.meta.url), "utf8");
eq(/inflight \|\| busy \|\| !ctx\.isIdle\(\)/.test(src), false, "no call site still refuses a blocked run");
eq(/if \(busy \|\| !ctx\.isIdle\(\)\) return;/.test(src), false, "no call site still refuses a blocked run (warm/tick)");
eq(src.split("warmGate({").length - 1, 3, "all three gates go through warmGate");


// ---- warmCount: a count owns the cap when it is set ----------------------------------------------
const CFG = (o = {}) => ({ ...m.DEFAULT_CONFIG, ...o });
const track = (o = {}) => ({
  key: "anthropic/claude-opus-5-5", modelId: "claude-opus-5-5", provider: "anthropic",
  wire: "anthropic-messages", payloadJson: "{}", payloadSha: "x", renderSha: "x",
  lastRequestAt: 1000, lastConfirmedAt: 1000, ttlMs: 3_600_000, priceMetadata: true,
  warmsThisGap: 0, warmsAllowed: 9, budgetUsd: 0, warmCostUsd: 0,
  nextWarmAllowedAt: 0, expired: false, rewritten: false, closedGap: false,
  ...o,
});
const at = 1000 + 51 * 60_000;          // 51 minutes after the capture: due
const dec = (o = {}, cfg = {}) => m.decideWarm(track(o), at, CFG(cfg));

eq(dec({ warmsThisGap: 8 }).warm, true, "the ninth warm is allowed under warmCount 9");
eq(dec({ warmsThisGap: 9 }).reason, "cost-budget", "the tenth is refused");
eq(dec({ warmsThisGap: 9 }, { warmCount: 9 }).reason, "cost-budget", "count 9 caps at 9");
eq(dec({ warmsThisGap: 8 }, { warmCount: 9 }).warm, true, "count 9 allows 8");
eq(dec({ warmsThisGap: 9, warmsAllowed: 12 }, { warmCount: 12 }).warm, true, "count 12 allows 9");

// without price metadata the configured count replaces the six-warm backstop
eq(dec({ priceMetadata: false, warmsThisGap: 8 }, { warmCount: 9 }).warm, true, "count 9 beats the old fallback of 6");
eq(dec({ priceMetadata: false, warmsThisGap: 9 }, { warmCount: 9 }).reason, "count-fallback", "count 9 stops at 9");
eq(dec({ priceMetadata: false, warmsThisGap: 6 }).reason, "count-fallback", "no warmCount keeps the fallback of 6");

// config parsing
eq(m.parseConfig({ warmCount: 9 }).warmCount, 9, "warmCount parses");
eq(m.parseConfig({ warmCount: 9.7 }).warmCount, 9, "warmCount floors");
eq(m.parseConfig({ warmCount: 0 }).warmCount, undefined, "warmCount 0 is ignored");
eq(m.parseConfig({}).warmCount, undefined, "absent warmCount keeps the priced policy");


// ---- the transcript line ------------------------------------------------------------------------
const WARM = { costUsd: 0.013656, promptTokens: 68141, warmsThisGap: 3, cacheWrite: 0,
  provider: "anthropic", model: "claude-opus-5-5", payloadSha: "dbd30317349a385f",
  derived: { coldStartUsd: 0.540705, warmUsd: 0.013656 }, window: { before: 41.2, after: 41.4 } };
eq(m.formatWarmNotice(WARM), "Cache warmed: $0.013656 · 68,141 tokens · warm 3", "line matches pi's shape and adds the count");
eq(m.formatWarmNotice({ ...WARM, cacheWrite: 900 }), "Cache warmed: $0.013656 · 68,141 tokens · warm 3 · WROTE 900", "a write is impossible to miss");
eq(m.formatWarmNotice({ ...WARM, costUsd: 0.000076 }).startsWith("Cache warmed: $0.000076"), true, "six decimals kept, trailing zeros trimmed");
eq(m.formatWarmNotice({ ...WARM, costUsd: 0.005 }).includes("$0.005"), true, "short costs stay short");
eq(m.formatWarmNotice({}).startsWith("Cache warmed: $0"), true, "an old entry without fields does not throw");
eq(m.formatWarmDetails(WARM).includes("cold start $0.540705"), true, "expanded body names what the warm avoided");
eq(m.formatWarmDetails(WARM).split("\n").length, 3, "expanded body is three lines");

console.log(`ok ${checks} checks`);
