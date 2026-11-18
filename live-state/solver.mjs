// The opening chart's answer for the hero's first move before the flop, put
// beside the hand the coach is asked about.
//
// The game names the spot (`hand.hero.firstIn`, src/lib/askCoach/hand.ts): the
// chart seat, the stack in big blinds and the hand class. This looks it up in
// Pip's opening chart (./chart.mjs, written by `pnpm coach-chart`) and says, in
// the coach's own words, what the standard play is, how much it matters, and
// where the hand sits in the seat's range, so the model explains a baseline
// instead of recalling one.
//
// **Who decides.** The chart is a baseline that holds against anybody; it knows
// nothing about the players at this table. Where a play is better than the
// rest by anything that matters, the chart decides and the service shows the
// advice line itself, at once (`leadFor`): the model only explains. Where the
// hand is close, the model decides, with the reads the table shows, and says
// the standard play and its reason for leaving it.

import { HANDS, OPEN, STEPS } from './chart.mjs'

const SEATS = { utg: 'UTG', mp: 'HJ', co: 'CO', btn: 'BTN', sb: 'SB' }
const ORDER = ['utg', 'mp', 'co', 'btn']
const PLAYS = { R: 'raise', S: 'shove', L: 'limp', F: 'fold' }
const DOING = { raise: 'Raising', shove: 'Shoving', limp: 'Limping' }
/** The chart's gap sizes, as the coach says them (the edges are in scripts/coach-chart.ts). */
export const SIZES = [
  'nothing that matters',
  'a little, around a tenth of a big blind',
  'about a quarter of a big blind',
  'about half a big blind',
  'about a big blind',
  'two big blinds or more',
]
/** The house raise, in big blinds: smaller on a short stack, bigger out of position. */
const raiseSize = (seat, step) => (seat === 'sb' ? (step <= 35 ? 2.5 : 3) : step <= 35 ? 2 : 2.5)

/** @typedef {{ hands: string, steps: number[], open: Record<string, any> }} Chart */
/** @type {Chart} */
export const CHART = { hands: HANDS, steps: STEPS, open: OPEN }

const indexes = new WeakMap()
function indexOf(chart) {
  let index = indexes.get(chart)
  if (!index) {
    index = new Map(chart.hands.split(' ').map((hand, at) => [hand, at]))
    indexes.set(chart, index)
  }
  return index
}

const RANKS = 'AKQJT98765432'
/** The hands that share a hand's shape, strongest first, and what to call them. */
function family(hand) {
  if (hand.length === 2) return { name: 'pair', hands: [...RANKS].map((rank) => rank + rank) }
  const high = hand[0]
  const suited = hand[2] === 's'
  const names = { A: 'ace', K: 'king', Q: 'queen', J: 'jack', T: 'ten' }
  const lead = names[high] ?? high
  return {
    name: `${suited ? 'suited' : 'offsuit'} ${lead}`,
    hands: [...RANKS.slice(RANKS.indexOf(high) + 1)].map((low) => high + low + hand[2]),
  }
}

/**
 * Where the hand sits: the weakest hand of its shape this seat plays, and the
 * first seat that plays this one. What turns one answer into a rule to keep.
 */
function pattern(chart, node, step, seat, hand) {
  const index = indexOf(chart)
  const played = (row, each) => row.best[index.get(each)] !== 'F'
  const { name, hands } = family(hand)
  const weakest = hands.findLast((each) => played(node, each))
  const parts = [
    weakest
      ? `The weakest ${name} the ${SEATS[seat]} plays at this depth is ${weakest}.`
      : `The ${SEATS[seat]} plays no ${name} at this depth.`,
  ]
  if (ORDER.includes(seat) && !played(node, hand)) {
    const first = ORDER.find((each) => played(chart.open[step][each], hand))
    parts.push(
      first
        ? `${hand} is first played from the ${SEATS[first]}.`
        : `${hand} is played from no seat.`,
    )
  }
  return parts.join(' ')
}

/**
 * The solver entry the model is sent (`solverFor`).
 * @typedef {object} SolverEntry
 * @property {string} source
 * @property {string} seat
 * @property {number} chartStackBb
 * @property {string} hand
 * @property {string} play
 * @property {string} [asGood]
 * @property {boolean} close
 * @property {string} verdict
 * @property {number} [raiseToChips]
 * @property {string} pattern
 * @property {string} [note]
 */

/**
 * What the chart says about the hero's hand in the spot the game named, or
 * null when it has no answer: not a first-in spot, a short stack (the game's
 * own shove chart answers those, `firstIn.shoveChart`), heads-up (there the
 * small blind is the button, a different game), or a hand, seat or number it
 * cannot read.
 * @param {any} hand
 * @param {Chart} [chart]
 * @returns {SolverEntry | null}
 */
export function solverFor(hand, chart = CHART) {
  const spot = hand?.hero?.firstIn
  if (!spot || typeof spot !== 'object' || spot.shoveChart) return null
  if (hand.currentPlayerToAct !== hand.hero.playerId) return null
  const at = indexOf(chart).get(spot.handClass)
  if (at === undefined || !Object.hasOwn(SEATS, spot.seat)) return null
  if (!(spot.stackBb > 0) || spot.playersDealt === 2) return null
  const step = chart.steps.reduce((best, each) =>
    Math.abs(each - spot.stackBb) < Math.abs(best - spot.stackBb) ? each : best,
  )
  const node = chart.open[step][spot.seat]
  const best = PLAYS[node.best[at]]
  const also = PLAYS[node.also[at]]
  const next = PLAYS[node.next[at]]
  const gap = Number(node.gap[at])
  if (!best || !next || !(gap >= 0 && gap < SIZES.length)) return null

  /** @type {SolverEntry} */
  const entry = {
    source: 'Pip’s opening chart: the standard play against anybody, from solver ranges.',
    seat: SEATS[spot.seat],
    chartStackBb: step,
    hand: spot.handClass,
    play: best,
    ...(also ? { asGood: also } : {}),
    close: gap === 0,
    verdict: '',
    pattern: pattern(chart, node, step, spot.seat, spot.handClass),
  }
  const both = also ? `${best} or ${also}` : best
  const Both = both[0].toUpperCase() + both.slice(1)
  if (gap === 0) entry.verdict = `Close: ${both}, worth the same. Reads may decide it.`
  else if (best === 'fold') entry.verdict = `Fold. ${DOING[next]} loses ${SIZES[gap]}.`
  else if (next === 'fold') entry.verdict = `${Both}. Folding gives up ${SIZES[gap]}.`
  else entry.verdict = `${Both}. It beats a ${next} by ${SIZES[gap]}.`

  // The house raise as chips the table will take.
  const legal = hand.availableActions
  const bigBlind = Number(hand.bigBlind)
  if (bigBlind > 0 && legal?.canRaise && [best, also].includes('raise')) {
    const to = Math.round(raiseSize(spot.seat, step) * bigBlind)
    entry.raiseToChips = Math.min(
      Math.max(to, Number(legal.minRaiseTo) || to),
      Number(legal.maxRaiseTo) || to,
    )
  }
  if (spot.playersBehind > 5)
    entry.note = `The chart is six-handed and there are ${spot.playersBehind} players behind: play tighter than it says.`
  return entry
}

/**
 * The advice line the service can show before the model has said a word, or
 * null when the model must write it: only on the hero's first-in turn, only
 * for a play that is clearly the standard one, and only as a legal action.
 * Covers the chart above and the game's own shove chart for a short stack.
 * @param {any} hand
 * @param {Chart} [chart]
 * @returns {string | null}
 */
export function leadFor(hand, chart = CHART) {
  const legal = hand?.availableActions
  if (!legal || hand.currentPlayerToAct !== hand.hero?.playerId) return null
  if (hand.table && ['busted', 'won', 'scored', 'watching'].includes(hand.table.status)) return null
  const shove = legal.canRaise && legal.maxRaiseTo > 0 ? `All in, ${legal.maxRaiseTo}.` : null
  const short = hand.hero.firstIn?.shoveChart
  if (short) return short.verdict === 'shove' ? shove : short.verdict === 'fold' ? 'Fold.' : null
  const entry = solverFor(hand, chart)
  if (!entry || entry.close || entry.note) return null
  if (entry.play === 'fold') return legal.canFold === false ? null : 'Fold.'
  if (entry.play === 'shove') return shove
  if (entry.play === 'limp')
    return legal.canCall && legal.callAmount > 0 ? `Call ${legal.callAmount}.` : null
  return entry.raiseToChips ? `Raise to ${entry.raiseToChips}.` : null
}
