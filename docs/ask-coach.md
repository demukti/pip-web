# The coach

Coaching on the hand in front of you, inside the game, only when you ask. Press the
lightbulb in the corner of your own panel (A on a keyboard) and an answer streams into
a card over your own hand: the first line is the advice ("Call 6."), then why. A hand
you don't ask about costs nothing and sends nothing.

In code it is `askCoach` (`src/lib/askCoach/`), never plain `coach`: upstream's
`lib/coach.ts` is the Second opinion read (docs/review.md), a different thing. The
player sees "Coach"; it was called "Ask Pip" until 2026-11-16, renamed because the
answer is not Pip talking.

Status (2026-11-16): on the branch `feat/in-game-coach`. Its Worker was deployed by
hand from that branch (version `68630224`, with follow-ups; a game with follow-ups needs
a Worker that reads `thread`, or each follow-up is answered as the first question
again); the hosted game has no button until the
branch reaches `main`, whose push also redeploys the Worker. It replaces
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
odds and hand name rather than its own arithmetic; legal actions only; reads only when
present; never a guessed card; chips without a currency sign. Then the player's
length, then the player's notes, told to yield to the rules. The user message is
`{ hand }`, exactly as the game sent it. The rules end with how to answer a
follow-up: the question itself, in plain words, no advice line unless asked what to
do, within the length's sentences.

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
`AskCoachSection.tsx`, `tests/askCoach*.test.ts`, `deploy-pip-tutor.yaml`, this doc and
`docs/archive/`) do not exist upstream. A merge can conflict only here:

| File | Change |
| --- | --- |
| `src/components/AppBoot.tsx` | `startAskCoach()`, stopped on unmount |
| `src/components/table/Table.tsx` | `coachButton` in the `HeroPanel` corners (`bottomLeft`, phone and desktop); the hero's row wrapped in `<div className="relative">` holding `<AskCoachCard>`; `revealAll` via `showsHoleCards` |
| `src/components/settings/SettingsDialog.tsx`, `SettingsScreen.tsx` | `<AskCoachSection />` |
| `src/components/ui/segmented.tsx` | `min-w-0` on each option, so its own `truncate` can work: without it a long label widened its option past the track (the length picker on a 320px phone). A fix upstream can take as it is |
| `src/store/game.ts` | `buildHandRecord` reveals by `showsHoleCards` (no coach code) |
| `src/lib/poker/engine.ts`, `tests/engine.test.ts`, `tests/spectate.test.ts` | `showsHoleCards`, its tests, and the spectate test's matching regex |
| `.github/workflows/deploy-cloudflare-pages.yaml` | Gated to `playpip/pip-web` |
| `package.json`, `pnpm-lock.yaml` | `@anthropic-ai/sdk` |
| `knip.json` | `live-state/worker.mjs` entry |
| `.env.example` | `NEXT_PUBLIC_ASK_COACH_URL` |

The coach also reads upstream code it does not change: `table.ts` reads the game store
(`hand`, `handIndex`, `heroEquity`, `venue`, `seats`, `seatStats`, `status`, `place`,
`blindLevel`), `useProfile().castRecords` and `deriveReads`; `hand.ts` uses
`evaluateHand`, `handPhrase` and `ordinal`. The type check catches a renamed field.
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
| Unverified | The notes as the model applies them (Teach me ran to seven sentences once, one over its six), a refused API key, the rate limit as the player sees it, the bulb on a real phone (touch); follow-ups against the real model, the sheet on a real iPhone with the keyboard and dictation open (the visual-viewport sizing), and the sheet in Firefox and Safari |
