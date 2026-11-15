import { bearer, bodyText, hash, json, randomSecret } from './http.mjs'

const SESSION_MS = 12 * 60 * 60 * 1000

// Only the outer Worker can reach this object. All browser reads go through
// OAuth; all browser writes need the session's separate random publishing key.
export class LiveState {
  constructor(ctx) {
    this.ctx = ctx
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const path = new URL(request.url).pathname
      const now = Date.now()
      let session = await this.ctx.storage.get('session')
      if (session && session.expiresAt <= now) {
        await this.ctx.storage.deleteAll()
        session = null
      }
      if (path === '/create') {
        const { writerId, ownerEpoch } = JSON.parse(await bodyText(request))
        const token = randomSecret()
        const next = {
          id: crypto.randomUUID(),
          writerId,
          ownerEpoch,
          tokenHash: await hash(token),
          expiresAt: now + SESSION_MS,
          version: 0,
          expectedVersion: 0,
          state: null,
          receivedAt: null,
          lastSeenAt: now,
        }
        await this.ctx.storage.put('session', next)
        await this.ctx.storage.setAlarm(next.expiresAt)
        return json({ sessionId: next.id, token, version: 0, expiresAt: next.expiresAt })
      }
      if (path === '/read') {
        if (!session || session.ownerEpoch !== request.headers.get('X-Owner-Epoch')) {
          return json({ active: false, state: null, stale: true, reason: 'No active session' })
        }
        return json({
          active: true,
          sessionId: session.id,
          version: session.version,
          receivedAt: session.receivedAt,
          lastSeenAt: new Date(session.lastSeenAt).toISOString(),
          readAt: new Date(now).toISOString(),
          connectionAgeMs: now - session.lastSeenAt,
          pending: session.expectedVersion > session.version,
          stale:
            !session.state ||
            now - session.lastSeenAt > 30_000 ||
            session.expectedVersion > session.version,
          state: session.state,
        })
      }
      if (
        !session ||
        request.headers.get('X-Pip-Session') !== session.id ||
        request.headers.get('X-Owner-Epoch') !== session.ownerEpoch ||
        (await hash(bearer(request))) !== session.tokenHash
      ) {
        return json({ error: 'Publishing session expired or revoked' }, 401)
      }
      if (path === '/claim') {
        const { writerId } = JSON.parse(await bodyText(request))
        if (typeof writerId !== 'string' || writerId.length > 100)
          return json({ error: 'Invalid writer' }, 400)
        session.writerId = writerId
        await this.ctx.storage.put('session', session)
        return json({ version: Math.max(session.version, session.expectedVersion) })
      }
      if (request.headers.get('X-Pip-Writer') !== session.writerId) {
        return json(
          { error: 'Another browser tab took over publishing', code: 'writer_changed' },
          409,
        )
      }
      if (path === '/revoke') {
        await this.ctx.storage.deleteAll()
        return json({ revoked: true })
      }
      const data = JSON.parse(await bodyText(request))
      if (path === '/heartbeat') {
        if (!Number.isSafeInteger(data.version) || data.version < 0)
          return json({ error: 'Invalid version' }, 400)
        session.expectedVersion = Math.max(session.expectedVersion, data.version)
        session.lastSeenAt = now
        await this.ctx.storage.put('session', session)
        return json({ acceptedVersion: session.version })
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
      session.state = data
      session.version = data.version
      session.expectedVersion = Math.max(session.expectedVersion, data.version)
      session.receivedAt = new Date(now).toISOString()
      session.lastSeenAt = now
      await this.ctx.storage.put('session', session)
      return json({ acceptedVersion: session.version, receivedAt: session.receivedAt })
    })
  }

  async alarm() {
    // An old alarm can be retried after the owner has created a newer session.
    const session = await this.ctx.storage.get('session')
    if (session && session.expiresAt > Date.now()) {
      await this.ctx.storage.setAlarm(session.expiresAt)
    } else {
      await this.ctx.storage.deleteAll()
    }
  }
}
