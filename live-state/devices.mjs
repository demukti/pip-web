import { bearer, hash, json, randomSecret } from './http.mjs'

// The browsers signed in to the coach, and how often they ask. One object for the
// owner; only the outer Worker can reach it.

// A browser stays signed in while it is used: 30 days after its last question.
const DEVICE_MS = 30 * 24 * 60 * 60 * 1000
// Signing in a sixth browser signs out the one used longest ago.
export const MAX_DEVICES = 5
// Questions per rolling minute, across every browser: each one is a paid model
// call, so a stuck button or a script cannot run up the bill.
export const COACH_PER_MINUTE = 6
const DEVICES = 'devices'

// The class keeps the name it was first deployed under, so the Durable Object
// binding needs no migration. Its storage from the ChatGPT era (the session and
// the shared snapshot) is deleted on first load.
export class LiveState {
  constructor(ctx) {
    this.ctx = ctx
    /** id → { tokenHash, ownerEpoch, createdAt, lastUsedAt, expiresAt }, or null until loaded. */
    this.devices = null
    // When recent questions were let through. Memory only: a restart forgets at
    // most one minute's count.
    this.asked = []
  }

  async fetch(request) {
    const path = new URL(request.url).pathname
    return this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now()
      await this.load(now)
      if (path === '/connect') return this.connect(request, now)
      const id = await this.find(request, now)
      if (!id)
        return json({ error: 'Signed out of the coach; sign in again', code: 'signed_out' }, 401)
      if (path === '/disconnect') {
        delete this.devices[id]
        await this.save()
        return json({ signedOut: true })
      }
      if (path === '/coach') return this.admit(id, now)
      return json({ error: 'Not found' }, 404)
    })
  }

  async load(now) {
    if (!this.devices) {
      const stored = await this.ctx.storage.get(DEVICES)
      if (stored) this.devices = stored
      else {
        // Nothing yet, or the old ChatGPT-era records: start clean.
        await this.ctx.storage.deleteAll()
        this.devices = {}
      }
    }
    for (const [id, device] of Object.entries(this.devices))
      if (device.expiresAt <= now) delete this.devices[id]
  }

  save() {
    return this.ctx.storage.put(DEVICES, this.devices)
  }

  async connect(request, now) {
    const ownerEpoch = request.headers.get('X-Owner-Epoch')
    const token = randomSecret()
    const id = crypto.randomUUID()
    const signedIn = Object.entries(this.devices).sort(
      ([, a], [, b]) => a.lastUsedAt - b.lastUsedAt,
    )
    for (const [old] of signedIn.slice(0, Math.max(0, signedIn.length - MAX_DEVICES + 1)))
      delete this.devices[old]
    this.devices[id] = {
      tokenHash: await hash(token),
      ownerEpoch,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + DEVICE_MS,
    }
    await this.save()
    return json({ token, expiresAt: now + DEVICE_MS })
  }

  /** The signed-in browser this request's token belongs to, under the current owner key. */
  async find(request, now) {
    const token = bearer(request)
    if (!token) return null
    const tokenHash = await hash(token)
    const ownerEpoch = request.headers.get('X-Owner-Epoch')
    for (const [id, device] of Object.entries(this.devices))
      if (
        device.tokenHash === tokenHash &&
        device.ownerEpoch === ownerEpoch &&
        device.expiresAt > now
      )
        return id
    return null
  }

  // The ChatGPT-era object set an alarm for its session's expiry; one may still
  // be due. Expired browsers are dropped on load, so there is nothing to do.
  async alarm() {}

  /** Lets one question through, or says when the next one can be asked. */
  async admit(id, now) {
    this.asked = this.asked.filter((at) => now - at < 60_000)
    if (this.asked.length >= COACH_PER_MINUTE) {
      const retryAfterMs = 60_000 - (now - this.asked[0])
      return json(
        { error: 'Too many questions this minute', code: 'coach_limit', retryAfterMs },
        429,
      )
    }
    this.asked.push(now)
    const device = this.devices[id]
    device.lastUsedAt = now
    device.expiresAt = now + DEVICE_MS
    await this.save()
    return json({ expiresAt: device.expiresAt })
  }
}
