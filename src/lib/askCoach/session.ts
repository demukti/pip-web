import { type CoachPrefs, coachPrefs, readCoach } from './coach'
import { askCoachConnection } from './connection'
import type { CoachHand } from './hand'
import { currentHand } from './table'

/**
 * Where the current answer stands. `hand` is the deal it was asked on; `shown`
 * is whether its card is open. A hidden answer is kept (and keeps arriving) so
 * the button can bring it back without asking again.
 */
export type AskCoachState =
  | { phase: 'idle' }
  | { phase: 'asking' | 'answering' | 'done'; hand: number; text: string; shown: boolean }
  | { phase: 'failed'; hand: number; text: string; message: string; shown: boolean }

/** What one question sends: the hand as it stands, and the player's settings. */
export interface Question {
  hand: CoachHand | null
  settings: CoachPrefs
}
type Ask = (question: Question, signal: AbortSignal) => Promise<Response>

/** A whole streamed answer; the service gives the model 30 seconds. */
const ANSWER_TIMEOUT_MS = 45_000

const IDLE: AskCoachState = { phase: 'idle' }

/**
 * One coaching answer at a time, shared by the button (a corner of the
 * player's own panel) and the card (over the player's own row), which the
 * table lays out apart.
 *
 * Hiding the card keeps the answer: the button brings it back. Only asking
 * again, from the open card, puts a new question. The answer is dropped, and
 * a model call still running is stopped, when it no longer applies: the player
 * acted on it, the deal moved on, or the table closed.
 */
export class AskCoachSession {
  private state: AskCoachState = IDLE
  private inFlight: AbortController | null = null
  private listeners = new Set<() => void>()

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
   * The button (or its key): bring back the answer kept for the hand being
   * played, or else ask about it. With the card open, it asks again. A failed
   * answer is never brought back: pressing asks again.
   */
  press(hand: number) {
    const { state } = this
    const hidden = state.phase !== 'idle' && state.phase !== 'failed' && !state.shown
    if (hidden && state.hand === hand) this.set({ ...state, shown: true })
    else void this.start(hand)
  }

  /** Ask about the hand being played; replaces any answer already kept. */
  async start(hand: number) {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    let text = ''
    this.set({ phase: 'asking', hand, text, shown: true })
    // Hidden or shown, as the player last left it while the answer arrives.
    const shown = () => this.state.phase === 'idle' || this.state.shown
    try {
      // The hand at the moment of asking: the latest move is in it by construction.
      const question = { hand: this.hand(), settings: this.prefs() }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)])
      const response = await this.ask(question, signal)
      const outcome = await readCoach(response, (chunk) => {
        if (controller.signal.aborted) return
        text += chunk
        this.set({ phase: 'answering', hand, text, shown: shown() })
      })
      if (controller.signal.aborted) return
      this.set(
        outcome.ok
          ? { phase: 'done', hand, text, shown: shown() }
          : { phase: 'failed', hand, text, message: outcome.message, shown: shown() },
      )
    } catch {
      if (controller.signal.aborted) return
      this.set({
        phase: 'failed',
        hand,
        text,
        message: 'Couldn’t reach the coach. Ask again.',
        shown: shown(),
      })
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }

  /** Closes the card and keeps the answer, which goes on arriving if it still is. */
  hide() {
    const { state } = this
    if (state.phase !== 'idle' && state.shown) this.set({ ...state, shown: false })
  }

  /** The answer no longer applies: drop it, and stop a model call still running. */
  retire() {
    this.inFlight?.abort()
    this.inFlight = null
    if (this.state.phase !== 'idle') this.set(IDLE)
  }

  /** The table has moved past `hand`: its answer no longer applies. */
  leave(hand: number) {
    if (this.state.phase !== 'idle' && this.state.hand === hand) this.retire()
  }
}

export const askCoach = new AskCoachSession()
