import { type CoachPrefs, coachPrefs, readCoach } from './coach'
import { livePublisher } from './publisher'

/** Where the current answer stands. `hand` is the deal it was asked on. */
export type AskPipState =
  | { phase: 'idle' }
  | { phase: 'asking' | 'answering' | 'done'; hand: number; text: string }
  | { phase: 'failed'; hand: number; text: string; message: string }

type Ask = (prefs: CoachPrefs, signal: AbortSignal) => Promise<Response>

const IDLE: AskPipState = { phase: 'idle' }

/**
 * One Ask Pip answer at a time, shared by the button (beside the sharing
 * badge) and the card (over the player's own hand), which sit apart on the
 * table. Asking again, closing, or the deal moving on stops an answer still
 * being written, which also stops the model call on the service.
 */
export class AskPipSession {
  private state: AskPipState = IDLE
  private inFlight: AbortController | null = null
  private listeners = new Set<() => void>()

  constructor(
    private ask: Ask = (prefs, signal) => livePublisher.coach(prefs, signal),
    private prefs: () => CoachPrefs = coachPrefs.get,
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
      const response = await this.ask(this.prefs(), controller.signal)
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
