import test from 'ava'
import { liveSnapshot } from '@/lib/liveCoaching/state'
import { mulberry32, cardToString } from '@/lib/poker/cards'
import { startHand, applyAction, legalActions, isHandComplete } from '@/lib/poker/engine'

const context = {
  sessionId: 'test-private-session',
  version: 1,
  capturedAt: '2026-11-15T12:00:00.000Z',
  handNo: 1,
  heroId: 'hero',
}
const deal = () =>
  startHand({
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
