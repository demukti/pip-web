// Pip's preflop charts, put beside the hand the coach is asked about: the
// first move when it folds round to the hero, and the reply to one raise.
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

import { HANDS, HEADS_UP, OPEN, STEPS, VS_OPEN } from './chart.mjs'

const SEATS = { utg: 'UTG', mp: 'HJ', co: 'CO', btn: 'BTN', sb: 'SB' }
const NAMES = { ...SEATS, bb: 'BB' }
const ORDER = ['utg', 'mp', 'co', 'btn']
const PLAYS = { R: 'raise', S: 'shove', L: 'limp', F: 'fold', C: 'call', K: 'check' }
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

/**
 * @typedef {{ hands: string, steps: number[], open: Record<string, any>,
 *   vsOpen: Record<string, any>, headsUp: Record<string, any> }} Chart
 */
/** @type {Chart} */
export const CHART = { hands: HANDS, steps: STEPS, open: OPEN, vsOpen: VS_OPEN, headsUp: HEADS_UP }

/**
 * The charts for one raise in front and for heads-up are solved at 100 big
 * blinds. Under `SOLVED_DEEP` the coach is told so and decides for itself;
 * under `SOLVED_FROM` they say nothing. A raise bigger than `RAISE_UP_TO` big
 * blinds is not the raise they were solved against.
 */
const SOLVED_DEEP = 60
const SOLVED_FROM = 25
const RAISE_UP_TO = 3.5

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
 * @property {string} [position]
 * @property {string} [note]
 */

/**
 * What the charts say about the hero's hand in the spot the game named, or
 * null when they have no answer. Three spots are charted: first in
 * (`hero.firstIn`: the opening chart, or the heads-up one), one raise in front
 * (`hero.facing`), and the small blind's limp heads-up. Not a short stack's
 * first move (the game's own shove chart answers those, `firstIn.shoveChart`),
 * nor a hand, seat or number it cannot read.
 * @param {any} hand
 * @param {Chart} [chart]
 * @returns {SolverEntry | null}
 */
export function solverFor(hand, chart = CHART) {
  if (!hand?.hero || hand.currentPlayerToAct !== hand.hero.playerId) return null
  const { firstIn, facing } = hand.hero
  if (firstIn && typeof firstIn === 'object') {
    if (firstIn.shoveChart) return null
    return firstIn.playersDealt === 2
      ? often(hand, chart, chart.headsUp.open, firstIn, 'heads-up')
      : opening(hand, chart, firstIn)
  }
  if (!facing || typeof facing !== 'object') return null
  if (facing.kind === 'limp')
    return facing.playersDealt === 2
      ? often(hand, chart, chart.headsUp.vs_limp, facing, 'heads-up, after the small blind limps')
      : null
  if (facing.kind !== 'raise' || !(facing.raiseToBb <= RAISE_UP_TO)) return null
  const seat = NAMES[facing.seat]
  const opener = NAMES[facing.opener]
  if (!seat || !opener) return null
  return facing.playersDealt === 2
    ? often(hand, chart, chart.headsUp.vs_raise, facing, 'heads-up, against a raise')
    : often(
        hand,
        chart,
        Object.hasOwn(chart.vsOpen, `${facing.seat}_vs_${facing.opener}`)
          ? chart.vsOpen[`${facing.seat}_vs_${facing.opener}`]
          : null,
        facing,
        `against a ${opener} raise`,
      )
}

/** The order seats act in after the flop: the blinds first, the button last. */
const AFTER_THE_FLOP = ['sb', 'bb', 'utg', 'mp', 'co', 'btn']

/**
 * Who acts last after the flop, in a spot with one opponent in: a fact the
 * model otherwise works out from seat names, and has got wrong. Heads-up the
 * small blind is the button, so it acts last there.
 */
function positionOf(spot) {
  if (spot.playersDealt === 2)
    return spot.seat === 'sb'
      ? 'After the flop you act last: heads-up the small blind is the button. You have position.'
      : 'After the flop you act first: heads-up the small blind is the button. You are out of position.'
  const mine = AFTER_THE_FLOP.indexOf(spot.seat)
  const theirs = AFTER_THE_FLOP.indexOf(spot.opener)
  if (mine < 0 || theirs < 0) return null
  return mine > theirs
    ? 'After the flop you act after the raiser. You have position on them.'
    : 'After the flop you act before the raiser. You are out of position.'
}

/** The reply to a raise is bigger out of position: three times the raise, four from the blinds. */
const reRaise = (spot) => (spot.seat === 'sb' || spot.seat === 'bb' ? 4 : 3) * spot.raiseToBb

/** A raise size in big blinds as chips the table will take, or null when no raise is legal. */
function legalRaise(hand, sizeBb) {
  const legal = hand.availableActions
  const bigBlind = Number(hand.bigBlind)
  if (!(bigBlind > 0) || !legal?.canRaise) return null
  const to = Math.round(sizeBb * bigBlind)
  return Math.min(Math.max(to, Number(legal.minRaiseTo) || to), Number(legal.maxRaiseTo) || to)
}

/**
 * An answer from a chart that knows how often each play is taken and not what
 * it is worth: one raise in front, and heads-up. Solved at one depth, so a
 * shorter stack is told so, and a much shorter one gets no answer.
 * @returns {SolverEntry | null}
 */
function often(hand, chart, node, spot, where) {
  const at = indexOf(chart).get(spot.handClass)
  if (!node || at === undefined || !Object.hasOwn(NAMES, spot.seat)) return null
  if (!(spot.stackBb >= SOLVED_FROM)) return null
  const best = PLAYS[node.best[at]]
  const also = PLAYS[node.also[at]]
  if (!best) return null
  const seat = NAMES[spot.seat]
  const facingRaise = spot.kind === 'raise'
  const say = (play) => (facingRaise && play === 'raise' ? 're-raise' : play)
  const both = also ? `${say(best)} or ${say(also)}` : say(best)
  const loose = spot.stackBb < SOLVED_DEEP

  // The weakest hand of this shape that does anything but fold (or check).
  const { name, hands } = family(spot.handClass)
  const index = indexOf(chart)
  const passive = spot.kind === 'limp' ? 'K' : 'F'
  const weakest = hands.findLast((each) => node.best[index.get(each)] !== passive)
  const doing = spot.kind === 'limp' ? 'raises' : facingRaise ? 'continues with' : 'plays'

  /** @type {SolverEntry} */
  const entry = {
    source: `Pip’s chart, ${where}: the standard play against anybody, solved at 100 big blinds.`,
    seat,
    chartStackBb: 100,
    hand: spot.handClass,
    play: say(best),
    ...(also ? { asGood: say(also) } : {}),
    // Under the depth it was solved for, the chart's play is where to start
    // from and never the answer: the model decides.
    close: Boolean(also) || loose,
    verdict: loose
      ? `At 100 big blinds the standard play is to ${both}. At ${Math.round(spot.stackBb)} that is a starting point, not the answer.`
      : also
        ? `Close: ${both}; the solver does both. Reads may decide it.`
        : `${both[0].toUpperCase()}${both.slice(1)}.`,
    pattern: weakest
      ? `The weakest ${name} the ${seat} ${doing} here is ${weakest}.`
      : `The ${seat} ${doing} no ${name} here.`,
  }
  if ([best, also].includes('raise')) {
    const size = facingRaise ? reRaise(spot) : spot.kind === 'limp' ? 3.5 : 2.5
    const chips = legalRaise(hand, size)
    if (chips) entry.raiseToChips = chips
  }
  const position = positionOf(spot)
  if (position) entry.position = position
  if (loose)
    entry.note = `Solved at 100 big blinds, and this is ${Math.round(spot.stackBb)}: calls with small pairs and suited connectors are worth less here, and a re-raise is close to all-in, so re-raise only a hand you would be glad to get all in with. A hand the deep chart re-raises as a bluff is a call or a fold here.`
  return entry
}

/** @returns {SolverEntry | null} */
function opening(hand, chart, spot) {
  const at = indexOf(chart).get(spot.handClass)
  if (at === undefined || !Object.hasOwn(SEATS, spot.seat)) return null
  if (!(spot.stackBb > 0)) return null
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
  if ([best, also].includes('raise')) {
    const chips = legalRaise(hand, raiseSize(spot.seat, step))
    if (chips) entry.raiseToChips = chips
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
  if (entry.play === 'check') return legal.canCheck ? 'Check.' : null
  if (entry.play === 'shove') return shove
  if (entry.play === 'limp' || entry.play === 'call')
    return legal.canCall && legal.callAmount > 0 ? `Call ${legal.callAmount}.` : null
  return entry.raiseToChips ? `Raise to ${entry.raiseToChips}.` : null
}
