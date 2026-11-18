# The coach

Coaching on the hand in front of you, inside the game, only when you ask. Press the
lightbulb in the corner of your own panel (A on a keyboard) and an answer streams into
a card over your own hand: the first line is the advice ("Call 6."), then why. A hand
you don't ask about costs nothing and sends nothing.

In code it is `askCoach` (`src/lib/askCoach/`), never plain `coach`: upstream's
`lib/coach.ts` is the Second opinion read (docs/review.md), a different thing. The
player sees "Coach"; it was called "Ask Pip" until 2026-11-16, renamed because the
answer is not Pip talking.

Status (2026-11-16): live on the fork's `main`, follow-ups included. Each push to
`main` deploys the game and the Worker together (`deploy-pip-tutor.yaml`, a new Worker
version each time: `wrangler deployments list --config live-state/wrangler.jsonc`
shows the live one). Deploy the Worker by hand only alongside the game
it serves: a game with follow-ups needs a Worker that reads `thread`, or each
follow-up is answered as the first question again. It replaces
the ChatGPT coaching ("Pip Live"), which is archived at the tag `archive/chatgpt-live`
with its docs in [archive/](./archive/live-coaching.md). The poker rules are
unchanged; the engine gained one pure helper, `showsHoleCards`.

Why it replaced ChatGPT: ChatGPT answers took 12–17 seconds (measured 2026-11-16),
and almost none of that was the service (every read 22–62 ms). The model worked twice
per question, once to decide to fetch the hand and once to answer. The coach sends the
hand with the question and answers in one model pass: first words in about a second.

## How it flows

1. The player presses the lightbulb (`src/components/table/AskCoach.tsx`). The game
   describes the hand at that moment (`src/lib/askCoach/table.ts` → `hand.ts`): only
   what the player can see, plus the table around it (venue, level, each seat's
   style line and "Your reads", derived as `PlayerDialog` derives them).
2. `AskCoachSession` (`session.ts`) sends `POST /coach` with this browser's token and
   `{ hand, settings }` (`connection.ts`), and for a follow-up `thread` too (see
   [Follow-ups](#follow-ups)).
3. The Worker (`live-state/worker.mjs`) checks the question's shape (at most 64 KB,
   `hand` an object or `null`, `thread` as `coachThread` takes it), then asks the Durable Object (`devices.mjs`), which
   checks the token and the rate (6 questions a rolling minute, across every browser).
4. `live-state/coach.mjs` streams one Claude answer back as NDJSON: `text` lines, then
   one `done` or `error` (with a message fit to show the player). The game reads the
   body to its very end: a body left half-read keeps the request open, and the Worker
   then never finishes or logs it.
5. Acting on the advice, asking again, the next deal or leaving the table aborts the
   model call at once, so the rest is never generated or billed. Closing the card does
   not: the answer keeps arriving, hidden, so the button can bring it back. On Cloudflare a dropped connection does not
   cancel the response body, so the incoming request's own signal does it; that needs
   the `enable_request_signal` compatibility flag in `wrangler.jsonc`. A cancelled body
   is the second trigger, for any other host.

Nothing runs in the background: the game store has no coach code at all. One
subscription, started in `AppBoot`, remembers what the store forgets (a spectator's
finishing place and the deal's last equity estimate) so the description can be built
when asked.

## Signing in

The service has one owner. Settings → Coach asks once for the service URL and the
owner key; the service answers with a token for this browser, and the browser keeps
only that (localStorage `pip.ask-coach.v1`: the URL and the token, never the key).
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

About 1,000 tokens in and 100–150 out: roughly 0.35 cents a question. A follow-up
sends the whole conversation again, about 200 tokens more each time: 0.4–0.5 cents,
so a question and three follow-ups come to about 1.6 cents. Nothing is cached:
Sonnet 5.5 caches prefixes from 512 tokens, but most questions get no follow-up, and
writing the cache costs 1.25 times the input on every first question to save about
0.2 cents on each follow-up.

**What the model sees.** Fixed rules (`COACH_SYSTEM`): the answer's shape; no advice
when it is not the hero's turn or the run is over; the description's own equity, pot
odds and hand name rather than its own arithmetic; the opening chart's play or the shove
chart's for a first move before the flop ([The opening chart](#the-opening-chart)); legal
actions only; reads only when present; never a guessed card; chips without a currency
sign. Then the player's
length, then the player's notes, told to yield to the rules. The user message is
`{ hand }`, exactly as the game sent it, with `solver` beside it when the chart answers
the spot and `shown` when the service has already written the advice line. The rules end with how to answer a
follow-up: the question itself, in plain words, no advice line unless asked what to
do, within the length's sentences.

## The opening chart

Folded round to you before the flop, the coach is handed a chart's answer for your exact
seat, stack and hand, so the advice is a known baseline and not what the model
remembers. Added 2026-11-18. It covers that one decision (about half of all first
preflop decisions, by a count over 2,400 simulated hands at six venues); every other
spot is still the model's judgment on the game's own equity and pot odds.

**It is a baseline, not a way to beat Pip.** The chart says what holds up against
anybody. Nothing in it is tuned to how Pip's own opponents play, on purpose: advice bent
to one pool of players stops being true at the next table. Adjusting to opponents is
the coach's job, out loud, from the reads the table shows ("the standard play is a
raise; these two call everything, so with a hand this close, folding is fine").

**Two charts, by stack.** The game names the spot in `hero.firstIn`
(`firstInFacts` in `hand.ts`): the chart seat (by players behind, the engine's
`firstInSpot`), the stack in big blinds against the biggest behind, and the hand class.

- **Fifteen big blinds or fewer:** the game adds `shoveChart`, from the shove chart Pip
  already teaches (`lib/drills/shoveRange`): shove, fold or close, and what shoving is
  worth.
- **Above fifteen:** the service looks the spot up in Pip's opening chart
  (`live-state/chart.mjs`, read by `live-state/solver.mjs`) and sends the model a `solver`
  entry beside the hand. Heads-up the small blind is the button, a different game with
  its own chart (below), and with more than five players behind the entry says to play
  tighter than the six-handed chart.

**What the chart holds.** For five seats at ten stack steps (20 to 100 big blinds; the
nearest answers), one answer a hand: the play (raise, shove, limp from the small blind,
or fold), another play worth the same if there is one, the best of the rest, and how
much better the play is than that, as one of six sizes. The coach is given words, never
decimals: "folding gives up about a quarter of a big blind". A hand with nothing clearly
worse is **close**.

**How it was built** (`pnpm coach-chart`, `scripts/coach-chart.ts`): from published
six-handed solver ranges and Pip's own shove solver, and it is neither of them.

- Values are read between the solved depths, so the steps are Pip's own.
- Shoving is an option the published ranges never consider. Up to 30 big blinds Pip's
  solver prices it against equilibrium callers, and it is the play where it beats
  everything else by a tenth of a big blind (a quarter from the small blind). At 20 big
  blinds that is the button's small pairs and a few suited broadways, and most aces
  and pairs from the small blind.
- Two plays within a twentieth of a big blind are the same choice.
- At the deep steps a second, independent solver is asked whether it opens the hand; a
  disagreement would make the hand close. There are none: every hand the two disagree
  on was already close.
- The raise size is the house's: 2 big blinds up to the 35 step and 2.5 above, and half
  a big blind more from the small blind.

The source ranges sit in `private/sets/` on the machine that builds the chart, which git
ignores. A clone does not need them: the chart is checked in.

**Facing a raise, and heads-up** (added 2026-11-18, second step). The game also names
`hero.facing` (`facingFacts` in `hand.ts`): exactly one player in ahead of you before the
flop and you have not acted. That is one raise with nobody else in (no limper before
it, no caller after it, the raiser not all in), or the small blind's limp heads-up.
`VS_OPEN` in the chart file answers the first for all fifteen seat pairings, and
`HEADS_UP` answers two-handed play: the small blind's first move, and the big blind
against its raise or its limp. By the same count these are about a fifth of first
preflop decisions, the largest gap the opening chart left.

These come from published ranges solved at 100 big blinds without rake, which have
frequencies and no values, so they keep less: the play taken most often, and a second
one when it is taken at least 30% of the time, which makes the hand close. There is no
"how much it matters" for them. And they are one depth, so the service is strict about
where they apply: from 60 big blinds (the smaller of the two stacks) they decide like the
opening chart; from 25 to 60 the entry is marked close, its verdict is worded as a
starting point, and a `note` says the chart fits loosely and to re-raise only a hand
worth getting all in with, so the model decides (the first live hand in this range
re-raised 6-5 suited with a third of the stack, straight off the deep chart); under 25, and against a raise of more than 3.5 big blinds, there is
no entry. A re-raise is sized at three times the raise, four from the blinds. The entry
also says who acts last after the flop (`position`): on the first live facing-a-raise
hand the model called the cutoff out of position against a hijack raise, so it is now
told and not left to work it out from seat names.

**Calling an all-in** (added 2026-11-18). When the one raise in front of you is all in,
`hero.facing` is a `shove`. If the smaller of the two stacks is fifteen big blinds or
fewer, the game adds `callChart` (`callFacts` in `hand.ts`) from the shove chart it
already teaches: the equilibrium calling range for your seat against the equilibrium
shoving range for the shover's. Its verdict is call, fold or close (the range mixes the
hand, or the call's value is inside the chart's sampling margin), with what calling wins
over folding if nobody behind comes in too. This is Pip's own data and exact for the
depth, so there is no loose zone: a deeper all-in simply has no `callChart`, and the
model decides it on equity and the price as before. The rules tell the model the
verdict outranks the equity-against-pot-odds comparison here, because that equity is
against a guessed range and this is against the shover's real one.

**Who decides, and the instant advice line.** Where the play is clearly the standard one,
the chart decides: the service sends the advice line itself ("Raise to 25.", `leadFor`)
before the model has been asked, and tells the model it is already `shown`, so the model
writes only the reason. Where the hand is close, the model decides and writes the line
as usual. The same goes for the shove chart's shove and fold, and for its call and fold
against somebody else's all-in. On a follow-up the
service never writes a line. The entry also carries the **pattern** ("the weakest
offsuit king the CO plays at this depth is KTo; K9o is first played from the BTN"), so
an answer teaches a rule and not one hand.

**What it costs an answer.** Nothing: the chart is 40 KB inside the Worker, a lookup is
under a tenth of a millisecond, and no storage is read. In a clear spot the first words
no longer wait for the model at all. The question grows by about 400 tokens (the rules
by about 290, the entry by about 95; measured in characters, 2026-11-18). `ask_coach_answer` logs `solver` (the hand went
with an entry) and `lead` (the service wrote the advice line).

## The player's settings

Settings → Coach → How the coach answers, kept in this browser under
`pip.ask-coach-settings.v1` and sent with each question, so a change applies to the
next one:

- **Length:** Short (the call and one line), Standard (the call and why, at most three
  sentences, the default) or Teach me (the idea behind it, four to six). The picker
  shows the labels only, with the picked one explained in a line under it: labels
  with subtitles ran past the picker's edge on an iPhone 16 Pro. Each ends with
  "Stop there.": without it, Standard ran to five sentences in the first browser test.
- **How do you want to be coached?** Up to 500 characters in the player's own words.
  The service also trims and caps it, and ignores an unknown length.

## The button and the card

**The button** is a lightbulb in the bottom-left corner of your own panel, on a phone
and a desktop alike: under the thumb, beside the panel's other corner controls (hand
rankings and last hand, which upstream put there because "anywhere else on the felt
they look dropped"), and away from "< Venues". The slot is upstream's `HeroPanel`
`corners.bottomLeft`, which only a multiplayer room's turn clock uses, so the table
passes one prop and upstream's panel is unchanged. It shows only when this browser
is signed in and the table is Hold'em. It started in the stage's top-left corner,
right under "< Venues": a mis-tap away from leaving the table.

**What it does.** Nothing kept: it asks. An answer kept for this deal and closed: it
brings the card back without asking (a dot on the bulb says one is waiting; the bulb
pulses while one is still being written). A failed answer is never brought back:
pressing asks again. With the card open, asking again is the card's ↻. Once there
are follow-ups, nothing starts over: closed, the button brings the card back; open, it
opens the conversation; and the card has no ↻.

**Closing and dropping.** Esc, the card's ✕ or a tap on the table away from it closes
the card and keeps the answer. Taps on controls do not count as away: pressing Raise
keeps the advice in view while you size the bet. The answer is dropped, and a model
call still running is stopped, when you commit an action (fold, check, call, or a
confirmed bet or raise: `heroActions` counts your entries in `hand.actions`), at the
next deal, and when the table closes.

**Keys** (desktop only, by upstream's `KEYBOARD_QUERY`): A does what the button does,
Q does what the card's Reply does (open or closed, whenever the card would offer it:
it opens the conversation), Esc closes the card. Q sits right above A: A asks, Q asks
more. Both are free in `lib/tableKeys.ts` (F, C, X, Space, R, 1–4, Enter, Esc, ?), and
`tests/askCoachHooks.test.ts` fails if upstream ever claims either. Neither is added to
upstream's `?` list, which its test holds to that file; the bulb's tooltip says A and
the Reply button shows a small Q. Keys go through upstream's `keysReachTable`, so
nothing fires while typing or while a dialog is open: Esc in the raise sizer closes
only the sizer.

**The card** lies over the hero's row
(cards and panel), anchored to its foot, as tall as the row (at least 12rem, scrolling
past that), on desktop and phone alike. It never covers a seat, the board or the pot;
what it hides is what the advice already speaks for. The first version opened under
the button and hid an opponent's seat.

The hero's row is wrapped in a positioned box that sets no z-index, so the card (z-40)
lies over the hand's result banner (z-30) and under the end-of-run overlay. A z-index
on the wrapper made a stacking context and put the banner over the card at showdown.

The button and the card sit apart, so they share one answer (`session.ts`, no React).

## Follow-ups

The card's **Reply** opens the conversation on that deal
(`src/components/table/AskCoachChat.tsx`): full screen on a phone, so the keyboard
and its dictation mic have room, and a panel in the middle of a wider screen. Voice
is the keyboard's own dictation (Apple's, on iPhone and Mac), never the browser's
speech API, which sends the audio to Google in Chrome and does not exist in Firefox.

- **The hand** stays pinned at the top, live: your cards, the board, the pot and the
  price to call.
- **The conversation** scrolls under it: what you asked on the right (the bulb's own
  question shows as "What should I do here?"), the coach's answers on the left.
- **The question box** at the foot grows with what you type or dictate. Enter sends,
  Shift+Enter starts a new line. It takes the focus on opening only with a mouse:
  on a phone the keyboard waits for a tap, so it doesn't cover the conversation you
  opened to read.
- **Quick questions** sit behind the small ? button left of the box, out of the way
  until wanted. A tap asks one as written. They are a plain list in
  `src/lib/askCoach/questions.ts`: add your own there.
- **Closing** (✕, Esc, or a click outside on a wide screen) goes back to the table
  with the card open on the latest answer. The conversation ends with the card's:
  acting, the next deal or leaving the table drops it and stops an answer still
  being written. A half-typed question survives closing the sheet.

**What is sent.** The game keeps the conversation; the service keeps nothing between
questions. Each follow-up sends `thread`: one turn per follow-up, each the coach's
answer to the message before it and the question put after it. The model sees the
hand, then each answer as an assistant turn and each question as a user turn. A
question asked while an opponent was to act can go stale as the table moves, so a
turn carries `hand` too when the hand changed since the coach last saw it, and the
rules tell the model the newest hand stands.

**Limits** (`FOLLOW_UPS_MAX`, `FOLLOW_UP_MAX`, held equal on both sides by a test): 8
follow-ups a deal, 500 characters each; the sheet says when two or fewer are left.
A failed follow-up is replaced by the next one, or put again as it was with "Try
again"; a failed first answer is asked again, never replied to. Follow-ups count
against the same 6 questions a minute.

**On an iPhone** the sheet is sized to the visual viewport (`visualViewport`), not the
screen: Safari lays the keyboard over the page without resizing it, so a sheet sized
to the screen would put the question box under the keys. The box's text is 16px, or
iOS zooms the page in on focus.

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
   NEXT_PUBLIC_ASK_COACH_URL=https://pip-live-state.tizav.workers.dev corepack pnpm build
   corepack pnpm exec wrangler pages deploy out --project-name pip-tutor-tizav --branch main
   ```

   Only the URL is public build configuration; no key goes in the build.

5. Open the game, Settings → Coach, enter the owner key, sit at a Hold'em table and
   press the lightbulb.

Without `ANTHROPIC_API_KEY`, `/coach` answers 503 `coach_off` and the card says the coach
isn't set up. A refused API key shows as "The coach's API key was refused. Replace it."

**Automated deployment.** `.github/workflows/deploy-pip-tutor.yaml` runs on pushes to
`main` (or by hand) only in `demukti/pip-web` and only while `PIP_TUTOR_ENABLED=true`.
It runs `pnpm test:types` and `pnpm ava 'tests/askCoach*.test.ts'` (seconds), builds the
game with `NEXT_PUBLIC_ASK_COACH_URL`, deploys the Worker, then Pages. It does not run the
full gate (about 11 minutes on a runner), so run `pnpm test:all` before pushing. It
needs the secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers Scripts
Edit and Cloudflare Pages Edit) and the variable `PIP_PAGES_PROJECT`. Upstream's
deploy-and-release workflow is gated to `playpip/pip-web`.

## Logs

Read them with `corepack pnpm exec wrangler tail --config live-state/wrangler.jsonc
--format json`. Two lines, allow-listed fields only, never the hand, the settings, the
answer, a token or a key:

- `ask_coach_request`, one per request (not `/health`): `requestId`, `method`, `path`,
  `status`, `ms`, `colo`, `hasBearer`, and an exception's class name if one escaped.
  For `/coach` it is written when the answer starts.
- `ask_coach_answer`, when an answer ends, with the same `requestId`: `model`,
  `firstTextMs`, `totalMs`, `inputTokens`, `outputTokens`, `stop`, and on failure `code`
  and the exception's class name. `coach_closed` with `APIUserAbortError` means the
  answer was dropped mid-way (the player acted, asked again, the deal moved on or the
  player left) and the model call was stopped.

Before the rename (2026-11-16) these were `ask_pip_request` and `ask_pip_answer`;
before that, the ChatGPT era wrote `pip_live_request` and `pip_live_coach`.

A slow answer: compare `firstTextMs` (the model) with the request's `ms` (the service
until the answer started). The browser's own timing is in DevTools → Network.

## Keeping up with upstream

The fork was cut at upstream `v1.49.4` (`065156f`). In a fresh clone:

```sh
git remote add upstream https://github.com/playpip/pip-web.git
git fetch upstream --tags
```

The coach's own files (`live-state/`, `src/lib/askCoach/`, `AskCoach.tsx`,
`AskCoachSection.tsx`, `tests/askCoach*.test.ts`, `scripts/coach-chart.ts`,
`deploy-pip-tutor.yaml`, this doc and `docs/archive/`) do not exist upstream. A merge can conflict only here:

| File | Change |
| --- | --- |
| `src/components/AppBoot.tsx` | `startAskCoach()`, stopped on unmount |
| `src/components/table/Table.tsx` | `coachButton` in the `HeroPanel` corners (`bottomLeft`, phone and desktop); the hero's row wrapped in `<div className="relative">` holding `<AskCoachCard>`; `revealAll` via `showsHoleCards` |
| `src/components/settings/SettingsDialog.tsx`, `SettingsScreen.tsx` | `<AskCoachSection />` |
| `src/components/ui/segmented.tsx` | `min-w-0` on each option, so its own `truncate` can work: without it a long label widened its option past the track (the length picker on a 320px phone). A fix upstream can take as it is |
| `src/store/game.ts` | `buildHandRecord` reveals by `showsHoleCards` (no coach code) |
| `src/lib/poker/engine.ts`, `tests/engine.test.ts`, `tests/spectate.test.ts` | `showsHoleCards`, its tests, and the spectate test's matching regex |
| `.github/workflows/deploy-cloudflare-pages.yaml` | Gated to `playpip/pip-web` |
| `package.json`, `pnpm-lock.yaml` | `@anthropic-ai/sdk`; the `coach-chart` script |
| `.gitignore` | `/private/` (source ranges for the chart) |
| `knip.json` | `live-state/worker.mjs` entry |
| `.env.example` | `NEXT_PUBLIC_ASK_COACH_URL` |

The coach also reads upstream code it does not change: `table.ts` reads the game store
(`hand`, `handIndex`, `heroEquity`, `venue`, `seats`, `seatStats`, `status`, `place`,
`blindLevel`), `useProfile().castRecords` and `deriveReads`; `hand.ts` uses
`evaluateHand`, `handPhrase` and `ordinal`, and for the first-in spot `firstInSpot`,
`holeKey` and the shove chart's `nashFor`, `shoveEv` and `classOf`. The type check catches a renamed field.
`tests/askCoachHooks.test.ts` fails the gate if a merge drops the `AppBoot` wiring, the
table or Settings mounts, puts coach code into the game store, or changes how
`PlayerDialog` derives reads. It reads source, so after a merge still ask the coach once.

## Taking it upstream

The parts are separable: `coach.mjs` takes a hand and settings and returns a stream;
the game's side knows only `askCoachConnection.ask()`. What is single-owner here is the
gate: an owner key and one organization paying. Upstream would put `/coach` behind its
own account sign-in instead of `/connect`, with a per-player rate and a decision on
who pays (docs/membership.md already lists coaching among what the membership sells).

## Verification

| Area | Status |
| --- | --- |
| Automated, `ava 'tests/askCoach*.test.ts'` | 79 pass (2026-11-16). `askCoach` (42): the real Worker and Durable Object in Node with the real Anthropic SDK against a stand-in API: sign-in (wrong key, only the hash stored), signed-out, revoked and rotated tokens, the 5-browser cap, 30-day sliding expiry, old records deleted, the answer on the hand sent, the rate, no API key, malformed and oversized questions, settings settled, failures and refusals with class-only logs, closing and disconnecting stopping the model call (each checked to fail with its abort path removed), CORS; the game's sign-in, the NDJSON reader, the shared answer (closing keeps it and the button brings it back without asking, an answer closed mid-way still arrives whole, a failed one is asked again, acting or the next deal drops it and stops the call), the settings store; follow-ups: the conversation sent whole as alternating turns, a changed hand sent again once, malformed conversations refused, a failed follow-up put again or replaced, a failed first answer never replied to, the limit, the button opening a conversation instead of starting over, and the two sides' limits agreeing. `askCoachHand` (26): the hand description and its privacy. `askCoachTable` (6): the table context against the real stores with a real game, including spectating, and the action count that drops the answer. `askCoachHooks` (5): the wiring guard, including the button in the panel's corner on both layouts |
| By hand, 2026-11-16, the lightbulb | Local game against the deployed Worker: the bulb in the panel's bottom-left corner, lined up under the ? above it. Asked once, then Esc closed the card (the bulb's label became "Show the coach's advice", with its dot), A brought it back, a tap on the felt closed it, the bulb brought it back: one question in all. ↻ put a second. With the raise sizer open the card stayed; confirming the raise dropped it |
| By hand, 2026-11-16, deployed Worker `24a1dce0` | Local game: the owner signed in once in Settings (`/connect` 200 in 149 ms; the browser keeps only the URL and the token). Two Teach me answers preflop: the service streamed after 37–40 ms, first words at 0.64–0.78 s, done at 2.8 s, 1,350 tokens in and 210–226 out, both log lines each. A refused token (a placeholder) signed the browser out, hid the button and said so in the card |
| By hand, 2026-11-16 (ChatGPT-era protocol, same model code) | Answers streaming into the card (first words 0.7–1.1 s, done 1.3–2.7 s from the click), Standard at three sentences, Short shorter, ✕ stopping the model call (`coach_closed` at 933 ms), the card over the result banner at showdown |
| By hand, 2026-11-16, follow-ups | Local game against a local stand-in for `/coach` (no model calls), Chromium at 375×812 and at desktop width. Reply opened the sheet full screen on the phone size with the hand pinned (J♣ 3♣, pot 3, to call 2) and the box inside the screen at 16px, not focused; a typed follow-up sent with Enter and a quick question from the ? menu both streamed in. The stand-in received the conversation growing by one turn each time, the hand never sent again (unchanged). Esc went back to the card, which showed the latest follow-up with "Conversation" and no ↻; a second Esc closed it and the bulb brought it back without asking. At desktop width the sheet is a 448×640 panel with the box focused, and reopening it lands at the conversation's end |
| Automated, 2026-11-18, the opening chart | 95 pass with the 16 added. `askCoachSolver` (11): the chart whole and well-formed (letters, limps only from the small blind, no shove above 30 big blinds, close meaning nothing clearly worse); it reads like poker (later seats play more, aces a raise, seven-deuce a fold, small pairs shoved short and raised deep); the play, the size in words and the pattern for a clear raise, a clear fold, a close hand, the small blind's limp-or-raise and a shove; no decimal reaching the coach; the house raise made legal; no entry heads-up, on a short stack, off the hero's turn or for an unreadable spot; the advice line for clear plays only and only as a legal action, from both charts; `solver` and `shown` in the message. `askCoach` (2 more): the real Worker sending the advice line first and the model's reason after it, logging `solver` and `lead`, a follow-up and any other hand going as before; a close spot left to the model. `askCoachHand` (3 more): `hero.firstIn` deep, short (against `shoveEv` itself) and null everywhere else |
| By hand, 2026-11-18, the opening chart, deployed (`b000d10`) | The hosted game at the Garage against the live Worker and model. On the button with 7-4 offsuit at 49 big blinds, four asks: "Fold." from the service, then a reason that agreed with it, did not repeat it, and used the pattern and the size in words ("a hand the chart plays from no seat", "loses about a tenth of a big blind"). Timed in the browser on three of them: the advice line at 98 and 134 ms, the model's first words at 670 and 692 ms, done at 1.9 to 2.0 s; one ask waited 6.6 s before the service answered at all, then ran normally (unexplained, seen once, minutes after the deploy). A spot the chart does not cover (big blind, limped to): the model's own line at 610 ms, done at 2.0 s, as before |
| Automated, 2026-11-18, facing a raise and heads-up | 104 pass with the 9 added (the last for `position`; the depth test also covers a light re-raise on a shorter stack). `askCoachSolver` (5 more): all fifteen pairings and the three heads-up charts whole; they read like poker (the big blind defends most, and more against a later raise; aces re-raise and seven-deuce folds everywhere; heads-up the small blind plays nearly everything); the play, the pattern, a legal re-raise and the advice line for a fold, a call and a re-raise; a mixed hand left to the model; the depth rule (a note under 60 big blinds, nothing under 25 or against a big raise). `askCoachHand` (3 more): `hero.facing` from real hands, null with a caller in between, a limper, an all-in raiser or the hero already in, and heads-up |
| By hand, 2026-11-18, both charts, deployed (`2e7460b`) | The hosted game against the live Worker and model, timed in the browser. Opening chart at The Card Room, 67 big blinds: K-5 suited on the button, aces in the cutoff and A-K suited under the gun each got "Raise to 75." from the service with a reason that agreed; 5-3 offsuit in the small blind got "Fold."; 5-4 suited in the hijack is close, so no line came from the service and the model chose a fold, naming the chart ("only becomes a regular open from the CO") and its reads on the two players behind. Facing a raise at the Downtown Casino, 99.5 big blinds: 4-3 offsuit in the cutoff against a hijack raise to 3.1 big blinds got "Fold." at 267 ms, the model's first words at 907 ms, done at 2.1 s, with the pattern ("the CO continues with no offsuit 4 here"); the reason called the hero out of position, which is wrong (the cutoff acts after the hijack). Advice line across eleven asks: 0.1 to 0.5 s. The service's own log for three of them: 40 to 135 ms to the start of the answer, about 2,480 tokens in. Three of the fourteen asks were slow for a reason outside the service (next row) |
| Checked, 2026-11-18, a 6.6 s wait that was the test's own | Three of fourteen asks made while an agent was driving the embedded browser (key presses and waits through its automation) waited 6.57 to 6.61 s before the response began, then ran normally. It was not the service: with nothing driving the page, 128 requests from the same browser were all fast, with the service log recording each. 44 with an invalid token and a small body, 68 alternating a small and a 10 KB body (0.03 to 0.3 s in the browser, 10 to 85 ms in the service), and 16 real questions (response begun in 0.07 to 0.43 s, 24 to 141 ms in the service, the model's first words at 0.59 to 0.70 s). A question asked by hand in the same browser took 0.27 s. Why automation stalls a request was not found. The CORS preflight is cached as intended: one for those 16 questions |
| By hand, 2026-11-18, the two fixes, deployed (`30195af`) | Played at the Downtown Casino before the fixes: K-J offsuit in the big blind against a button raise at 48 big blinds, "Call 149." written by the model (no line from the service at that depth), citing the chart; and 6-5 suited on the button against a hijack raise at 31 big blinds, "Raise to 1215.", the fault the second fix is for. Replayed against the live service after the deploy with hands built to match: the same 6-5 suited spot now "Fold.", calling the deep answer a starting point; 4-3 offsuit in the cutoff against a hijack raise, "Fold." with no position mistake; A-Q offsuit on the button against a cutoff raise, "Raise to 375." from the service, with "you act after her on every street". The Teach me answers ran to nine or ten sentences, over their six |
| Automated, 2026-11-18, calling an all-in | 107 pass with the 3 added. `askCoachHand` (2 more; one earlier case moved): a six big blind shove from a real hand gives `callChart` equal to the shove chart's own range, value and margin for the big blind; a forty big blind all-in has none; a covered hero reads the chart at its own stack. `askCoachSolver` (1 more): the advice line for call and fold, none for close or a deep all-in, and the raise chart never answering an all-in |
| By hand, 2026-11-18, heads-up, deployed (`30195af`) | The Challenge, two-handed at 67 big blinds. On the button with 8-3 suited the game sent `firstIn` with two players dealt, the chart mixes a raise and a limp there, so the model chose: "Call 60.", with the pattern and "you act last after the flop". The big blind's two spots, replayed against the live service with hands built to match: Q-7 offsuit against a raise to 300, "Call 180."; 7-2 offsuit after a limp, "Check."; aces after a limp, "Raise to 420."; each line from the service in 0.07 to 0.14 s, each reason with the big blind acting first after the flop |
| Unverified | The notes as the model applies them (Teach me ran to seven sentences once, one over its six), a refused API key, the rate limit as the player sees it, the bulb on a real phone (touch); follow-ups against the real model, the sheet on a real iPhone with the keyboard and dictation open (the visual-viewport sizing), and the sheet in Firefox and Safari |
