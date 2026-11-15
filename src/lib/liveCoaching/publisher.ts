import type { HandState } from '@/lib/poker/engine'
import { liveSnapshot, type LiveSnapshot } from './state'

const KEY = 'pip.live-coaching.v1'
interface Connection {
  url: string
  sessionId: string
  token: string
  version: number
  expiresAt: number
}
interface SharingStatus {
  connected: boolean
  message: string
  version: number
  acceptedVersion: number
}

/** Network errors are isolated here: gameplay never waits for publishing. */
export class LivePublisher {
  private connection: Connection | null = null
  private last: { hand: HandState | null; handNo: number; equity: number | null } = {
    hand: null,
    handNo: 0,
    equity: null,
  }
  private queue: LiveSnapshot[] = []
  private listeners = new Set<() => void>()
  private status: SharingStatus = {
    connected: false,
    message: 'Off',
    version: 0,
    acceptedVersion: 0,
  }
  private sending: Promise<void> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private ready = false
  private writerId = ''

  constructor(
    private storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = () =>
      typeof window === 'undefined' ? null : window.sessionStorage,
    private request: typeof fetch = (...args) => fetch(...args),
  ) {}

  getStatus = () => this.status
  getServerStatus = () => OFF
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private update(patch: Partial<SharingStatus>) {
    this.status = { ...this.status, ...patch }
    for (const listener of this.listeners) listener()
  }
  private save() {
    const storage = this.storage()
    if (!storage) throw new Error('Session storage unavailable')
    if (this.connection) storage.setItem(KEY, JSON.stringify(this.connection))
    else storage.removeItem(KEY)
  }
  private async send(path: string, method: string, body?: unknown, connection = this.connection) {
    if (!connection) throw new Error('No publishing session')
    return this.request(`${connection.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        'X-Pip-Session': connection.sessionId,
        'X-Pip-Writer': this.writerId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
  }
  async connect(url: string, ownerKey: string) {
    const endpoint = new URL(url)
    if (
      endpoint.protocol !== 'https:' &&
      !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))
    )
      throw new Error('Use an HTTPS service URL')
    if (endpoint.username || endpoint.password) throw new Error('Invalid service URL')
    this.writerId ||= crypto.randomUUID()
    const response = await this.request(`${endpoint.origin}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerKey}` },
      body: JSON.stringify({ writerId: this.writerId }),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok)
      throw new Error(
        'Could not connect. Check the owner key, service URL and allowed game origin.',
      )
    const session = await response.json()
    this.generation++
    this.queue = []
    this.connection = {
      url: endpoint.origin,
      sessionId: session.sessionId,
      token: session.token,
      version: session.version,
      expiresAt: session.expiresAt,
    }
    this.ready = true
    this.save()
    this.update({
      connected: true,
      version: 0,
      acceptedVersion: 0,
      message: 'Connected; publishing current state',
    })
    this.capture(this.last.hand, this.last.handNo, this.last.equity)
  }
  async restore() {
    const generation = ++this.generation
    try {
      const raw = this.storage()?.getItem(KEY)
      if (!raw) return
      const saved = JSON.parse(raw) as Connection
      if (!saved.url || !saved.token || !saved.sessionId || saved.expiresAt <= Date.now()) {
        this.storage()?.removeItem(KEY)
        return
      }
      this.writerId ||= crypto.randomUUID()
      const response = await this.send('/claim', 'POST', { writerId: this.writerId }, saved)
      if (generation !== this.generation) return
      if (!response.ok) throw new Error('Publishing session expired; reconnect')
      const { version } = await response.json()
      this.queue = []
      this.connection = { ...saved, version: Math.max(saved.version, version) }
      this.ready = true
      this.save()
      this.update({ connected: true, version, acceptedVersion: version, message: 'Connected' })
      this.capture(this.last.hand, this.last.handNo, this.last.equity)
    } catch {
      if (generation === this.generation)
        this.update({ message: 'Could not resume sharing. Reconnect or retry when online.' })
    }
  }
  capture(hand: HandState | null, handNo: number, displayedEquity: number | null = null) {
    this.last = { hand, handNo, equity: displayedEquity }
    try {
      const connection = this.connection
      if (!connection || !this.ready) return
      if (connection.expiresAt <= Date.now()) {
        this.clear('Session expired. Reconnect to continue sharing.')
        return
      }
      connection.version++
      // Persist the sequence BEFORE sending so a reload cannot reuse a version.
      this.save()
      const state = liveSnapshot(hand, {
        sessionId: connection.sessionId,
        version: connection.version,
        capturedAt: new Date().toISOString(),
        handNo,
        heroId: 'hero',
        displayedEquity,
      })
      this.queue.push(state)
      if (this.queue.length > 128) this.queue = [state]
      this.update({ version: connection.version, message: 'Publishing…' })
      this.pump()
    } catch {
      this.clear('Sharing paused: session storage or snapshot unavailable.')
    }
  }
  private pump() {
    if (this.sending || !this.connection || !this.ready) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const generation = this.generation
    this.sending = (async () => {
      while (this.queue.length && generation === this.generation && this.connection) {
        const next = this.queue[0]
        try {
          const response = await this.send('/publish', 'PUT', next)
          if (generation !== this.generation) return
          const result = await response.json()
          if ([401, 403].includes(response.status) || result.code === 'writer_changed') {
            this.clear(
              result.code === 'writer_changed'
                ? 'Another tab took over. Reconnect here to publish from this tab.'
                : 'Session revoked or expired. Reconnect.',
            )
            return
          }
          if (!response.ok && !(response.status === 409 && result.acceptedVersion >= next.version))
            throw new Error('Upload failed')
          this.queue.shift()
          this.update({
            acceptedVersion: result.acceptedVersion,
            message: this.queue.length ? 'Publishing…' : `Live · version ${result.acceptedVersion}`,
          })
        } catch {
          if (generation !== this.generation) return
          // On failure prefer the latest full snapshot (which includes history)
          // over replaying stale intermediate states after a long outage.
          this.queue = this.queue.length ? [this.queue[this.queue.length - 1]] : []
          this.update({ message: 'Upload pending; retrying. ChatGPT may see stale data.' })
          this.retry = setTimeout(() => this.pump(), 2000)
          return
        }
      }
    })().finally(() => {
      this.sending = null
      if (this.queue.length && !this.retry) this.pump()
    })
  }
  async flush() {
    await this.sending
  }
  async ping() {
    if (!this.connection || !this.ready) return
    const generation = this.generation
    try {
      const response = await this.send('/heartbeat', 'POST', { version: this.connection.version })
      if (generation !== this.generation) return
      const result = await response.json()
      if ([401, 403].includes(response.status) || result.code === 'writer_changed')
        this.clear('Session expired or another tab took over. Reconnect.')
      if (!response.ok)
        this.update({ message: 'Connection interrupted; current state may be stale.' })
    } catch {
      if (generation !== this.generation) return
      this.update({ message: 'Offline; ChatGPT may see stale data.' })
    }
  }
  start() {
    void this.restore()
    this.heartbeat = setInterval(() => void this.ping(), 10_000)
    return () => {
      this.generation++
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (this.retry) clearTimeout(this.retry)
      this.heartbeat = null
      this.retry = null
      this.ready = false
    }
  }
  private clear(message: string) {
    this.generation++
    this.ready = false
    this.connection = null
    this.queue = []
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    try {
      this.save()
    } catch {
      /* Storage may be unavailable. */
    }
    this.update({ connected: false, message })
  }
  async disconnect() {
    const generation = this.generation
    try {
      await this.send('/publish', 'DELETE')
    } catch {
      /* Remote data expires even if offline. */
    }
    if (generation === this.generation)
      this.clear('Off. If offline, remote data expires automatically.')
  }
}

const OFF: SharingStatus = { connected: false, message: 'Off', version: 0, acceptedVersion: 0 }
export const livePublisher = new LivePublisher()
