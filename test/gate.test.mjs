import assert from "node:assert/strict";

const PI_DIR = process.env.PI_PI_DIR ?? "/home/qualidiv/.pi/agent/install/releases/1.5.1";
const { createJiti } = await import(`${PI_DIR}/node_modules/jiti/lib/jiti.mjs`);
const j = createJiti(import.meta.url, { interopDefault: true, moduleCache: false, alias: {
  "@earendil-works/pi-coding-agent": `${PI_DIR}/node_modules/@earendil-works/pi-coding-agent/dist/index.js`,
  "@earendil-works/pi-ai": `${PI_DIR}/node_modules/@earendil-works/pi-ai/dist/index.js`,
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

console.log(`ok ${checks} checks`);
