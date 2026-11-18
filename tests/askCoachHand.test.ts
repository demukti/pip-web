import test from 'ava'
import { describeHand, type TableContext } from '@/lib/askCoach/hand'
import { holeKey } from '@/config/handNames'
import { classOf, nashFor, shoveEv } from '@/lib/drills/shoveRange'
import { mulberry32, cardToString } from '@/lib/poker/cards'
import { evaluateHand, handPhrase } from '@/lib/poker/handEval'
import {
  startHand,
  applyAction,
  legalActions,
  isHandComplete,
  type HandState,
} from '@/lib/poker/engine'

const context = {
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
  const result = describeHand(hand, context)!
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
  const encoded = JSON.stringify(describeHand(extended, context))
  const result = JSON.parse(encoded)
  t.false('deck' in result)
  t.false(encoded.includes('hidden-engine-extension'))
  for (const player of result.players) {
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
      const described = describeHand(hand, context)
      const encoded = JSON.stringify(described)
      t.is(described!.result, null)
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
  const result = describeHand(hand, context)!.result!
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
  const described = describeHand(hand, context)
  t.deepEqual(
    described!.result!.shownHands.map((shown) => shown.playerId),
    ['hero', 'ai2'],
  )
  const encoded = JSON.stringify(described)
  for (const card of cardsOf(hand.players[1])) t.false(mentions(encoded, card))
  for (const card of cardsOf(hand.players[2])) t.true(mentions(described!.brief, card))
})

test('won without a showdown: nothing is shown and no opponent card appears', (t) => {
  for (const mystery of [false, true]) {
    // Hero calls, One raises, everyone else folds: One takes it unseen.
    let hand = applyAction(deal({ mystery }), { type: 'call' })
    hand = applyAction(hand, { type: 'raise', amount: 40 })
    hand = playOut(hand, ['hero', 'ai2'])
    t.false(hand.result!.showdown)
    const described = describeHand(hand, context)
    t.deepEqual(described!.result!.shownHands, [])
    const encoded = JSON.stringify(described)
    for (const player of hand.players.slice(1))
      for (const card of cardsOf(player)) t.false(mentions(encoded, card))
    t.false(described!.brief.includes('showed'))
  }
})

test('Mystery Card: the turned-over card is shown at showdown, a folded one never', (t) => {
  const hand = playOut(deal({ mystery: true }), ['ai1'])
  t.true(hand.result!.showdown)
  // The folded hand keeps its Mystery Card face down.
  t.truthy(hand.players[1].mystery)
  const described = describeHand(hand, context)
  const shown = described!.result!.shownHands
  t.deepEqual(
    shown.map((s) => [s.playerId, s.holeCards.length]),
    [
      ['hero', 2],
      ['ai2', 2],
    ],
  )
  t.deepEqual(shown[1].holeCards, hand.players[2].hole.map(cardToString))
  const encoded = JSON.stringify(described)
  for (const card of cardsOf(hand.players[1])) t.false(mentions(encoded, card))
})

test('several real moves give fresh unfinished descriptions without mutating earlier ones', (t) => {
  let hand = deal()
  const initial = describeHand(hand, context)
  const frozen = JSON.stringify(initial)
  const streets = new Set<string>()
  for (let i = 1; i <= 6; i++) {
    const legal = legalActions(hand)!
    hand = applyAction(hand, { type: legal.canCheck ? 'check' : 'call' })
    const described = describeHand(hand, context)!
    t.is(described.actionHistory.length, i)
    t.false(described.complete)
    streets.add(described.street)
  }
  t.true(streets.has('preflop'))
  t.true(streets.has('flop'))
  t.true(streets.has('turn'))
  t.is(JSON.stringify(initial), frozen)
})

test('completed hands have no actor/actions and leaving clears the current hand', (t) => {
  let hand = deal()
  while (!isHandComplete(hand)) hand = applyAction(hand, { type: 'fold' })
  const result = describeHand(hand, context)!
  t.true(result.complete)
  t.is(result.currentPlayerToAct, null)
  t.is(result.availableActions, null)
  t.true(result.potAwarded)
  t.is(describeHand(null, context), null)
})

test('heads-up button is the small blind', (t) => {
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
  t.is(describeHand(hand, context)!.hero?.position, 'BTN/SB')
})

test('equity carries the existing estimate with the same rounded percentage as Pip', (t) => {
  for (const [equity, display] of [
    [0, '0%'],
    [0.72493, '72%'],
    [1, '100%'],
  ] as const) {
    const hero = describeHand(deal(), { ...context, displayedEquity: equity })!.hero!
    t.is(hero.equity, equity)
    t.is(hero.equityDisplay, display)
  }
  for (const equity of [null, undefined, NaN, Infinity, -0.1, 1.1]) {
    const hero = describeHand(deal(), { ...context, displayedEquity: equity })!.hero!
    t.is(hero.equity, null)
    t.is(hero.equityDisplay, '—')
  }
})

test('a prior-turn estimate is never carried into an AI turn or a finished hand', (t) => {
  const aiTurn = applyAction(deal(), { type: 'call' })
  t.not(aiTurn.players[aiTurn.toActIndex].id, 'hero')
  t.is(describeHand(aiTurn, { ...context, displayedEquity: 0.72 })!.hero!.equity, null)
  let complete = deal()
  while (!isHandComplete(complete)) complete = applyAction(complete, { type: 'fold' })
  t.is(describeHand(complete, { ...context, displayedEquity: 0.72 })!.hero!.equity, null)
})

test('hero price fields: stack, engine call amount and pot odds on the hero turn only', (t) => {
  const preflop = describeHand(deal(), context)!
  t.is(preflop.hero?.stack, 200)
  t.is(preflop.hero?.toCall, 10)
  // 10 to call into 15: 10 / (15 + 10).
  t.is(preflop.hero?.potOdds, 0.4)
  let hand = applyAction(deal(), { type: 'call' })
  const aiTurn = describeHand(hand, context)!
  t.is(aiTurn.hero?.stack, 190)
  t.is(aiTurn.hero?.toCall, null)
  t.is(aiTurn.hero?.potOdds, null)
  hand = applyAction(applyAction(hand, { type: 'call' }), { type: 'check' })
  hand = applyAction(hand, { type: 'check' })
  hand = applyAction(hand, { type: 'check' })
  const check = describeHand(hand, context)!
  t.is(check.currentPlayerToAct, 'hero')
  t.is(check.hero?.toCall, 0)
  t.is(check.hero?.potOdds, null)
})

test('pot odds are the call over the pot after calling', (t) => {
  let hand = applyAction(deal(), { type: 'call' })
  hand = applyAction(applyAction(hand, { type: 'call' }), { type: 'check' })
  hand = applyAction(applyAction(hand, { type: 'bet', amount: 20 }), { type: 'call' })
  const result = describeHand(hand, context)!
  t.is(result.pot, 70)
  t.is(result.hero?.toCall, legalActions(hand)!.callAmount)
  t.is(result.hero?.toCall, 20)
  t.is(result.hero?.potOdds, 20 / 90)
})

test('action history names each actor and their position', (t) => {
  let hand = applyAction(deal(), { type: 'call' })
  hand = applyAction(hand, { type: 'fold' })
  t.deepEqual(describeHand(hand, context)!.actionHistory, [
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

const dealDeep = (stacks: [number, number, number]) =>
  startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: stacks[0] },
      { id: 'ai1', name: 'One', stack: stacks[1] },
      { id: 'ai2', name: 'Two', stack: stacks[2] },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })

test('hero.firstIn: folded round to the hero, the spot as a chart names it', (t) => {
  // Three-handed on the button: two players behind, 150 big blinds against the biggest.
  const hand = dealDeep([2000, 1500, 1000])
  const firstIn = describeHand(hand, context)!.hero?.firstIn
  t.deepEqual(firstIn, {
    seat: 'btn',
    playersBehind: 2,
    playersDealt: 3,
    stackBb: 150,
    handClass: holeKey(hand.players[0].hole),
    // Deep: the service's solved chart answers, not the shove chart.
    shoveChart: null,
  })
  t.regex(firstIn?.handClass ?? '', /^[AKQJT2-9]{2}[so]?$/)
})

test('hero.firstIn: a short stack carries the shove chart’s own answer', (t) => {
  const hand = deal() // 200 against 150 at a big blind of 10: fifteen big blinds
  const hole = hand.players[0].hole
  const firstIn = describeHand(hand, context)!.hero?.firstIn
  const value = shoveEv(
    classOf(hole),
    { seat: 'btn', stack: 15 },
    nashFor({ seat: 'btn', stack: 15 }).call,
  )
  t.like(firstIn, { seat: 'btn', stackBb: 15, handClass: holeKey(hole) })
  t.deepEqual(firstIn?.shoveChart, {
    stackBb: 15,
    verdict: Math.abs(value.ev) <= value.band ? 'close' : value.ev > 0 ? 'shove' : 'fold',
    shoveValueBb: Math.round(value.ev * 100) / 100,
    marginBb: Math.round(value.band * 100) / 100,
  })
  // A stack under the chart's three big blinds is read at three.
  const tiny = describeHand(dealDeep([25, 1500, 1000]), context)!.hero?.firstIn
  t.like(tiny, { stackBb: 2.5, shoveChart: { stackBb: 3 } })
})

test('hero.firstIn: null once anybody has come in, off the hero’s turn, and after the flop', (t) => {
  let hand = dealDeep([2000, 1500, 1000])
  hand = applyAction(hand, { type: 'call' }) // the hero limps the button
  t.is(describeHand(hand, context)!.hero?.firstIn, null) // the small blind to act
  hand = applyAction(hand, { type: 'call' })
  hand = applyAction(hand, { type: 'check' })
  t.is(hand.street, 'flop')
  for (; hand.players[hand.toActIndex].id !== 'hero'; hand = applyAction(hand, { type: 'check' }));
  t.is(describeHand(hand, context)!.hero?.firstIn, null)

  // In the big blind with a raise in front: facing a bet, not first in.
  let raised = startHand({
    seats: [
      { id: 'ai1', name: 'One', stack: 1500 },
      { id: 'ai2', name: 'Two', stack: 1000 },
      { id: 'hero', name: 'Hero', stack: 2000 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })
  raised = applyAction(raised, { type: 'raise', amount: 25 })
  raised = applyAction(raised, { type: 'fold' })
  t.is(raised.players[raised.toActIndex].id, 'hero')
  t.is(describeHand(raised, { ...context })!.hero?.firstIn, null)
})

const threeHanded = (button: number, stacks = [2000, 1500, 1000]) =>
  startHand({
    seats: [
      { id: 'ai1', name: 'One', stack: stacks[1] },
      { id: 'ai2', name: 'Two', stack: stacks[2] },
      { id: 'hero', name: 'Hero', stack: stacks[0] },
    ],
    buttonIndex: button,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })

test('hero.facing: one raise in ahead, as a chart names the spot', (t) => {
  // The button raises, the small blind folds, the hero is the big blind.
  let hand = threeHanded(0)
  hand = applyAction(hand, { type: 'raise', amount: 25 })
  hand = applyAction(hand, { type: 'fold' })
  const described = describeHand(hand, context)!
  t.deepEqual(described.hero?.facing, {
    kind: 'raise',
    raiseToBb: 2.5,
    seat: 'bb',
    opener: 'btn',
    playersDealt: 3,
    stackBb: 150, // the raiser's 1,500 against the hero's 2,000
    handClass: holeKey(hand.players[2].hole),
  })
  t.is(described.hero?.firstIn, null)
})

test('hero.facing: null with a caller in between, a limper, an all-in, or the hero already in', (t) => {
  // A raise and a call: a different spot (a squeeze), not charted.
  let called = threeHanded(0)
  called = applyAction(called, { type: 'raise', amount: 25 })
  called = applyAction(called, { type: 'call' })
  t.is(describeHand(called, context)!.hero?.facing, null)
  // A limp three-handed is not charted either.
  let limped = threeHanded(0)
  limped = applyAction(limped, { type: 'call' })
  limped = applyAction(limped, { type: 'fold' })
  t.is(describeHand(limped, context)!.hero?.facing, null)
  // The raiser is all in: a call-or-fold on equity, not the chart's raise.
  let shoved = threeHanded(0, [2000, 60, 1000])
  shoved = applyAction(shoved, { type: 'raise', amount: 60 })
  shoved = applyAction(shoved, { type: 'fold' })
  t.is(shoved.players[shoved.toActIndex].id, 'hero')
  t.is(describeHand(shoved, context)!.hero?.facing, null)
  // The hero opened and was re-raised: no longer a first decision.
  let reraised = threeHanded(2)
  t.is(reraised.players[reraised.toActIndex].id, 'hero')
  t.is(describeHand(reraised, context)!.hero?.facing, null) // first in, nobody ahead
  reraised = applyAction(reraised, { type: 'raise', amount: 25 })
  reraised = applyAction(reraised, { type: 'raise', amount: 80 })
  reraised = applyAction(reraised, { type: 'fold' })
  t.is(reraised.players[reraised.toActIndex].id, 'hero')
  t.is(describeHand(reraised, context)!.hero?.facing, null)
})

test('hero.facing: heads-up, the small blind is the button, and its limp is a spot', (t) => {
  const headsUp = () =>
    startHand({
      seats: [
        { id: 'ai1', name: 'One', stack: 800 },
        { id: 'hero', name: 'Hero', stack: 1200 },
      ],
      buttonIndex: 0,
      smallBlind: 5,
      bigBlind: 10,
      rng: mulberry32(42),
    })
  const raised = applyAction(headsUp(), { type: 'raise', amount: 25 })
  t.like(describeHand(raised, context)!.hero?.facing, {
    kind: 'raise',
    seat: 'bb',
    opener: 'sb',
    playersDealt: 2,
    stackBb: 80,
  })
  const limped = applyAction(headsUp(), { type: 'call' })
  t.like(describeHand(limped, context)!.hero?.facing, { kind: 'limp', raiseToBb: null, seat: 'bb' })
})

test('brief: preflop on the hero turn', (t) => {
  const hand = deal()
  const [a, b] = hand.players[0].hole.map(cardToString)
  t.is(
    describeHand(hand, { ...context, displayedEquity: 0.72 })!.brief,
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
    describeHand(hand, { ...context, handNo: 12, displayedEquity: 0.5 })!.brief,
    `Hand 12, flop. You are BTN with ${a} ${b}, 190 behind. Board ${board}. You have a pair. Pot 70. Your turn: 20 to call, pot odds 22%. Equity 50%.`,
  )
})

test('brief: completed hands report the public result only', (t) => {
  let folded = deal()
  while (!isHandComplete(folded)) folded = applyAction(folded, { type: 'fold' })
  const [a, b] = folded.players[0].hole.map(cardToString)
  t.is(
    describeHand(folded, context)!.brief,
    `Hand 1, complete. You are BTN with ${a} ${b}, 200 behind. You folded. Two won 15 without a showdown.`,
  )
  let shown = deal()
  while (!isHandComplete(shown)) {
    const legal = legalActions(shown)!
    shown = applyAction(shown, { type: legal.canCheck ? 'check' : 'call' })
  }
  const brief = describeHand(shown, context)!.brief
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
  t.true(describeHand(aiTurn, context)!.brief.endsWith('Pot 25. One (SB) to act.'))
  let hand = applyAction(applyAction(aiTurn, { type: 'call' }), { type: 'check' })
  hand = applyAction(applyAction(hand, { type: 'check' }), { type: 'check' })
  t.true(describeHand(hand, context)!.brief.endsWith('Your turn, nothing to call.'))
  const absent = describeHand(deal(), { ...context, heroId: 'nobody' })!
  t.is(absent.hero, null)
  t.is(absent.brief, 'Hand 1, preflop. You are not in this hand. Pot 15. Hero (BTN) to act.')
  for (const described of [aiTurn, hand, deal()])
    t.false(/\$|dollar|usd|€|£/i.test(describeHand(described, context)!.brief))
})

test('lastEquity keeps the latest hero-turn estimate separately from equity', (t) => {
  const heroTurn = describeHand(deal(), { ...context, displayedEquity: 0.72 })!.hero!
  t.deepEqual(heroTurn.lastEquity, { equity: 0.72, equityDisplay: '72%', street: 'preflop' })
  const aiTurn = applyAction(deal(), { type: 'call' })
  const remembered = describeHand(aiTurn, {
    ...context,
    displayedEquity: 0.72,
    lastEquity: { equity: 0.72, street: 'preflop' },
  })!
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
    t.is(describeHand(aiTurn, { ...context, lastEquity: bad })!.hero!.lastEquity, null)
})

test('hero.handName names the made hand from the flop on, as the felt does', (t) => {
  const preflop = deal()
  t.is(describeHand(preflop, context)!.hero!.handName, null)
  // The preflop nickname ("Pocket Rockets") is the felt's, not a made hand.
  t.false(describeHand(preflop, context)!.brief.includes('You have'))
  const streets = new Set<string>()
  playOut(deal(), [], (hand) => {
    const described = describeHand(hand, context)!
    const hero = hand.players[0]
    const expected =
      hand.community.length >= 3 ? evaluateHand(hero.hole, hand.community, hand.variant) : null
    t.is(described.hero!.handName, expected?.name ?? null)
    if (expected) t.true(described.brief.includes(`You have ${handPhrase(expected)}.`))
    streets.add(hand.street)
  })
  t.deepEqual([...streets], ['preflop', 'flop', 'turn', 'river'])
})

test('hero.handName: no brief clause once the hero folds or the hand is over', (t) => {
  // Hero folds the button; the blinds see a flop.
  let hand = applyAction(deal(), { type: 'fold' })
  hand = applyAction(hand, { type: 'call' })
  hand = applyAction(hand, { type: 'check' })
  t.is(hand.street, 'flop')
  const folded = describeHand(hand, context)!
  t.is(typeof folded.hero!.handName, 'string')
  t.false(folded.brief.includes('You have'))
  const done = describeHand(playOut(deal()), context)!
  t.is(typeof done.hero!.handName, 'string')
  t.false(done.brief.includes('You have'))
})

test('Mystery Card: no made hand is named while a hole card is face down', (t) => {
  let checked = 0
  playOut(deal({ mystery: true }), [], (hand) => {
    if (hand.players[0].hole.length >= 2) return
    t.is(describeHand(hand, context)!.hero!.handName, null)
    checked++
  })
  t.true(checked > 0)
})

const table = (over: Partial<TableContext> = {}): TableContext => ({
  venue: 'The Back Room',
  format: 'tournament',
  blindLevel: 2,
  status: 'playing',
  place: null,
  scoreHands: null,
  players: {
    hero: { style: null, reads: ['Should never be sent'] },
    ai1: { style: 'Tight and patient', reads: ['Waits for real hands', 'Folds under pressure'] },
    ai2: { style: null, reads: [] },
  },
  ...over,
})

test('players carry the style line and reads the table shows; none without a context', (t) => {
  const bare = describeHand(deal(), context)!
  t.is(bare.table, null)
  for (const player of bare.players) {
    t.is(player.style, null)
    t.deepEqual(player.reads, [])
  }
  const result = describeHand(deal(), { ...context, table: table() })!
  t.deepEqual(
    result.players.map((player) => [player.playerId, player.style, player.reads]),
    [
      // Nobody reads the hero, whatever the context says.
      ['hero', null, []],
      ['ai1', 'Tight and patient', ['Waits for real hands', 'Folds under pressure']],
      ['ai2', null, []],
    ],
  )
})

test('hand.table: venue, format, level, status and place, and nothing else', (t) => {
  const extended = {
    ...table({ status: 'handover' }),
    ai: { hiddenSkill: 0.937531, hiddenLooseness: 0.4 },
    players: {
      ai1: { style: 'Loose', reads: [], ai: { hiddenSkill: 0.937531 }, form: 'hidden-form' },
    },
  } as unknown as TableContext
  const described = describeHand(deal(), { ...context, table: extended })
  t.deepEqual(described!.table, {
    venue: 'The Back Room',
    format: 'tournament',
    blindLevel: 2,
    status: 'handover',
    place: null,
    scoreHands: null,
  })
  const encoded = JSON.stringify(described)
  for (const hidden of ['hiddenSkill', 'hiddenLooseness', '0.937531', 'hidden-form'])
    t.false(encoded.includes(hidden), hidden)
})

test('brief: a finished run says so; a run in progress says nothing', (t) => {
  const done = playOut(deal())
  const brief = (over: Partial<TableContext>) =>
    describeHand(done, { ...context, table: table(over) })!.brief
  t.true(brief({ status: 'busted', place: 3 }).endsWith(' You are out in 3rd.'))
  t.true(brief({ status: 'won', place: 1 }).endsWith(' You won the table.'))
  t.true(
    brief({ status: 'busted', place: null, format: 'cash' }).endsWith(' You are out of chips.'),
  )
  t.true(
    brief({ status: 'scored', format: 'score', scoreHands: 10 }).endsWith(
      ` The game is over: you finish with ${done.players[0].stack} chips.`,
    ),
  )
  const plain = describeHand(done, context)!.brief
  for (const status of ['playing', 'handover'] as const) t.is(brief({ status }), plain)
  // Watching the rest after busting: the hero is out of the hand being played.
  const watching = describeHand(deal(), {
    ...context,
    heroId: 'nobody',
    table: table({ status: 'watching', place: 4 }),
  })!.brief
  t.true(watching.endsWith(' You are out in 4th, watching the table play out.'))
  for (const status of ['busted', 'won', 'scored', 'watching'] as const)
    t.false(/\$|dollar|usd|€|£/i.test(brief({ status, place: 2 })))
})
