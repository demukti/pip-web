import test from 'ava'
import { beatenBy, outs } from '@/lib/askCoach/board'
import { describeHand } from '@/lib/askCoach/hand'
import {
  applyAction,
  isHandComplete,
  legalActions,
  startHand,
  type HandState,
} from '@/lib/poker/engine'
import { cardFromString, cardToString, mulberry32 } from '@/lib/poker/cards'

const cards = (s: string) => s.split(' ').map(cardFromString)

test('beatenBy: the live hand of 2026-11-18, tens full on the turn, and no straight', (t) => {
  // The coach said a straight would beat this. Only a bigger full house or quads do.
  t.deepEqual(beatenBy(cards('Tc Th'), cards('Jc Jh Td Kc')), {
    holdings: 12,
    of: 1035,
    hands: [
      { made: 'Four of a Kind', holdings: 1, classes: ['JJ'] },
      { made: 'Full House', holdings: 11, classes: ['KK', 'KJ', 'JT'] },
    ],
  })
})

test('beatenBy: suit shows only where only suited holdings do it, and a chop is no beat', (t) => {
  const facts = beatenBy(cards('9c 8d'), cards('Th Jh Qh 2c 3s'))
  t.deepEqual(facts.hands, [
    { made: 'Straight Flush', holdings: 3, classes: ['AKs', 'K9s', '98s'] },
    // Any two hearts: too many classes to list, so the count alone.
    { made: 'Flush', holdings: 42 },
    { made: 'Straight', holdings: 26, classes: ['AK', 'K9'] },
  ])
  // 9-8 of other suits chops the same straight and is not counted.
  t.false(facts.hands.some((hand) => hand.classes?.includes('98')))
  t.is(facts.of, 990)
})

test('outs: a flush draw is any heart, and the overcards are named by rank', (t) => {
  t.deepEqual(outs(cards('Ah Kh'), cards('Qh 7h 2c')), {
    cards: 15,
    of: 47,
    improvesTo: [
      { made: 'Flush', cards: 9, suit: 'h' },
      { made: 'Pair', cards: 6, ranks: ['A', 'K'] },
    ],
  })
})

test('outs: a card that improves the board for everyone is not an out', (t) => {
  // A king, ten or jack pairs or trips the board itself; only a 7 or a 2 plays.
  t.deepEqual(outs(cards('7c 2h'), cards('Jc Jh Td Kc')), {
    cards: 6,
    of: 46,
    improvesTo: [{ made: 'Two Pair', cards: 6, ranks: ['7', '2'] }],
  })
  t.deepEqual(outs(cards('Tc Th'), cards('Jc Jh Td Kc'))!.improvesTo, [
    { made: 'Four of a Kind', cards: 1, ranks: ['T'] },
  ])
})

test('outs: none on the river, with no card to come', (t) => {
  t.is(outs(cards('9c 8d'), cards('Th Jh Qh 2c 3s')), null)
})

const context = { handNo: 1, heroId: 'hero' }
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
const playOut = (hand: HandState, each: (hand: HandState) => void, folds: string[] = []) => {
  while (!isHandComplete(hand)) {
    each(hand)
    const legal = legalActions(hand)!
    const actor = hand.players[hand.toActIndex].id
    hand = applyAction(hand, {
      type: folds.includes(actor) ? 'fold' : legal.canCheck ? 'check' : 'call',
    })
  }
  return hand
}

test('describeHand: board facts from the flop on, outs until the river, none once over', (t) => {
  const seen = new Map<string, [boolean, boolean]>()
  const done = playOut(deal(), (hand) => {
    const hero = describeHand(hand, context)!.hero!
    seen.set(hand.street, [hero.beatenBy !== null, hero.outs !== null])
    if (hand.community.length >= 3)
      t.deepEqual(hero.beatenBy, beatenBy(hand.players[0].hole, hand.community))
  })
  t.deepEqual(Object.fromEntries(seen), {
    preflop: [false, false],
    flop: [true, true],
    turn: [true, true],
    river: [true, false],
  })
  const over = describeHand(done, context)!.hero!
  t.is(over.beatenBy, null)
  t.is(over.outs, null)
})

test('describeHand: no board facts once the hero folds', (t) => {
  let hand = applyAction(deal(), { type: 'fold' })
  hand = applyAction(hand, { type: 'call' })
  hand = applyAction(hand, { type: 'check' })
  t.is(hand.street, 'flop')
  t.is(describeHand(hand, context)!.hero!.beatenBy, null)
})

test('describeHand: no board facts while a hole card is face down, and no unseen card named', (t) => {
  let faceDown = 0
  playOut(deal({ mystery: true }), (hand) => {
    const described = describeHand(hand, context)!
    if (hand.players[0].hole.length < 2) {
      t.is(described.hero!.beatenBy, null)
      if (hand.community.length >= 3) faceDown++
    }
    // The facts are counts, classes, ranks and suits: never a card the hero can't see.
    const facts = JSON.stringify([described.hero!.beatenBy, described.hero!.outs])
    for (const player of hand.players.slice(1))
      for (const card of [...player.hole, ...(player.mystery ? [player.mystery] : [])])
        t.false(new RegExp(`\\b${cardToString(card)}\\b`).test(facts))
  })
  t.true(faceDown > 0)
})
