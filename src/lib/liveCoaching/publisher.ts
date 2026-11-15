import type { HandState } from '@/lib/poker/engine'
import { heroTurnEquity, liveSnapshot, type LiveSnapshot } from './state'

const KEY = 'pip.live-coaching.v1'
const HERO_ID = 'hero'
/** A holder tab that has not touched the shared record for this long is gone. */
const HOLD_MS = 90_000
const HEARTBEAT_MS = 10_000
const RETRY_MS = 2000

interface Connection {
  url: string
  sessionId: string
  token: string
  version: number
  expiresAt: number
}
/** What localStorage holds: the connection plus which tab last held it. Never the owner key. */
interface StoredConnection extends Connection {
  writerId?: string
  /** When the holder last wrote; 0 once it released the record (tab closed or reloaded). */
  heldAt?: number
}
interface SharingStatus {
  connected: boolean
  message: string
  version: number
  acceptedVersion: number
  /** A saved session exists but could not be resumed yet; retrying on its own. */
  resuming: boolean
  /** Another tab of this browser holds the saved session and is publishing. */
  otherTab: boolean
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Page lifecycle signals, injectable so tests can fire them in Node. */
export interface LiveEvents {
  /** Subscribe; returns an unsubscribe. `visible` fires when the tab becomes visible. */
  on(event: 'online' | 'visible' | 'pagehide', listener: () => void): () => void
}

const browserEvents: LiveEvents = {
  on(event, listener) {
    if (typeof window === 'undefined') return () => {}
    if (event === 'visible') {
      const onChange = () => {
        if (document.visibilityState === 'visible') listener()
      }
      document.addEventListener('visibilitychange', onChange)
      return () => document.removeEventListener('visibilitychange', onChange)
    }
    window.addEventListener(event, listener)
    return () => window.removeEventListener(event, listener)
  },
}

/** Another tab claimed the shared session: stop here without touching storage. */
class WriterLost extends Error {}

/** Network errors are isolated here: gameplay never waits for publishing. */
export class LivePublisher {
  private connection: Connection | null = null
  private last: { hand: HandState | null; handNo: number; equity: number | null } = {
    hand: null,
    handNo: 0,
    equity: null,
  }
  /** Latest hero-turn estimate in the current hand (C3). Memory only. */
  private lastEquity: { handNo: number; equity: number; street: string } | null = null
  /** Newest snapshot not yet sent. Each capture overwrites it: every snapshot is the full state. */
  private pending: LiveSnapshot | null = null
  private listeners = new Set<() => void>()
  private status: SharingStatus = { ...OFF }
  private sending: Promise<void> | null = null
  private restoring: Promise<void> | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private generation = 0
  private ready = false
  private writerId = ''

  constructor(
    private storage: () => Storage | null = () =>
      typeof window === 'undefined' ? null : window.localStorage,
    private request: typeof fetch = (...args) => fetch(...args),
    private events: LiveEvents = browserEvents,
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
  private load(): StoredConnection | null {
    try {
      const raw = this.storage()?.getItem(KEY)
      return raw ? (JSON.parse(raw) as StoredConnection) : null
    } catch {
      return null
    }
  }
  /**
   * Persist the connection, stamped with this tab as holder. Storage is shared
   * between tabs, so unless this tab has just claimed the session, refuse to
   * overwrite a record that now belongs to another session or writer.
   */
  private save(claimed = false) {
    const storage = this.storage()
    if (!storage) throw new Error('Storage unavailable')
    if (!this.connection) return
    if (!claimed) {
      const stored = this.load()
      if (
        stored &&
        (stored.sessionId !== this.connection.sessionId ||
          (stored.writerId && stored.writerId !== this.writerId))
      )
        throw new WriterLost()
    }
    const record: StoredConnection = {
      ...this.connection,
      writerId: this.writerId,
      heldAt: Date.now(),
    }
    storage.setItem(KEY, JSON.stringify(record))
  }
  /** Delete the saved session, but only if it is still this session's. */
  private forget(sessionId: string | undefined) {
    try {
      if (sessionId && this.load()?.sessionId === sessionId) this.storage()?.removeItem(KEY)
    } catch {
      /* Storage may be unavailable. */
    }
  }
  /** True while another tab holds the saved session and has written recently. */
  private otherTabHolds() {
    const stored = this.load()
    return Boolean(
      stored?.writerId &&
        stored.writerId !== this.writerId &&
        Date.now() - (stored.heldAt ?? 0) < HOLD_MS,
    )
  }
  private async send(
    path: string,
    method: string,
    body?: unknown,
    connection: Connection | null = this.connection,
    writerId = this.writerId,
  ) {
    if (!connection) throw new Error('No publishing session')
    return this.request(`${connection.url}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${connection.token}`,
        'X-Pip-Session': connection.sessionId,
        'X-Pip-Writer': writerId,
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
    this.pending = null
    this.connection = {
      url: endpoint.origin,
      sessionId: session.sessionId,
      token: session.token,
      version: session.version,
      expiresAt: session.expiresAt,
    }
    this.ready = true
    this.save(true)
    this.update({
      connected: true,
      resuming: false,
      otherTab: false,
      version: 0,
      acceptedVersion: 0,
      message: 'Connected; publishing current state',
    })
    this.capture(this.last.hand, this.last.handNo, this.last.equity)
  }
  /** Claim the saved session for this tab. The latest call wins; earlier ones are ignored. */
  restore() {
    const attempt = this.claim()
    this.restoring = attempt
    void attempt.finally(() => {
      if (this.restoring === attempt) this.restoring = null
    })
    return attempt
  }
  private async claim() {
    const generation = ++this.generation
    try {
      const saved = this.load()
      if (!saved) {
        if (!this.status.connected)
          this.update({ resuming: false, otherTab: false, message: 'Off' })
        return
      }
      if (!saved.url || !saved.token || !saved.sessionId || saved.expiresAt <= Date.now()) {
        this.forget(saved.sessionId)
        this.update({
          resuming: false,
          otherTab: false,
          message: 'Sharing session expired. Reconnect to continue sharing.',
        })
        return
      }
      this.writerId ||= crypto.randomUUID()
      let response: Response
      try {
        response = await this.send('/claim', 'POST', { writerId: this.writerId }, saved)
      } catch {
        // Offline or timed out: the saved session may well be fine. Keep it and retry.
        if (generation === this.generation) this.resuming()
        return
      }
      if (generation !== this.generation) return
      if ([401, 403].includes(response.status)) {
        this.forget(saved.sessionId)
        this.update({
          connected: false,
          resuming: false,
          otherTab: false,
          message: 'Sharing session expired or revoked. Reconnect with the owner key.',
        })
        return
      }
      if (!response.ok) {
        this.resuming()
        return
      }
      const { version } = await response.json()
      if (generation !== this.generation) return
      this.pending = null
      this.connection = {
        url: saved.url,
        sessionId: saved.sessionId,
        token: saved.token,
        expiresAt: saved.expiresAt,
        version: Math.max(saved.version, version),
      }
      this.ready = true
      this.save(true)
      this.update({
        connected: true,
        resuming: false,
        otherTab: false,
        version,
        acceptedVersion: version,
        message: 'Connected',
      })
      this.capture(this.last.hand, this.last.handNo, this.last.equity)
    } catch {
      if (generation === this.generation) this.resuming()
    }
  }
  private resuming() {
    this.update({ connected: false, resuming: true, otherTab: false, message: 'Reconnecting…' })
  }
  capture(hand: HandState | null, handNo: number, displayedEquity: number | null = null) {
    this.last = { hand, handNo, equity: displayedEquity }
    this.remember(hand, handNo, displayedEquity)
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
      this.pending = liveSnapshot(hand, {
        sessionId: connection.sessionId,
        version: connection.version,
        capturedAt: new Date().toISOString(),
        handNo,
        heroId: HERO_ID,
        displayedEquity,
        lastEquity: this.lastEquity,
      })
      this.update({ version: connection.version, message: 'Publishing…' })
      this.pump()
    } catch (error) {
      if (error instanceof WriterLost) this.release()
      else this.clear('Sharing paused: storage or snapshot unavailable.')
    }
  }
  /** Keep the newest valid hero-turn estimate of this hand; forget it on a new hand. */
  private remember(hand: HandState | null, handNo: number, estimate: number | null) {
    if (!hand || this.lastEquity?.handNo !== handNo) this.lastEquity = null
    if (!hand) return
    const equity = heroTurnEquity(hand, HERO_ID, estimate)
    if (equity !== null) this.lastEquity = { handNo, equity, street: hand.street }
  }
  /** One upload in flight; at most one newer snapshot waits behind it. */
  private pump() {
    if (this.sending || !this.connection || !this.ready) return
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const generation = this.generation
    this.sending = (async () => {
      while (this.pending && generation === this.generation && this.connection) {
        const next = this.pending
        this.pending = null
        try {
          const response = await this.send('/publish', 'PUT', next)
          if (generation !== this.generation) return
          const result = await response.json()
          if (result.code === 'writer_changed') {
            this.release()
            return
          }
          if ([401, 403].includes(response.status)) {
            this.clear('Session revoked or expired. Reconnect.')
            return
          }
          if (!response.ok && !(response.status === 409 && result.acceptedVersion >= next.version))
            throw new Error('Upload failed')
          this.update({
            acceptedVersion: result.acceptedVersion,
            message: this.pending ? 'Publishing…' : `Live · version ${result.acceptedVersion}`,
          })
        } catch {
          if (generation !== this.generation) return
          // Retry the newest full snapshot (it includes the whole history);
          // a capture made during the failed upload has already replaced it.
          this.pending ??= next
          this.update({ message: 'Upload pending; retrying. ChatGPT may see stale data.' })
          this.retry = setTimeout(() => this.pump(), RETRY_MS)
          return
        }
      }
    })().finally(() => {
      this.sending = null
      if (this.pending && !this.retry) this.pump()
    })
  }
  /** Resolves once no claim or upload is in flight (a scheduled retry may remain). */
  async flush() {
    while (this.restoring || this.sending) {
      await this.restoring
      await this.sending
    }
  }
  async ping() {
    if (!this.connection || !this.ready) return
    const generation = this.generation
    try {
      const response = await this.send('/heartbeat', 'POST', { version: this.connection.version })
      if (generation !== this.generation) return
      const result = await response.json()
      if (result.code === 'writer_changed') {
        this.release()
        return
      }
      if ([401, 403].includes(response.status)) {
        this.clear('Session expired or revoked. Reconnect.')
        return
      }
      if (!response.ok) {
        this.update({ message: 'Connection interrupted; current state may be stale.' })
        return
      }
      try {
        this.save() // Mark this tab as the live holder for other tabs.
      } catch (error) {
        if (error instanceof WriterLost) return this.release()
      }
      if (!this.pending && !this.sending && !this.retry)
        this.update({ message: `Live · version ${result.acceptedVersion}` })
    } catch {
      if (generation !== this.generation) return
      this.update({ message: 'Offline; ChatGPT may see stale data.' })
    }
  }
  /**
   * The heartbeat: keep a live connection fresh, keep retrying a saved session
   * that could not be resumed, and pick up a session another tab let go of.
   */
  tick() {
    if (this.connection && this.ready) return this.ping()
    if (this.restoring) return
    if (this.status.resuming) return this.restore()
    if (this.status.otherTab && !this.otherTabHolds()) {
      if (this.load()) return this.restore()
      this.update({ otherTab: false, message: 'Off' })
    }
  }
  /** Back online or visible again: hidden tabs throttle timers, so act now. */
  private wake = () => {
    if (this.connection && this.ready && this.pending) this.pump()
    void this.tick()
  }
  /** The tab is going away: let another tab take the saved session at once. */
  private letGo = () => {
    if (!this.connection || !this.ready) return
    try {
      const stored = this.load()
      if (stored?.sessionId === this.connection.sessionId && stored.writerId === this.writerId)
        this.storage()?.setItem(KEY, JSON.stringify({ ...stored, heldAt: 0 }))
    } catch {
      /* Storage may be unavailable. */
    }
  }
  start() {
    if (this.otherTabHolds())
      this.update({ otherTab: true, message: 'Sharing from another Pip tab.' })
    else void this.restore()
    this.heartbeat = setInterval(() => void this.tick(), HEARTBEAT_MS)
    const unsubscribe = [
      this.events.on('online', this.wake),
      this.events.on('visible', this.wake),
      this.events.on('pagehide', this.letGo),
    ]
    return () => {
      this.generation++
      if (this.heartbeat) clearInterval(this.heartbeat)
      if (this.retry) clearTimeout(this.retry)
      for (const off of unsubscribe) off()
      this.heartbeat = null
      this.retry = null
      this.ready = false
    }
  }
  /** Stop publishing from this tab; keep nothing in memory. */
  private drop() {
    this.generation++
    this.ready = false
    const sessionId = this.connection?.sessionId
    this.connection = null
    this.pending = null
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    return sessionId
  }
  /** Another tab took over: the saved session is now its, so leave storage alone. */
  private release() {
    this.drop()
    this.update({
      connected: false,
      resuming: false,
      otherTab: true,
      message: 'Sharing moved to another Pip tab.',
    })
  }
  private clear(message: string) {
    this.forget(this.drop())
    this.update({ connected: false, resuming: false, otherTab: false, message })
  }
  /** Stop sharing: revoke remotely if reachable and forget the saved session. */
  async disconnect() {
    // Works from any state: connected, reconnecting, or while another tab shares.
    const saved = this.connection ? null : this.load()
    const connection = this.connection ?? saved
    const writerId = saved?.writerId ?? this.writerId
    this.forget(this.drop())
    this.update({ resuming: false, otherTab: false, message: 'Stopping…' })
    const generation = this.generation
    try {
      await this.send('/publish', 'DELETE', undefined, connection, writerId)
    } catch {
      /* Remote data expires even if offline. */
    }
    this.forget(saved?.sessionId)
    if (generation === this.generation)
      this.clear('Off. If offline, remote data expires automatically.')
  }
}

const OFF: SharingStatus = {
  connected: false,
  message: 'Off',
  version: 0,
  acceptedVersion: 0,
  resuming: false,
  otherTab: false,
}
export const livePublisher = new LivePublisher()
