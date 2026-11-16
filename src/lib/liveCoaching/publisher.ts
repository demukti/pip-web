import { cardToString } from '@/lib/poker/cards'
import type { HandState } from '@/lib/poker/engine'
import { heroTurnEquity, liveSnapshot, type LiveSnapshot, type LiveTableContext } from './state'

const KEY = 'pip.live-coaching.v1'
const HERO_ID = 'hero'
/** A holder tab that has not touched the shared record for this long is gone. */
const HOLD_MS = 90_000
const HEARTBEAT_MS = 10_000
const RETRY_MS = 2000
/** An upload's slid expiry is saved at once only when it moved at least this far. */
const EXPIRY_SAVE_MS = 60_000

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
  /**
   * The last heartbeat or upload got through. Cleared by a failed one (the
   * service then soon reports the state stale), restored by the next success.
   */
  reachable: boolean
  /**
   * Sharing stopped without the player asking: the session expired, was
   * revoked, or storage failed. Reset by connecting and by Stop sharing.
   */
  ended: boolean
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

/** How long Ask Pip waits for an upload in flight, so the answer sees the latest move. */
const COACH_WAIT_MS = 3000
/** A whole streamed answer; the service itself gives the model 30 seconds. */
const COACH_TIMEOUT_MS = 45_000

const headersFor = (connection: Connection, writerId: string) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${connection.token}`,
  'X-Pip-Session': connection.sessionId,
  'X-Pip-Writer': writerId,
})

/** Another tab claimed the shared session: stop here without touching storage. */
class WriterLost extends Error {}

/** The service's sliding expiry, when a response carries one (older services do not). */
function expiryOf(result: unknown): number | null {
  const value = (result as { expiresAt?: unknown } | null)?.expiresAt
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Which deal a remembered estimate belongs to. The hand number alone repeats
 * when a bust re-seats the player at a fresh table, so the hero's cards and the
 * board so far go with it. Both only grow within one deal (a Mystery Card joins
 * the hole at the river), so a later state of the same deal extends them.
 */
interface DealMark {
  handNo: number
  hole: string[]
  board: string[]
}
function markOf(hand: HandState, handNo: number): DealMark {
  const hero = hand.players.find((player) => player.id === HERO_ID)
  return {
    handNo,
    hole: (hero?.hole ?? []).map(cardToString),
    board: hand.community.map(cardToString),
  }
}
const startsWith = (cards: string[], prefix: string[]) =>
  prefix.length <= cards.length && prefix.every((card, i) => cards[i] === card)
const sameDeal = (earlier: DealMark, now: DealMark) =>
  earlier.handNo === now.handNo &&
  startsWith(now.hole, earlier.hole) &&
  startsWith(now.board, earlier.board)

/** Network errors are isolated here: gameplay never waits for publishing. */
export class LivePublisher {
  private connection: Connection | null = null
  private last: { hand: HandState | null; handNo: number; equity: number | null } = {
    hand: null,
    handNo: 0,
    equity: null,
  }
  /** Latest hero-turn estimate in the current deal (C3). Memory only. */
  private lastEquity: { mark: DealMark; equity: number; street: string } | null = null
  /** The table around the hand (venue, run status, reads), read at capture time. */
  private tableContext: (() => LiveTableContext | null) | null = null
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
  /** The expiry last written to storage, so a small slide can skip a write. */
  private savedExpiresAt = 0

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
  /**
   * Supply the table context each snapshot carries (`tableContext.ts`). Kept
   * injectable so this module never imports a store and runs in Node without
   * one. Returns a function that removes it.
   */
  setTableContext(provider: (() => LiveTableContext | null) | null) {
    this.tableContext = provider
    return () => {
      if (this.tableContext === provider) this.tableContext = null
    }
  }
  /**
   * Publish the last captured hand again because what is around it changed
   * (the run ended, the hand went to the handover). Only while `hand` is still
   * that hand: a newer deal captures itself.
   */
  refresh(hand: HandState | null) {
    if (!hand || hand !== this.last.hand) return
    this.capture(this.last.hand, this.last.handNo, this.last.equity)
  }
  private readTable() {
    try {
      return this.tableContext?.() ?? null
    } catch {
      // A fault in the context must never stop the hand itself being shared.
      return null
    }
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
    this.savedExpiresAt = record.expiresAt
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
      headers: headersFor(connection, writerId),
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })
  }
  /**
   * Ask Pip: once the newest capture has been accepted (or after a short wait),
   * ask the service for a coaching answer on the stored snapshot. Resolves to the
   * streaming response; `coach.ts` reads it. Only the tab that publishes can ask.
   */
  async coach(prefs: unknown, signal: AbortSignal) {
    if (!this.connection || !this.ready) throw new Error('Not sharing from this tab')
    this.pump()
    await Promise.race([this.flush(), new Promise((resolve) => setTimeout(resolve, COACH_WAIT_MS))])
    const connection = this.connection
    if (!connection) throw new Error('Not sharing from this tab')
    return this.request(`${connection.url}/coach`, {
      method: 'POST',
      headers: headersFor(connection, this.writerId),
      body: JSON.stringify(prefs),
      cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(COACH_TIMEOUT_MS)]),
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
      reachable: true,
      ended: false,
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
          ended: true,
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
          ended: true,
          message: 'Sharing session expired or revoked. Reconnect with the owner key.',
        })
        return
      }
      if (!response.ok) {
        this.resuming()
        return
      }
      const result = await response.json()
      if (generation !== this.generation) return
      const { version } = result
      this.pending = null
      this.connection = {
        url: saved.url,
        sessionId: saved.sessionId,
        token: saved.token,
        // A sliding session: the claim itself counts as activity.
        expiresAt: expiryOf(result) ?? saved.expiresAt,
        version: Math.max(saved.version, version),
      }
      this.ready = true
      this.save(true)
      this.update({
        connected: true,
        resuming: false,
        otherTab: false,
        reachable: true,
        ended: false,
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
        this.clear('Session expired. Reconnect to continue sharing.', true)
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
        table: hand ? this.readTable() : null,
      })
      this.update({ version: connection.version, message: 'Publishing…' })
      this.pump()
    } catch (error) {
      if (error instanceof WriterLost) this.release()
      else this.clear('Sharing paused: storage or snapshot unavailable.', true)
    }
  }
  /** Keep the newest valid hero-turn estimate of this deal; forget it on a new one. */
  private remember(hand: HandState | null, handNo: number, estimate: number | null) {
    if (!hand) {
      this.lastEquity = null
      return
    }
    const mark = markOf(hand, handNo)
    if (this.lastEquity && !sameDeal(this.lastEquity.mark, mark)) this.lastEquity = null
    const equity = heroTurnEquity(hand, HERO_ID, estimate)
    if (equity !== null) this.lastEquity = { mark, equity, street: hand.street }
  }
  /**
   * Take a later expiry from a service response and save it with the session.
   * Throws `WriterLost` like `save`; other storage faults are left for the
   * next heartbeat to retry.
   */
  private extend(result: unknown) {
    const expiresAt = expiryOf(result)
    if (expiresAt === null || !this.connection) return
    this.connection.expiresAt = expiresAt
    // `capture` has just saved this session; a slide of under a minute can
    // ride along with the next save instead of costing a write per upload.
    if (Math.abs(expiresAt - this.savedExpiresAt) < EXPIRY_SAVE_MS) return
    try {
      this.save()
    } catch (error) {
      if (error instanceof WriterLost) throw error
    }
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
          // A connect or claim during the body read: this answer is for an older session.
          if (generation !== this.generation) return
          if (result.code === 'writer_changed') {
            this.release()
            return
          }
          if ([401, 403].includes(response.status)) {
            this.clear('Session revoked or expired. Reconnect.', true)
            return
          }
          if (!response.ok && !(response.status === 409 && result.acceptedVersion >= next.version))
            throw new Error('Upload failed')
          if (response.ok) {
            try {
              this.extend(result)
            } catch {
              // Only WriterLost escapes `extend`: another tab holds the session now.
              this.release()
              return
            }
          }
          this.update({
            reachable: true,
            acceptedVersion: result.acceptedVersion,
            message: this.pending ? 'Publishing…' : `Live · version ${result.acceptedVersion}`,
          })
        } catch {
          if (generation !== this.generation) return
          // Retry the newest full snapshot (it includes the whole history);
          // a capture made during the failed upload has already replaced it.
          this.pending ??= next
          this.update({
            reachable: false,
            message: 'Upload pending; retrying. ChatGPT may see stale data.',
          })
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
      // A connect or claim during the body read: this answer is for an older session.
      if (generation !== this.generation) return
      if (result.code === 'writer_changed') {
        this.release()
        return
      }
      if ([401, 403].includes(response.status)) {
        this.clear('Session expired or revoked. Reconnect.', true)
        return
      }
      if (!response.ok) {
        this.update({
          reachable: false,
          message: 'Connection interrupted; current state may be stale.',
        })
        return
      }
      try {
        // Mark this tab as the live holder for other tabs, with any later expiry.
        const expiresAt = expiryOf(result)
        if (expiresAt !== null) this.connection.expiresAt = expiresAt
        this.save()
      } catch (error) {
        if (error instanceof WriterLost) return this.release()
      }
      if (!this.pending && !this.sending && !this.retry) {
        this.update({ reachable: true, message: `Live · version ${result.acceptedVersion}` })
        return
      }
      // An upload is still waiting: only its own success says the latest state
      // landed, so `reachable` stays as the upload left it (no Offline/Syncing
      // flicker each heartbeat while uploads keep failing). The service answers
      // again, though: send a failed upload now rather than at its retry.
      if (this.retry) this.pump()
    } catch {
      if (generation !== this.generation) return
      this.update({ reachable: false, message: 'Offline; ChatGPT may see stale data.' })
    }
  }
  /**
   * The heartbeat: keep a live connection fresh, keep retrying a saved session
   * that could not be resumed, and pick up a session another tab let go of.
   */
  tick() {
    if (this.connection && this.ready) return this.ping()
    if (this.restoring) return
    // A saved session this tab was resuming: keep trying (as before).
    if (this.status.resuming) return this.restore()
    // Another tab shares now (perhaps one connected after this tab's session
    // ended): say so, and never claim its session from under it.
    if (this.otherTabHolds()) return this.yieldToOtherTab()
    if (this.status.otherTab) {
      if (this.load()) return this.restore()
      this.update({ otherTab: false, message: 'Off' })
    }
  }
  private yieldToOtherTab() {
    if (this.status.otherTab && !this.status.ended) return
    this.update({
      otherTab: true,
      ended: false,
      message: 'Sharing from another Pip tab.',
    })
  }
  /**
   * Put away the "Sharing ended" notice. Local only: no request, no storage,
   * so it can never touch a session another tab has started since.
   */
  dismiss() {
    if (!this.status.ended || this.status.connected) return
    this.update({ ended: false, message: 'Off' })
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
    if (this.otherTabHolds()) this.yieldToOtherTab()
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
      ended: false,
      message: 'Sharing moved to another Pip tab.',
    })
  }
  /** Forget the session. `ended` when the player did not ask for it (expiry, revocation, a fault). */
  private clear(message: string, ended = false) {
    this.forget(this.drop())
    this.update({
      connected: false,
      resuming: false,
      otherTab: false,
      reachable: true,
      ended,
      message,
    })
  }
  /** Stop sharing: revoke remotely if reachable and forget the saved session. */
  async disconnect() {
    // Works from any state: connected, reconnecting, or while another tab shares.
    const saved = this.connection ? null : this.load()
    const connection = this.connection ?? saved
    const writerId = saved?.writerId ?? this.writerId
    this.forget(this.drop())
    this.update({ resuming: false, otherTab: false, ended: false, message: 'Stopping…' })
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
  reachable: true,
  ended: false,
}
export const livePublisher = new LivePublisher()
