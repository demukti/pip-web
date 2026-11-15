import { bearer, bodyText, hash, json, READ_META, randomSecret } from './http.mjs'

// A session expires 12 hours after its last accepted heartbeat, upload or claim,
// and never later than 7 days after it was created.
const SESSION_MS = 12 * 60 * 60 * 1000
const MAX_SESSION_MS = 7 * 24 * 60 * 60 * 1000
// Heartbeats refresh lastSeenAt and expiresAt in memory; storage gets them at most
// this often.
const SEEN_PERSIST_MS = 60_000
// Storage keys. The snapshot lives apart from the session metadata, so heartbeats
// and claims never rewrite it.
const META = 'meta'
const STATE = 'state'
// The original single-record format. Those sessions lasted at most 12 hours, so a
// leftover record is treated as no session and deleted rather than migrated.
const LEGACY = 'session'

const slide = (session, now) => {
  session.expiresAt = Math.min(now + SESSION_MS, session.createdAt + MAX_SESSION_MS)
}

// Only the outer Worker can reach this object. All browser reads go through
// OAuth; all browser writes need the session's separate random publishing key.
export class LiveState {
  constructor(ctx) {
    this.ctx = ctx
    this.loaded = false
    this.meta = null
    this.state = null
    this.savedSeenAt = 0
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    const now = Date.now()
    // A loaded, unexpired session is read without the lock: read() is synchronous,
    // so no write can interleave with it.
    if (path === '/read' && this.loaded && (!this.meta || this.meta.expiresAt > now))
      return this.read(request, now)
    // Read the body BEFORE taking the lock. While the lock is held the object
    // serves nothing else, so a slow or stalled upload would hold up every read.
    let data = null
    if (path !== '/read' && path !== '/revoke') {
      try {
        data = JSON.parse(await bodyText(request))
      } catch {
        data = null
      }
      if (!data || typeof data !== 'object' || Array.isArray(data))
        return json({ error: 'Invalid request body' }, 400)
    }
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now()
      await this.load(now)
      if (path === '/read') return this.read(request, now)
      return this.write(request, path, now, data)
    })
  }

  async load(now) {
    if (!this.loaded) {
      const stored = await this.ctx.storage.get([META, STATE, LEGACY])
      const meta = stored.get(META)
      if (meta) {
        // Stored before expiry slid: such a session never moved its expiry, so it
        // was created exactly 12 hours before it.
        meta.createdAt ??= meta.expiresAt - SESSION_MS
        // Heartbeats save at most once a minute, so activity since the last save may
        // have moved the expiry up to that much later than stored. Assume it did,
        // so a restart (or the alarm after one) never drops a live session early.
        meta.expiresAt = Math.min(meta.expiresAt + SEEN_PERSIST_MS, meta.createdAt + MAX_SESSION_MS)
        this.meta = meta
        this.state = stored.get(STATE) ?? null
        this.savedSeenAt = meta.lastSeenAt
      } else if (stored.has(LEGACY)) {
        await this.ctx.storage.deleteAll()
      }
      this.loaded = true
    }
    if (this.meta && this.meta.expiresAt <= now) await this.clear()
  }

  // Every storage wipe goes through here so memory never outlives storage.
  async clear() {
    this.meta = null
    this.state = null
    this.loaded = true
    await this.ctx.storage.deleteAll()
  }

  saveMeta() {
    this.savedSeenAt = this.meta.lastSeenAt
    return this.ctx.storage.put(META, this.meta)
  }

  // The READ_META header carries freshness figures to the outer Worker, which logs
  // them and drops the header, so it never has to re-parse the snapshot body.
  read(request, now) {
    const session = this.meta
    if (!session || session.ownerEpoch !== request.headers.get('X-Owner-Epoch')) {
      const response = json({
        active: false,
        state: null,
        stale: true,
        reason: 'No active session',
      })
      response.headers.set(
        READ_META,
        JSON.stringify({ version: null, stale: true, pending: null, stateAgeMs: null }),
      )
      return response
    }
    const pending = session.expectedVersion > session.version
    const stale = !this.state || now - session.lastSeenAt > 30_000 || pending
    const response = json({
      active: true,
      sessionId: session.id,
      version: session.version,
      receivedAt: session.receivedAt,
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      readAt: new Date(now).toISOString(),
      connectionAgeMs: now - session.lastSeenAt,
      pending,
      stale,
      state: this.state,
    })
    const stateAgeMs = session.receivedAt ? now - Date.parse(session.receivedAt) : null
    response.headers.set(
      READ_META,
      JSON.stringify({ version: session.version, stale, pending, stateAgeMs }),
    )
    return response
  }

  async write(request, path, now, data) {
    if (path === '/create') {
      const { writerId, ownerEpoch } = data
      const token = randomSecret()
      const next = {
        id: crypto.randomUUID(),
        writerId,
        ownerEpoch,
        tokenHash: await hash(token),
        createdAt: now,
        expiresAt: now + SESSION_MS,
        version: 0,
        expectedVersion: 0,
        receivedAt: null,
        lastSeenAt: now,
      }
      // Drops the previous session's snapshot (and any legacy record).
      await this.clear()
      this.meta = next
      await this.saveMeta()
      await this.ctx.storage.setAlarm(next.expiresAt)
      return json({ sessionId: next.id, token, version: 0, expiresAt: next.expiresAt })
    }
    const session = this.meta
    if (
      !session ||
      request.headers.get('X-Pip-Session') !== session.id ||
      request.headers.get('X-Owner-Epoch') !== session.ownerEpoch ||
      (await hash(bearer(request))) !== session.tokenHash
    ) {
      return json({ error: 'Publishing session expired or revoked' }, 401)
    }
    if (path === '/claim') {
      const { writerId } = data
      if (typeof writerId !== 'string' || writerId.length > 100)
        return json({ error: 'Invalid writer' }, 400)
      session.writerId = writerId
      slide(session, now)
      await this.saveMeta()
      return json({
        version: Math.max(session.version, session.expectedVersion),
        expiresAt: session.expiresAt,
      })
    }
    if (request.headers.get('X-Pip-Writer') !== session.writerId) {
      return json(
        { error: 'Another browser tab took over publishing', code: 'writer_changed' },
        409,
      )
    }
    if (path === '/revoke') {
      await this.clear()
      return json({ revoked: true })
    }
    if (path === '/heartbeat') {
      if (!Number.isSafeInteger(data.version) || data.version < 0)
        return json({ error: 'Invalid version' }, 400)
      const expectedVersion = Math.max(session.expectedVersion, data.version)
      const persist =
        expectedVersion !== session.expectedVersion || now - this.savedSeenAt >= SEEN_PERSIST_MS
      session.expectedVersion = expectedVersion
      session.lastSeenAt = now
      // The slid expiry rides on the same at-most-once-a-minute save (see load()).
      slide(session, now)
      if (persist) await this.saveMeta()
      return json({ acceptedVersion: session.version, expiresAt: session.expiresAt })
    }
    if (path !== '/publish') return json({ error: 'Not found' }, 404)
    if (
      data.schemaVersion !== 1 ||
      data.sessionId !== session.id ||
      !Number.isSafeInteger(data.version) ||
      data.version < 1 ||
      !Number.isFinite(Date.parse(data.capturedAt)) ||
      !Object.hasOwn(data, 'hand') ||
      (data.hand !== null && (typeof data.hand !== 'object' || Array.isArray(data.hand)))
    ) {
      return json({ error: 'Invalid snapshot envelope' }, 400)
    }
    if (data.version <= session.version) {
      return json(
        { error: 'Version already accepted or superseded', acceptedVersion: session.version },
        409,
      )
    }
    this.state = data
    session.version = data.version
    session.expectedVersion = Math.max(session.expectedVersion, data.version)
    session.receivedAt = new Date(now).toISOString()
    session.lastSeenAt = now
    slide(session, now)
    this.savedSeenAt = now
    // One atomic write of both keys.
    await this.ctx.storage.put({ [STATE]: data, [META]: session })
    return json({
      acceptedVersion: session.version,
      receivedAt: session.receivedAt,
      expiresAt: session.expiresAt,
    })
  }

  async alarm() {
    // The alarm is set for the expiry at creation; activity since then slides the
    // expiry, so a live session just re-arms it for its current expiry. An old alarm
    // can also be retried after the owner has created a newer session.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.load(Date.now())
      if (this.meta) await this.ctx.storage.setAlarm(this.meta.expiresAt)
      else await this.clear()
    })
  }
}
