# Pip Live coaching

> **Archived (2026-11-16).** Pip Live, the ChatGPT coaching, was replaced by
> [the coach](../ask-coach.md) (first called Ask Pip), which coaches inside the game in one model pass. This page
> describes the code at the tag `archive/chatgpt-live` (commit `50fb222`, the Worker
> deployed on 2026-11-16 as version `1595168f`), not the code on `main`.
>
> **Left outside the repo** while archived:
>
> - Cloudflare keeps the OAuth KV namespace `pip-live-state-oauth`
>   (`2887fef7714c41759b7ae2dd22c887d7`) for a restore. If you will never go back,
>   delete it: `corepack pnpm exec wrangler kv namespace delete --namespace-id 2887fef7714c41759b7ae2dd22c887d7`.
> - The **Pip Live** plugin in ChatGPT no longer has a service behind it: remove it there.
> - Codex: `codex mcp remove pip-live`.
>
> **To restore it:** `git revert` the commit that switched to Ask Pip (or branch from
> the tag: `git switch -c chatgpt-live archive/chatgpt-live`), run `pnpm install`, then
> `wrangler deploy` as below; the reverted config points at the same KV namespace and
> URL, and the secret `OWNER_KEY` carries over. The Durable Object's ChatGPT-era
> records were deleted by Ask Pip, so start sharing again in Settings. Then reconnect
> the Pip Live plugin in ChatGPT (and `codex mcp add pip-live --url
> https://pip-live-state.tizav.workers.dev/mcp`), and refresh its tool metadata.

Status (2026-11-15): the private service and the game are live with the code as of
`624c521`, which includes `cc2e06b` (the tool description explains showdown cards)
and the batch recorded as Batch E in
[live-coaching-ledger.md](./live-coaching-ledger.md) (table context, sliding
sessions, badge states, logs). The push to `main` deployed it: the hosted game's
build stamp read `pip-624c521`, and the workflow deploys the Worker before the game.
By the owner's report, after reloading the game and refreshing Pip Live's tool
metadata, ChatGPT reads the new fields; the earlier deployment (`cd6ae72`, by hand)
was already readable from an OAuth-protected text chat and from iPhone Live in the
owner's ChatGPT workspace. Any later change to the tool description needs that
metadata refresh again. Deploys run on pushes to `main` while `PIP_TUTOR_ENABLED`
is `true`.

Ask Pip (in-game coaching on the Claude API, Batch F, 2026-11-16) is on the branch
`feat/in-game-coach`. Its Worker was deployed by hand from that branch on 2026-11-16
(version `1595168f`), with the secret `ANTHROPIC_API_KEY` set; the hosted game does not
have the button until the branch reaches `main`. Until then, a push to `main` would
redeploy the Worker without `/coach`.

The poker rules are unchanged; the engine gained one pure helper, `showsHoleCards`.
The service makes one kind of model call, and only when the player asks for it:
**Ask Pip** (below), added on 2026-11-16. Nothing advises on its own.

## Architecture

- GitHub: source and an opt-in Actions deployment workflow.
- Cloudflare Pages: Pip's existing static Next.js export. The upstream app assumes
  root-relative public assets, links and service-worker paths. Keeping a root-hosted
  Pages site avoids broad changes for a GitHub Pages repository subdirectory.
- `live-state/`: one Worker, one Durable Object retaining the latest session/state,
  and a KV namespace used only by the maintained OAuth library. Game reads/writes
  go directly to the Durable Object, not eventually consistent KV.
- The browser publishes after the deal, every human/AI action, resume and leaving.
  A hand's end publishes twice: the hand-complete capture (taken before the store
  settles, so its `table.status` is still `playing`), then the same hand again
  when the run status moves on (handover, busted, won, scored, watching), so the
  coach hears that the run is over. A heartbeat every 10 seconds marks the browser
  as connected even when nobody acts.
- ChatGPT calls the OAuth-protected read-only `get_current_hand` operation each time.
  There is no session ID or URL to supply in the conversation.

The snapshot adapter (`src/lib/liveCoaching/state.ts`) reuses `HandState`,
`legalActions()`, `potSize()`, the engine log and `cardToString()`. Pip's existing
`encodeHand()` is for completed replay links; its v2 form contains hidden opponent
cards and must not be uploaded live. The table around the hand (venue, run status,
per-seat style and reads) is read from the stores at capture time by
`src/lib/liveCoaching/tableContext.ts`, started from `AppBoot.tsx` beside the
publisher; the publisher itself imports no store, and `src/store/game.ts` has only its four capture calls.

## Access model and limits

This is a single-owner, single-active-session feature for play-money Hold'em against
Pip's cast. It does not publish multiplayer, lessons, drills, or other variants.

The owner creates a random key (at least 32 characters; recommend 64 random hex
characters) and saves it in their password manager. It is stored only as a Worker
secret named `OWNER_KEY`. Enter it on the game connection form and the Worker's
OAuth consent page; never send it in chat, put it in a URL, commit it, or set it in
`NEXT_PUBLIC_*`. This key is separate from the user's Cloudflare login/API token.

The game exchanges the owner key for a random 256-bit publishing credential and a
random session UUID. Only that credential, the session's expiry and sequence
metadata are retained in localStorage (`pip.live-coaching.v1`), so a new tab or a
browser restart resumes without the owner key while the session lasts; the owner
key is not persisted by the app. ChatGPT receives audience-bound OAuth tokens with
`hand:read` permission, not the publishing credential. The library handles PKCE,
one-time codes, browser-bound consent and refresh tokens. Access tokens last 1 hour;
grants last 30 days. The owner key is still compared on every read, so rotating it
revokes at once.

**Session lifetime is sliding.** A session expires 12 hours after its last accepted
heartbeat, upload or claim, and never more than 7 days after it was created.
`/heartbeat`, `/claim` and successful `/publish` responses carry the new
`expiresAt`, and the game saves it with the session (a slide of under a minute from
an upload is kept in memory and saved with the next write, rather than costing a
storage write per upload). Heartbeats persist at most once
a minute, so after a Durable Object restart the object assumes the last minute was
active: a session can outlive its nominal expiry by up to 60 seconds, never end
early. On expiry the alarm deletes the session and its snapshot.

A new game connection replaces the previous session. A reload claims the existing
session with a new writer ID, preventing a duplicated tab from silently reusing
its sequence. Only one tab publishes: a second tab opened while another is sharing
does not take over by itself (it offers "Share from this tab"), and a tab that
loses the writer role stops publishing without deleting the saved session. If the
claim fails at load because the network is down, the game keeps the saved session
and retries on the next heartbeat and when the browser comes back online. Stop
sharing deletes the remote session if online. When offline, the remote snapshot
stays (and reads as `stale`) until the session expires. Rotating `OWNER_KEY`
invalidates existing reads and publishing credentials, and requires reconnecting
both the game and ChatGPT. Scope/identity checks run on every read.

The endpoint returns the latest **acknowledged** upload. An action still in flight
cannot be visible yet. The UI reports pending/retrying uploads; the API reports
versions and freshness. Uploads never block gameplay. At most one upload is in
flight and one waits behind it; each new capture replaces the waiting one, because
every snapshot is the newest full state including its complete action history.

A small badge at the table mirrors the Settings status:

| Badge | When |
| --- | --- |
| Live | Connected, reachable, the latest state accepted |
| Syncing | An upload is on its way |
| Offline | Connected, but the last heartbeat or upload failed. Cleared by the next successful heartbeat when nothing is waiting to upload; while an upload waits, only that upload succeeding clears it (so failing uploads do not flicker Offline/Syncing on each heartbeat) |
| Reconnecting | A saved session is waiting for the service (e.g. a failed claim at load) |
| Sharing ended | Sharing stopped without the player asking (expired, revoked, storage fault). Stays until the player reconnects, presses Dismiss in Settings, or the tab sees another tab sharing (it then shows nothing, as for any other tab). Dismiss is local to the tab: no request and no storage write, so it can never touch a session another tab has started since |

Nothing shows when sharing was never on, was stopped, or another tab holds it.

ChatGPT reads cost nothing beyond ChatGPT's own limits and Cloudflare's quotas. Ask Pip
is billed per question to the owner's Claude API organization (see below). Disable script observability
for private data (the supplied config does); no application code logs cards,
credentials or OAuth callback parameters.

## Ask Pip (in-game coaching)

ChatGPT answers took 12–17 seconds when measured on 2026-11-16, and almost none of
that was the service: every read took 22–62 ms. The rest was the model working twice
per question, once to decide to fetch the hand and once to answer. Ask Pip
answers inside the game in one model pass, with the hand already in the prompt.

**On demand only.** A small **Ask Pip** button sits under the badge while this tab
shares. Pressing it streams an answer into a card laid over your own row (your cards
and panel): the first line is the advice ("Call 6."), then why. A hand you don't ask
about costs nothing.

**Where the card goes.** Over the hero's row, anchored to its foot, as tall as the
row (at least 12rem, scrolling past that), on desktop and phone alike. It never covers
a seat, the board or the pot; what it hides is what the advice already speaks for.
The first version opened under the button, over the felt's corner, and in the
browser test it hid an opponent's seat and stack. The button and the card sit apart,
so they share one answer (`src/lib/liveCoaching/askPip.ts`, no React): asking again,
the card's ✕, or the deal moving on stops an answer still being written.

**How it flows.**

1. The game (`src/lib/liveCoaching/coach.ts`, `LivePublisher.coach`) waits up to 3 s
   for an upload in flight, so the answer sees the latest move, then sends `POST
   /coach` with the tab's own publishing credential and the player's coaching settings.
2. The Worker reads the settings (body at most 4 KB) and asks the Durable Object,
   which checks the credential and the writer exactly as for an upload, applies the
   rate (6 questions a rolling minute, memory only) and returns the stored snapshot.
   Nothing the browser sends reaches the model except the two settings.
3. `live-state/coach.mjs` streams one Claude answer back as NDJSON: `text` lines, then
   one `done` or `error` (with a message fit to show the player). The game reads the
   body to its very end even after the last line: a body left half-read keeps the
   request open, and the Worker then never finishes or logs it.
4. If the player closes the card (or the tab), the model call is aborted at once, so
   the rest of the answer is never generated or billed. On Cloudflare a dropped
   connection does not cancel the response body, so the incoming request's own
   signal does it; that needs the `enable_request_signal` compatibility flag in
   `wrangler.jsonc`. A cancelled body is the second trigger, for any other host.

**The model.** `claude-sonnet-5-5`, effort `low`, at most 1024 tokens, with the API's
server-side refusal fallback (`fallbacks: "default"`). Measured on four made-up spots
(2026-11-16):

| Model | First words | Whole answer | Note |
| --- | --- | --- | --- |
| Sonnet 5.5, low effort | 0.7–1.0 s | 1.7–2.2 s | Chosen: cleanest advice |
| Sonnet 5.5, thinking off | 0.6–1.1 s | 1.6–2.7 s | No faster in practice |
| Haiku 5.5, thinking off | 0.9–1.7 s | 1.7–2.7 s | Gave the wrong outs for a straight draw |
| Opus 5.5, low effort | 2.3–3.1 s | 3.4–4.3 s | Good, slowest |

About 1,000 tokens in and 100–150 out: roughly 0.35 cents a question at Sonnet 5.5
prices. The system prompt is under the minimum cacheable length, so it is not cached.

**What the model sees.** Fixed rules (`COACH_SYSTEM`): the answer's shape, no advice
when stale, not the hero's turn or the run is over, the snapshot's own equity, pot
odds and hand name rather than its own arithmetic, legal actions only, reads only when
present, never a guessed card, chips without a currency sign. Then the player's
length, then the player's notes, told to yield to the rules. The user message is the
snapshot reduced to `{ active, stale, pending, hand }`: no session ID or timestamps.

**The player's settings** (Settings → Live coaching → Ask Pip), kept in this browser
under `pip.live-coach.v1` and sent with each question, so a change applies to the next:

- **Length:** Short (the call and one line), Standard (the call and why, at most three
  sentences, the default) or Teach me (the idea behind it, four to six). Each ends with
  "Stop there.": without it, Standard ran to five sentences in the first browser test.
- **How should Pip coach you?** Up to 500 characters in the player's own words.
  The service also trims and caps it, and ignores an unknown length.

**Setup.** Create an API key in the Claude Console (platform.claude.com → API keys),
in the organization that holds the credits, and store it on the Worker:

```sh
corepack pnpm exec wrangler secret put ANTHROPIC_API_KEY --config live-state/wrangler.jsonc
```

Without the secret, `/coach` answers 503 `coach_off` and the card says Ask Pip isn't
set up. A refused key shows as "The coach's API key was refused. Replace it."

**Logs.** `/coach` writes the usual `pip_live_request` line when the answer starts
(status, `ms` to the start, version, stale), and a `pip_live_coach` line when it ends:
`model`, `firstTextMs`, `totalMs`, `inputTokens`, `outputTokens`, `stop`, and on failure
`code` and the exception's class name (`coach_closed` with `APIUserAbortError` when
the player closed the answer). Never the question, the notes or the answer.

**Taking it upstream.** The parts are separable: `coach.mjs` takes a snapshot and
settings and returns a stream; `coach.ts` and `AskPip.tsx` know only `LivePublisher`'s
`coach()`. What is single-owner here is the gate in front: a publishing session made
with the owner key, and one organization paying. Upstream would put the same route
behind its own account sign-in, with a per-player rate and a decision on who pays
(the membership, per docs/membership.md, already lists coaching among what it sells).

## First deployment (local terminal)

From the repository root. This deploys the
private state Worker.

1. Add the KV and Pages permissions needed by this phase:

   ```sh
   corepack pnpm exec wrangler login --device \
     --scopes account:read user:read workers_scripts:write workers_tail:read workers_kv:write pages:write
   ```

2. Create the OAuth namespace and let Wrangler record its ID in the config:

   ```sh
   corepack pnpm exec wrangler kv namespace create pip-live-state-oauth \
     --binding OAUTH_KV --update-config --config live-state/wrangler.jsonc
   ```

   Do this once. Check that `live-state/wrangler.jsonc` now contains the namespace
   ID. Keep that ID for subsequent deploys; do not create a new namespace each time.

3. Deploy, then set the owner key interactively (do not paste it into chat):

   ```sh
   corepack pnpm exec wrangler deploy --config live-state/wrangler.jsonc
   corepack pnpm exec wrangler secret put OWNER_KEY --config live-state/wrangler.jsonc
   ```

   The configured service URL is `https://pip-live-state.tizav.workers.dev`.
   If the printed URL differs, update `PUBLIC_URL` before using OAuth and redeploy.
   `/health` should return `{"ok":true,"service":"pip-live-state"}` once configured.
   `/mcp` and `/mcp/current` must reject anonymous reads with an OAuth challenge.

4. First test with the local game:

   ```sh
   corepack pnpm dev --port 3000
   ```

   Open `http://localhost:3000/game`, create a local Pip profile if prompted, and
   open Settings → Live coaching. Enter the private service URL and owner key.
   Start sharing, sit down at a normal Hold'em table, and wait for `Live · version N`.
   Sharing is opt-in; inactive installations do not upload gameplay.

5. For the static hosted game:

   ```sh
   NEXT_PUBLIC_LIVE_STATE_URL=https://pip-live-state.tizav.workers.dev corepack pnpm build
   corepack pnpm exec wrangler pages project create pip-tutor-tizav --production-branch main
   corepack pnpm exec wrangler pages deploy out --project-name pip-tutor-tizav --branch main
   ```

   Create the Pages project once. Use your actual available project name if that
   one is taken. Update the Worker's `ALLOWED_ORIGINS` to the exact resulting
   origin and redeploy the Worker if it differs from `https://pip-tutor-tizav.pages.dev`.
   Only the service URL is a public build setting; no key or publishing token goes
   in the build. Optional upstream account/membership integrations remain optional.

## Connect ChatGPT to the private service

Create a custom plugin called Pip Live (remove the retired Pip Live Probe plugin
if it is still installed):

- Server URL: `https://pip-live-state.tizav.workers.dev/mcp`.
- Authentication: OAuth. The server publishes authorization/protected-resource
  metadata, dynamic client registration and CIMD support. Use discovery if offered;
  do not select None for this private service.
- Expected tool: `get_current_hand`, read-only, no arguments.
- Complete the Worker's sign-in/consent form using the Pip Live owner key. Check
  the displayed client and return hostname before approving. Review/enable the
  plugin for the intended workspace seat. Individual app authorization still applies.

Whenever a Worker deploy changes the tool description in `live-state/worker.mjs`,
refresh the plugin's tool metadata in ChatGPT; until then it keeps the old text.

Use a new text chat with Pip Live enabled, then iPhone Live in the same workspace:
"Fetch my current Pip hand. Include its version, street and freshness."
Ask again after each move; do not accept a response that merely recalls a prior
hand. Do not manually transfer session URLs or game data between requests.

The supported route and account-specific access are documented in
[ChatGPT Voice](https://help.openai.com/en/articles/20001274-chatgpt-voice),
[custom MCP connections](https://help.openai.com/en/articles/12584461-connecting-custom-mcp-servers-in-chatgpt),
[plugin connection testing](https://developers.openai.com/plugins/deploy/connect-chatgpt)
and [OAuth authentication](https://developers.openai.com/plugins/build/auth).
Documentation checked 2026-11-15.

## JSON schema (version 1)

`GET /mcp/current` returns JSON with no-cache/no-store headers and requires an OAuth
Bearer token with the same resource audience as `/mcp`. `get_current_hand` returns
the same payload as a JSON text tool result.

The read wrapper includes `active`, `stale`, `pending`, `sessionId`, accepted
`version`, server `receivedAt`, `lastSeenAt`, `readAt`, `connectionAgeMs`, and `state`.
If no session exists or it expired, it returns `active: false`, `stale: true`,
`state: null` and a reason. Never describe this as a live hand.

The service keeps the session in memory and stores the snapshot and its metadata
under separate keys (`state`, `meta`). Heartbeats are persisted at most once a
minute, so after a rare mid-session restart of the object a read can report
`stale` until the next heartbeat. The game also sends a heartbeat as soon as its
tab becomes visible again or the browser comes back online.

### Diagnosing a slow answer

A read never waits for the next move; it returns the latest stored snapshot at
once. Every read ends with a `timing` object:

| Field | Meaning |
| --- | --- |
| `requestId` | Matches the log line for this request |
| `serverMs` | Worker entry to result, including token validation and the stored-hand read |
| `readMs` | The Durable Object round trip alone |
| `stateAgeMs` | Server clock now minus `receivedAt`; null without a snapshot |

A long wait with a small `serverMs` and a recent `readAt` happened outside the
service. Uploads are read before the object takes its lock, so a slow upload
cannot hold up a read.

Each request to `/mcp`, `/mcp/current`, `/token` and `/register`, and any other
request on which the Worker caught an exception, writes one `pip_live_request` log
line: method, path, RPC method and tool, status, `error` (the caught exception's
class name only, e.g. `SyntaxError`; absent when none was caught), `ms`, Cloudflare
`colo`, `hasBearer`, and for reads `version`, `stale`, `pending`, `stateAgeMs`. It
never holds cards, state, tokens, keys, cookies, query strings, bodies, client IDs,
IP addresses or error messages. Observability stays off; watch live with:

```sh
corepack pnpm exec wrangler tail --config live-state/wrangler.jsonc --format json
```

Reading the tail: a large `ms` or a 429 on `/token` points to the OAuth layer
(racing refreshes can be told to retry after 30 s); a large `readMs` points to the
Durable Object; repeated 401s on `/mcp` with `hasBearer: true` point to a token
problem; an `error` on a publishing path points to a malformed request or a fault
in the Worker; no request at all during the wait points to ChatGPT.

`stale` is true when no snapshot exists, the heartbeat is over 30 seconds old, or
the browser reports a version newer than the accepted snapshot. An idle hand with
fresh heartbeats is not stale solely because `capturedAt` is older. A disconnected
browser is not detected instantly; the maximum heartbeat window is 30 seconds.

### The snapshot

The `state` envelope uses `schemaVersion: 1`, private `sessionId`, positive
monotonic `version` and UTC ISO `capturedAt`. Versions are allocated and saved
before upload, acknowledged by the server and never accepted out of order.
`hand` is null when there is no current supported hand. Otherwise:

| Field | Meaning |
| --- | --- |
| `number`, `variant`, `complete`, `street` | Current hand identity/round; unfinished hands included |
| `buttonPlayerId`, `smallBlind`, `bigBlind`, `blindPosts` | Button and actual capped blind contributions; blinds are separate from the engine action log |
| `hero` | Player ID, original-deal position, visible `holeCards`, `equity` (probability 0–1) and `equityDisplay` (Pip's exact rounded text, e.g. `72%`), or null if hero absent |
| `hero.handName` | The made hand as the table names it (e.g. `Pair`, `Two Pair`), from the flop on; null preflop and while a Mystery Card is still face down |
| `hero.lastEquity` | `{ equity, equityDisplay, street }`: the most recent hero-turn estimate in this deal and the street it was computed on, or null. A past estimate, not current equity. Kept per deal (hand number, hero cards and board), so a new table's hand 1 never inherits it; lost on reload |
| `hero.stack`, `hero.toCall`, `hero.potOdds` | Chips behind; on the hero's turn the engine's call amount, and `toCall / (pot + toCall)` when there is something to call; otherwise null |
| `brief` | One plain sentence-style summary built only from the other fields, for a voice answer to lead with. See below |
| `communityCards` | Only cards currently on the board; Pip strings such as `Ah`, `Td` |
| `pot`, `potAwarded` | Total hand contributions from the engine; after completion this is the contested pot already awarded |
| `players` | IDs/names, original-deal positions, statuses, chips behind and commitments this street/across the hand; no opponent hole cards |
| `players[].style`, `players[].reads` | What opening that seat shows: its style line (string or null) and the "Your reads" labels (string array). `reads` is `[]` until 8 observed hands, and always for the hero. Never the AI's hidden profile |
| `effectiveRemainingStacks` | Per live opponent: the smaller remaining stack between hero and opponent, excluding committed chips |
| `currentBet`, `currentPlayerToAct` | Current street price and actor, including AI actors; actor null on completion |
| `availableActions` | Actor ID and exact engine legal-action flags/sizes; bet/raise sizes are total street commitment, call amount is additional chips, capped at stack |
| `actionHistory` | Actor (ID, `name`, `position`), street, action type and resulting street commitment in chronological order |
| `result` | Null while the hand is in play. Then the public `showdown` flag, `payouts`, `potsAwarded`, and `shownHands`: `{ playerId, name, position, holeCards, handName? }` for each hand the table turned face up, in seat order, the hero's included. A hand is shown only when it ended at a real showdown and the player was still in it, live or all in (engine `showsHoleCards`, the rule the felt draws by). `[]` without a showdown; never a folded hand or an unturned Mystery Card. `handName` (e.g. `Two Pair`) only where the table names it: the hero's own hand and the first pot's winners. No other evaluations |
| `table` | Null, or `{ venue, format, blindLevel, status, place, scoreHands }`: venue name; `format` `tournament`, `cash` or `score` (a quick game played for a score); `blindLevel` 1-based as the header's "L2"; run `status` `idle`, `playing`, `handover`, `busted`, `won`, `watching` or `scored`; tournament `place` once the run is over (1 = won), else null; `scoreHands` the hands a score game deals, else null. While spectating after a bust, `status` is `watching` and `place` is the place the player actually finished (see Spectating below) |

`brief` names the hand, street, the hero's seat, cards and stack, the board, then:
in play, the made hand ("You have a pair."; not once the hero folds), the pot, whose
turn and the price ("Your turn: 20 to call, pot odds 22%."), and the equity or last
estimate; once complete, who won what, and opponent cards only from
`result.shownHands` ("One showed Ah Kd, you showed 9s Tc."). When the run is over
it ends with one of: "You are out in 3rd.", "You won the table.", "You are out of
chips.", "The game is over: you finish with 1200 chips.", "You are out in 4th,
watching the table play out." Chip counts are bare numbers.

All amounts are play-money chip units. Heads-up uses `BTN/SB`; folded/all-in
players keep their original deal positions. The adapter never serializes the
engine deck, a Mystery Card before the table turns it over, or the replay/review
payload wholesale. Opponent hole cards appear only in `result.shownHands`, once a
hand has ended at a showdown, and only for the players the table shows: exactly
what the player can already see, nothing more. (After busting, "Watch it out" turns
every live hand face up mid-hand; the snapshot does not follow it.)

**Spectating.** Upstream's game store does not hold `watching` through a spectated
hand: `dealHand` sets `status: 'playing'`, and the end of that hand runs the bust
branch again, setting `busted` with `place` recomputed from the players left (so a
second "Watch it out" is needed for each further hand; observed by a store-driven
test, `tests/liveCoachingTable.test.ts`). `game.ts` is left as upstream wrote it.
Instead `tableContext.ts` reports what is true: once the player's seat has no chips
at a tournament, `status` `playing` or `watching` is published as `watching`, and
`place` is the place recorded when they first busted, held until they have chips
again (a new table). After each spectated hand the snapshot says `busted` with
that same place, matching the end card the table shows again.

A fix for the store itself was proposed upstream on 2026-11-15 (branch
`fix/spectate-records-once`, a pull request against `playpip/pip-web`): the deal
keeps a spectated table `watching` and a watched hand no longer settles the run
again. Once that is merged and pulled into this fork, the store reports `watching`
and the original place by itself, and this workaround can be reduced.

Equity is the exact existing Monte Carlo estimate from the game store, computed
on the hero's turn. The publisher does not run a second simulation. During AI
turns, at completion or when no valid estimate exists, `equity` is null and
`equityDisplay` is `—`. The estimate is the odds panel's underlying value; the
player's Show Odds setting can hide that panel without removing it from the
private payload. Publishing occurs after the estimate is available. Connecting
or resuming sharing mid-turn preserves the current estimate.

Every field above is additive within schema v1; existing readers can ignore what
they do not know. New fields come from the game client alone, but the tool
description that tells the model how to use them lives in the Worker (see Status).

## Automated deployment

`.github/workflows/deploy-pip-tutor.yaml` runs on main pushes or manual dispatch
only in `demukti/pip-web` and only when `PIP_TUTOR_ENABLED=true`. It installs locked
dependencies, runs `pnpm test:types` and `pnpm ava tests/live*.test.ts` (seconds),
builds the static game, deploys the state Worker and deploys Pages. It does not run
the full gate (about 11 minutes on a runner), so run `pnpm test:all` locally before
pushing. It does not refresh ChatGPT's tool metadata. Configure:

- Repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Use an API
  token scoped to this account with Workers Scripts Edit, Workers KV Storage Edit
  and Cloudflare Pages Edit permissions. The OAuth owner key stays on the Worker.
- Repository variable `PIP_PAGES_PROJECT` with the actual Pages project name.
- A real persisted `OAUTH_KV` namespace ID in the Worker config, configured Worker
  secret and an existing Pages project from the first-deployment steps.
- Enable `PIP_TUTOR_ENABLED` last. Upstream's deploy-and-release workflow
  (`deploy-cloudflare-pages.yaml`) is gated to `playpip/pip-web`; the fork does not
  need its release app or production secrets.

Poker actions never trigger repository writes
or deployments. Source remains on GitHub; runtime snapshots stay in the state service.

## Keeping up with upstream

The fork was cut at upstream `v1.49.4` (`065156f`), still upstream's latest tag on
2026-11-15. Remotes are local configuration; in a fresh clone add upstream with:

```sh
git remote add upstream https://github.com/playpip/pip-web.git
git fetch upstream --tags
```

The add-on's own files (`live-state/`, `src/lib/liveCoaching/`,
`LiveCoachingSection.tsx`, `LiveCoachingBadge.tsx`, `AskPip.tsx`, `tests/live*.test.ts`,
`tests/liveServiceFixture.ts`, `tests/cloudflareLoader.mjs`, `deploy-pip-tutor.yaml`, these two docs) do not exist
upstream. A merge can conflict only where the add-on touches upstream files:

| File | Add-on change |
| --- | --- |
| `src/store/game.ts` | Imports `livePublisher`; four `livePublisher.capture` calls (hand complete, hero turn with equity, AI turn, `leave()`); `buildHandRecord` reveals by `showsHoleCards` |
| `src/lib/poker/engine.ts`, `tests/engine.test.ts` | `showsHoleCards` and its tests |
| `src/components/AppBoot.tsx` | `livePublisher.start()` and `startTableContext()`; both stopped on unmount |
| `src/components/table/Table.tsx`, `tests/spectate.test.ts` | The badge with `<AskPipButton>` under it; the hero's row wrapped in a positioned box holding `<AskPipCard>`; `revealAll` via `showsHoleCards`, and the spectate test's matching regex |
| `src/components/settings/SettingsDialog.tsx`, `SettingsScreen.tsx` | `<LiveCoachingSection />` |
| `.github/workflows/deploy-cloudflare-pages.yaml` | Gated to `playpip/pip-web` |
| `package.json`, `pnpm-lock.yaml` | `@cloudflare/workers-oauth-provider`, `@anthropic-ai/sdk` |
| `knip.json` | `live-state/worker.mjs` entry |
| `.env.example` | `NEXT_PUBLIC_LIVE_STATE_URL` |

The add-on also reads upstream code it does not change: `tableContext.ts` reads the
game store (`venue`, `seats`, `seatStats`, `status`, `place`, `blindLevel`),
`useProfile().castRecords` and `deriveReads`; `state.ts` uses `evaluateHand`,
`handPhrase` and `ordinal`. The type check catches a renamed field.
`tests/liveCoachingHooks.test.ts` fails the gate if a merge drops a capture site in
`game.ts` or the `AppBoot` wiring, or if `PlayerDialog` changes how it derives
reads. It reads source, so it cannot prove the hooks fire at the right moment: after
a merge, still play a hand with sharing on.

## Verification

| Area | Status |
| --- | --- |
| Automated, `ava tests/live*.test.ts` | 112 pass (2026-11-16; full suite 1932): the 90 below plus Ask Pip (`liveCoach`, 22): the real Worker and Durable Object with the real Anthropic SDK against a stand-in API (the answer stream, what the model is sent, the credential, writer and rate checks, no key, a malformed or oversized question, settings settled, failures and refusals, a closed answer aborting the model call, the log lines), the real publisher asking after its upload lands, the NDJSON reader read to the end of the stream, a client disconnect stopping the model, the shared answer state, and the settings store. Earlier, 90 pass (2026-11-15): snapshot privacy and fields (`liveCoachingState`, 26), publisher against a fake service (`livePublisher`, 30), hook guard (`liveCoachingHooks`, 8), the table context against the real game and profile stores with a real game played in Node, including the run-status re-publish and spectating (`liveCoachingTable`, 4), and the real Worker, Durable Object and OAuth library with in-memory bindings, driven by the real engine and the real publisher (`liveStateService`, 22), including sliding expiry end to end |
| Automated, full suite | Run by `pnpm test:all`, the gate before every push |
| By hand, owner report 2026-11-15 | On the `cd6ae72` deployment: `Live · version N` in the real game; private OAuth text chat and iPhone Live retrieval both work. On the `624c521` deployment: ChatGPT reads the new fields (hand name, opponents' style and reads, table). Tool versions and timestamps not recorded |
| By hand, 2026-11-16 | Ask Pip, local game (`localhost:3000`) against the deployed Worker and the real API: the button under the badge, answers streaming into the card (first words 0.7–1.1 s, done 1.3–2.7 s from the click), Standard at three sentences, Short shorter, the settings switch and notes box, ✕ closing mid-answer stopping the model call (logged `coach_closed` at 933 ms), and both log lines for every question |
| Unverified | Ask Pip: Teach me and the notes as the model applies them, a refused key, the rate limit, a phone-width table. In a real browser: each badge state, the Settings copy and Dismiss button, and the run-over `brief` as ChatGPT reads it. Also, from before: second-device retrieval, displayed-equity comparison against the odds panel, stale reporting after closing the tab |

For the deployed demonstration: connect the real game, fetch its initial state,
make a move, fetch again, and repeat at least four times through an unfinished
flop/turn. Compare cards, actor, pot, action history, `hero.handName`, `table`
(venue, level) and increasing version against the browser; open a seat with 8+
hands played and compare `style` and `reads` with its dialog. Play a run to its end
and check the run-over sentence in `brief`. Repeat from the iPhone using Pip Live;
record exact tool versions and timestamps. Unplug the network and check the badge
reads Offline, then Live again. Close the game tab and verify stale reporting after
30 seconds. Stop sharing and confirm the read tool reports no active session. Test
anonymous reads separately (must be denied). These are distinct from local handler
tests.
