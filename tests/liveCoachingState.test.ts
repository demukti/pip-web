import test from 'ava'
import { liveSnapshot } from '@/lib/liveCoaching/state'
import { mulberry32, cardToString } from '@/lib/poker/cards'
import {
  startHand,
  applyAction,
  legalActions,
  isHandComplete,
  type HandState,
} from '@/lib/poker/engine'

const context = {
  sessionId: 'test-private-session',
  version: 1,
  capturedAt: '2026-11-15T12:00:00.000Z',
  handNo: 1,
  heroId: 'hero',
}
const deal = (opts: { mystery?: boolean } = {}) =>
  startHand({
    ...opts,
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai1', name: 'One', stack: 150 },
      { id: 'ai2', name: 'Two', stack: 100 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })

test('initial unfinished state exposes the hero, public stacks and engine legal sizes', (t) => {
  const hand = deal()
  const result = liveSnapshot(hand, context).hand!
  t.false(result.complete)
  t.is(result.hero?.position, 'BTN')
  t.deepEqual(result.hero?.holeCards, hand.players[0].hole.map(cardToString))
  t.is(result.pot, 15)
  t.deepEqual(result.communityCards, [])
  t.deepEqual(result.availableActions, { playerId: 'hero', ...legalActions(hand) })
  t.deepEqual(result.effectiveRemainingStacks, [
    { opponentId: 'ai1', chips: 145 },
    { opponentId: 'ai2', chips: 90 },
  ])
})

test('projection never exposes deck, opponent cards or unknown engine extensions', (t) => {
  const hand = deal()
  const extended = { ...hand, privateFutureField: 'hidden-engine-extension' }
  const encoded = JSON.stringify(liveSnapshot(extended, context))
  const result = JSON.parse(encoded)
  t.false('deck' in result.hand)
  t.false(encoded.includes('hidden-engine-extension'))
  for (const player of result.hand.players) {
    t.false('hole' in player)
    t.false('mystery' in player)
  }
  for (const player of hand.players.slice(1)) {
    for (const card of player.hole) t.false(encoded.includes(JSON.stringify(cardToString(card))))
  }
  for (const card of hand.deck) t.false(encoded.includes(JSON.stringify(cardToString(card))))
})

/** Play to the end, checking or calling, through `fold` for any player listed. */
const playOut = (hand: HandState, folds: string[] = [], each?: (hand: HandState) => void) => {
  while (!isHandComplete(hand)) {
    each?.(hand)
    const actor = hand.players[hand.toActIndex].id
    const legal = legalActions(hand)!
    hand = applyAction(hand, {
      type: folds.includes(actor) ? 'fold' : legal.canCheck ? 'check' : 'call',
    })
  }
  return hand
}
/** Every card a player holds or will hold, the face-down Mystery Card included. */
const cardsOf = (player: HandState['players'][number]) =>
  [...player.hole, ...(player.mystery ? [player.mystery] : [])].map(cardToString)
const mentions = (encoded: string, card: string) => new RegExp(`\\b${card}\\b`).test(encoded)

test('in play, no opponent card or Mystery Card appears anywhere, on any street', (t) => {
  for (const mystery of [false, true]) {
    const checked = new Set<string>()
    playOut(deal({ mystery }), [], (hand) => {
      const snapshot = liveSnapshot(hand, context)
      const encoded = JSON.stringify(snapshot)
      t.is(snapshot.hand!.result, null)
      for (const player of hand.players) {
        // The hero sees their own face-up cards; nobody sees a Mystery Card yet.
        const hidden =
          player.id === 'hero' ? cardsOf(player).slice(player.hole.length) : cardsOf(player)
        for (const card of hidden) t.false(mentions(encoded, card), `${player.id} ${card}`)
      }
      checked.add(hand.street)
    })
    t.deepEqual([...checked], ['preflop', 'flop', 'turn', 'river'])
  }
})

test('showdown: the hands the table turned over, in seat order, and only those', (t) => {
  const hand = playOut(deal())
  t.true(hand.result!.showdown)
  const result = liveSnapshot(hand, context).hand!.result!
  const evaluations = hand.result!.evaluations!
  t.deepEqual(result.shownHands, [
    {
      playerId: 'hero',
      name: 'Hero',
      position: 'BTN',
      holeCards: cardsOf(hand.players[0]),
      // The table names the hero's own hand under their cards…
      handName: evaluations.hero.name,
    },
    {
      playerId: 'ai1',
      name: 'One',
      position: 'SB',
      holeCards: cardsOf(hand.players[1]),
      // …and the winner's in the result line…
      handName: evaluations.ai1.name,
    },
    // …but never a losing opponent's.
    { playerId: 'ai2', name: 'Two', position: 'BB', holeCards: cardsOf(hand.players[2]) },
  ])
  t.deepEqual(result.potsAwarded, [{ amount: 30, winners: ['ai1'] }])
})

test('showdown: a player who folded on the way is not shown, anywhere', (t) => {
  // Hero calls on the button, One folds the small blind, Two checks it down.
  const hand = playOut(deal(), ['ai1'])
  t.true(hand.result!.showdown)
  t.is(hand.players[1].status, 'folded')
  const snapshot = liveSnapshot(hand, context)
  t.deepEqual(
    snapshot.hand!.result!.shownHands.map((shown) => shown.playerId),
    ['hero', 'ai2'],
  )
  const encoded = JSON.stringify(snapshot)
  for (const card of cardsOf(hand.players[1])) t.false(mentions(encoded, card))
  for (const card of cardsOf(hand.players[2])) t.true(mentions(snapshot.hand!.brief, card))
})

test('won without a showdown: nothing is shown and no opponent card appears', (t) => {
  for (const mystery of [false, true]) {
    // Hero calls, One raises, everyone else folds: One takes it unseen.
    let hand = applyAction(deal({ mystery }), { type: 'call' })
    hand = applyAction(hand, { type: 'raise', amount: 40 })
    hand = playOut(hand, ['hero', 'ai2'])
    t.false(hand.result!.showdown)
    const snapshot = liveSnapshot(hand, context)
    t.deepEqual(snapshot.hand!.result!.shownHands, [])
    const encoded = JSON.stringify(snapshot)
    for (const player of hand.players.slice(1))
      for (const card of cardsOf(player)) t.false(mentions(encoded, card))
    t.false(snapshot.hand!.brief.includes('showed'))
  }
})

test('Mystery Card: the turned-over card is shown at showdown, a folded one never', (t) => {
  const hand = playOut(deal({ mystery: true }), ['ai1'])
  t.true(hand.result!.showdown)
  // The folded hand keeps its Mystery Card face down.
  t.truthy(hand.players[1].mystery)
  const snapshot = liveSnapshot(hand, context)
  const shown = snapshot.hand!.result!.shownHands
  t.deepEqual(
    shown.map((s) => [s.playerId, s.holeCards.length]),
    [
      ['hero', 2],
      ['ai2', 2],
    ],
  )
  t.deepEqual(shown[1].holeCards, hand.players[2].hole.map(cardToString))
  const encoded = JSON.stringify(snapshot)
  for (const card of cardsOf(hand.players[1])) t.false(mentions(encoded, card))
})

test('several real moves produce fresh unfinished snapshots without mutating earlier ones', (t) => {
  let hand = deal()
  const initial = liveSnapshot(hand, context)
  const frozen = JSON.stringify(initial)
  const streets = new Set<string>()
  for (let i = 1; i <= 6; i++) {
    const legal = legalActions(hand)!
    hand = applyAction(hand, { type: legal.canCheck ? 'check' : 'call' })
    const snapshot = liveSnapshot(hand, { ...context, version: i + 1 })
    t.is(snapshot.version, i + 1)
    t.is(snapshot.hand?.actionHistory.length, i)
    t.false(snapshot.hand!.complete)
    streets.add(snapshot.hand!.street)
  }
  t.true(streets.has('preflop'))
  t.true(streets.has('flop'))
  t.true(streets.has('turn'))
  t.is(JSON.stringify(initial), frozen)
})

test('completed hands have no actor/actions and leaving clears the current hand', (t) => {
  let hand = deal()
  while (!isHandComplete(hand)) hand = applyAction(hand, { type: 'fold' })
  const result = liveSnapshot(hand, context).hand!
  t.true(result.complete)
  t.is(result.currentPlayerToAct, null)
  t.is(result.availableActions, null)
  t.true(result.potAwarded)
  t.is(liveSnapshot(null, { ...context, version: 2 }).hand, null)
})

test('heads-up button is the small blind and metadata must be valid', (t) => {
  const hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Opponent', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(1),
  })
  t.is(liveSnapshot(hand, context).hand!.hero?.position, 'BTN/SB')
  t.throws(() => liveSnapshot(hand, { ...context, version: 0 }))
  t.throws(() => liveSnapshot(hand, { ...context, capturedAt: 'invalid' }))
})

test('equity carries the existing estimate with the same rounded percentage as Pip', (t) => {
  for (const [equity, display] of [
    [0, '0%'],
    [0.72493, '72%'],
    [1, '100%'],
  ] as const) {
    const hero = liveSnapshot(deal(), { ...context, displayedEquity: equity }).hand!.hero!
    t.is(hero.equity, equity)
    t.is(hero.equityDisplay, display)
  }
  for (const equity of [null, undefined, NaN, Infinity, -0.1, 1.1]) {
    const hero = liveSnapshot(deal(), { ...context, displayedEquity: equity }).hand!.hero!
    t.is(hero.equity, null)
    t.is(hero.equityDisplay, '—')
  }
})

test('a prior-turn estimate is never carried into an AI turn or a finished hand', (t) => {
  const aiTurn = applyAction(deal(), { type: 'call' })
  t.not(aiTurn.players[aiTurn.toActIndex].id, 'hero')
  t.is(liveSnapshot(aiTurn, { ...context, displayedEquity: 0.72 }).hand!.hero!.equity, null)
  let complete = deal()
  while (!isHandComplete(complete)) complete = applyAction(complete, { type: 'fold' })
  t.is(liveSnapshot(complete, { ...context, displayedEquity: 0.72 }).hand!.hero!.equity, null)
})

test('hero price fields: stack, engine call amount and pot odds on the hero turn only', (t) => {
  const preflop = liveSnapshot(deal(), context).hand!
  t.is(preflop.hero?.stack, 200)
  t.is(preflop.hero?.toCall, 10)
  // 10 to call into 15: 10 / (15 + 10).
  t.is(preflop.hero?.potOdds, 0.4)
  let hand = applyAction(deal(), { type: 'call' })
  const aiTurn = liveSnapshot(hand, context).hand!
  t.is(aiTurn.hero?.stack, 190)
  t.is(aiTurn.hero?.toCall, null)
  t.is(aiTurn.hero?.potOdds, null)
  hand = applyAction(applyAction(hand, { type: 'call' }), { type: 'check' })
  hand = applyAction(hand, { type: 'check' })
  hand = applyAction(hand, { type: 'check' })
  const check = liveSnapshot(hand, context).hand!
  t.is(check.currentPlayerToAct, 'hero')
  t.is(check.hero?.toCall, 0)
  t.is(check.hero?.potOdds, null)
})

test('pot odds are the call over the pot after calling', (t) => {
  let hand = applyAction(deal(), { type: 'call' })
  hand = applyAction(applyAction(hand, { type: 'call' }), { type: 'check' })
  hand = applyAction(applyAction(hand, { type: 'bet', amount: 20 }), { type: 'call' })
  const result = liveSnapshot(hand, context).hand!
  t.is(result.pot, 70)
  t.is(result.hero?.toCall, legalActions(hand)!.callAmount)
  t.is(result.hero?.toCall, 20)
  t.is(result.hero?.potOdds, 20 / 90)
})

test('action history names each actor and their position', (t) => {
  let hand = applyAction(deal(), { type: 'call' })
  hand = applyAction(hand, { type: 'fold' })
  t.deepEqual(liveSnapshot(hand, context).hand!.actionHistory, [
    {
      playerId: 'hero',
      street: 'preflop',
      type: 'call',
      committedTo: 10,
      name: 'Hero',
      position: 'BTN',
    },
    {
      playerId: 'ai1',
      street: 'preflop',
      type: 'fold',
      committedTo: 5,
      name: 'One',
      position: 'SB',
    },
  ])
})

test('brief: preflop on the hero turn', (t) => {
  const hand = deal()
  const [a, b] = hand.players[0].hole.map(cardToString)
  t.is(
    liveSnapshot(hand, { ...context, displayedEquity: 0.72 }).hand!.brief,
    `Hand 1, preflop. You are BTN with ${a} ${b}, 200 behind. Pot 15. Your turn: 10 to call, pot odds 40%. Equity 72%.`,
  )
})

test('brief: facing a bet on the flop', (t) => {
  let hand = applyAction(deal(), { type: 'call' })
  hand = applyAction(applyAction(hand, { type: 'call' }), { type: 'check' })
  hand = applyAction(applyAction(hand, { type: 'bet', amount: 20 }), { type: 'call' })
  const [a, b] = hand.players[0].hole.map(cardToString)
  const board = hand.community.map(cardToString).join(' ')
  t.is(
    liveSnapshot(hand, { ...context, handNo: 12, displayedEquity: 0.5 }).hand!.brief,
    `Hand 12, flop. You are BTN with ${a} ${b}, 190 behind. Board ${board}. Pot 70. Your turn: 20 to call, pot odds 22%. Equity 50%.`,
  )
})

test('brief: completed hands report the public result only', (t) => {
  let folded = deal()
  while (!isHandComplete(folded)) folded = applyAction(folded, { type: 'fold' })
  const [a, b] = folded.players[0].hole.map(cardToString)
  t.is(
    liveSnapshot(folded, context).hand!.brief,
    `Hand 1, complete. You are BTN with ${a} ${b}, 200 behind. You folded. Two won 15 without a showdown.`,
  )
  let shown = deal()
  while (!isHandComplete(shown)) {
    const legal = legalActions(shown)!
    shown = applyAction(shown, { type: legal.canCheck ? 'check' : 'call' })
  }
  const brief = liveSnapshot(shown, context).hand!.brief
  const board = shown.community.map(cardToString).join(' ')
  const [one, two] = shown.players.slice(1).map((player) => cardsOf(player).join(' '))
  // At showdown the brief says what the table turned over, and nothing more.
  t.is(
    brief,
    `Hand 1, complete. You are BTN with ${a} ${b}, 190 behind. Board ${board}. One won 30 at showdown. You showed ${a} ${b}, One showed ${one}, Two showed ${two}.`,
  )
})

test('brief: waiting on an AI, nothing to call, absent hero, never currency', (t) => {
  const aiTurn = applyAction(deal(), { type: 'call' })
  t.true(liveSnapshot(aiTurn, context).hand!.brief.endsWith('Pot 25. One (SB) to act.'))
  let hand = applyAction(applyAction(aiTurn, { type: 'call' }), { type: 'check' })
  hand = applyAction(applyAction(hand, { type: 'check' }), { type: 'check' })
  t.true(liveSnapshot(hand, context).hand!.brief.endsWith('Your turn, nothing to call.'))
  const absent = liveSnapshot(deal(), { ...context, heroId: 'nobody' }).hand!
  t.is(absent.hero, null)
  t.is(absent.brief, 'Hand 1, preflop. You are not in this hand. Pot 15. Hero (BTN) to act.')
  for (const snapshot of [aiTurn, hand, deal()])
    t.false(/\$|dollar|usd|€|£/i.test(liveSnapshot(snapshot, context).hand!.brief))
})

test('lastEquity keeps the latest hero-turn estimate separately from equity', (t) => {
  const heroTurn = liveSnapshot(deal(), { ...context, displayedEquity: 0.72 }).hand!.hero!
  t.deepEqual(heroTurn.lastEquity, { equity: 0.72, equityDisplay: '72%', street: 'preflop' })
  const aiTurn = applyAction(deal(), { type: 'call' })
  const remembered = liveSnapshot(aiTurn, {
    ...context,
    displayedEquity: 0.72,
    lastEquity: { equity: 0.72, street: 'preflop' },
  }).hand!
  t.is(remembered.hero!.equity, null)
  t.is(remembered.hero!.equityDisplay, '—')
  t.deepEqual(remembered.hero!.lastEquity, {
    equity: 0.72,
    equityDisplay: '72%',
    street: 'preflop',
  })
  t.true(remembered.brief.endsWith('One (SB) to act. Last estimate 72% preflop.'))
  for (const bad of [
    null,
    undefined,
    { equity: 1.2, street: 'flop' },
    { equity: NaN, street: 'flop' },
  ])
    t.is(liveSnapshot(aiTurn, { ...context, lastEquity: bad }).hand!.hero!.lastEquity, null)
})
