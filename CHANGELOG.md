# Changelog

## 1.2.0

- **`warmCount`**: a hard cap on keepalives per gap. The priced policy (`maxWarmCostFraction`) allows
  six on the Anthropic read/write ratio whatever the prompt size, because the warm and the cold start
  scale together; a count is what "nine warms" needs. When `warmCount` is set it owns the cap and the
  spend budget is unused. It also replaces the six-warm backstop used when a model reports no prices.
- Unit tests cover the count at the boundary (8 warms warm, 9 refuse), the metadata-free path, and
  config parsing.

## 1.1.0

- **Warms while a run is blocked.** The gate used to require an idle agent (`busy || !ctx.isIdle()`),
  which kept it dark for the entire duration of a long tool call or an unanswered
  `ask_user_question` — exactly the waits that outlive the TTL. A run that is open but not
  streaming is now allowed; a streaming request and a compaction are still refused. New
  `warmGate()` is exported and unit-tested (test/gate.test.mjs).
- Streaming is tracked from `before_provider_request` to the assistant `message_end`, so "blocked"
  means "nothing of the session's own is on the wire", not "the agent is idle".
- With pi's built-in warmer stopped at 60 minutes and uncapped in spend, this extension is the one
  to run when a wait can last hours; keep `cacheWarming: "off"` so both do not warm the same entry.

## [1.0.0]

- First release: payload replay through the provider transport, with the alive / unchanged /
  resize / budget / write-detection guards.
- Config path honours `PI_CODING_AGENT_DIR`; log path honours `PI_CACHE_KEEPALIVE_LOG`.
