/**
 * Ask Pip: an on-demand coaching answer for the hand in front of you, streamed
 * from the live-state service (`live-state/coach.mjs`). Nothing is asked unless
 * the player presses the button; nothing here imports a store or React.
 */

export type CoachStyle = 'short' | 'standard' | 'teach'
export interface CoachPrefs {
  style: CoachStyle
  /** The player's own words on how to coach them. Capped by the service too. */
  notes: string
}

export const COACH_STYLES: { value: CoachStyle; label: string; sub: string }[] = [
  { value: 'short', label: 'Short', sub: 'The call and one line' },
  { value: 'standard', label: 'Standard', sub: 'The call and why' },
  { value: 'teach', label: 'Teach me', sub: 'The idea behind it' },
]
export const NOTES_MAX = 500

const KEY = 'pip.live-coach.v1'
const DEFAULT_PREFS: CoachPrefs = { style: 'standard', notes: '' }
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem'>

const isStyle = (value: unknown): value is CoachStyle =>
  COACH_STYLES.some((style) => style.value === value)

/** The coaching settings, kept in this browser and readable from React. */
export class CoachPrefsStore {
  private value: CoachPrefs | null = null
  private listeners = new Set<() => void>()

  constructor(
    private storage: () => Storage | null = () =>
      typeof window === 'undefined' ? null : window.localStorage,
  ) {}

  get = (): CoachPrefs => {
    if (this.value) return this.value
    let stored: Partial<CoachPrefs> = {}
    try {
      stored = JSON.parse(this.storage()?.getItem(KEY) ?? '{}') ?? {}
    } catch {
      /* Unreadable or unavailable storage: the defaults stand. */
    }
    this.value = {
      style: isStyle(stored.style) ? stored.style : DEFAULT_PREFS.style,
      notes: typeof stored.notes === 'string' ? stored.notes.slice(0, NOTES_MAX) : '',
    }
    return this.value
  }
  getServer = () => DEFAULT_PREFS
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  set(patch: Partial<CoachPrefs>) {
    const next = { ...this.get(), ...patch }
    next.notes = next.notes.slice(0, NOTES_MAX)
    this.value = next
    try {
      this.storage()?.setItem(KEY, JSON.stringify(next))
    } catch {
      /* Kept for this visit only. */
    }
    for (const listener of this.listeners) listener()
  }
}
export const coachPrefs = new CoachPrefsStore()

export type CoachOutcome = { ok: true } | { ok: false; message: string }

/** What the player is told when the service turns the question away. */
function refusal(status: number, code: unknown): string {
  if (code === 'coach_limit') return 'That’s a lot of questions for one minute. Try again shortly.'
  if (code === 'coach_off') return 'Ask Pip isn’t set up on your service yet.'
  if (code === 'writer_changed') return 'Another tab is sharing now. Ask from that one.'
  if (status === 401 || status === 403) return 'Sharing has ended. Reconnect in Settings.'
  return 'Pip couldn’t answer. Ask again.'
}

/**
 * Reads a coaching response: `text` lines are handed to `onText` as they
 * arrive; the stream ends with `done` or an `error` carrying the player-facing
 * message. A response that ends without either was cut off.
 */
export async function readCoach(
  response: Response,
  onText: (text: string) => void,
): Promise<CoachOutcome> {
  if (!response.ok || !response.body) {
    let code: unknown
    try {
      code = (await response.json())?.code
    } catch {
      /* Not JSON: the status decides. */
    }
    return { ok: false, message: refusal(response.status, code) }
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffered = ''
  let outcome: CoachOutcome | null = null
  // Read to the very end even after the last line: a body left half-read keeps
  // the request open on the service, which then never finishes (or logs) it.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (outcome) continue
    buffered += value
    let end = buffered.indexOf('\n')
    while (end >= 0 && !outcome) {
      const line = buffered.slice(0, end).trim()
      buffered = buffered.slice(end + 1)
      end = buffered.indexOf('\n')
      if (!line) continue
      let event: { type?: unknown; text?: unknown; message?: unknown }
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'text' && typeof event.text === 'string') onText(event.text)
      else if (event.type === 'done') outcome = { ok: true }
      else if (event.type === 'error')
        outcome = {
          ok: false,
          message: typeof event.message === 'string' ? event.message : refusal(200, null),
        }
    }
  }
  return outcome ?? { ok: false, message: 'The answer was cut off. Ask again.' }
}
