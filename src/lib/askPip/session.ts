import { type CoachPrefs, coachPrefs, readCoach } from './coach'
import { askPipConnection } from './connection'
import type { CoachHand } from './hand'
import { currentHand } from './table'

/** Where the current answer stands. `hand` is the deal it was asked on. */
export type AskPipState =
  | { phase: 'idle' }
  | { phase: 'asking' | 'answering' | 'done'; hand: number; text: string }
  | { phase: 'failed'; hand: number; text: string; message: string }

/** What one question sends: the hand as it stands, and the player's settings. */
export interface Question {
  hand: CoachHand | null
  settings: CoachPrefs
}
type Ask = (question: Question, signal: AbortSignal) => Promise<Response>

/** A whole streamed answer; the service gives the model 30 seconds. */
const ANSWER_TIMEOUT_MS = 45_000

const IDLE: AskPipState = { phase: 'idle' }

/**
 * One Ask Pip answer at a time, shared by the button (the table's top-left
 * corner) and the card (over the player's own hand), which sit apart on the
 * table. Asking again, closing, or the deal moving on stops an answer still
 * being written, which also stops the model call on the service.
 */
export class AskPipSession {
  private state: AskPipState = IDLE
  private inFlight: AbortController | null = null
  private listeners = new Set<() => void>()

  constructor(
    private ask: Ask = (question, signal) => askPipConnection.ask(question, signal),
    private prefs: () => CoachPrefs = coachPrefs.get,
    private hand: () => CoachHand | null = currentHand,
  ) {}

  get = () => this.state
  getServer = () => IDLE
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private set(state: AskPipState) {
    this.state = state
    for (const listener of this.listeners) listener()
  }

  /** Ask about the hand being played; replaces any answer already showing. */
  async start(hand: number) {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    let text = ''
    this.set({ phase: 'asking', hand, text })
    try {
      // The hand at the moment of asking: the latest move is in it by construction.
      const question = { hand: this.hand(), settings: this.prefs() }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(ANSWER_TIMEOUT_MS)])
      const response = await this.ask(question, signal)
      const outcome = await readCoach(response, (chunk) => {
        if (controller.signal.aborted) return
        text += chunk
        this.set({ phase: 'answering', hand, text })
      })
      if (controller.signal.aborted) return
      this.set(
        outcome.ok
          ? { phase: 'done', hand, text }
          : { phase: 'failed', hand, text, message: outcome.message },
      )
    } catch {
      if (controller.signal.aborted) return
      this.set({ phase: 'failed', hand, text, message: 'Couldn’t reach Pip. Ask again.' })
    } finally {
      if (this.inFlight === controller) this.inFlight = null
    }
  }

  close() {
    this.inFlight?.abort()
    this.inFlight = null
    if (this.state.phase !== 'idle') this.set(IDLE)
  }

  /** The table has moved past `hand`: its answer no longer applies. */
  leave(hand: number) {
    if (this.state.phase !== 'idle' && this.state.hand === hand) this.close()
  }
}

export const askPip = new AskPipSession()
