# Pip Live coaching

Status: the private service is deployed and, by user confirmation, readable from
an OAuth-protected text chat and from iPhone Live in the owner's ChatGPT workspace. The
public diagnostic that preceded it is retired. The changes in
[live-coaching-ledger.md](./live-coaching-ledger.md) were deployed by hand on
2026-11-15: Worker version `4189e5d6`, and the game at
`https://pip-tutor-tizav.pages.dev` (commit `4838a8e`). Automatic deploys stay off
until `PIP_TUTOR_ENABLED` is set. No automated poker decisions or model API calls were added. The poker
rules are unchanged; the engine gained one pure helper, `showsHoleCards`.

## Architecture

- GitHub: source and an opt-in Actions deployment workflow.
- Cloudflare Pages: Pip's existing static Next.js export. The upstream app assumes
  root-relative public assets, links and service-worker paths. Keeping a root-hosted
  Pages site avoids broad changes for a GitHub Pages repository subdirectory.
- `live-state/`: one Worker, one Durable Object retaining the latest session/state,
  and a KV namespace used only by the maintained OAuth library. Game reads/writes
  go directly to the Durable Object, not eventually consistent KV.
- The browser publishes after the deal, every human/AI action, resume and leaving.
  A heartbeat every 10 seconds marks the browser as connected even when nobody acts.
- ChatGPT calls the OAuth-protected read-only `get_current_hand` operation each time.
  There is no session ID or URL to supply in the conversation.

The snapshot adapter reuses `HandState`, `legalActions()`, `potSize()`, the engine
log and `cardToString()`. Pip's existing `encodeHand()` is for completed replay
links; its v2 form contains hidden opponent cards and must not be uploaded live.
The public `live-probe` connectivity diagnostic was retired on 2026-11-15, once
private iPhone Live retrieval worked; its code is in git history before that date.

## Access model and limits

This is a single-owner, single-active-session feature for play-money Hold'em against
Pip's cast. It does not publish multiplayer, lessons, drills, or other variants.

The owner creates a random key (at least 32 characters; recommend 64 random hex
characters) and saves it in their password manager. It is stored only as a Worker
secret named `OWNER_KEY`. Enter it on the game connection form and the Worker's
OAuth consent page; never send it in chat, put it in a URL, commit it, or set it in
`NEXT_PUBLIC_*`. This key is separate from the user's Cloudflare login/API token.

The game exchanges the owner key for a random 256-bit publishing credential and a
random session UUID. Only that credential and sequence metadata are retained in
localStorage, so a new tab or a browser restart resumes without the owner key
until the session expires; the owner key is not persisted by the app.
ChatGPT receives audience-bound OAuth tokens with `hand:read` permission, not the
publishing credential. The library handles PKCE, one-time codes, browser-bound
consent and refresh tokens. Access tokens last 1 hour; grants last 30 days. The
owner key is still compared on every read, so rotating it revokes at once.

A new game connection replaces the previous session. A reload claims the existing
session with a new writer ID, preventing a duplicated tab from silently reusing
its sequence. Only one tab publishes: a second tab opened while another is sharing
does not take over by itself (it offers "Share from this tab"), and a tab that
loses the writer role stops publishing without deleting the saved session. If the
claim fails at load because the network is down, the game keeps the saved session
and retries on the next heartbeat and when the browser comes back online. Sessions/data expire after 12 hours. Stop sharing deletes the remote
session if online. When offline, remote data remains stale until expiry. Rotating
`OWNER_KEY` invalidates existing reads and publishing credentials, and requires
reconnecting both the game and ChatGPT. Scope/identity checks run on every read.

The endpoint returns the latest **acknowledged** upload. An action still in flight
cannot be visible yet. The UI reports pending/retrying uploads; the API reports
versions and freshness. Uploads never block gameplay. At most one upload is in
flight and one waits behind it; each new capture replaces the waiting one, because
every snapshot is the newest full state including its complete action history.
A small "Live"/"Syncing" indicator at the table mirrors the Settings status.

No AI API subscription or per-token billing is introduced. Existing ChatGPT Voice
limits and Cloudflare hosting/storage quotas apply. Disable script observability
for private data (the supplied config does); no application code logs cards,
credentials or OAuth callback parameters.

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

Each request to `/mcp`, `/mcp/current`, `/token` and `/register` writes one
`pip_live_request` log line: method, path, RPC method and tool, status, `ms`,
Cloudflare `colo`, `hasBearer`, and for reads `version`, `stale`, `pending`,
`stateAgeMs`. It never holds cards, state, tokens, keys, cookies, query strings,
bodies, client IDs or IP addresses. Observability stays off; watch live with:

```sh
corepack pnpm exec wrangler tail --config live-state/wrangler.jsonc --format json
```

Reading the tail: a large `ms` or a 429 on `/token` points to the OAuth layer
(racing refreshes can be told to retry after 30 s); a large `readMs` points to the
Durable Object; repeated 401s on `/mcp` with `hasBearer: true` point to a token
problem; no request at all during the wait points to ChatGPT.

`stale` is true when no snapshot exists, the heartbeat is over 30 seconds old, or
the browser reports a version newer than the accepted snapshot. An idle hand with
fresh heartbeats is not stale solely because `capturedAt` is older. A disconnected
browser is not detected instantly; the maximum heartbeat window is 30 seconds.

The `state` envelope uses `schemaVersion: 1`, private `sessionId`, positive
monotonic `version` and UTC ISO `capturedAt`. Versions are allocated and saved
before upload, acknowledged by the server and never accepted out of order.
`hand` is null when there is no current supported hand. Otherwise:

| Field | Meaning |
| --- | --- |
| `number`, `variant`, `complete`, `street` | Current hand identity/round; unfinished hands included |
| `buttonPlayerId`, `smallBlind`, `bigBlind`, `blindPosts` | Button and actual capped blind contributions; blinds are separate from the engine action log |
| `hero` | Player ID, original-deal position, visible `holeCards`, `equity` (probability 0–1) and `equityDisplay` (Pip's exact rounded text, e.g. `72%`), or null if hero absent |
| `hero.lastEquity` | `{ equity, equityDisplay, street }`: the most recent hero-turn estimate in this hand and the street it was computed on, or null. A past estimate, not current equity; lost on reload |
| `hero.stack`, `hero.toCall`, `hero.potOdds` | Chips behind; on the hero's turn the engine's call amount, and `toCall / (pot + toCall)` when there is something to call; otherwise null |
| `brief` | One plain sentence-style summary built only from the other fields, for a voice answer to lead with. Names opponent cards only after a showdown, and only those in `result.shownHands` ("One showed Ah Kd, you showed 9s Tc.") |
| `communityCards` | Only cards currently on the board; Pip strings such as `Ah`, `Td` |
| `pot`, `potAwarded` | Total hand contributions from the engine; after completion this is the contested pot already awarded |
| `players` | IDs/names, original-deal positions, statuses, chips behind and commitments this street/across the hand; no opponent hole cards |
| `effectiveRemainingStacks` | Per live opponent: the smaller remaining stack between hero and opponent, excluding committed chips |
| `currentBet`, `currentPlayerToAct` | Current street price and actor, including AI actors; actor null on completion |
| `availableActions` | Actor ID and exact engine legal-action flags/sizes; bet/raise sizes are total street commitment, call amount is additional chips, capped at stack |
| `actionHistory` | Actor (ID, `name`, `position`), street, action type and resulting street commitment in chronological order |
| `result` | Null while the hand is in play. Then the public `showdown` flag, `payouts`, `potsAwarded`, and `shownHands`: `{ playerId, name, position, holeCards, handName? }` for each hand the table turned face up, in seat order, the hero's included. A hand is shown only when it ended at a real showdown and the player was still in it, live or all in (engine `showsHoleCards`, the rule the felt draws by). `[]` without a showdown; never a folded hand or an unturned Mystery Card. `handName` (e.g. `Two Pair`) only where the table names it: the hero's own hand and the first pot's winners. No other evaluations |

All amounts are play-money chip units. Heads-up uses `BTN/SB`; folded/all-in
players keep their original deal positions. The adapter never serializes the
engine deck, a Mystery Card before the table turns it over, or the replay/review
payload wholesale. Opponent hole cards appear only in `result.shownHands`, once a
hand has ended at a showdown, and only for the players the table shows: exactly
what the player can already see, nothing more. (After busting, "Watch it out" turns
every live hand face up mid-hand; the snapshot does not follow it.)

Equity is the exact existing Monte Carlo estimate from the game store, computed
on the hero's turn. The publisher does not run a second simulation. During AI
turns, at completion or when no valid estimate exists, `equity` is null and
`equityDisplay` is `—`. The estimate is the odds panel's underlying value; the
player's Show Odds setting can hide that panel without removing it from the
private payload. Publishing occurs after the estimate is available. Connecting
or resuming sharing mid-turn preserves the current estimate. These are additive
schema-v1 fields; existing readers can ignore them. No Worker/plugin redeployment
or tool metadata refresh is needed; the game client supplies the new fields.

## Automated deployment

`.github/workflows/deploy-pip-tutor.yaml` runs on main pushes or manual dispatch
only when `PIP_TUTOR_ENABLED=true`. It installs locked dependencies, runs all gates,
builds the static game, deploys the state Worker and deploys Pages. Configure:

- Repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. Use an API
  token scoped to this account with Workers Scripts Edit, Workers KV Storage Edit
  and Cloudflare Pages Edit permissions. The OAuth owner key stays on the Worker.
- Repository variable `PIP_PAGES_PROJECT` with the actual Pages project name.
- A real persisted `OAUTH_KV` namespace ID in the Worker config, configured Worker
  secret and an existing Pages project from the first-deployment steps.
- Enable `PIP_TUTOR_ENABLED` last. Upstream's release workflow is now gated to the
  upstream repository; the fork does not need its release app or production secrets.

Poker actions never trigger repository writes
or deployments. Source remains on GitHub; runtime snapshots stay in the state service.

## Verification results

| Check | Result |
| --- | --- |
| Upstream/fork state and replay inspection | Completed |
| Public probe deployment (retired) | User deployed `https://pip-live-probe.tizav.workers.dev`, version `d3fb52bc-67ea-4c9f-919c-1ae1906c00f2` |
| Public probe text chat | Two user-supplied tool results at 12:20:09.110Z and 12:20:09.507Z on 2026-11-15, distinct IDs |
| Public probe iPhone Live | User reports it works; app version and correlated Worker logs not supplied |
| Initial state and repeated moves in unfinished hands | Automated handler tests use the real engine and real OAuth library with in-memory bindings; initial and four subsequent states retrieved with matching increasing versions |
| Credential separation, PKCE, refresh, audiences, replay rejection, session replacement and equity propagation | Passed; all 24 focused tests pass, see `tests/liveStateService.test.ts` |
| Full AVA regression suite | Passed: 1,843 tests, including displayed-equity updates |
| Repository formatting, type, lint and unused-code checks | Passed; pre-existing unrelated lint warnings remain |
| Private Worker bundle | Wrangler dry run succeeded; no deployment performed by agent |
| Private Worker deployment | User supplied deployed URL https://pip-live-state.tizav.workers.dev; namespace ID is recorded locally. Independent web checks remain unavailable from agent tools. |
| Production game build | Blocked in agent shell fetching upstream Geist/Geist Mono Google Fonts; local terminal/CI build still required |
| Dependency audit | Agent shell cannot resolve the package registry; result pending |
| Actual browser UI/gameplay and HTTP endpoint | Pending deployment and user browser run; sandbox denies local port binding |
| Browser publisher connection | User reports `Live · version 7` from the real game |
| OAuth consent browser issue | Fixed `no-referrer` causing `Origin: null` on form posts by using `strict-origin`; origin and browser-bound cookie checks remain enforced. Private deployment/retest required. |
| Actual second-device private retrieval | Pending |
| Actual OAuth-protected ChatGPT text and iPhone Live retrieval | User reports both work (2026-11-15); tool versions and timestamps not supplied |
| Private OAuth text retrieval after consent fix | User reports it works; displayed-equity comparison still requires explicit verification |

For the deployed demonstration: connect the real game, fetch its initial state,
make a move, fetch again, and repeat at least four times through an unfinished
flop/turn. Compare cards, actor, pot, action history and increasing version against
the browser. Repeat from the iPhone using Pip Live; record exact tool versions and
timestamps. Close the game tab and verify stale reporting after 30 seconds. Stop
sharing and confirm the read tool reports no active session. Test anonymous reads
separately (must be denied). These are distinct from local handler tests.
