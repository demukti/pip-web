// Pip's opening chart beside the hand (live-state/chart.mjs and solver.mjs):
// the chart itself, what the coach is told about a first-in spot, and the
// advice line the service shows before the model has said a word.
import test from 'ava'
import { HANDS, OPEN, STEPS } from '../live-state/chart.mjs'
import { COACH_SYSTEM, coachInput, coachMessages } from '../live-state/coach.mjs'
import { SIZES, leadFor, solverFor } from '../live-state/solver.mjs'

const hands = HANDS.split(' ')
const combos = (h: string) => (h.length === 2 ? 6 : h.endsWith('s') ? 4 : 12)
const SEATS = ['utg', 'mp', 'co', 'btn', 'sb'] as const
type Row = { best: string; also: string; next: string; gap: string }
const rows = OPEN as Record<number, Record<string, Row>>

/** A first-in spot as the game describes it, as far as the lookup reads it. */
const spot = (seat: string, stackBb: number, handClass: string, more: object = {}) => ({
  currentPlayerToAct: 'hero',
  bigBlind: 10,
  hero: {
    playerId: 'hero',
    firstIn: { seat, stackBb, handClass, playersBehind: 2, playersDealt: 6, shoveChart: null },
  },
  availableActions: {
    canFold: true,
    canCall: true,
    callAmount: seat === 'sb' ? 5 : 10,
    canRaise: true,
    minRaiseTo: 20,
    maxRaiseTo: stackBb * 10,
  },
  ...more,
})
const withSpot = (base: ReturnType<typeof spot>, firstIn: object) => ({
  ...base,
  hero: { ...base.hero, firstIn: { ...base.hero.firstIn, ...firstIn } },
})

test('the chart: 169 hands, ten steps, five seats, every row whole and well-formed', (t) => {
  t.is(hands.length, 169)
  t.is(new Set(hands).size, 169)
  t.deepEqual(STEPS, [20, 25, 30, 35, 40, 50, 60, 70, 85, 100])
  t.deepEqual(Object.keys(OPEN).map(Number), STEPS)
  for (const step of STEPS) {
    t.deepEqual(Object.keys(rows[step]), [...SEATS])
    for (const seat of SEATS) {
      const { best, also, next, gap } = rows[step][seat]
      const where = `${step} ${seat}`
      // Only the small blind limps, and nobody shoves above thirty big blinds.
      const plays = `RF${seat === 'sb' ? 'L' : ''}${step <= 30 ? 'S' : ''}`
      t.regex(best, new RegExp(`^[${plays}]{169}$`), where)
      t.regex(also, new RegExp(`^[${plays}-]{169}$`), where)
      t.regex(next, new RegExp(`^[${plays}]{169}$`), where)
      t.regex(gap, new RegExp(`^[0-${SIZES.length - 1}]{169}$`), where)
      for (let at = 0; at < 169; at++) {
        t.not(also[at], best[at], `${where} ${hands[at]}`)
        t.not(next[at], best[at], `${where} ${hands[at]}`)
        // Close means nothing is clearly worse: the next play is the one as good.
        if (gap[at] === '0') t.is(next[at], also[at], `${where} ${hands[at]}`)
        else t.not(next[at], also[at], `${where} ${hands[at]}`)
      }
    }
  }
})

test('the chart reads like poker', (t) => {
  for (const step of STEPS) {
    const share = (seat: string) =>
      hands.reduce((sum, h, at) => sum + (rows[step][seat].best[at] === 'F' ? 0 : combos(h)), 0) /
      1326
    const [utg, mp, co, btn] = SEATS.map(share)
    t.true(utg < mp && mp < co && co < btn, `${step}bb`)
    t.true(utg > 0.12 && utg < 0.22 && btn > 0.3 && btn < 0.45, `${step}bb`)
    for (const seat of SEATS) {
      const { best, gap } = rows[step][seat]
      // Aces are a raise worth big blinds; seven-deuce is a fold that is not close.
      // (From the small blind the next play is a limp, which is not far behind.)
      t.is(best[hands.indexOf('AA')], 'R')
      if (seat !== 'sb') t.is(gap[hands.indexOf('AA')], '5')
      t.is(best[hands.indexOf('72o')], 'F')
      t.not(gap[hands.indexOf('72o')], '0')
    }
  }
  // Short, the button shoves its small pairs; deep, it raises them.
  t.is(rows[20].btn.best[hands.indexOf('33')], 'S')
  t.is(rows[100].btn.best[hands.indexOf('33')], 'R')
})

test('a clear raise and a clear fold: the play, what it is worth in words, and the pattern', (t) => {
  t.like(solverFor(spot('utg', 100, 'AA')), {
    seat: 'UTG',
    chartStackBb: 100,
    hand: 'AA',
    play: 'raise',
    close: false,
    verdict: 'Raise. Folding gives up two big blinds or more.',
    raiseToChips: 25,
    pattern: 'The weakest pair the UTG plays at this depth is 66.',
  })
  const fold = solverFor(spot('utg', 100, '72o'))
  t.like(fold, {
    play: 'fold',
    close: false,
    verdict: 'Fold. Raising loses about a quarter of a big blind.',
    pattern: 'The UTG plays no offsuit 7 at this depth. 72o is played from no seat.',
  })
  t.false('raiseToChips' in (fold ?? {}))
  // No decimal ever reaches the coach.
  t.notRegex(JSON.stringify([fold, solverFor(spot('btn', 100, '76s'))]), /\d\.\d/)
})

test('a close hand is said to be close, and the pattern names where it is played', (t) => {
  t.like(solverFor(spot('utg', 100, 'KJo')), {
    close: true,
    verdict: 'Close: raise or fold, worth the same. Reads may decide it.',
  })
  // 43 big blinds reads the 40 step.
  t.like(solverFor(spot('co', 43, 'K9o')), {
    seat: 'CO',
    chartStackBb: 40,
    close: true,
    play: 'fold',
    asGood: 'raise',
    pattern:
      'The weakest offsuit king the CO plays at this depth is KTo. K9o is first played from the BTN.',
  })
})

test('the small blind limps or raises, and a short stack shoves', (t) => {
  t.like(solverFor(spot('sb', 100, 'K2s')), {
    seat: 'SB',
    play: 'limp',
    asGood: 'raise',
    close: false,
    verdict: 'Limp or raise. Folding gives up a little, around a tenth of a big blind.',
    raiseToChips: 30,
  })
  t.like(solverFor(spot('btn', 20, '33')), { play: 'shove', close: false })
  t.is(
    solverFor(spot('sb', 20, 'A7o'))?.verdict,
    'Shove. It beats a raise by about half a big blind.',
  )
  t.is(solverFor(spot('mp', 80, 'AA'))?.seat, 'HJ')
})

test('the house raise is a legal one: smaller short, bigger from the small blind', (t) => {
  t.is(solverFor(spot('btn', 31, 'AA'))?.raiseToChips, 20)
  t.is(solverFor(spot('btn', 60, 'AA'))?.raiseToChips, 25)
  t.is(solverFor(spot('sb', 31, 'AA'))?.raiseToChips, 25)
  const aces = spot('btn', 60, 'AA')
  const legal = (more: object) => ({
    ...aces,
    availableActions: { ...aces.availableActions, ...more },
  })
  t.is(solverFor(legal({ minRaiseTo: 40 }))?.raiseToChips, 40)
  t.is(solverFor(legal({ minRaiseTo: 12, maxRaiseTo: 15 }))?.raiseToChips, 15)
  t.false('raiseToChips' in (solverFor(legal({ canRaise: false })) ?? {}))
})

test('no entry where the chart has no answer, and a longer table is told to tighten', (t) => {
  const good = spot('btn', 100, 'AA')
  t.truthy(solverFor(good))
  t.is(solverFor(null), null)
  t.is(solverFor({ hero: { firstIn: null } }), null)
  // A short stack is the shove chart's, which the game sends itself.
  t.is(solverFor(withSpot(good, { stackBb: 12, shoveChart: { verdict: 'shove' } })), null)
  // Heads-up the small blind is the button: not the six-handed small blind.
  t.is(solverFor(withSpot(spot('sb', 100, 'AA'), { playersDealt: 2 })), null)
  t.is(solverFor({ ...good, currentPlayerToAct: 'ai1' }), null)
  t.is(solverFor(withSpot(good, { handClass: 'XX' })), null)
  t.is(solverFor(withSpot(good, { seat: 'bb' })), null)
  t.is(solverFor(withSpot(good, { seat: 'constructor' })), null)
  t.is(solverFor(withSpot(good, { stackBb: 'deep' })), null)
  const long = withSpot(spot('utg', 100, 'AA'), { playersBehind: 7, playersDealt: 9 })
  t.regex(solverFor(long)?.note ?? '', /six-handed and there are 7 players behind/)
  // And the service does not answer for it: the model does.
  t.is(leadFor(long), null)
})

test('the advice line is shown at once for a clear play, as a legal action', (t) => {
  t.is(leadFor(spot('utg', 100, 'AA')), 'Raise to 25.')
  t.is(leadFor(spot('utg', 100, '72o')), 'Fold.')
  t.is(leadFor(spot('btn', 20, '33')), 'All in, 200.')
  t.is(leadFor(spot('sb', 100, 'K2s')), 'Call 5.')
  // A close hand is the model's to decide.
  t.is(leadFor(spot('utg', 100, 'KJo')), null)
  // Not the hero's turn, the run over, or the play not legal: no line.
  const aces = spot('utg', 100, 'AA')
  t.is(leadFor({ ...aces, currentPlayerToAct: 'ai1' }), null)
  t.is(leadFor({ ...aces, table: { status: 'busted' } }), null)
  t.is(leadFor({ ...aces, table: { status: 'playing' } }), 'Raise to 25.')
  t.is(leadFor({ ...aces, availableActions: { ...aces.availableActions, canRaise: false } }), null)
  t.is(leadFor({ ...aces, availableActions: null }), null)
  t.is(leadFor(null), null)
  t.is(leadFor({ street: 'flop', currentPlayerToAct: 'hero', hero: { playerId: 'hero' } }), null)
})

test('the advice line for a short stack comes from the game’s own shove chart', (t) => {
  const short = (verdict: string) =>
    withSpot(spot('btn', 12, 'A5s'), { shoveChart: { stackBb: 12, verdict } })
  t.is(leadFor(short('shove')), 'All in, 120.')
  t.is(leadFor(short('fold')), 'Fold.')
  t.is(leadFor(short('close')), null)
})

test('the model is sent the chart’s answer beside the hand, and the line already shown', (t) => {
  const hand = spot('btn', 100, '76s')
  const sent = JSON.parse(coachInput(hand, 'Raise to 25.'))
  t.deepEqual(Object.keys(sent), ['hand', 'solver', 'shown'])
  t.deepEqual(sent.hand, hand)
  t.is(sent.solver.hand, '76s')
  t.is(sent.shown, 'Raise to 25.')
  t.deepEqual(Object.keys(JSON.parse(coachInput(hand))), ['hand', 'solver'])
  t.deepEqual(JSON.parse(coachInput({ street: 'flop' })), { hand: { street: 'flop' } })
  // A follow-up that carries the hand again carries the chart's answer again, never "shown".
  const turn = { answer: 'Raise to 25.\nIt is a standard open.', question: 'Why?', hand }
  const [first, , followUp] = coachMessages(hand, [turn], 'Raise to 25.')
  t.is(JSON.parse(first.content as string).shown, 'Raise to 25.')
  const [again] = followUp.content as unknown as { text: string }[]
  t.deepEqual(Object.keys(JSON.parse(again.text)), ['hand', 'solver'])
  // The rules say what each part is.
  t.regex(COACH_SYSTEM, /"solver" entry beside the hand/)
  t.regex(COACH_SYSTEM, /hero\.firstIn\.shoveChart/)
  t.regex(COACH_SYSTEM, /"shown"/)
})
