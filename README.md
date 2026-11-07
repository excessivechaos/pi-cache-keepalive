# pi-cache-keepalive

Keeps a pi session's provider prompt cache warm between turns.

A subscription cache entry expires a few minutes after the last request. When that happens the
next request re-bills the whole prefix. This extension re-sends the session's **own** captured
request — byte for byte, with `max_tokens: 1` — shortly before the entry expires, so the entry is
refreshed at a cache **read** price instead of being lost.

Measured on `anthropic/claude-haiku-5-5`, 7,563-token prompt:

```
warm   cacheRead=7559  cacheWrite=0  input=4  output=1  costUsd=$0.000076
next   cacheRead=7559 (99.9%)                             costUsd=$0.000076
without it, the next turn after the TTL: cacheRead=0, full re-write
```

`cacheWrite: 0` is the property the whole design is built around: **a warm must never cost a write.**

## What it does

At `warmAtFraction` (default 0.85) of the TTL that the captured payload itself advertises, it
replays the capture through pi's provider transport (`ctx.modelRegistry.streamSimple`, with
`onPayload` returning the capture) so any provider shaping — OAuth billing headers, for example —
is applied exactly as it was for the original request.

## Guards

Every one of these is checked before a send, and each refuses rather than guesses:

| guard | effect |
|---|---|
| `alive` | warms only while the entry is still within `ttl × 0.95`; a missed window marks the model `expired` for the rest of the gap and it is never warmed again — a warm after expiry would re-write the prefix |
| `unchanged` | a `compaction`, `context_edit` or `branch_summary` entry after the capture drops it (`skipped:rewritten`); plain message appends are allowed because they extend the prefix |
| prompt resize | a materially different prompt size resets the gap (`prompt-resized`) |
| budget | stops at `maxWarmCostFraction` (default 0.25) of one cold start per idle gap, computed from API rates; `warmsAllowed` is derived from those prices, not configured |
| belt | if a warm's own usage reports `cacheWrite > 0`, it is logged as `warm-wrote-cache`, not counted as a success, and the gap stops |
| wire | `anthropic-messages` only; other wires are tracked but never sent |

Everything fails open: a transport error is recorded and counted, never thrown into the session.
Nothing is written to the transcript except one `cache-keepalive` audit entry per warm.

## Configuration

`$PI_CODING_AGENT_DIR/cache-keepalive.json` (default `~/.pi/agent/cache-keepalive.json`):

```json
{
  "enabled": true,
  "warmAtFraction": 0.85,
  "maxWarmCostFraction": 0.25,
  "models": ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"],
  "maxIdleHours": 8
}
```

`models` is an allowlist of `provider/modelId`; empty means every eligible model. With a list, any
model not named is marked `skipped:not-selected` at capture time and is never warmed.

## Install

```bash
pi install git:github.com/excessivechaos/pi-cache-keepalive
```

Turn pi's own warmer off, or both will warm the same model:

```
"cacheWarming": "off"     # in ~/.pi/agent/settings.json
```

## Commands

`/cache-keepalive status | on | off` — status shows the derived prices, warms allowed in the
current gap, spend, and the last decision. Log: `/tmp/cache-keepalive.log`
(`PI_CACHE_KEEPALIVE_LOG` overrides it).

## Limits

- Warming **spends the same quota the session does**. On a subscription plan the warm consumes
  window tokens; the budget caps how much per gap, but it is not free.
- Magic Context (or any extension that rewrites its injected block inside `context`) can move the
  prefix without a session entry. That is invisible here; the `alive` guard bounds the damage to
  one cache read, and the bust that follows is the other extension's.
- Anthropic-wire models only in v1.

MIT.
