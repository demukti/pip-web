import { type CoachPrefs, coachPrefs, FOLLOW_UP_MAX, FOLLOW_UPS_MAX, readCoach } from './coach'
import { askCoachConnection } from './connection'
import type { CoachHand } from './hand'
import { currentHand } from './table'

/** One question and its answer. `question` is null for the button's own: what to do. */
export interface Exchange {
  question: string | null
  answer: string
}

/**
 * The conversation on one deal. `hand` is the deal; `earlier` the questions
 * already answered, oldest first; `question` and `text` the one being answered
 * now. `shown` is whether the card is open, `chat` whether the conversation
 * is (over the card). A hidden answer is kept (and keeps arriving) so the
 * button can bring it back without asking again.
 */
interface Thread {
  hand: number
  earlier: Exchange[]
  question: string | null
  text: string
  shown: boolean
  chat: boolean
}
export type AskCoachState =
  | { phase: 'idle' }
  | ({ phase: 'asking' | 'answering' | 'done' } & Thread)
  | ({ phase: 'failed'; message: string } & Thread)

/** A follow-up as the service takes it: the answer before it, then the question. */
export interface ThreadTurn {
  answer: string
  question: string
  /** The hand as it then stood, when it had changed since the coach last saw it. */
  hand?: CoachHand | null
}
/** What one question sends: the hand, the player's settings, and any follow-ups. */
export interface Question {
  hand: CoachHand | null
  settings: CoachPrefs
  thread?: ThreadTurn[]
}
type Ask = (question: Question, signal: AbortSignal) => Promise<Response>

/** A question as it was put: with the hand when the coach had not seen it yet. */
interface Put {
  question: string | null
  hand?: CoachHand | null
}

/** A whole streamed answer; the service gives the model 30 seconds. */
const ANSWER_TIMEOUT_MS = 45_000

const IDLE: AskCoachState = { phase: 'idle' }

/** Follow-ups asked so far in this conversation, counting the one being answered. */
export const followUps = (state: Thread) =>
  state.earlier.filter((exchange) => exchange.question !== null).length +
  (state.question === null ? 0 : 1)

/**
 * Whether the player can put a follow-up now: after a whole answer, while
 * follow-ups remain, or in place of a follow-up that failed. A first answer
 * that failed is asked again, not replied to.
 */
export function canReply(state: AskCoachState) {
  if (state.phase === 'done') return followUps(state) < FOLLOW_UPS_MAX
  return state.phase === 'failed' && state.question !== null
}

/**
 * One conversation at a time, shared by the button (a corner of the player's
 * own panel), the card (over the player's own row) and the conversation sheet,
 * which the table lays out apart.
 *
 * Hiding the card keeps the answer: the button brings it back. Asking again,
 * from the open card, starts over; a follow-up continues. The conversation is
 * dropped, and a model call still running is stopped, when it no longer
 * applies: the player acted on it, the deal moved on, or the table closed.
 */
export class AskCoachSession {
  private state: AskCoachState = IDLE
  private inFlight: AbortController | null = null
  private listeners = new Set<() => void>()
  /** The questions answered so far, as they were put, beside `state.earlier`. */
  private put: Put[] = []
  /** The question being answered now, as it was put. */
  private current: Put = { question: null }

  constructor(
    private ask: Ask = (question, signal) => askCoachConnection.ask(question, signal),
    private prefs: () => CoachPrefs = coachPrefs.get,
    private hand: () => CoachHand | null = currentHand,
  ) {}

  get = () => this.state
  getServer = () => IDLE
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(state: AskCoachState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /**
   * The button (or its key): bring back the conversation kept for the hand
   * being played, or else ask about it. With the card open it asks again, or,
   * once there are follow-ups to lose, opens the conversation instead. A
   * failed first answer is never brought back: pressing asks again.
   */
  press(hand: number) {
    const { state } = this
    if (state.phase === 'idle' || state.hand !== hand) return void this.start(hand)
    const talked = followUps(state) > 0
    if (!state.shown && (state.phase !== 'failed' || talked)) this.set({ ...state, shown: true })
    else if (talked) this.set({ ...state, shown: true, chat: true })
    else void this.start(hand)
  }

  /** Ask about the hand being played; replaces any conversation already kept. */
  start(hand: number) {
    this.put = []
    const chat = this.state.phase !== 'idle' && this.state.hand === hand && this.state.chat
    return this.run(hand, [], { question: null, hand: this.hand() }, chat)
  }

  /**
   * A follow-up in the player's own words, about the deal the conversation is
   * on. It goes in place of a follow-up that failed. Ignored when `canReply`
   * says no, or when there are no words.
   */
  reply(words: string) {
    const { state } = this
    const question = words.trim().slice(0, FOLLOW_UP_MAX)
    if (!question || !canReply(state) || state.phase === 'idle') return
    if (state.phase === 'done') this.put.push(this.current)
    const earlier =
      state.phase === 'done'
        ? [...state.earlier, { question: state.question, answer: state.text }]
        : state.earlier
    // The hand goes again only when it changed since the coach last saw it:
    // asked while an opponent was to act, the table has moved since.
    const now = this.hand()
    const seen = this.put.findLast((put) => put.hand !== undefined)?.hand
    const fresh = JSON.stringify(now) !== JSON.stringify(seen ?? null)
    return this.run(state.hand, earlier, fresh ? { question, hand: now } : { question }, true)
  }

  /** Puts the current question again: the first one starts over. */
  again() {
    const { state } = this
    if (state.phase === 'idle') return
    if (state.question === null) return this.start(state.hand)
    return this.run(state.hand, state.earlier, this.current, state.chat)
  }

  private question(): Question {
    const [first, ...rest] = [...this.put, this.current]
    const question: Question = { hand: first.hand ?? null, settings: this.prefs() }
    const answers = this.state.phase === 'idle' ? [] : this.state.earlier
    if (rest.length)
      question.thread = rest.map((put, i) => ({
        answer: answers[i].answer,
        question: put.question ?? '',
        ...(put.hand !== undefined && { hand: put.hand }),
      }))
    return question
  }

  private async run(hand: number, earlier: Exchange[], put: Put, chat: boolean) {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    this.current = put
    const { question } = put
    let text = ''
    this.set({ phase: 'asking', hand, earlier, question, text, shown: true, chat })
    // Open or closed, as the player last left it while the answer arrives.
    const view = () =>
      this.state.phase === 'idle'
        ? { shown: true, chat }
        : { shown: this.state.shown, chat: this.state.chat }
    try {
      // The hand at the moment of asking: the latest move is in it by construction.
      const sent = this.question()
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)])
      const response = await this.ask(sent, signal)
      const outcome = await readCoach(response, (chunk) => {
        if (controller.signal.aborted) return
        text += chunk
        this.set({ phase: 'answering', hand, earlier, question, text, ...view() })
      })
      if (controller.signal.aborted) return
      this.set(
        outcome.ok
          ? { phase: 'done', hand, earlier, question, text, ...view() }
          : { phase: 'failed', hand, earlier, question, text, message: outcome.message, ...view() },
      )
    } catch {
      if (controller.signal.aborted) return
      this.set({
        phase: 'failed',
        hand,
        earlier,
        question,
        text,
        message: 'Couldn’t reach the coach. Ask again.',
        ...view(),
      })
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }

  /** Opens the conversation, over the card. */
  openChat() {
    const { state } = this
    if (state.phase !== 'idle' && !state.chat) this.set({ ...state, shown: true, chat: true })
  }

  /** Back to the table: the card stays open on the latest answer. */
  closeChat() {
    const { state } = this
    if (state.phase !== 'idle' && state.chat) this.set({ ...state, chat: false })
  }

  /** Closes the card and keeps the conversation, which goes on arriving if it still is. */
  hide() {
    const { state } = this
    if (state.phase !== 'idle' && (state.shown || state.chat))
      this.set({ ...state, shown: false, chat: false })
  }

  /** The conversation no longer applies: drop it, and stop a model call still running. */
  retire() {
    this.inFlight?.abort()
    this.inFlight = null
    this.put = []
    if (this.state.phase !== 'idle') this.set(IDLE)
  }

  /** The table has moved past `hand`: its conversation no longer applies. */
  leave(hand: number) {
    if (this.state.phase !== 'idle' && this.state.hand === hand) this.retire()
  }
}

export const askCoach = new AskCoachSession()
