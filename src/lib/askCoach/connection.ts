/**
 * The coach's sign-in: this browser signs in once with the owner key and keeps
 * only the token the service gives back (localStorage `pip.ask-coach.v1`), never
 * the key. The token stays valid 30 days past its last question; rotating the
 * owner key on the service signs every browser out. No React, no store.
 */

const KEY = 'pip.ask-coach.v1'

interface Saved {
  url: string
  token: string
}
export interface AskCoachStatus {
  signedIn: boolean
  /** The service this browser is signed in to, for Settings. */
  url: string | null
  /** Why the last sign-in ended or failed, for Settings; '' when there is nothing to say. */
  message: string
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

const SIGNED_OUT: AskCoachStatus = { signedIn: false, url: null, message: '' }

/** An HTTPS service, or plain HTTP on this machine for development; its origin only. */
function serviceOrigin(url: string) {
  let endpoint: URL
  try {
    endpoint = new URL(url)
  } catch {
    throw new Error('Enter the service URL')
  }
  const local = ['localhost', '127.0.0.1'].includes(endpoint.hostname)
  if (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && local))
    throw new Error('Use an HTTPS service URL')
  if (endpoint.username || endpoint.password) throw new Error('Invalid service URL')
  return endpoint.origin
}

export class AskCoachConnection {
  private status: AskCoachStatus | null = null
  private listeners = new Set<() => void>()

  constructor(
    private storage: () => Storage | null = () =>
      typeof window === 'undefined' ? null : window.localStorage,
    private request: typeof fetch = (...args) => fetch(...args),
  ) {}

  private load(): Saved | null {
    try {
      const saved = JSON.parse(this.storage()?.getItem(KEY) ?? 'null')
      return typeof saved?.url === 'string' && typeof saved?.token === 'string' ? saved : null
    } catch {
      return null
    }
  }
  private update(status: AskCoachStatus) {
    this.status = status
    for (const listener of this.listeners) listener()
  }
  private forget(message: string) {
    try {
      this.storage()?.removeItem(KEY)
    } catch {
      /* Storage unavailable: nothing was saved. */
    }
    this.update({ ...SIGNED_OUT, message })
  }

  get = (): AskCoachStatus => {
    if (!this.status) {
      const saved = this.load()
      this.status = saved ? { signedIn: true, url: saved.url, message: '' } : SIGNED_OUT
    }
    return this.status
  }
  getServer = () => SIGNED_OUT
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    // Another tab signing in or out changes this browser's sign-in too.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== KEY && event.key !== null) return
      this.status = null
      listener()
    }
    if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
    return () => {
      this.listeners.delete(listener)
      if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
    }
  }

  async connect(url: string, ownerKey: string) {
    const origin = serviceOrigin(url)
    const response = await this.request(`${origin}/connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ownerKey}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 403) throw new Error('That owner key isn’t right.')
    if (!response.ok) throw new Error('Couldn’t sign in. Check the service URL and try again.')
    const { token } = await response.json()
    if (typeof token !== 'string') throw new Error('Couldn’t sign in. Try again.')
    this.storage()?.setItem(KEY, JSON.stringify({ url: origin, token } satisfies Saved))
    this.update({ signedIn: true, url: origin, message: '' })
  }

  /** Signs this browser out here and, when reachable, on the service. */
  async disconnect() {
    const saved = this.load()
    this.forget('')
    if (!saved) return
    try {
      await this.request(`${saved.url}/disconnect`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${saved.token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      /* Offline: the token lapses on its own 30 days after its last use. */
    }
  }

  /**
   * Sends one question; resolves to the streaming answer (`readCoach` reads it).
   * A refused token signs this browser out, with a message for Settings.
   */
  async ask(question: unknown, signal: AbortSignal) {
    const saved = this.load()
    if (!saved) throw new Error('Not signed in to the coach')
    const response = await this.request(`${saved.url}/coach`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${saved.token}` },
      body: JSON.stringify(question),
      cache: 'no-store',
      signal,
    })
    if (response.status === 401) this.forget('You were signed out. Sign in again to ask the coach.')
    return response
  }
}

export const askCoachConnection = new AskCoachConnection()
