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

It warms **while a run is blocked**. A run that is open but not streaming — a long tool, or
`ask_user_question` waiting for an answer — used to be excluded by the `busy` flag, which is the
one situation where a gap actually outlives the TTL. A blocked run is now allowed, keepalives
included, up to the budget:

```
wait        warms (warmCount 9, 250k opus)  spend      without
 62 min     1 at 51 min                      $0.049     $1.98 cold write
  3 h       3 at 51/102/153 min              $0.15      $1.98
  8 h       9 at 51…459 min                  $0.44      $1.98
overnight   9, count reached                 $0.44      $1.98
```

`warmCount` (this workstation sets 9) is a count cap that replaces the priced one. The priced
policy allows only six on the Anthropic read/write ratio — `0.25 ÷ (0.2 ÷ 5) = 6.25` — whatever the
prompt size, because both sides scale together. A count says what it means; a warm is still a cache
read, so nine of them cost nine reads (`$0.049` each at 250k) and never a write.

A streaming request still refuses, so a warm never interleaves with the session's own response; the
capture is also dropped if the conversation was rewritten, and the budget caps a gap at
`maxWarmCostFraction` of one cold start whatever the wait looks like.

## Where you see it

Every successful warm appends one dim line to the transcript, the same shape pi's own warmer uses:

```
Cache warmed: $0.013656 · 68,141 tokens · warm 3
```

Expanded (Ctrl+O) it adds the model, the cold start it avoided, and the payload sha. A warm that
ever reports `cacheWrite > 0` — the one outcome the design forbids — prints `WROTE <n>` on that line
instead of hiding in the log. The line comes from a renderer on the extension's existing audit entry,
so `cache-keepalive` entries stay out of the LLM context and out of `/session` cost totals.

## Guards

Every one of these is checked before a send, and each refuses rather than guesses:

| guard | effect |
|---|---|
| `gate` | warms when idle, or when a run is **blocked** (open but not streaming) — never while the session's own request streams, never during a compaction, never twice at once |
| `alive` | warms only while the entry is still within `ttl × 0.95`; a missed window marks the model `expired` for the rest of the gap and it is never warmed again — a warm after expiry would re-write the prefix |
| `unchanged` | a `compaction`, `context_edit` or `branch_summary` entry after the capture drops it (`skipped:rewritten`); plain message appends are allowed because they extend the prefix |
| prompt resize | a materially different prompt size resets the gap (`prompt-resized`) |
| budget | either `warmCount` warms per gap, or — when that is unset — `maxWarmCostFraction` (default 0.25) of one cold start, computed from API rates. Whichever is configured gates; they are not both applied |
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
  "warmCount": 9,
  "maxWarmCostFraction": 0.25,
  "models": ["anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5"],
  "maxIdleHours": 8
}

`warmCount` is optional. Set it when the number of hours of cover is the thing you care about
(9 warms ≈ 7.6 h at a 1 h TTL); leave it out to let the priced fraction decide.
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
