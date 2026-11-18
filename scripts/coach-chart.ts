// Writes live-state/chart.mjs: Pip's own opening chart, the baseline the coach
// is handed when it folds round to you before the flop (live-state/solver.mjs,
// docs/ask-coach.md → "The opening chart").
//
//   pnpm coach-chart
//
// **What goes in.** Two published sets of six-handed solver ranges, kept in
// private/sets/ on the machine that builds the chart (git ignores private/, so
// a fresh clone cannot rebuild it and does not need to: the chart is checked
// in), and Pip's own shove solver (lib/drills/shoveRange):
//
//   a  what each hand is worth raised (and limped, from the small blind) over
//      folding, at six stack depths
//   b  how often each hand is opened at 100 big blinds, by a second,
//      independent solver
//
// **What comes out is Pip's, not either set.** For every seat, hand and one of
// Pip's own stack steps:
//
//   - The values are read between the solved depths, so a 25 big blind stack
//     is not answered as 20.
//   - Shoving is an option the sets never consider. Up to 30 big blinds it is
//     priced by Pip's solver against equilibrium callers, and it is the play
//     where it beats everything else by `SHOVE_MARGIN`.
//   - The best play, any other worth the same, and how much better they are
//     than the best of the rest, as one of six sizes: the coach says "about a
//     quarter of a big blind", never a decimal. Under `CLOSE` two plays are the
//     same choice; a hand with nothing clearly worse is close.
//   - At the deep steps a hand the two solvers disagree on is close, whatever
//     either says it is worth.
//
// It is a baseline: what holds up against anybody. Nothing here is tuned to
// how Pip's own opponents play; the coach adjusts to them out loud, from the
// reads the table shows.
//
// Deterministic: the same input writes the same file, byte for byte.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CLASSES, type ShoveSeat, shoveEv, solveNash } from '@/lib/drills/shoveRange'

const SETS = new URL('../private/sets/', import.meta.url)
const OUT = fileURLToPath(new URL('../live-state/chart.mjs', import.meta.url))

/** The depths set `a` is solved at, and the steps Pip's chart answers. */
const SOLVED = [20, 30, 40, 50, 70, 100] as const
const STEPS = [20, 25, 30, 35, 40, 50, 60, 70, 85, 100] as const
/** The deepest step at which a shove is priced. */
const SHOVE_UP_TO = 30
/**
 * A shove is the play only when it beats every other by this much, in big
 * blinds. More from the small blind: set `a` was solved with rake, which a
 * shove mostly escapes and a raise that sees a flop does not, and that flatters
 * the shove most where the most flops are seen.
 */
const SHOVE_MARGIN = 0.1
const SHOVE_MARGIN_SB = 0.25
/** Two plays this close are the same choice. */
const CLOSE = 0.05
/** From this step up, set `b` (solved at 100 big blinds) is asked for a second opinion. */
const SECOND_OPINION_FROM = 85
/** The gap between the best play and the next, as a size: the upper edge of each, in big blinds. */
const SIZES = [CLOSE, 0.175, 0.375, 0.75, 1.75] as const

const SEATS = [
  ['UTG', 'utg'],
  ['HJ', 'mp'],
  ['CO', 'co'],
  ['BTN', 'btn'],
  ['SB', 'sb'],
] as const

const RANKS = 'AKQJT98765432'
const HANDS: string[] = []
for (let i = 0; i < 13; i++)
  for (let j = 0; j < 13; j++)
    HANDS.push(
      i === j ? RANKS[i] + RANKS[j] : i < j ? `${RANKS[i]}${RANKS[j]}s` : `${RANKS[j]}${RANKS[i]}o`,
    )
const combos = (hand: string) => (hand.length === 2 ? 6 : hand.endsWith('s') ? 4 : 12)

// ---------------------------------------------------------------------------
// Set a: values and frequencies at the solved depths.

interface SetAAction {
  kind: string
  weights: Record<string, number>
  evs: Record<string, number>
}
interface Solved {
  raise: number[]
  raiseOften: number[]
  limp: number[] | null
  limpOften: number[] | null
}

function solved(depth: number, seat: string): Solved {
  const where = `a/node-${depth}-${seat}.json`
  const envelope = JSON.parse(readFileSync(new URL(where, SETS), 'utf8'))
  const node = JSON.parse(envelope.result.content[0].text)
  if (node.stack !== depth || node.actor !== seat || node.units.evs !== 'sb')
    throw new Error(`${where}: not the node it is named for`)
  const actions: SetAAction[] = node.actions
  const fold = actions.find((a) => a.kind === 'fold')
  const limp = actions.find((a) => a.kind === 'call')
  const raises = actions.filter((a) => a.kind !== 'fold' && a.kind !== 'call')
  if (!fold || raises.length !== 1) throw new Error(`${where}: expected a fold and one raise`)
  // Values arrive in small blinds, measured from before the blinds were
  // posted: each is taken over that node's own fold, in big blinds.
  const over = (action: SetAAction) =>
    HANDS.map((hand) => {
      const value = action.evs[hand]
      const base = fold.evs[hand]
      if (typeof value !== 'number' || typeof base !== 'number')
        throw new Error(`${where}: no value for ${hand}`)
      return (value - base) / 2
    })
  const often = (action: SetAAction) => HANDS.map((hand) => action.weights[hand] ?? 0)
  return {
    raise: over(raises[0]),
    raiseOften: often(raises[0]),
    limp: limp ? over(limp) : null,
    limpOften: limp ? often(limp) : null,
  }
}

/** One of set a's rows, read between the two solved depths around a step. */
function between(step: number, seat: string, pick: (node: Solved) => number[] | null) {
  const above = SOLVED.find((depth) => depth >= step) ?? SOLVED[SOLVED.length - 1]
  const below = [...SOLVED].reverse().find((depth) => depth <= step) ?? SOLVED[0]
  const low = pick(solved(below, seat))
  const high = pick(solved(above, seat))
  if (!low || !high) return null
  const share = above === below ? 0 : (step - below) / (above - below)
  return low.map((value, at) => value + (high[at] - value) * share)
}

// ---------------------------------------------------------------------------
// Set b: how often each hand is opened at 100 big blinds, by a second solver.
// One file a seat: card pairs, the ones not always opened wrapped in their
// weight in percent, as "[41.5]Kc5d, Kh5d[/41.5]".

function setB(seat: string): number[] | null {
  let text: string
  try {
    text = readFileSync(new URL(`b/${seat}.txt`, SETS), 'utf8')
  } catch {
    return null
  }
  const total = new Map<string, number>()
  const add = (pair: string, weight: number) => {
    const [r1, s1, r2, s2] = pair.trim()
    if (!r2) return
    const [high, low] = RANKS.indexOf(r1) <= RANKS.indexOf(r2) ? [r1, r2] : [r2, r1]
    const hand = high === low ? high + low : `${high}${low}${s1 === s2 ? 's' : 'o'}`
    total.set(hand, (total.get(hand) ?? 0) + weight)
  }
  const plain = text.replace(/\[([\d.]+)\]([\s\S]*?)\[\/\1\]/g, (_, weight, pairs: string) => {
    for (const pair of pairs.split(',')) add(pair, Number(weight) / 100)
    return ''
  })
  for (const pair of plain.split(',')) add(pair, 1)
  return HANDS.map((hand) => (total.get(hand) ?? 0) / combos(hand))
}

// ---------------------------------------------------------------------------
// The chart.

type Play = 'R' | 'S' | 'L' | 'F'
const size = (gap: number) => {
  const at = SIZES.findIndex((edge) => gap < edge)
  return at < 0 ? SIZES.length : at
}

const tally: string[] = []
type Row = { best: string; also: string; next: string; gap: string }
const open: Record<number, Record<string, Row>> = {}
for (const step of STEPS) {
  open[step] = {}
  for (const [theirs, ours] of SEATS) {
    const raise = between(step, theirs, (node) => node.raise)
    const raiseOften = between(step, theirs, (node) => node.raiseOften)
    const limp = between(step, theirs, (node) => node.limp)
    const limpOften = between(step, theirs, (node) => node.limpOften)
    if (!raise || !raiseOften) throw new Error(`${step} ${theirs}: no raise`)
    const spot = { seat: ours as ShoveSeat, stack: step }
    const callers = step <= SHOVE_UP_TO ? solveNash(spot).call : null
    const margin = ours === 'sb' ? SHOVE_MARGIN_SB : SHOVE_MARGIN
    const second = step >= SECOND_OPINION_FROM ? setB(theirs) : null
    const row: Row = { best: '', also: '', next: '', gap: '' }
    const count = { played: 0, shoved: 0, close: 0, lean: 0, disputed: 0 }
    HANDS.forEach((hand, at) => {
      // `often` is how often the solver takes the play: what picks between two
      // plays worth the same.
      const plays: { play: Play; value: number; often: number }[] = [
        { play: 'R', value: raise[at], often: raiseOften[at] },
        {
          play: 'F',
          value: 0,
          often: Math.max(0, 1 - raiseOften[at] - (limpOften ? limpOften[at] : 0)),
        },
      ]
      if (limp && limpOften) plays.push({ play: 'L', value: limp[at], often: limpOften[at] })
      if (callers) {
        const klass = CLASSES.findIndex((each) => each.key === hand)
        const shove = shoveEv(klass, spot, callers).ev
        // A shove is either clearly the play or not offered at all.
        if (shove >= Math.max(...plays.map((each) => each.value)) + margin)
          plays.push({ play: 'S', value: shove, often: 1 })
      }
      // The best play: the one taken most often among those within `CLOSE` of
      // the highest value. `also` is another of those, if there is one, and
      // `next` the best of the rest: what the best play is clearly better than.
      const highest = Math.max(...plays.map((each) => each.value))
      const near = plays
        .filter((each) => highest - each.value < CLOSE)
        .sort((x, y) => y.often - x.often || y.value - x.value)
      const rest = plays.filter((each) => !near.includes(each)).sort((x, y) => y.value - x.value)
      const best = near[0]
      const also = near[1] ?? null
      const next = rest[0] ?? also
      if (!next) throw new Error(`${step} ${theirs} ${hand}: one play only`)
      let gap = rest[0] ? size(best.value - rest[0].value) : 0
      // The second opinion: does the other solver open it at least half the time?
      if (second && best.play !== 'S' && gap > 0 && second[at] >= 0.5 !== (best.play !== 'F')) {
        gap = 0
        count.disputed++
      }
      row.best += best.play
      row.also += also ? also.play : '-'
      row.next += next.play
      row.gap += String(gap)
      if (best.play !== 'F') count.played += combos(hand)
      if (best.play === 'S') count.shoved++
      if (gap === 0) count.close++
      if (gap === 1) count.lean++
    })
    open[step][ours] = row
    tally.push(
      `${String(step).padStart(3)} ${ours.padEnd(3)} plays ${((100 * count.played) / 1326).toFixed(1).padStart(4)}%  shoves ${String(count.shoved).padStart(2)}  close ${String(count.close).padStart(3)}  lean ${String(count.lean).padStart(3)}  disputed ${count.disputed}`,
    )
  }
}

const blocks = STEPS.map((step) => {
  const seats = SEATS.map(([, ours]) => {
    const node = open[step][ours]
    return `    ${ours}: {\n      best: '${node.best}',\n      also: '${node.also}',\n      next: '${node.next}',\n      gap: '${node.gap}',\n    },`
  })
  return `  ${step}: {\n${seats.join('\n')}\n  },`
})

const file = `// Written by \`pnpm coach-chart\` (scripts/coach-chart.ts). Do not edit by hand.
//
// Pip's opening chart: the first move before the flop when it folds round to
// you, for five seats (by players left to act behind) at ten stack depths.
// Built from published solver ranges and Pip's own shove solver; how, and what
// was changed for Pip, is at the top of the script.
//
// HANDS: the 169 hand classes, in the order every row lists them.
// STEPS: the stack depths, in big blinds; the nearest answers a stack.
// OPEN: for each step and seat, one character a hand:
//   best  the play: R raise, S shove, L limp (small blind only), F fold
//   also  another play worth the same, or - when there is none
//   next  the best of the rest: what the best play is better than
//   gap   by how much: 0 nothing that matters (the hand is close), 1 a
//         little, then 2 to 5, each about twice the last (SIZES in ./solver.mjs)

export const HANDS =
  '${HANDS.join(' ')}'

export const STEPS = [${STEPS.join(', ')}]

export const OPEN = {
${blocks.join('\n')}
}
`

writeFileSync(OUT, file)
// Through the formatter, so the file is the one \`pnpm format:check\` accepts.
execFileSync('biome', ['format', '--write', OUT], { stdio: 'ignore' })
console.log(tally.join('\n'))
console.log(`wrote ${OUT}`)
