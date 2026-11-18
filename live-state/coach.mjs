import Anthropic from '@anthropic-ai/sdk'
import { leadFor, solverFor } from './solver.mjs'

// On-demand table coaching: the player asks the coach, the game sends the hand
// as it stands, and the Worker streams one Claude answer back. One model pass, no
// tools.
// Measured 2026-11-16 on four spots: first words in 0.6–1.0 s, done in 1.6–2.7 s
// (Haiku 5.5 was no faster and got a straight's outs wrong; Opus 5.5 took 2.3–3.1 s
// to start).
export const COACH_MODEL = 'claude-sonnet-5-5'
const MAX_TOKENS = 1024

// Fixed text, no per-request values, so every request sends the same prefix. It is
// below the model's minimum cacheable length, so it is not marked for caching.
export const COACH_SYSTEM = `You are Pip's table coach for a single-player, play-money Texas Hold'em game.
The player asked the coach at the table. The message holds the game's own JSON description of the hand at that moment, built only from what the player can see. The player's own seat has the id "hero".

Answer in this exact shape, plain text, no headings, lists or markdown:
Line 1: the advice in at most eight words, starting with the action and size, e.g. "Call 6." or "Raise to 24." or "Fold."
Then the explanation of why, for a learning player, at the length set below.

Rules:
- If hand is null, say there is no hand in play.
- If it is not the hero's turn (hand.currentPlayerToAct is not "hero"), say whose turn it is and what to watch for; give no action.
- If hand.table.status is busted, won, scored or watching, the run is over: say so instead of advising.
- If the hand is complete, explain how it ended using hand.result; opponents' cards only from hand.result.shownHands.
- Use the snapshot's numbers: hero.equity against hero.potOdds decides calls; hero.handName names the made hand; never re-derive either.
- Before the flop, first in or facing one raise: when the message has a "solver" entry beside the hand, it is Pip's chart for this exact spot and hand: the standard play against anybody. When solver.close is false, that play is the advice (a raise or re-raise is to solver.raiseToChips; a limp is a call; a shove is a raise to availableActions.maxRaiseTo). Explain it with solver.verdict and solver.pattern, so the player learns the rule and not only this hand. solver.position, when present, says who acts last after the flop: never say otherwise. You may add what a read on the other players changes, but never reverse the advice. When solver.close is true, or solver.note says the chart fits this stack only loosely, you decide: say what is standard, then let the reads, the stacks and the note choose, and say why.
- A short stack's first move: when hero.firstIn.shoveChart is present, it is the shove-or-fold chart's answer. Advise its verdict: shove (a raise to availableActions.maxRaiseTo), fold, or close (either is fine; you decide as above). shoveValueBb is what shoving wins over folding, in big blinds.
- Facing an all-in before the flop: when hero.facing.callChart is present, a short stack has shoved and it is the shove chart's calling answer for the hero's seat against that seat's shoving range. Advise its verdict, call or fold, even where hero.equity against hero.potOdds seems to say otherwise: that equity is against a guessed range, and this is against the shover's real one. When the verdict is close, you decide on the price and the reads. callValueBb is what calling wins over folding, in big blinds, if nobody behind comes in too.
- When the message has "shown", that advice line is already on the player's screen as line 1. Do not write an advice line: write only the explanation, and agree with it.
- Advise only legal actions from availableActions. Bet and raise sizes are the total street commitment; a call amount is the extra chips.
- Use an opponent's style and reads only if present; with empty reads there is no read yet. Never guess opponent cards.
- Chips only: bare numbers, never a currency sign.

Follow-up questions: after the first answer the player may ask about the same hand in their own words. Answer that question directly, in plain text: no advice line unless they ask what to do, and no more sentences than the length below allows after its advice line. A follow-up may come with the hand as it stands now, as {"hand": …}; from then on, that is the hand. The rules above still apply.`

// The player's own settings (Settings → Coach), sent with each question.
export const COACH_STYLES = {
  short: 'Length: the advice line, then exactly one short sentence. Stop there.',
  standard: 'Length: the advice line, then at most three short sentences. Stop there.',
  teach:
    'Length: the advice line, then four to six sentences that teach: name the idea behind the decision (pot odds, equity, position, what the opponent might hold) in plain words. Stop there.',
}
export const NOTES_MAX = 500

/** Settles the request body to a known style and trimmed notes; anything else is dropped. */
export function coachPrefs(body) {
  const style = Object.hasOwn(COACH_STYLES, body?.style) ? body.style : 'standard'
  const notes = typeof body?.notes === 'string' ? body.notes.trim().slice(0, NOTES_MAX) : ''
  return { style, notes }
}

// The fixed rules first, then the player's settings, so the notes shape the
// answer but come after (and are told to yield to) the rules.
export function coachSystem({ style, notes }) {
  const blocks = [
    { type: 'text', text: COACH_SYSTEM },
    { type: 'text', text: COACH_STYLES[style] },
  ]
  if (notes)
    blocks.push({
      type: 'text',
      text: `The player's own notes on how to coach them. Follow them unless they conflict with the rules above:\n${notes}`,
    })
  return blocks
}

/**
 * What the model sees: the hand, exactly as the game described it; beside it
 * the opening chart's answer when it has one for the spot (./solver.mjs); and
 * the advice line when the service has already shown it.
 * @param {unknown} hand
 * @param {string | null} [shown]
 */
export function coachInput(hand, shown = null) {
  const solver = solverFor(hand)
  return JSON.stringify({ hand, ...(solver ? { solver } : {}), ...(shown ? { shown } : {}) })
}

// Follow-ups on one hand: how many, and how long each part may be. The game
// keeps the conversation and sends it whole with each one; the service keeps
// nothing between questions.
export const FOLLOW_UPS_MAX = 8
export const FOLLOW_UP_MAX = 500
const ANSWER_MAX = 8000

const isHand = (hand) => hand === null || (typeof hand === 'object' && !Array.isArray(hand))

/**
 * The conversation so far, or null when it is not one the game sends: each turn
 * is the coach's answer to the message before it, then the player's next
 * question, with the hand as it then stood when it had changed.
 */
export function coachThread(thread) {
  if (thread === undefined) return []
  if (!Array.isArray(thread) || thread.length > FOLLOW_UPS_MAX) return null
  const turns = []
  for (const turn of thread) {
    const { answer, question, hand } = turn ?? {}
    if (typeof answer !== 'string' || !answer.trim() || answer.length > ANSWER_MAX) return null
    if (typeof question !== 'string') return null
    const asked = question.trim()
    if (!asked || asked.length > FOLLOW_UP_MAX) return null
    if (hand !== undefined && !isHand(hand)) return null
    turns.push(hand === undefined ? { answer, question: asked } : { answer, question: asked, hand })
  }
  return turns
}

/**
 * The hand first; then each answer and the follow-up put after it. `shown` is
 * the advice line already on the player's screen, on a first question only.
 * @param {unknown} hand
 * @param {{ answer: string, question: string, hand?: unknown }[]} [thread]
 * @param {string | null} [shown]
 */
export function coachMessages(hand, thread = [], shown = null) {
  const messages = [{ role: 'user', content: coachInput(hand, shown) }]
  for (const turn of thread) {
    messages.push({ role: 'assistant', content: turn.answer })
    messages.push({
      role: 'user',
      content:
        turn.hand === undefined
          ? turn.question
          : [
              { type: 'text', text: coachInput(turn.hand) },
              { type: 'text', text: turn.question },
            ],
    })
  }
  return messages
}

// Class name of a failure, mapped to what the player is told. Never the message.
const FAILURES = [
  // The player closed the answer; nobody is left to read the message.
  [Anthropic.APIUserAbortError, 'coach_closed', ''],
  [Anthropic.AuthenticationError, 'coach_key', "The coach's API key was refused. Replace it."],
  [Anthropic.PermissionDeniedError, 'coach_key', "The coach's API key was refused. Replace it."],
  [Anthropic.RateLimitError, 'coach_busy', 'The coach is busy. Ask again in a moment.'],
  [Anthropic.APIConnectionError, 'coach_unreachable', "Couldn't reach the coach. Ask again."],
]
export function coachFailure(error) {
  for (const [kind, code, message] of FAILURES) if (error instanceof kind) return { code, message }
  return { code: 'coach_failed', message: "The coach couldn't answer. Ask again." }
}

const line = (value) => `${JSON.stringify(value)}\n`

/**
 * Streams the answer as NDJSON: `{"type":"text","text":…}` lines as they are
 * written, then one `{"type":"done"}` or `{"type":"error","code","message"}`.
 * Returns the body and a promise that settles, with timings, token counts and
 * any failure's class name, once the answer ends: hand it to `waitUntil`.
 * `signal` is the incoming request's, which aborts when the client disconnects.
 *
 * On a first question in a spot the chart decides, the advice line is sent at
 * once, before the model is asked (`leadFor`), and the model writes only the
 * explanation.
 */
export function streamCoach(env, hand, prefs = coachPrefs(null), signal = null, thread = []) {
  const client = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    // Resolved per call, not captured, so a test can stand in for the API.
    fetch: (...args) => fetch(...args),
    maxRetries: 1,
    timeout: 30_000,
  })
  const encoder = new TextEncoder()
  const start = Date.now()
  const { readable, writable } = new TransformStream()
  const writer = writable.getWriter()
  const send = (value) => writer.write(encoder.encode(line(value)))
  const lead = thread.length === 0 ? leadFor(hand) : null
  const stream = client.beta.messages.stream({
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    system: coachSystem(prefs),
    messages: coachMessages(hand, thread, lead),
    // A safety decline is re-run on the model the API picks for its category.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  })
  // The player closed the answer or went away: stop generating, and paying, at
  // once, even while the model is between words. On Cloudflare a dropped
  // connection does not cancel the body, so the request's own signal (the
  // `enable_request_signal` flag) is the one that fires; a cancelled body covers
  // every other host.
  writer.closed.catch(() => stream.abort())
  signal?.addEventListener('abort', () => stream.abort(), { once: true })
  const finished = (async () => {
    // Whether the hand as it now stands went with the chart's answer, and
    // whether the service showed the advice line itself.
    const latest = thread.findLast((turn) => turn.hand !== undefined)?.hand ?? hand
    const outcome = {
      firstTextMs: null,
      inputTokens: null,
      outputTokens: null,
      stop: null,
      solver: solverFor(latest) !== null,
      lead: lead !== null,
    }
    try {
      if (lead) {
        outcome.firstTextMs = Date.now() - start
        await send({ type: 'text', text: `${lead}\n` })
      }
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          outcome.firstTextMs ??= Date.now() - start
          await send({ type: 'text', text: event.delta.text })
        }
      }
      const message = await stream.finalMessage()
      outcome.stop = message.stop_reason
      outcome.inputTokens = message.usage.input_tokens
      outcome.outputTokens = message.usage.output_tokens
      if (message.stop_reason === 'refusal')
        await send({
          type: 'error',
          code: 'coach_declined',
          message: "The coach can't answer that one.",
        })
      else await send({ type: 'done' })
    } catch (error) {
      stream.abort()
      outcome.error = error
      const { code, message } = coachFailure(error)
      outcome.code = code
      // The player may have closed the panel; then nobody reads this.
      await send({ type: 'error', code, message }).catch(() => {})
    } finally {
      await writer.close().catch(() => {})
    }
    return { ...outcome, totalMs: Date.now() - start }
  })()
  return { body: readable, finished }
}
