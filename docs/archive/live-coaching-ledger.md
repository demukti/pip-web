# Pip Live coaching — audit and work ledger

> **Archived (2026-11-16)** with [live-coaching.md](./live-coaching.md): the record of
> Pip Live, the ChatGPT coaching, up to the tag `archive/chatgpt-live`. Batch F became
> [Ask Pip](../ask-pip.md), which replaced it.

Audit of commit `4176069` ("add authenticated Pip live-state sharing for ChatGPT
coaching"), checked 2026-11-15. Companion to [live-coaching.md](./live-coaching.md).
This is the historical record; the live coaching doc describes the code as it stands.

**Status (2026-11-15):**

- Batches A, B and C, read timing and request logs, and showdown reveals
  (`result.shownHands`) are on `main` and were deployed by hand on 2026-11-15 at
  `cd6ae72`. D-3 is done: `live-probe` and its test are removed from the repo; the
  deployed probe Worker and its ChatGPT plugin were deleted by the owner.
- After that deploy: `cc2e06b` (the tool description explains showdown cards) and
  Batch E below. Both went live on 2026-11-15 with the push of `624c521` to `main`
  (the hosted game's build stamp read `pip-624c521`); the owner refreshed the tool
  metadata in ChatGPT and reports that it reads the new fields.
- Still open: D-1, the manual checks listed under Verification in the live coaching
  doc.

Baseline for the audit, at `4176069`: `ava tests/liveStateService.test.ts
tests/liveCoachingState.test.ts tests/liveProbe.test.ts` → 24 passed.
`tests/liveProbe.test.ts` has since been removed with the probe (D-3). `pnpm
test:all` and `pnpm build` were not re-run for the audit.

## Audit

File and line references in this section are as of the audited commit `4176069`;
the code has moved since.

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

### Housekeeping (at the audit; all since resolved)

- `live-coaching.md` said "Do not commit/push until requested" and that the private
  deployment was pending. Rewritten.
- Four verification rows were pending: second-device retrieval, private iPhone Live,
  displayed-equity comparison, stale-after-close. Private iPhone Live is now
  reported working; the other three remain under D-1.
- `live-probe` was a public Worker with observability on. Retired (D-3).
- The consent page set no `frame-ancestors` policy. Added (B6).

## Work ledger

Ordered so that each batch is one deploy and one retest. Batches A–C are done and
deployed at `cd6ae72`; Batch E is done and deployed at `624c521`.

### Batch A — game client only

| ID | Fixes | Change | Tests | Done when |
|----|-------|--------|-------|-----------|
| A1 | D1 | `ping()`: `return` after `clear()`. | Publisher test: 401 heartbeat leaves the "expired" message. | Message survives. |
| A2 | D3 | Replace the queue with one in-flight snapshot plus one `pending` slot that each `capture()` overwrites. Keep retry-newest behaviour. | Extend "publisher retries the latest snapshot": N captures during one slow upload → at most 2 PUTs, final accepted version = latest. | No more than one upload waits behind the one in flight. |
| A3 | D2 | Retry `restore()` on the heartbeat tick and on `online` while a saved session exists and is unexpired. Show "Reconnecting…" instead of the form. | Publisher test: first `/claim` throws, second succeeds, no owner key needed. | A flaky load recovers by itself. |
| A4 | S2 | Additive schema-v1 fields in `state.ts`: `hero.stack`, `hero.toCall`, `hero.potOdds` (hero's turn only); `name` and `position` on each `actionHistory` entry; `hand.brief`, one plain sentence built from the same fields. Chips only, never `$`. | `liveCoachingState.test.ts`: exact `brief` for preflop, facing a bet, and complete; pot-odds arithmetic; privacy test still passes. | ChatGPT can answer from `brief` alone. |
| A5 | F4 | Send a heartbeat on `visibilitychange` → visible and on `online`. | Publisher test with injected events. | Returning to the tab clears `stale` within one request. |

### Batch B — Worker (one `wrangler deploy`)

| ID | Fixes | Change | Tests | Done when |
|----|-------|--------|-------|-----------|
| B1 | S1, F5 | `accessTokenTTL` 300 → 3600; `refreshTokenTTL` 7 → 30 days. | Existing refresh/rotation test must still pass unchanged. | No refresh pause inside a normal session. |
| B2 | — | Tool description: tell the model to lead with `brief` and to check `stale`/`pending`. Needs a tool-metadata refresh in ChatGPT. | `tools/list` assertion. | Voice answers open with the situation. |
| B3 | S3, S4 | Memoize the owner-epoch hash and the `OAuthProvider` per `env` at module scope. | Existing suite; rotation test proves the memo is keyed on the key. | One hash per isolate, not per request. |
| B4 | S5 | `tools/call`: embed `await (await read()).text()` directly. | Existing read tests. | No parse/re-serialize. |
| B5 | S6, S7 | Durable Object: hold the session in memory; store `state` and metadata under separate keys; heartbeats update `lastSeenAt` in memory and persist it at most once a minute; drop `blockConcurrencyWhile` on `/read`. | Freshness and alarm tests; add one that rebuilds the object from storage mid-session. | A heartbeat no longer rewrites the snapshot. |
| B6 | — | `Content-Security-Policy: frame-ancestors 'none'` on the consent page. | Header assertion in the consent test. | Header present. |

### Batch C — decided and done

| ID | Fixes | Decision | Change |
|----|-------|----------|--------|
| C1 | F1 | A publishing token in localStorage is acceptable on this device. | `pip.live-coaching.v1` in localStorage. `restore()` claims with a new writer ID. Never the owner key. |
| C2 | F2 | The table shows sharing status. | Small badge in the table's corner, theme tokens only, driven by `livePublisher.subscribe`. |
| C3 | F3 | A past estimate is shown, separately. | `hero.lastEquity` with its street; `equity` stays null outside the hero's turn. |

### Batch D — close out

| ID | Change |
|----|--------|
| D-1 | Open. Run the manual checks under Verification in the live coaching doc; record versions and timestamps. |
| D-2 | Done: `live-coaching.md` describes the current schema, lifetimes, status and verification. |
| D-3 | Done 2026-11-15: private iPhone Live verified by the owner; `live-probe` removed from the repo. |

### Batch E — table context, sliding sessions, honest badge (deployed 2026-11-15)

Needed a Worker deploy (E1, E3, E6), a Pages deploy (E1, E2, E4, E5) and a
tool-metadata refresh in ChatGPT (E3); all three were done on 2026-11-15 at
`624c521`. This batch's tests carry no ID prefix (the
`A1:`…`C3:` prefixes in `livePublisher.test.ts` are the earlier batches' ledger
IDs); the Tests column names them by title.

| ID | Fixes | Change | Tests | Done when |
|----|-------|--------|-------|-----------|
| E1 | 12 h hard expiry ended long sessions mid-play | Sliding session: 12 h after the last accepted heartbeat, upload or claim, capped at 7 days from creation. `/claim`, `/heartbeat` and successful `/publish` return `expiresAt`; the publisher saves it. A restart grants up to 60 s extra, never less. Old `meta` records without `createdAt` keep working. | `liveStateService`: four serial expiry tests, plus "the real publisher saves each expiry the server slides…" (real publisher against the real Worker). `livePublisher`: "claim, heartbeat and publish slide the saved expiry…", "an older service without expiresAt…", "a later expiry never overwrites a record another tab now holds", "an upload that slides the expiry by under a minute costs no extra storage write", and the two "…answer read after a reconnect is ignored" tests (a stale response never lands on a newer session). | A session in use outlives its first 12 hours. |
| E2 | Coach could not see the table around the hand | `hero.handName`; `players[].style`, `players[].reads`; `hand.table` (venue, format, 1-based blind level, run status, place, score hands); `brief` gains the made hand and a run-over sentence. Read from the stores by `tableContext.ts`, started from `AppBoot.tsx`; a status change re-publishes the last hand. While spectating, `table.status` is `watching` and `place` the real finish, though the store itself flips to `playing`/`busted` around each spectated hand (see the live coaching doc, Spectating). `game.ts` unchanged. | `liveCoachingState`: six new tests (hand name, Mystery Card, reads, table, run-over brief). `livePublisher`: "table context: read at capture time…" and `refresh`. `liveCoachingTable` (4, real stores, a real game played in Node): reads and style as the dialog shows them, none for the hero; the double publish at each hand end; bust, spectate and a new table. | `brief` says when the run is over. |
| E3 | — | Tool description: run over when `table.status` is busted/won; trust `hero.handName`; use `style`/`reads`, never invent tendencies. | `tools/list` assertion names the new fields. | Metadata refreshed in ChatGPT. |
| E4 | Badge showed nothing when sharing failed | Status gains `reachable` and `ended`. Badge: Live, Syncing, Offline, Reconnecting, Sharing ended. Settings: Dismiss button for an ended session, local only (no request, no storage); an ended tab that sees another tab sharing clears it. A successful heartbeat restores `reachable` only when no upload is waiting. | `livePublisher`: "a failed heartbeat marks the service unreachable…", "a failed upload marks it unreachable…", "heartbeats that get through do not flip the badge…" (reachable); "expiry or revocation ends sharing involuntarily…", "stopping, or another tab taking over…", "a saved session found expired at load…", "Dismiss is local…", "an ended tab that sees another tab sharing…", "starting an ended tab while another tab shares…" (ended). Badge and Settings unverified in a browser. | Every failure mode is visible at the table. |
| E5 | `hero.lastEquity` could leak into a fresh table's hand of the same number | Estimate keyed on the deal: hand number, hero cards and board so far. | `livePublisher`: "a new table dealt in place does not inherit…". | — |
| E6 | Exceptions on unlogged paths left no trace | `pip_live_request` gains `error` (exception class name only) and is written on any path where one was caught. | "a caught exception is logged on any path, by class name only"; log-key allow-list includes `error`. | — |
| E7 | Deploy ran no checks | Workflow runs `pnpm test:types` and `pnpm ava tests/live*.test.ts` before building. Full gate still local. | — | — |
| E8 | An upstream merge could silently drop a hook | `tests/liveCoachingHooks.test.ts` reads `game.ts`, `AppBoot.tsx`, `PlayerDialog.tsx`, `Table.tsx` and fails if a capture site, the wiring or the reads derivation changes. | 8 tests. | — |

Gate: `ava tests/live*.test.ts` → 90 passed (2026-11-15). Then `pnpm test:all`,
deploy, refresh tool metadata, and the manual demonstration in the live coaching
doc.

### Batch F — Ask Pip, in-game coaching on demand (2026-11-16, branch `feat/in-game-coach`)

Measured first. ChatGPT (via Codex, the same connector path) took 12–17 s per
answer; the service's part was 22–62 ms per read and under 0.2 s per question in all.
Putting the hand straight into the prompt halved it; the Claude API in one streamed
pass gives first words in under a second. Full figures in the live coaching doc,
Ask Pip. Needs a Worker deploy (the route, `ANTHROPIC_API_KEY` set as a secret) and a
Pages deploy (the button and settings); no ChatGPT metadata refresh.

| ID | Change | Tests |
|----|--------|-------|
| F1 | `POST /coach`: the publishing tab's credential, checked by the Durable Object with the writer, 6 a rolling minute; one streamed `claude-sonnet-5-5` answer as NDJSON on the stored snapshot; aborted when the player closes it. `live-state/coach.mjs`. | `liveCoach`: streams on the stored snapshot with no session identity; credential, writer and rate; no key; malformed and oversized questions; closing aborts the model call |
| F2 | The player's settings: length (Short, Standard, Teach me) and up to 500 characters of their own notes, in this browser; the service settles both. | `liveCoach`: unknown style and long notes settled; settings store defaults, persists, survives bad storage; game and service agree on styles and the cap |
| F3 | Ask Pip button under the badge and the answer card (placed by F7); Settings → Live coaching → Ask Pip. | UI: checked by running the app |
| F4 | `pip_live_coach` log line: model, first-text and total time, tokens, stop, failure code and class. | `liveCoach`: allow-listed keys; no answer text; the API's error message never logged |
| F5 | `tests/liveServiceFixture.ts`: the Worker fixture shared by `liveStateService` and `liveCoach`. | `liveStateService` unchanged, 22 pass |
| F6 | Found in the first browser test against the deployed Worker: (a) the game stopped reading at the `done` line, so the request stayed open and was never logged; it now reads to the end. (b) Closing the card did not stop the model on Cloudflare, which does not cancel a streamed body when the client goes away; the request's signal now aborts the call (`enable_request_signal`), logged as `coach_closed`. (c) Standard answers ran long; each length now ends "Stop there." | `liveCoach`: "the answer is read to the end of the stream…"; "a client that disconnects stops the model call…" (fails with the hook removed); the close test checks `coach_closed` |
| F7 | The answer card moved from under the button (over the felt's corner, where it hid an opponent's seat) to over the hero's own row; the button and card share one answer in `askPip.ts`. Checked at 1280×800 and 375×812. | `liveCoach`: the shared answer streams and stays for its hand, the next deal retires it, closing or asking again stops it, failures keep what was written, each ask sends the settings of that moment |

