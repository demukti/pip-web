import Anthropic from '@anthropic-ai/sdk'

// On-demand table coaching: the player presses Ask Pip, the Worker reads the
// stored snapshot and streams one Claude answer back. One model pass, no tools.
// Measured 2026-11-16 on four spots: first words in 0.6–1.0 s, done in 1.6–2.7 s
// (Haiku 5.5 was no faster and got a straight's outs wrong; Opus 5.5 took 2.3–3.1 s
// to start).
export const COACH_MODEL = 'claude-sonnet-5-5'
const MAX_TOKENS = 1024

// Fixed text, no per-request values, so every request sends the same prefix. It is
// below the model's minimum cacheable length, so it is not marked for caching.
export const COACH_SYSTEM = `You are Pip's table coach for a single-player, play-money Texas Hold'em game.
The player pressed "Ask Pip" at the table. The message holds the game's own JSON snapshot of the hand, built from what the player can see. The player's own seat has the id "hero".

Answer in this exact shape, plain text, no headings, lists or markdown:
Line 1: the advice in at most eight words, starting with the action and size, e.g. "Call 6." or "Raise to 24." or "Fold."
Then the explanation of why, for a learning player, at the length set below.

Rules:
- If stale is true or active is false, say the game isn't connected right now and give no advice.
- If hand is null, say there is no hand in play.
- If it is not the hero's turn (hand.currentPlayerToAct is not "hero"), say whose turn it is and what to watch for; give no action.
- If hand.table.status is busted, won, scored or watching, the run is over: say so instead of advising.
- If the hand is complete, explain how it ended using hand.result; opponents' cards only from hand.result.shownHands.
- Use the snapshot's numbers: hero.equity against hero.potOdds decides calls; hero.handName names the made hand; never re-derive either.
- Advise only legal actions from availableActions. Bet and raise sizes are the total street commitment; a call amount is the extra chips.
- Use an opponent's style and reads only if present; with empty reads there is no read yet. Never guess opponent cards.
- Chips only: bare numbers, never a currency sign.`

// The player's own settings (Settings → Live coaching), sent with each question.
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

// What the model sees: freshness and the hand, nothing that identifies the session.
export function coachInput(read) {
  return JSON.stringify({
    active: read?.active === true,
    stale: read?.stale !== false,
    pending: read?.pending === true,
    hand: read?.state?.hand ?? null,
  })
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
 */
export function streamCoach(env, read, prefs = coachPrefs(null), signal = null) {
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
  const stream = client.beta.messages.stream({
    model: COACH_MODEL,
    max_tokens: MAX_TOKENS,
    output_config: { effort: 'low' },
    system: coachSystem(prefs),
    messages: [{ role: 'user', content: coachInput(read) }],
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
    const outcome = { firstTextMs: null, inputTokens: null, outputTokens: null, stop: null }
    try {
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
        await send({ type: 'error', code: 'coach_declined', message: "Pip can't answer that one." })
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
