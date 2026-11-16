# Ask Pip

Coaching on the hand in front of you, inside the game, only when you ask. Press
**Ask Pip** at the table and an answer streams into a card over your own hand: the
first line is the advice ("Call 6."), then why. A hand you don't ask about costs
nothing and sends nothing.

Status (2026-11-16): on the branch `feat/in-game-coach`. Its Worker was deployed by
hand from that branch (version `24a1dce0`); the hosted game has no button until the
branch reaches `main`, whose push also redeploys the Worker. It replaces
the ChatGPT coaching ("Pip Live"), which is archived at the tag `archive/chatgpt-live`
with its docs in [archive/](./archive/live-coaching.md). The poker rules are
unchanged; the engine gained one pure helper, `showsHoleCards`.

Why it replaced ChatGPT: ChatGPT answers took 12–17 seconds (measured 2026-11-16),
and almost none of that was the service (every read 22–62 ms). The model worked twice
per question, once to decide to fetch the hand and once to answer. Ask Pip sends the
hand with the question and answers in one model pass: first words in about a second.

## How it flows

1. The player presses **Ask Pip** (`src/components/table/AskPip.tsx`). The game
   describes the hand at that moment (`src/lib/askPip/table.ts` → `hand.ts`): only
   what the player can see, plus the table around it (venue, level, each seat's
   style line and "Your reads", derived as `PlayerDialog` derives them).
2. `AskPipSession` (`session.ts`) sends `POST /coach` with this browser's token and
   `{ hand, settings }` (`connection.ts`).
3. The Worker (`live-state/worker.mjs`) checks the question's shape (at most 32 KB,
   `hand` an object or `null`), then asks the Durable Object (`devices.mjs`), which
   checks the token and the rate (6 questions a rolling minute, across every browser).
4. `live-state/coach.mjs` streams one Claude answer back as NDJSON: `text` lines, then
   one `done` or `error` (with a message fit to show the player). The game reads the
   body to its very end: a body left half-read keeps the request open, and the Worker
   then never finishes or logs it.
5. Closing the card, asking again or the next deal aborts the model call at once, so
   the rest is never generated or billed. On Cloudflare a dropped connection does not
   cancel the response body, so the incoming request's own signal does it; that needs
   the `enable_request_signal` compatibility flag in `wrangler.jsonc`. A cancelled body
   is the second trigger, for any other host.

Nothing runs in the background: the game store has no Ask Pip code at all. One
subscription, started in `AppBoot`, remembers what the store forgets (a spectator's
finishing place and the deal's last equity estimate) so the description can be built
when asked.

## Signing in

The service has one owner. Settings → Ask Pip asks once for the service URL and the
owner key; the service answers with a token for this browser, and the browser keeps
only that (localStorage `pip.ask-pip.v1`: the URL and the token, never the key).
Signed out, the table shows no button at all.

- A browser stays signed in until 30 days after its last question.
- At most 5 browsers; signing in a sixth signs out the one used longest ago.
- **Sign out** in Settings revokes that browser's token on the service.
- Rotating `OWNER_KEY` signs every browser out on the next request.
- The service stores each token's SHA-256 hash, never the token or the key.

A refused token (expired, signed out elsewhere, key rotated) signs the browser out and
Settings says why.

## The model

`claude-sonnet-5-5`, effort `low`, at most 1024 tokens, with the API's server-side
refusal fallback (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
Measured on four made-up spots (2026-11-16):

| Model | First words | Whole answer | Note |
| --- | --- | --- | --- |
| Sonnet 5.5, low effort | 0.7–1.0 s | 1.7–2.2 s | Chosen: cleanest advice |
| Sonnet 5.5, thinking off | 0.6–1.1 s | 1.6–2.7 s | No faster in practice |
| Haiku 5.5, thinking off | 0.9–1.7 s | 1.7–2.7 s | Gave the wrong outs for a straight draw |
| Opus 5.5, low effort | 2.3–3.1 s | 3.4–4.3 s | Good, slowest |

About 1,000 tokens in and 100–150 out: roughly 0.35 cents a question. The system
prompt is under the minimum cacheable length, so it is not cached.

**What the model sees.** Fixed rules (`COACH_SYSTEM`): the answer's shape; no advice
when it is not the hero's turn or the run is over; the description's own equity, pot
odds and hand name rather than its own arithmetic; legal actions only; reads only when
present; never a guessed card; chips without a currency sign. Then the player's
length, then the player's notes, told to yield to the rules. The user message is
`{ hand }`, exactly as the game sent it.

## The player's settings

Settings → Ask Pip → How Pip answers, kept in this browser under
`pip.ask-pip-settings.v1` and sent with each question, so a change applies to the
next one:

- **Length:** Short (the call and one line), Standard (the call and why, at most three
  sentences, the default) or Teach me (the idea behind it, four to six). Each ends with
  "Stop there.": without it, Standard ran to five sentences in the first browser test.
- **How should Pip coach you?** Up to 500 characters in the player's own words.
  The service also trims and caps it, and ignores an unknown length.

## Where the card goes

The button sits in the table's top-left corner. The card lies over the hero's row
(cards and panel), anchored to its foot, as tall as the row (at least 12rem, scrolling
past that), on desktop and phone alike. It never covers a seat, the board or the pot;
what it hides is what the advice already speaks for. The first version opened under
the button and hid an opponent's seat.

The hero's row is wrapped in a positioned box that sets no z-index, so the card (z-40)
lies over the hand's result banner (z-30) and under the end-of-run overlay. A z-index
on the wrapper made a stacking context and put the banner over the card at showdown.

The button and the card sit apart, so they share one answer (`session.ts`, no React).

## Setup

From the repository root, in your own terminal (never paste a key into chat).

1. Log in to Cloudflare with the scopes this needs:

   ```sh
   corepack pnpm exec wrangler login --scopes account:read user:read workers_scripts:write workers_tail:read pages:write
   ```

2. Deploy the Worker and set its two secrets. `OWNER_KEY` is at least 32 random
   characters; `ANTHROPIC_API_KEY` comes from the Claude Console (platform.claude.com
   → API keys), in the organization that holds the credits:

   ```sh
   corepack pnpm exec wrangler deploy --config live-state/wrangler.jsonc
   corepack pnpm exec wrangler secret put OWNER_KEY --config live-state/wrangler.jsonc
   corepack pnpm exec wrangler secret put ANTHROPIC_API_KEY --config live-state/wrangler.jsonc
   ```

   `/health` answers `{"ok":true,"service":"pip-live-state"}`. The Worker keeps its
   ChatGPT-era name (`pip-live-state`) and Durable Object class (`LiveState`), so the
   URL, the secrets and the object carry over; the object deletes its old records on
   first use.

3. Set `ALLOWED_ORIGINS` in `wrangler.jsonc` to the game's exact origins
   (`http://localhost:3000` for development, the Pages origin for the hosted game).

4. Build the hosted game with the service URL, so Settings fills it in:

   ```sh
   NEXT_PUBLIC_ASK_PIP_URL=https://pip-live-state.tizav.workers.dev corepack pnpm build
   corepack pnpm exec wrangler pages deploy out --project-name pip-tutor-tizav --branch main
   ```

   Only the URL is public build configuration; no key goes in the build.

5. Open the game, Settings → Ask Pip, enter the owner key, sit at a Hold'em table and
   press Ask Pip.

Without `ANTHROPIC_API_KEY`, `/coach` answers 503 `coach_off` and the card says Ask Pip
isn't set up. A refused API key shows as "The coach's API key was refused. Replace it."

**Automated deployment.** `.github/workflows/deploy-pip-tutor.yaml` runs on pushes to
`main` (or by hand) only in `demukti/pip-web` and only while `PIP_TUTOR_ENABLED=true`.
It runs `pnpm test:types` and `pnpm ava 'tests/askPip*.test.ts'` (seconds), builds the
game with `NEXT_PUBLIC_ASK_PIP_URL`, deploys the Worker, then Pages. It does not run the
full gate (about 11 minutes on a runner), so run `pnpm test:all` before pushing. It
needs the secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers Scripts
Edit and Cloudflare Pages Edit) and the variable `PIP_PAGES_PROJECT`. Upstream's
deploy-and-release workflow is gated to `playpip/pip-web`.

## Logs

Read them with `corepack pnpm exec wrangler tail --config live-state/wrangler.jsonc
--format json`. Two lines, allow-listed fields only, never the hand, the settings, the
answer, a token or a key:

- `ask_pip_request`, one per request (not `/health`): `requestId`, `method`, `path`,
  `status`, `ms`, `colo`, `hasBearer`, and an exception's class name if one escaped.
  For `/coach` it is written when the answer starts.
- `ask_pip_answer`, when an answer ends, with the same `requestId`: `model`,
  `firstTextMs`, `totalMs`, `inputTokens`, `outputTokens`, `stop`, and on failure `code`
  and the exception's class name. `coach_closed` with `APIUserAbortError` means the
  player closed the answer (or went away) and the model call was stopped.

A slow answer: compare `firstTextMs` (the model) with the request's `ms` (the service
until the answer started). The browser's own timing is in DevTools → Network.

## Keeping up with upstream

The fork was cut at upstream `v1.49.4` (`065156f`). In a fresh clone:

```sh
git remote add upstream https://github.com/playpip/pip-web.git
git fetch upstream --tags
```

Ask Pip's own files (`live-state/`, `src/lib/askPip/`, `AskPip.tsx`,
`AskPipSection.tsx`, `tests/askPip*.test.ts`, `deploy-pip-tutor.yaml`, this doc and
`docs/archive/`) do not exist upstream. A merge can conflict only here:

| File | Change |
| --- | --- |
| `src/components/AppBoot.tsx` | `startAskPip()`, stopped on unmount |
| `src/components/table/Table.tsx` | `<AskPipButton>` in the stage's top-left corner; the hero's row wrapped in `<div className="relative">` holding `<AskPipCard>`; `revealAll` via `showsHoleCards` |
| `src/components/settings/SettingsDialog.tsx`, `SettingsScreen.tsx` | `<AskPipSection />` |
| `src/store/game.ts` | `buildHandRecord` reveals by `showsHoleCards` (no Ask Pip code) |
| `src/lib/poker/engine.ts`, `tests/engine.test.ts`, `tests/spectate.test.ts` | `showsHoleCards`, its tests, and the spectate test's matching regex |
| `.github/workflows/deploy-cloudflare-pages.yaml` | Gated to `playpip/pip-web` |
| `package.json`, `pnpm-lock.yaml` | `@anthropic-ai/sdk` |
| `knip.json` | `live-state/worker.mjs` entry |
| `.env.example` | `NEXT_PUBLIC_ASK_PIP_URL` |

Ask Pip also reads upstream code it does not change: `table.ts` reads the game store
(`hand`, `handIndex`, `heroEquity`, `venue`, `seats`, `seatStats`, `status`, `place`,
`blindLevel`), `useProfile().castRecords` and `deriveReads`; `hand.ts` uses
`evaluateHand`, `handPhrase` and `ordinal`. The type check catches a renamed field.
`tests/askPipHooks.test.ts` fails the gate if a merge drops the `AppBoot` wiring, the
table or Settings mounts, puts Ask Pip code into the game store, or changes how
`PlayerDialog` derives reads. It reads source, so after a merge still ask Pip once.

## Taking it upstream

The parts are separable: `coach.mjs` takes a hand and settings and returns a stream;
the game's side knows only `askPipConnection.ask()`. What is single-owner here is the
gate: an owner key and one organization paying. Upstream would put `/coach` behind its
own account sign-in instead of `/connect`, with a per-player rate and a decision on
who pays (docs/membership.md already lists coaching among what the membership sells).

## Verification

| Area | Status |
| --- | --- |
| Automated, `ava 'tests/askPip*.test.ts'` | 68 pass (2026-11-16). `askPip` (32): the real Worker and Durable Object in Node with the real Anthropic SDK against a stand-in API: sign-in (wrong key, only the hash stored), signed-out, revoked and rotated tokens, the 5-browser cap, 30-day sliding expiry, old records deleted, the answer on the hand sent, the rate, no API key, malformed and oversized questions, settings settled, failures and refusals with class-only logs, closing and disconnecting stopping the model call (each checked to fail with its abort path removed), CORS; the game's sign-in, the NDJSON reader, the shared answer, the settings store. `askPipHand` (26): the hand description and its privacy. `askPipTable` (5): the table context against the real stores with a real game, including spectating. `askPipHooks` (5): the wiring guard |
| By hand, 2026-11-16, deployed Worker `24a1dce0` | Local game: the owner signed in once in Settings (`/connect` 200 in 149 ms; the browser keeps only the URL and the token). Two Teach me answers preflop: the service streamed after 37–40 ms, first words at 0.64–0.78 s, done at 2.8 s, 1,350 tokens in and 210–226 out, both log lines each. A refused token (a placeholder) signed the browser out, hid the button and said so in the card. At phone width the button sits above the felt, clear of the seats, and the card over the hero's row |
| By hand, 2026-11-16 (ChatGPT-era protocol, same model code) | Answers streaming into the card (first words 0.7–1.1 s, done 1.3–2.7 s from the click), Standard at three sentences, Short shorter, ✕ stopping the model call (`coach_closed` at 933 ms), the card over the result banner at showdown |
| Unverified | The notes as the model applies them (Teach me ran to seven sentences once, one over its six), a refused API key, the rate limit as the player sees it, a FOLD tag next to the button at a full phone-width table |
