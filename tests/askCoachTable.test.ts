import test from 'ava'

// The coach's view of the table against the real stores, in Node: what
// `tableContext()` reads from `useGame`/`useProfile`, and what `currentHand()`
// describes at the moment the player asks, with `startAskCoach()` remembering what
// the store forgets. The game is played for real (AI timers run at once).
//
// What this cannot cover: a browser. The button, the card and the timing of real
// AI turns still need a hand played and asked about.

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
const { legalActions, isHandComplete } = await import('@/lib/poker/engine')
const { deriveReads, emptySeatStats } = await import('@/lib/reads')
const { currentHand, startAskCoach, tableContext } = await import('@/lib/askCoach/table')

const HERO = { name: 'Hero', avatar: { seed: 'hero', backgroundColor: 'b6e3f4' }, member: true }
/** A five-seat tournament with cast characters. */
const PUB = venueById('pub')!

/** The coach's memory of the store, as AppBoot starts it. */
function tracking(t: import('ava').ExecutionContext) {
  const stop = startAskCoach()
  t.teardown(() => {
    stop()
    useGame.getState().leave()
  })
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
  'at a hand’s end, the hand is described with the run status that followed',
  async (t) => {
    tracking(t)
    await fast(async () => {
      useGame.getState().sitDown(PUB, HERO)
      const status = await play((s) => s !== 'playing')
      const described = currentHand()!
      t.true(described.complete)
      t.is(described.table!.status, status)
      t.is(described.number, useGame.getState().handIndex)
    })
  },
)

test.serial('on the hero’s turn the panel’s own equity and price are in the hand', async (t) => {
  tracking(t)
  await fast(async () => {
    useGame.getState().sitDown(PUB, HERO)
    await play((s) => {
      const { hand } = useGame.getState()
      return s !== 'playing' || (!!hand && hand.players[hand.toActIndex]?.id === 'hero')
    })
  })
  const game = useGame.getState()
  t.truthy(game.hand && !isHandComplete(game.hand), 'never reached a hero turn')
  const described = currentHand()!
  t.is(described.currentPlayerToAct, 'hero')
  t.is(described.hero!.equity, game.heroEquity)
  t.is(described.hero!.toCall, legalActions(game.hand!)!.callAmount)
  // Another seat to act: no current equity, but this turn's estimate is remembered.
  useGame.setState({
    heroEquity: null,
    hand: { ...game.hand!, toActIndex: (game.hand!.toActIndex + 1) % game.hand!.players.length },
  })
  const later = currentHand()!
  t.is(later.hero!.equity, null)
  t.is(typeof game.heroEquity, 'number', 'the panel had no estimate to remember')
  t.is(later.hero!.lastEquity?.equity, game.heroEquity ?? undefined)
})

test.serial('busted, then spectating: the place the player really finished', async (t) => {
  tracking(t)
  await fast(async () => {
    t.true(await bustWithAFieldLeft(), 'never busted with a field left in 40 tries')
    const place = useGame.getState().place!
    const busted = currentHand()!
    t.like(busted.table, { status: 'busted', place })
    t.true(busted.brief.endsWith(`You are out in ${ordinal(place)}.`))

    useGame.getState().watchItOut()
    // The store itself goes watching → playing → busted for each spectated hand
    // (dealHand sets `playing`; the bust branch runs again at its end).
    await play((s) => s === 'playing')
    const watching = currentHand()!
    t.like(watching.table, { status: 'watching', place })
    t.true(
      watching.brief.endsWith(`You are out in ${ordinal(place)}, watching the table play out.`),
    )
    await play((s) => s === 'busted')
    t.like(currentHand()!.table, { status: 'busted', place })

    // If the store's recomputed place differs, the description keeps the real one.
    useGame.setState({ status: 'busted', place: Math.max(1, place - 1) })
    t.like(currentHand()!.table, { status: 'busted', place })
  })
})

test.serial('a new table forgets the last finishing place', async (t) => {
  tracking(t)
  await fast(async () => {
    t.true(await bustWithAFieldLeft())
    useGame.getState().leave()
    useGame.getState().sitDown(PUB, HERO)
    await play((s) => s !== 'playing')
    t.not(currentHand()!.table!.status, 'watching')
    t.like(currentHand()!.table, { place: useGame.getState().place })
  })
})

function ordinal(n: number) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

test.serial(
  'the card’s action count moves on the player’s own committed actions only',
  async (t) => {
    tracking(t)
    const { heroActions } = await import('@/lib/askCoach/table')
    t.is(heroActions({ hand: null }), 0)
    await fast(async () => {
      useGame.getState().sitDown(PUB, HERO)
      // Wait for the player's first turn: opponents may act first, and do not count.
      for (let i = 0; i < 2000; i++) {
        const game = useGame.getState()
        if (game.hand?.players[game.hand.toActIndex]?.id === 'hero') break
        if (game.status === 'handover') game.nextHand()
        await turn()
      }
    })
    const game = useGame.getState()
    t.is(game.hand?.players[game.hand.toActIndex]?.id, 'hero')
    // Opponents' actions so far do not count.
    t.is(heroActions(game), 0)
    const legal = legalActions(game.hand!)!
    game.act({ type: legal.canCheck ? 'check' : 'fold' })
    t.is(heroActions(useGame.getState()), 1)
  },
)
