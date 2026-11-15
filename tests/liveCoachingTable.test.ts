import test from 'ava'

// The table context against the real stores, in Node: what `tableContext()`
// reads from `useGame`/`useProfile`, and the run-status re-publish that
// `startTableContext()` subscribes. The game is played for real (AI timers run
// at once); the publisher talks to a small in-memory stand-in for the service.
//
// What this cannot cover: a browser. The badge, the dialog itself and the
// timing of real AI turns still need a hand played with sharing on.

// Storage before the stores are imported, as in tests/castTalk.test.ts.
const storage = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
})

const { useGame } = await import('@/store/game')
const { useProfile } = await import('@/store/profile')
const { venueById } = await import('@/config/venues')
const { legalActions } = await import('@/lib/poker/engine')
const { deriveReads, emptySeatStats } = await import('@/lib/reads')
const { LivePublisher, livePublisher } = await import('@/lib/liveCoaching/publisher')
const { startTableContext, tableContext } = await import('@/lib/liveCoaching/tableContext')

const HERO = { name: 'Hero', avatar: { seed: 'hero', backgroundColor: 'b6e3f4' }, member: true }
/** A five-seat tournament with cast characters. */
const PUB = venueById('pub')!

type Snapshot = {
  version: number
  hand: {
    number: number
    complete: boolean
    table: { status: string; place: number | null } | null
    brief: string
  } | null
}

/** The service's publishing routes, in memory: enough for a publisher to stay connected. */
function service() {
  const snapshots: Snapshot[] = []
  let version = 0
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetcher: typeof fetch = async (input, init) => {
    const route = `${init?.method} ${new URL(String(input)).pathname}`
    const body = init?.body ? JSON.parse(init.body as string) : {}
    if (route === 'POST /sessions')
      return json({ sessionId: 's', token: 't', version: 0, expiresAt: Date.now() + 1e7 })
    if (route === 'POST /heartbeat') return json({ acceptedVersion: version })
    if (route === 'PUT /publish') {
      if (body.version <= version) return json({ acceptedVersion: version }, 409)
      version = body.version
      snapshots.push(body)
      return json({ acceptedVersion: version })
    }
    return json({ revoked: true })
  }
  return { snapshots, fetcher }
}

/**
 * A publisher of the test's own, fed every capture the game store makes (the
 * store calls the app's singleton) and given the table context.
 */
async function sharing(t: import('ava').ExecutionContext) {
  const { snapshots, fetcher } = service()
  const values = new Map<string, string>()
  const publisher = new LivePublisher(
    () => ({
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    }),
    fetcher,
    { on: () => () => {} },
  )
  await publisher.connect('https://state.example', 'k'.repeat(40))
  const original = livePublisher.capture
  livePublisher.capture = (...args) => publisher.capture(...args)
  const stop = startTableContext(publisher)
  t.teardown(() => {
    stop()
    livePublisher.capture = original
  })
  const latest = async () => {
    await publisher.flush()
    return snapshots.at(-1)!
  }
  return { snapshots, latest, publisher }
}

const realSetTimeout = globalThis.setTimeout
const turn = () => new Promise((resolve) => setImmediate(resolve))

/** Store timers (AI turns, the spectator pause) run at once while `fn` runs. */
async function fast<T>(fn: () => Promise<T>): Promise<T> {
  globalThis.setTimeout = ((handler: () => void) => realSetTimeout(handler, 0)) as typeof setTimeout
  try {
    return await fn()
  } finally {
    globalThis.setTimeout = realSetTimeout
  }
}

/** Shove every hero turn; deal on from each handover; stop at `until`. */
async function play(until: (status: string) => boolean, limit = 20_000) {
  for (let i = 0; i < limit; i++) {
    const game = useGame.getState()
    if (until(game.status)) return game.status
    if (game.status === 'handover') game.nextHand()
    else if (game.hand && game.hand.players[game.hand.toActIndex]?.id === 'hero') {
      const legal = legalActions(game.hand)!
      game.act(
        legal.canRaise || legal.canBet
          ? { type: legal.canRaise ? 'raise' : 'bet', amount: legal.maxRaiseTo }
          : { type: legal.canCall ? 'call' : 'check' },
      )
    }
    await turn()
  }
  return useGame.getState().status
}

/** Sit down and shove until busted with at least three players left (so watching is offered). */
async function bustWithAFieldLeft() {
  for (let attempt = 0; attempt < 40; attempt++) {
    useGame.getState().sitDown(PUB, HERO)
    const status = await play((s) => s === 'busted' || s === 'won')
    const live = useGame.getState().seats.filter((s) => s.stack > 0).length
    if (status === 'busted' && live >= 3) return true
    useGame.getState().leave()
  }
  return false
}

test.serial('tableContext: style and reads exactly as each seat’s dialog shows them', (t) => {
  useGame.getState().sitDown(PUB, HERO)
  t.teardown(() => useGame.getState().leave())
  const { seats } = useGame.getState()
  const cast = seats.find((s) => !s.isHuman && s.characterId)
  t.truthy(cast, 'the venue seats no cast character')
  // Ten hands of table stats for everybody, the hero included.
  const plenty = { ...emptySeatStats(), handsDealt: 10, vpipHands: 2, raises: 1, calls: 5 }
  useGame.setState({
    seatStats: Object.fromEntries(seats.map((s) => [s.id, plenty])),
  })
  // A career record outranks this table's stats, as in PlayerDialog.
  const career = { ...emptySeatStats(), handsDealt: 40, vpipHands: 30, raises: 20, calls: 4 }
  const castRecords = useProfile.getState().castRecords
  useProfile.setState({
    castRecords: { ...castRecords, [cast!.characterId!]: { stats: career, kos: 0 } },
  })
  t.teardown(() => useProfile.setState({ castRecords }))

  const context = tableContext()!
  t.is(context.venue, PUB.name)
  t.is(context.format, 'tournament')
  t.is(context.blindLevel, useGame.getState().blindLevel + 1)
  for (const seat of seats) {
    const shown = context.players[seat.id]
    t.is(shown.style, seat.style ?? null, seat.id)
    if (seat.isHuman) {
      t.deepEqual(shown.reads, [], 'the hero is read')
      continue
    }
    const record = seat.characterId
      ? useProfile.getState().castRecords[seat.characterId]
      : undefined
    const expected = deriveReads(record?.stats ?? plenty)!.map((read) => read.label)
    t.deepEqual(shown.reads, expected, seat.id)
  }
  t.deepEqual(
    context.players[cast!.id].reads,
    deriveReads(career)!.map((read) => read.label),
  )
  t.not(
    JSON.stringify(deriveReads(career)!.map((r) => r.label)),
    JSON.stringify(deriveReads(plenty)!.map((r) => r.label)),
    'career and table stats should read differently, or this checks nothing',
  )
  // Too few hands: nothing to go on, as the dialog says.
  useGame.setState({ seatStats: {} })
  useProfile.setState({ castRecords: {} })
  for (const seat of seats) t.deepEqual(tableContext()!.players[seat.id].reads, [])
})

test.serial(
  'each hand end republishes the finished hand with the run status that followed',
  async (t) => {
    const { snapshots, latest } = await sharing(t)
    t.teardown(() => useGame.getState().leave())
    await fast(async () => {
      useGame.getState().sitDown(PUB, HERO)
      const status = await play((s) => s !== 'playing')
      const last = await latest()
      t.is(last.hand!.table!.status, status)
      t.true(last.hand!.complete)
      // Twice for the one hand: at completion (still `playing`), then settled.
      const finished = snapshots.filter(
        (s) => s.hand?.number === last.hand!.number && s.hand.complete,
      )
      t.deepEqual(
        finished.map((s) => s.hand!.table!.status),
        ['playing', status],
      )
    })
  },
)

test.serial(
  'busting publishes the place; spectating reads as watching with that place',
  async (t) => {
    const { snapshots, latest } = await sharing(t)
    t.teardown(() => useGame.getState().leave())
    await fast(async () => {
      t.true(await bustWithAFieldLeft(), 'never busted with a field left in 40 tries')
      const place = useGame.getState().place!
      const busted = await latest()
      t.like(busted.hand!.table, { status: 'busted', place })
      t.true(busted.hand!.brief.endsWith(`You are out in ${ordinal(place)}.`))

      const from = snapshots.length
      useGame.getState().watchItOut()
      // The store itself goes watching → playing → busted for each spectated
      // hand (dealHand sets `playing`; the bust branch runs again at its end).
      await play((s) => s === 'busted')
      await latest()
      const spectated = snapshots.slice(from).filter((s) => s.hand?.table)
      t.true(spectated.length > 1)
      for (const s of spectated.slice(0, -1)) {
        t.like(s.hand!.table, { status: 'watching', place }, `v${s.version}`)
        t.true(
          s.hand!.brief.endsWith(`You are out in ${ordinal(place)}, watching the table play out.`),
        )
      }
      t.like(spectated.at(-1)!.hand!.table, { status: 'busted', place })

      // If the store's recomputed place differs, the snapshot keeps the real one.
      useGame.setState({ status: 'watching' })
      useGame.setState({ status: 'busted', place: Math.max(1, place - 1) })
      t.like((await latest()).hand!.table, { status: 'busted', place })
    })
  },
)

test.serial('a new table forgets the last finishing place', async (t) => {
  const { latest } = await sharing(t)
  t.teardown(() => useGame.getState().leave())
  await fast(async () => {
    t.true(await bustWithAFieldLeft())
    useGame.getState().leave()
    useGame.getState().sitDown(PUB, HERO)
    await play((s) => s !== 'playing')
    t.not((await latest()).hand!.table!.status, 'watching')
    t.like((await latest()).hand!.table, { place: useGame.getState().place })
  })
})

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
