# Pip Live coaching — audit and work ledger

Audit of commit `a16271b` ("add authenticated Pip live-state sharing for ChatGPT
coaching"), checked 2026-11-15. Companion to [live-coaching-poc.md](./live-coaching-poc.md).

**Status (2026-11-15):** Batches A, B and C are implemented on branch
`feat/live-coaching-ledger`, plus read timing and request logs (see "Diagnosing a
slow answer" in the POC doc), and showdown reveals in the snapshot
(`result.shownHands`). `pnpm test:all` passes. Not yet deployed. Still open:
D-1 (the four manual verification rows) and D-3 (retire `live-probe`).

Baseline: `ava tests/liveStateService.test.ts tests/liveCoachingState.test.ts
tests/liveProbe.test.ts` → 24 passed. `pnpm test:all` and `pnpm build` were not
re-run for this audit.

## Audit

### Sound as built

- **No hidden cards leave the browser.** `liveSnapshot` builds the payload field by
  field; it never spreads `HandState`. The Mystery Card stays out too: the engine
  holds it in `player.mystery`, not `hole`, until the river (`engine.ts:219`, `:638`).
  Cards the table turns face up at a showdown are not hidden: they ride in
  `result.shownHands`, chosen by the engine's `showsHoleCards`, the same rule the
  felt and the hand record use. Never a folded hand, nothing without a showdown.
- **Credentials are separated.** Owner key → session only; the browser keeps a
  random publishing token; ChatGPT holds OAuth tokens with `hand:read`.
  `X-Owner-Epoch` is always overwritten by the outer Worker, so a client cannot
  forge it.
- **Owner-key rotation revokes at once.** `worker.mjs:82` compares the epoch on
  every read, independent of token lifetime.
- **Versions cannot go backwards** (`session.mjs:107`), and a second tab cannot
  silently reuse a sequence (`/claim` + writer ID).
- **Gameplay never waits on the network.** `capture()` is synchronous and
  swallows its own errors.
- **Fork deploys are gated.** `deploy-cloudflare-pages.yaml` runs only on
  `playpip/pip-web`; `deploy-pip-tutor.yaml` only on `demukti/pip-web` with
  `PIP_TUTOR_ENABLED=true`; `deploy-rooms.yaml` needs `ROOMS_ENABLED`.

### Defects

| # | Where | Problem |
|---|-------|---------|
| D1 | `publisher.ts:225–228` | After a 401/403 heartbeat, `clear()` sets its message, then the `!response.ok` branch overwrites it with "Connection interrupted…". The player is disconnected but told it is a blip. |
| D2 | `publisher.ts:140–143` | If the `/claim` call fails once at page load (offline, timeout), nothing retries. The saved session is still valid, but the form reappears and asks for the owner key again. |
| D3 | `publisher.ts:165`, `:179–199` | Backed-up snapshots upload one after another, although each is the full state. During fast AI turns the newest state lands several round trips late. Collapsing to newest only happens after a failure. |

### Slower or heavier than needed

| # | Where | Problem | Expected gain |
|---|-------|---------|---------------|
| S1 | `worker.mjs:237` | Access tokens last 300 s, so ChatGPT refreshes mid-conversation every 5 minutes. | Removes a visible pause; largest server-side win |
| S2 | `state.ts` | ChatGPT must join player IDs to names and positions and derive the price to call before it can speak. | Faster, more accurate voice answers; largest win overall |
| S3 | `worker.mjs:61, 82, 178, 190` | `hash(env.OWNER_KEY)` recomputed 1–3 times per request. | Small; not measured |
| S4 | `worker.mjs:222` | `OAuthProvider` rebuilt on every request. | Small; not measured |
| S5 | `worker.mjs:142` | `tools/call` parses the read response and re-serializes it. | Small; not measured |
| S6 | `session.mjs:92` | Every 10 s heartbeat rewrites the whole session, snapshot included (~4,300 writes per 12 h session). | Fewer storage writes; no latency change |
| S7 | `session.mjs:13–16` | Every request, reads included, runs inside `blockConcurrencyWhile` and reloads the session from storage. | Small; not measured |

S3–S7 are cleanup. Durable Object storage already caches recent keys in memory,
so do not expect a felt difference from them.

### Flow gaps for the player

| # | Problem |
|---|---------|
| F1 | The connection lives in sessionStorage. A new tab or a browser restart needs the owner key again. |
| F2 | "Live · version N" is only visible in Settings. At the table there is no sign that ChatGPT has the current state. |
| F3 | Equity is null whenever it is not the hero's turn. "How's my hand?" during an AI turn has no number. |
| F4 | Heartbeats run on `setInterval`. Browsers throttle timers in hidden tabs, so a backgrounded game is likely reported `stale` after 30 s although its state is current. Not reproduced here. |
| F5 | Grants last 7 days, so the ChatGPT consent form returns weekly. |

### Housekeeping

- `live-coaching-poc.md` still says "Do not commit/push until requested" and that
  the private deployment is pending; the commit is on `origin/main`.
- Four verification rows are still pending: second-device retrieval, private
  iPhone Live, displayed-equity comparison, stale-after-close.
- `live-probe` is a public Worker with observability on. It holds no game data,
  but it has served its purpose once private iPhone Live is verified.
- The consent page sets no `frame-ancestors` policy. Low risk (the form needs a
  typed key), cheap to add.

## Work ledger

Ordered so that each batch is one deploy and one retest. Batch A changes only the
game, so it needs no Worker deploy and no ChatGPT reconnect.

### Batch A — game client only

| ID | Fixes | Change | Tests | Done when |
|----|-------|--------|-------|-----------|
| A1 | D1 | `ping()`: `return` after `clear()`. | Publisher test: 401 heartbeat leaves the "expired" message. | Message survives. |
| A2 | D3 | Replace the queue with one in-flight snapshot plus one `pending` slot that each `capture()` overwrites. Keep retry-newest behaviour. | Extend "publisher retries the latest snapshot": N captures during one slow upload → at most 2 PUTs, final accepted version = latest. | No more than one upload waits behind the one in flight. |
| A3 | D2 | Retry `restore()` on the heartbeat tick and on `online` while a saved session exists and is unexpired. Show "Reconnecting…" instead of the form. | Publisher test: first `/claim` throws, second succeeds, no owner key needed. | A flaky load recovers by itself. |
| A4 | S2 | Additive schema-v1 fields in `state.ts`: `hero.stack`, `hero.toCall`, `hero.potOdds` (hero's turn only); `name` and `position` on each `actionHistory` entry; `hand.brief`, one plain sentence built from the same fields. Chips only, never `$`. | `liveCoachingState.test.ts`: exact `brief` for preflop, facing a bet, and complete; pot-odds arithmetic; privacy test still passes. | ChatGPT can answer from `brief` alone. |
| A5 | F4 | Send a heartbeat on `visibilitychange` → visible and on `online`. | Publisher test with injected events. | Returning to the tab clears `stale` within one request. |

Gate: `pnpm test:all`, then play a hand with sharing on and compare `brief`
against the table.

### Batch B — Worker (one `wrangler deploy`)

| ID | Fixes | Change | Tests | Done when |
|----|-------|--------|-------|-----------|
| B1 | S1, F5 | `accessTokenTTL` 300 → 3600. Optionally `refreshTokenTTL` 7 → 30 days. | Existing refresh/rotation test must still pass unchanged. | No refresh pause inside a normal session. |
| B2 | — | Tool description: tell the model to lead with `brief` and to check `stale`/`pending`. Needs a tool-metadata refresh in ChatGPT. | `tools/list` assertion. | Voice answers open with the situation. |
| B3 | S3, S4 | Memoize the owner-epoch hash and the `OAuthProvider` per `env` at module scope. | Existing suite; rotation test proves the memo is keyed on the key. | One hash per isolate, not per request. |
| B4 | S5 | `tools/call`: embed `await (await read()).text()` directly. | Existing read tests. | No parse/re-serialize. |
| B5 | S6, S7 | Durable Object: hold the session in memory; store `state` and metadata under separate keys; heartbeats update `lastSeenAt` in memory and persist it at most once a minute; drop `blockConcurrencyWhile` on `/read`. | Freshness and alarm tests; add one that rebuilds the object from storage mid-session. | A heartbeat no longer rewrites the snapshot. |
| B6 | — | `Content-Security-Policy: frame-ancestors 'none'` on the consent page. | Header assertion in the consent test. | Header present. |

Gate: focused suite, `wrangler deploy --dry-run`, deploy, then one text-chat read.
B3–B5 are optional; skip them if the POC is not going further.

### Batch C — needs a decision first

| ID | Fixes | Decision | Change |
|----|-------|----------|--------|
| C1 | F1 | Is a publishing token in localStorage for up to 12 h acceptable on this device? | Move `pip.live-coaching.v1` to localStorage. `restore()` already claims with a new writer ID. Never the owner key. |
| C2 | F2 | Should the table show sharing status? | Small status dot near the table chrome, theme tokens only, driven by `livePublisher.subscribe`. Verify in the running app. |
| C3 | F3 | Should a past estimate be shown at all? | Carry the last hero-turn estimate as `hero.lastEquity` with its street. This reverses the tested rule "a prior-turn estimate is never carried into an AI turn", so keep `equity` null and add a separate field. |

### Batch D — close out

| ID | Change |
|----|--------|
| D-1 | Run the four pending verification rows; record versions and timestamps. |
| D-2 | Update `live-coaching-poc.md`: schema table (A4), token lifetimes (B1), status line, verification results. |
| D-3 | Delete or disable `live-probe` once private iPhone Live is verified. |

## Suggested order

A1 → A2 → A4 → A3 → A5, then B1 + B2 in one deploy, then D-1. Take C and B3–B6
only if the POC continues.
