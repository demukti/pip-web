import test from 'ava'
import { LivePublisher, type LiveEvents } from '@/lib/liveCoaching/publisher'
import { mulberry32 } from '@/lib/poker/cards'
import { applyAction, startHand } from '@/lib/poker/engine'

// A small in-memory stand-in for the state Worker's publishing routes, so these
// tests exercise the publisher's own behaviour (queueing, resume, tabs) only.
const base = 'https://state.example'
const KEY = 'pip.live-coaching.v1'

function server() {
  const s = {
    sessionId: 'session-1',
    token: 'token-1',
    writerId: '',
    version: 0,
    puts: [] as number[],
    beats: 0,
    claims: 0,
    snapshots: [] as { version: number; hand: Record<string, unknown> | null }[],
    /** A sliding-expiry service returns this from claim, heartbeat and publish; unset = older service. */
    expiresAt: undefined as number | undefined,
    /** Return a response (or throw) instead of the normal handling. */
    override: {} as Record<string, () => Response | Promise<Response>>,
  }
  const expiry = () => (s.expiresAt === undefined ? {} : { expiresAt: s.expiresAt })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(init.body as string) : {}
    const route = `${init?.method} ${path}`
    if (s.override[route]) return s.override[route]()
    if (route === 'POST /sessions') {
      s.writerId = body.writerId
      return json({
        sessionId: s.sessionId,
        token: s.token,
        version: 0,
        expiresAt: Date.now() + 1e7,
      })
    }
    if (headers.get('Authorization') !== `Bearer ${s.token}`) return json({ error: 'expired' }, 401)
    if (route === 'POST /claim') {
      s.claims++
      s.writerId = body.writerId
      return json({ version: s.version, ...expiry() })
    }
    if (headers.get('X-Pip-Writer') !== s.writerId)
      return json({ error: 'taken', code: 'writer_changed' }, 409)
    if (route === 'POST /heartbeat') {
      s.beats++
      return json({ acceptedVersion: s.version, ...expiry() })
    }
    if (route === 'DELETE /publish') return json({ revoked: true })
    if (route === 'PUT /publish') {
      s.puts.push(body.version)
      if (body.version <= s.version) return json({ acceptedVersion: s.version }, 409)
      s.version = body.version
      s.snapshots.push(body)
      return json({ acceptedVersion: s.version, ...expiry() })
    }
    return json({ error: 'Not found' }, 404)
  }
  return { s, fetcher }
}

function memoryStorage() {
  const values = new Map<string, string>()
  const storage = () => ({
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
  })
  return { values, storage }
}

function fakeEvents() {
  const listeners = new Map<string, Set<() => void>>()
  const events: LiveEvents = {
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return () => listeners.get(event)?.delete(listener)
    },
  }
  return {
    events,
    emit: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener()
    },
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const ownerKey = 'k'.repeat(40)

test('A1: a rejected heartbeat keeps the expired message and forgets the session', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  s.token = 'rotated'
  await publisher.ping()
  t.false(publisher.getStatus().connected)
  t.is(publisher.getStatus().message, 'Session expired or revoked. Reconnect.')
  t.false(values.has(KEY))
})

test('A2: captures during one slow upload send at most two PUTs, latest wins', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const gate = deferred()
  let first = true
  const slow: typeof fetch = async (input, init) => {
    if (init?.method === 'PUT' && first) {
      first = false
      await gate.promise
    }
    return fetcher(input, init)
  }
  const publisher = new LivePublisher(storage, slow, fakeEvents().events)
  await publisher.connect(base, ownerKey) // version 1 is now in flight and held
  for (let i = 0; i < 6; i++) publisher.capture(null, 0)
  t.is(publisher.getStatus().version, 7)
  gate.release()
  await publisher.flush()
  t.deepEqual(s.puts, [1, 7])
  t.is(s.version, 7)
  t.is(publisher.getStatus().acceptedVersion, 7)
  t.is(publisher.getStatus().message, 'Live · version 7')
})

test('A2: a failed upload retries the newest snapshot, not the one that failed', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const gate = deferred()
  let fail = true
  const flaky: typeof fetch = async (input, init) => {
    if (init?.method === 'PUT' && fail) {
      fail = false
      await gate.promise
      throw new Error('offline')
    }
    return fetcher(input, init)
  }
  const { events, emit } = fakeEvents()
  const publisher = new LivePublisher(storage, flaky, events)
  t.teardown(publisher.start())
  await publisher.connect(base, ownerKey)
  publisher.capture(null, 0)
  publisher.capture(null, 0)
  gate.release()
  await publisher.flush()
  // Version 1 failed; versions 2 and 3 never went out on their own.
  t.deepEqual(s.puts, [])
  t.is(publisher.getStatus().message, 'Upload pending; retrying. ChatGPT may see stale data.')
  // Back online: skip the backoff and send only the newest full snapshot.
  emit('online')
  await settle()
  await publisher.flush()
  t.deepEqual(s.puts, [3])
  t.is(publisher.getStatus().acceptedVersion, 3)
})

test('A3: a failed claim at load keeps the session and resumes on its own', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const first = new LivePublisher(storage, fetcher, fakeEvents().events)
  await first.connect(base, ownerKey)
  await first.flush()
  // Simulate a reload: the stored record was released by the closing page.
  const saved = JSON.parse(values.get(KEY)!)
  values.set(KEY, JSON.stringify({ ...saved, heldAt: 0 }))

  s.override['POST /claim'] = () => {
    throw new Error('offline')
  }
  const { events, emit } = fakeEvents()
  const reloaded = new LivePublisher(storage, fetcher, events)
  const stop = reloaded.start()
  t.teardown(stop)
  await reloaded.flush()
  t.false(reloaded.getStatus().connected)
  t.true(reloaded.getStatus().resuming)
  t.is(reloaded.getStatus().message, 'Reconnecting…')
  t.true(values.has(KEY))

  // Still offline on the heartbeat tick: keeps waiting, keeps the session.
  await reloaded.tick()
  t.true(reloaded.getStatus().resuming)

  delete s.override['POST /claim']
  emit('online')
  await settle()
  await reloaded.flush()
  t.true(reloaded.getStatus().connected)
  t.false(reloaded.getStatus().resuming)
  t.is(reloaded.getStatus().acceptedVersion, 2)
  t.is(s.claims, 1)
})

test('A3: a rejected claim forgets the session and stops retrying', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const first = new LivePublisher(storage, fetcher, fakeEvents().events)
  await first.connect(base, ownerKey)
  await first.flush()
  s.override['POST /claim'] = () => {
    throw new Error('offline')
  }
  const reloaded = new LivePublisher(storage, fetcher, fakeEvents().events)
  await reloaded.restore()
  t.true(reloaded.getStatus().resuming)
  s.override['POST /claim'] = () => new Response('{}', { status: 401 })
  await reloaded.tick()
  t.false(reloaded.getStatus().resuming)
  t.false(values.has(KEY))
  delete s.override['POST /claim']
  await reloaded.tick()
  t.is(s.claims, 0)
  t.false(reloaded.getStatus().connected)
})

test('A3: stop sharing while reconnecting forgets the saved session', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  await new LivePublisher(storage, fetcher, fakeEvents().events).connect(base, ownerKey)
  s.override['POST /claim'] = () => {
    throw new Error('offline')
  }
  const reloaded = new LivePublisher(storage, fetcher, fakeEvents().events)
  await reloaded.restore()
  t.true(reloaded.getStatus().resuming)
  await reloaded.disconnect()
  t.false(values.has(KEY))
  t.false(reloaded.getStatus().resuming)
  await reloaded.tick()
  t.false(reloaded.getStatus().resuming)
})

test('A5: becoming visible or coming online sends a heartbeat at once', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const { events, emit } = fakeEvents()
  const publisher = new LivePublisher(storage, fetcher, events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const stop = publisher.start()
  t.teardown(stop)
  await publisher.flush()
  const before = s.beats
  emit('visible')
  await settle()
  t.is(s.beats, before + 1)
  emit('online')
  await settle()
  t.is(s.beats, before + 2)
  stop()
  emit('visible')
  await settle()
  t.is(s.beats, before + 2)
})

test('C1: losing the writer role stops this tab but keeps the shared session', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const tab = new LivePublisher(storage, fetcher, fakeEvents().events)
  await tab.connect(base, ownerKey)
  await tab.flush()
  // Another tab claims at the server and in storage.
  s.writerId = 'other-tab'
  const theirs = JSON.stringify({ ...JSON.parse(values.get(KEY)!), writerId: 'other-tab' })
  values.set(KEY, theirs)
  await tab.ping()
  t.false(tab.getStatus().connected)
  t.true(tab.getStatus().otherTab)
  t.is(values.get(KEY), theirs)
  // Further game captures neither publish nor write the shared record.
  const puts = s.puts.length
  tab.capture(null, 0)
  await tab.flush()
  t.is(s.puts.length, puts)
  t.is(values.get(KEY), theirs)
})

test('C1: a PUT refused with writer_changed keeps the stored session untouched', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const tab = new LivePublisher(storage, fetcher, fakeEvents().events)
  await tab.connect(base, ownerKey)
  await tab.flush()
  s.writerId = 'other-tab'
  tab.capture(null, 0)
  await tab.flush()
  t.false(tab.getStatus().connected)
  t.true(tab.getStatus().otherTab)
  t.is(tab.getStatus().message, 'Sharing moved to another Pip tab.')
  t.true(values.has(KEY))
})

test('C1: a capture after another tab claimed never overwrites its record', async (t) => {
  const { fetcher } = server()
  const { values, storage } = memoryStorage()
  const first = new LivePublisher(storage, fetcher, fakeEvents().events)
  await first.connect(base, ownerKey)
  await first.flush()
  const second = new LivePublisher(storage, fetcher, fakeEvents().events)
  await second.restore()
  await second.flush()
  const record = values.get(KEY)
  first.capture(null, 0)
  await first.flush()
  t.false(first.getStatus().connected)
  t.is(values.get(KEY), record)
  t.true(second.getStatus().connected)
})

test('C1: a new tab waits while another tab shares, then takes over when it closes', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const a = fakeEvents()
  const first = new LivePublisher(storage, fetcher, a.events)
  await first.connect(base, ownerKey)
  await first.flush()
  t.teardown(first.start())
  await first.flush()
  const claims = s.claims

  const second = new LivePublisher(storage, fetcher, fakeEvents().events)
  t.teardown(second.start())
  await second.flush()
  t.false(second.getStatus().connected)
  t.true(second.getStatus().otherTab)
  t.is(s.claims, claims)

  a.emit('pagehide')
  await second.tick()
  await second.flush()
  t.true(second.getStatus().connected)
  t.is(s.claims, claims + 1)
})

test('C1: expiry and stop sharing delete the stored session; the owner key is never stored', async (t) => {
  const { fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  t.false([...values.values()].join('').includes(ownerKey))
  await publisher.disconnect()
  t.false(values.has(KEY))

  await publisher.connect(base, ownerKey)
  const saved = JSON.parse(values.get(KEY)!)
  values.set(KEY, JSON.stringify({ ...saved, expiresAt: Date.now() - 1 }))
  const reloaded = new LivePublisher(storage, fetcher, fakeEvents().events)
  await reloaded.restore()
  t.false(values.has(KEY))
  t.false(reloaded.getStatus().resuming)
})

test('C3: the last hero-turn estimate rides along until the hand changes', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  const hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })
  const latestHero = () => s.snapshots.at(-1)!.hand!.hero as Record<string, unknown>
  publisher.capture(hand, 3, 0.72493)
  await publisher.flush()
  t.is(latestHero().equity, 0.72493)
  const aiTurn = applyAction(hand, { type: 'call' })
  publisher.capture(aiTurn, 3)
  await publisher.flush()
  t.is(latestHero().equity, null)
  t.deepEqual(latestHero().lastEquity, {
    equity: 0.72493,
    equityDisplay: '72%',
    street: 'preflop',
  })
  t.true(String(s.snapshots.at(-1)!.hand!.brief).endsWith('Last estimate 72% preflop.'))
  publisher.capture(hand, 4)
  await publisher.flush()
  t.is(latestHero().lastEquity, null)
  publisher.capture(aiTurn, 4, 0.5)
  await publisher.flush()
  t.is(latestHero().lastEquity, null)
  publisher.capture(null, 0)
  publisher.capture(aiTurn, 4)
  await publisher.flush()
  t.is(latestHero().lastEquity, null)
})

const headsUp = (seed: number) =>
  startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(seed),
  })

test('a new table dealt in place does not inherit the last estimate of its hand 1', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  // Hand 1 at the first table: an estimate on the hero's turn.
  publisher.capture(headsUp(42), 1, 0.81)
  // Busted, re-seated without leaving: the new table's hand 1, an AI to act.
  const fresh = applyAction(headsUp(7), { type: 'call' })
  t.notDeepEqual(fresh.players[0].hole, headsUp(42).players[0].hole)
  publisher.capture(fresh, 1)
  await publisher.flush()
  const hero = s.snapshots.at(-1)!.hand!.hero as Record<string, unknown>
  t.is(hero.lastEquity, null)
  t.false(String(s.snapshots.at(-1)!.hand!.brief).includes('Last estimate'))
  // The same deal later on still keeps it.
  publisher.capture(headsUp(7), 1, 0.4)
  publisher.capture(fresh, 1)
  await publisher.flush()
  t.deepEqual((s.snapshots.at(-1)!.hand!.hero as Record<string, unknown>).lastEquity, {
    equity: 0.4,
    equityDisplay: '40%',
    street: 'preflop',
  })
})

test('a failed heartbeat marks the service unreachable until the next one succeeds', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  t.true(publisher.getStatus().reachable)
  s.override['POST /heartbeat'] = () => {
    throw new Error('offline')
  }
  await publisher.ping()
  t.true(publisher.getStatus().connected)
  t.false(publisher.getStatus().reachable)
  s.override['POST /heartbeat'] = () => new Response('{}', { status: 503 })
  await publisher.ping()
  t.false(publisher.getStatus().reachable)
  delete s.override['POST /heartbeat']
  await publisher.ping()
  t.true(publisher.getStatus().reachable)
  t.is(publisher.getStatus().message, 'Live · version 1')
})

test('a failed upload marks it unreachable; a heartbeat that gets through sends it at once', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  t.teardown(publisher.start())
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  s.override['PUT /publish'] = () => {
    throw new Error('offline')
  }
  publisher.capture(null, 0)
  await publisher.flush()
  t.false(publisher.getStatus().reachable)
  t.true(publisher.getStatus().acceptedVersion < publisher.getStatus().version)
  delete s.override['PUT /publish']
  await publisher.ping()
  await publisher.flush()
  t.true(publisher.getStatus().reachable)
  t.is(publisher.getStatus().acceptedVersion, 2)
  t.deepEqual(s.puts, [1, 2])
})

test('expiry or revocation ends sharing involuntarily; connect and stop reset it', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  t.false(publisher.getStatus().ended)
  s.token = 'rotated'
  await publisher.ping()
  t.false(publisher.getStatus().connected)
  t.true(publisher.getStatus().ended)
  s.token = 'token-1'
  await publisher.connect(base, ownerKey)
  t.false(publisher.getStatus().ended)
  // A rejected upload ends it too.
  s.token = 'rotated'
  publisher.capture(null, 0)
  await publisher.flush()
  t.true(publisher.getStatus().ended)
  // Stop sharing puts it away (so does Dismiss, locally: see below).
  await publisher.disconnect()
  t.false(publisher.getStatus().ended)
  t.false(publisher.getStatus().connected)
})

test('stopping, or another tab taking over, is not an involuntary end', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  s.writerId = 'other-tab'
  values.set(KEY, JSON.stringify({ ...JSON.parse(values.get(KEY)!), writerId: 'other-tab' }))
  await publisher.ping()
  t.true(publisher.getStatus().otherTab)
  t.false(publisher.getStatus().ended)

  const other = new LivePublisher(memoryStorage().storage, server().fetcher, fakeEvents().events)
  await other.connect(base, ownerKey)
  await other.disconnect()
  t.false(other.getStatus().ended)
})

test('a saved session found expired at load is an involuntary end', async (t) => {
  const { fetcher } = server()
  const { values, storage } = memoryStorage()
  await new LivePublisher(storage, fetcher, fakeEvents().events).connect(base, ownerKey)
  const saved = JSON.parse(values.get(KEY)!)
  values.set(KEY, JSON.stringify({ ...saved, heldAt: 0, expiresAt: Date.now() - 1 }))
  const reloaded = new LivePublisher(storage, fetcher, fakeEvents().events)
  await reloaded.restore()
  t.true(reloaded.getStatus().ended)
  t.false(reloaded.getStatus().resuming)
})

const storedExpiry = (values: Map<string, string>) => JSON.parse(values.get(KEY)!).expiresAt

test('claim, heartbeat and publish slide the saved expiry when the service sends one', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const initial = storedExpiry(values)

  const hour = 3_600_000
  s.expiresAt = initial + hour
  await publisher.ping()
  t.is(storedExpiry(values), initial + hour)

  s.expiresAt = initial + 2 * hour
  publisher.capture(null, 0)
  await publisher.flush()
  t.is(storedExpiry(values), initial + 2 * hour)

  s.expiresAt = initial + 3 * hour
  const reloaded = new LivePublisher(storage, fetcher, fakeEvents().events)
  await reloaded.restore()
  await reloaded.flush()
  t.true(reloaded.getStatus().connected)
  t.is(storedExpiry(values), initial + 3 * hour)
  t.false([...values.values()].join('').includes(ownerKey))
})

test('an upload that slides the expiry by under a minute costs no extra storage write', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  let writes = 0
  const counted = () => {
    const inner = storage()
    return {
      ...inner,
      setItem: (k: string, v: string) => {
        writes++
        inner.setItem(k, v)
      },
    }
  }
  const publisher = new LivePublisher(counted, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const initial = storedExpiry(values)

  s.expiresAt = initial + 30_000
  writes = 0
  publisher.capture(null, 0)
  await publisher.flush()
  t.is(writes, 1, 'only the capture’s own save')
  t.is(storedExpiry(values), initial)
  // Kept in memory: the next save (here the heartbeat's) carries it.
  s.expiresAt = undefined
  await publisher.ping()
  t.is(storedExpiry(values), initial + 30_000)

  s.expiresAt = initial + 5 * 60_000
  writes = 0
  publisher.capture(null, 0)
  await publisher.flush()
  t.is(writes, 2, 'a slide of minutes is saved at once')
  t.is(storedExpiry(values), initial + 5 * 60_000)
})

/** A response whose body arrives only when `gate` opens. */
const slowBody = (gate: Promise<void>, body: unknown) =>
  ({
    ok: true,
    status: 200,
    json: async () => {
      await gate
      return body
    },
  }) as Response

test('a heartbeat answer read after a reconnect is ignored', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const gate = deferred()
  s.override['POST /heartbeat'] = () =>
    slowBody(gate.promise, { acceptedVersion: 0, expiresAt: 1234 })
  const beat = publisher.ping()
  await settle()
  delete s.override['POST /heartbeat']
  await publisher.connect(base, ownerKey) // a new session while the old body is read
  await publisher.flush()
  gate.release()
  await beat
  t.not(storedExpiry(values), 1234)
  t.true(publisher.getStatus().connected)
  t.is(publisher.getStatus().message, 'Live · version 1')
})

test('an upload answer read after a reconnect is ignored', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const gate = deferred()
  s.override['PUT /publish'] = () =>
    slowBody(gate.promise, { acceptedVersion: 99, expiresAt: 1234 })
  publisher.capture(null, 0)
  await settle()
  delete s.override['PUT /publish']
  s.version = 0
  await publisher.connect(base, ownerKey)
  gate.release()
  await publisher.flush()
  t.not(storedExpiry(values), 1234)
  t.not(publisher.getStatus().acceptedVersion, 99)
  t.true(publisher.getStatus().connected)
})

test('heartbeats that get through do not flip the badge while uploads keep failing', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  t.teardown(publisher.start())
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  s.override['PUT /publish'] = () => {
    throw new Error('upload path down')
  }
  publisher.capture(null, 0)
  await publisher.flush()
  t.false(publisher.getStatus().reachable)
  const seen: boolean[] = []
  const off = publisher.subscribe(() => seen.push(publisher.getStatus().reachable))
  for (let i = 0; i < 3; i++) {
    await publisher.ping()
    await publisher.flush()
  }
  off()
  t.true(s.beats >= 3)
  t.false(seen.includes(true), 'reachable flickered back on between failed uploads')
  // The upload itself getting through is what restores it.
  delete s.override['PUT /publish']
  await publisher.ping()
  await publisher.flush()
  t.true(publisher.getStatus().reachable)
  t.is(publisher.getStatus().acceptedVersion, publisher.getStatus().version)
})

/** One tab whose session ended involuntarily, then another tab that connects afresh. */
async function endedThenOtherTab() {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  let requests = 0
  const counted: typeof fetch = (input, init) => {
    requests++
    return fetcher(input, init)
  }
  const a = new LivePublisher(storage, counted, fakeEvents().events)
  await a.connect(base, ownerKey)
  await a.flush()
  s.token = 'rotated' // A's session is revoked
  await a.ping()
  const b = new LivePublisher(storage, counted, fakeEvents().events)
  await b.connect(base, ownerKey) // the service issues `rotated` to the new session
  await b.flush()
  return { s, values, a, b, requests: () => requests }
}

test('Dismiss is local: it never touches a session another tab started since', async (t) => {
  const { values, a, b, requests } = await endedThenOtherTab()
  t.true(a.getStatus().ended)
  const record = values.get(KEY)
  const before = requests()
  a.dismiss()
  await a.flush()
  t.false(a.getStatus().ended)
  t.is(requests(), before, 'Dismiss made a request')
  t.is(values.get(KEY), record)
  await b.ping()
  t.true(b.getStatus().connected)
  t.false(b.getStatus().ended)
  t.is(b.getStatus().message, 'Live · version 1')
})

test('an ended tab that sees another tab sharing says so, and does not claim it', async (t) => {
  const { s, a, b } = await endedThenOtherTab()
  t.true(a.getStatus().ended)
  const claims = s.claims
  await a.tick()
  await a.flush()
  t.false(a.getStatus().ended)
  t.true(a.getStatus().otherTab)
  t.is(s.claims, claims)
  t.true(b.getStatus().connected)
  t.is(b.getStatus().message, 'Live · version 1')
})

test('starting an ended tab while another tab shares clears the ended notice', async (t) => {
  const { s, a } = await endedThenOtherTab()
  const claims = s.claims
  t.teardown(a.start())
  await a.flush()
  t.false(a.getStatus().ended)
  t.true(a.getStatus().otherTab)
  t.is(s.claims, claims)
})

test('an older service without expiresAt leaves the expiry as it was', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  const initial = storedExpiry(values)
  await publisher.ping()
  publisher.capture(null, 0)
  await publisher.flush()
  t.is(storedExpiry(values), initial)
  // A malformed value is ignored the same way.
  s.override['POST /heartbeat'] = () =>
    new Response(JSON.stringify({ acceptedVersion: s.version, expiresAt: 'soon' }), {
      status: 200,
    })
  await publisher.ping()
  t.is(storedExpiry(values), initial)
})

test('a later expiry never overwrites a record another tab now holds', async (t) => {
  const { s, fetcher } = server()
  const { values, storage } = memoryStorage()
  const gate = deferred()
  let hold = false
  const slow: typeof fetch = async (input, init) => {
    if (init?.method === 'PUT' && hold) await gate.promise
    return fetcher(input, init)
  }
  const publisher = new LivePublisher(storage, slow, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  await publisher.flush()
  hold = true
  s.expiresAt = Date.now() + 5e7
  publisher.capture(null, 0) // saved, then held in flight
  // Another tab claims in storage while the upload is out; the server accepts it.
  const theirs = JSON.stringify({ ...JSON.parse(values.get(KEY)!), writerId: 'other-tab' })
  values.set(KEY, theirs)
  gate.release()
  await publisher.flush()
  t.is(values.get(KEY), theirs)
  t.true(publisher.getStatus().otherTab)
  t.false(publisher.getStatus().connected)
})

test('table context: read at capture time, optional, and a fault never stops sharing', async (t) => {
  const { s, fetcher } = server()
  const { storage } = memoryStorage()
  const publisher = new LivePublisher(storage, fetcher, fakeEvents().events)
  await publisher.connect(base, ownerKey)
  const hand = headsUp(42)
  publisher.capture(hand, 1)
  await publisher.flush()
  t.is(s.snapshots.at(-1)!.hand!.table, null)

  let status: 'playing' | 'busted' = 'playing'
  const remove = publisher.setTableContext(() => ({
    venue: 'The Back Room',
    format: 'tournament',
    blindLevel: 1,
    status,
    place: status === 'busted' ? 2 : null,
    scoreHands: null,
    players: { ai: { style: 'Loose', reads: ['Plays most hands'] } },
  }))
  publisher.capture(hand, 1)
  await publisher.flush()
  t.like(s.snapshots.at(-1)!.hand!.table as object, { venue: 'The Back Room', status: 'playing' })
  const players = s.snapshots.at(-1)!.hand!.players as { style: string; reads: string[] }[]
  t.deepEqual(
    players.map((player) => player.reads),
    [[], ['Plays most hands']],
  )

  // The run ends with no new capture: refresh republishes the same hand.
  status = 'busted'
  const puts = s.puts.length
  publisher.refresh(headsUp(42)) // a different hand object: not the last capture
  await publisher.flush()
  t.is(s.puts.length, puts)
  publisher.refresh(hand)
  await publisher.flush()
  t.is(s.puts.length, puts + 1)
  t.like(s.snapshots.at(-1)!.hand!.table as object, { status: 'busted', place: 2 })
  t.true(String(s.snapshots.at(-1)!.hand!.brief).endsWith('You are out in 2nd.'))

  remove()
  publisher.setTableContext(() => {
    throw new Error('store fault')
  })
  publisher.capture(hand, 1)
  await publisher.flush()
  t.true(publisher.getStatus().connected)
  t.is(s.snapshots.at(-1)!.hand!.table, null)
  // No hand, no table.
  publisher.capture(null, 0)
  publisher.refresh(null)
  await publisher.flush()
  t.is(s.snapshots.at(-1)!.hand, null)
})
