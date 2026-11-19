// The hand as the coach sees it: an explicit, hero-visible projection of
// the engine, built when the player asks. Never serialize HandState directly: it
// contains the undealt deck and every opponent's private cards.
import { holeKey } from '@/config/handNames'
import { beatenBy, outs } from '@/lib/askCoach/board'
import { madeHandLabel, madeHandWords } from '@/lib/askCoach/made'
import type { SeatId } from '@/config/positions'
import {
  BLINDS,
  MAX_STACK,
  MIN_STACK,
  SHOVE_SEATS,
  type ShoveSeat,
  behind,
  classOf,
  equityVs,
  nashFor,
  posted,
  shoveEv,
} from '@/lib/drills/shoveRange'
import { firstInSpot } from '@/lib/poker/ai/pushFold'
import { cardToString } from '@/lib/poker/cards'
import {
  isHandComplete,
  legalActions,
  potSize,
  showsHoleCards,
  type HandState,
} from '@/lib/poker/engine'
import { evaluateHand, handPhrase, type EvaluatedHand } from '@/lib/poker/handEval'
import { ordinal } from '@/lib/recap'
import { formatWinPct } from '@/lib/utils'

/** The run's state as the game store names it (`GameStatus`). */
export type RunStatus = 'idle' | 'playing' | 'handover' | 'busted' | 'won' | 'watching' | 'scored'

/**
 * What the player can see about the table and the run around the hand: the
 * header (venue, blinds level, "Hand N of M") and, per seat, what opening that
 * player shows (their style line and "Your reads"). Read from the stores when
 * the player asks (`table.ts`); absent in Node, where no store exists.
 */
export interface TableContext {
  /** The venue's display name. */
  venue: string
  /** `score` is a quick game played for a score (`Venue.scoreHands`); `cash` a ring table. */
  format: 'tournament' | 'cash' | 'score'
  /** 1-based, as the header's "L2". */
  blindLevel: number
  status: RunStatus
  /** Tournament finishing place once the run is over (1 = won it); otherwise null. */
  place: number | null
  /** Hands a score game deals ("Hand N of M"); null at every other table. */
  scoreHands: number | null
  /** Per seat id: exactly what that player's dialog shows. */
  players: Record<string, { style: string | null; reads: string[] }>
}

export interface HandContext {
  handNo: number
  heroId: string
  /** Exact estimate already computed for Pip's odds panel, never recomputed here. */
  displayedEquity?: number | null
  /**
   * The most recent hero-turn estimate earlier in THIS hand, remembered by
   * `table.ts` so "how's my hand?" during an AI turn still has a number.
   */
  lastEquity?: { equity: number; street: string } | null
  /** The table around the hand, read from the stores (`table.ts`). */
  table?: TableContext | null
}

const validEquity = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1

/**
 * The estimate, when it is the hero's turn in an unfinished hand and the value
 * is a probability; otherwise null. Shared with `table.ts`, which remembers it
 * as `lastEquity`.
 */
export function heroTurnEquity(
  hand: HandState,
  heroId: string,
  estimate: number | null | undefined,
): number | null {
  if (isHandComplete(hand) || hand.players[hand.toActIndex]?.id !== heroId) return null
  return validEquity(estimate) ? estimate : null
}

const pct = (fraction: number) => `${Math.round(fraction * 100)}%`

/**
 * How the hero's hand stands on the board (`board.ts`), from the flop on while the
 * hero is still in an unfinished Hold'em hand with both cards face up; otherwise
 * null. A finished hand has its result instead.
 */
function boardFacts(hand: HandState, hero: HandState['players'][number] | undefined) {
  if (!hero || hand.variant !== 'holdem' || isHandComplete(hand)) return null
  if (hero.status === 'folded' || hero.status === 'out') return null
  if (hero.hole.length !== 2 || hand.community.length < 3) return null
  return { beatenBy: beatenBy(hero.hole, hand.community), outs: outs(hero.hole, hand.community) }
}

/**
 * The hero's made hand, by the felt's own rule (`useHandLabel` in
 * table/parts.tsx): from five cards on, never the preflop nickname, and
 * nothing at all if the evaluator refuses the cards.
 */
function heroMadeHand(hand: HandState, hero: HandState['players'][number] | undefined) {
  if (!hero || hero.hole.length < 2 || hero.hole.length + hand.community.length < 5) return null
  try {
    return evaluateHand(hero.hole, hand.community, hand.variant)
  } catch {
    return null
  }
}

/** The chart seat for a first move, by how many players are left to act behind it. */
const CHART_SEAT: Record<number, ShoveSeat> = { 1: 'sb', 2: 'btn', 3: 'co', 4: 'mp', 5: 'utg' }

const hundredths = (value: number) => Math.round(value * 100) / 100

/**
 * The hero's first move when it folds round to them before the flop: the spot
 * as a preflop chart names it, so the coach can be given a chart's answer
 * instead of working one out. Null in every other spot.
 *
 * `seat` is the six-handed seat with as many players behind (the engine's own
 * rule, `firstInSpot`), which is not always the seat's name at a shorter or
 * longer table. `stackBb` is the hero's stack against the biggest behind.
 *
 * `shoveChart` answers a stack of fifteen big blinds or fewer from the shove
 * chart the game teaches and its short-stacked opponents play
 * (lib/drills/shoveRange): what shoving is worth over folding against the
 * equilibrium callers, and `close` when that is inside the chart's own
 * sampling margin. Above fifteen it is null, and the service adds a solver's
 * opening chart for the spot (live-state/solver.mjs).
 */
function firstInFacts(hand: HandState, hero: HandState['players'][number]) {
  const spot = firstInSpot(hand, hero.id)
  const handClass = holeKey(hero.hole)
  if (!spot || !handClass) return null
  const seat = CHART_SEAT[Math.min(spot.behind, 5)]
  let shoveChart: {
    stackBb: number
    verdict: 'shove' | 'fold' | 'close'
    shoveValueBb: number
  } | null = null
  if (spot.effectiveBb <= MAX_STACK) {
    const stack = Math.max(MIN_STACK, Math.round(spot.effectiveBb))
    const value = shoveEv(classOf(hero.hole), { seat, stack }, nashFor({ seat, stack }).call)
    shoveChart = {
      stackBb: stack,
      verdict: Math.abs(value.ev) <= value.band ? 'close' : value.ev > 0 ? 'shove' : 'fold',
      shoveValueBb: hundredths(value.ev),
    }
  }
  return {
    seat,
    playersBehind: spot.behind,
    playersDealt: hand.players.filter((player) => player.hole.length > 0).length,
    stackBb: Math.round(spot.effectiveBb * 10) / 10,
    handClass,
    shoveChart,
  }
}

/** A table position as the charts name the seat. Heads-up the button is the small blind. */
const CHART_POSITION: Record<string, string> = {
  UTG: 'utg',
  HJ: 'mp',
  CO: 'co',
  BTN: 'btn',
  SB: 'sb',
  BB: 'bb',
  'BTN/SB': 'sb',
}

/**
 * Calling a first-in shove of fifteen big blinds or fewer, from the shove chart
 * (lib/drills/shoveRange): the equilibrium calling range for the hero's seat
 * against the equilibrium shoving range for the shover's, at the smaller of
 * the two stacks. `verdict` is the range's answer, and `close` when it mixes
 * the hand or the call's value is inside the chart's own sampling margin.
 * The margin itself is not sent: the model read it as the size of the edge.
 * `callValueBb` is what calling wins over folding against that shoving range
 * with nobody else coming in, in big blinds: a seat with players still behind
 * it calls tighter than that number alone says, which the verdict already
 * allows for. Null for a deeper shove, which no chart here answers.
 */
function callFacts(
  hero: HandState['players'][number],
  seat: string,
  opener: string,
  effectiveBb: number,
) {
  const shover = SHOVE_SEATS.find((each) => each === opener)
  if (!shover || effectiveBb > MAX_STACK + 0.5) return null
  const at = behind(shover).indexOf(seat as SeatId)
  if (at < 0) return null
  const stack = Math.min(MAX_STACK, Math.max(MIN_STACK, Math.round(effectiveBb)))
  const nash = nashFor({ seat: shover as ShoveSeat, stack })
  const klass = classOf(hero.hole)
  const calls = nash.call[at]?.[klass]
  if (calls === undefined) return null
  // The pot if the hero calls and nobody else does, and what the call adds to it.
  const pot = 2 * stack + (BLINDS - posted(shover) - posted(seat as SeatId))
  const risk = stack - posted(seat as SeatId)
  const against = equityVs(klass, nash.shove)
  const value = against.weight === 0 ? -risk : against.equity * pot - risk
  const margin = against.band * pot
  const mixed = calls > 0.01 && calls < 0.99
  return {
    stackBb: stack,
    verdict:
      mixed || Math.abs(value) <= margin
        ? ('close' as const)
        : calls >= 0.99
          ? ('call' as const)
          : ('fold' as const),
    callValueBb: hundredths(value),
  }
}

/**
 * Before the flop with exactly one player in ahead of the hero, who has not
 * acted yet: the spot as a chart names it, or null. `raise` is one raise and
 * nobody else in (no limper before it, no caller after it, the raiser not all
 * in). `limp` is the small blind's limp heads-up, the one limped pot the
 * charts cover. `stackBb` is the smaller of the two stacks. The service looks
 * those spots up (live-state/solver.mjs).
 *
 * `shove` is that one raise being all in. Up to fifteen big blinds the shove
 * chart the game teaches answers it here, as `callChart` (see `callFacts`);
 * a bigger all-in has none, and the call is the model's on equity and price.
 */
function facingFacts(
  hand: HandState,
  hero: HandState['players'][number],
  seats: Map<string, string>,
) {
  if (hand.street !== 'preflop' || hand.variant !== 'holdem' || seats.size > 6) return null
  const handClass = holeKey(hero.hole)
  const seat = CHART_POSITION[seats.get(hero.id) ?? '']
  if (!handClass || !seat) return null
  const acted = (hand.actions ?? []).filter((action) => action.street === 'preflop')
  if (acted.some((action) => action.playerId === hero.id)) return null
  const inAhead = acted.filter((action) => action.type !== 'fold')
  if (inAhead.length !== 1) return null
  const [only] = inAhead
  const them = hand.players.find((player) => player.id === only.playerId)
  const opener = CHART_POSITION[seats.get(only.playerId) ?? '']
  if (!them || !opener || (them.status !== 'active' && them.status !== 'allin')) return null
  const bigBlind = Math.max(hand.bigBlind, 1)
  const total = (player: HandState['players'][number]) => player.stack + player.committedThisHand
  const tenths = (value: number) => Math.round(value * 10) / 10
  const spot = {
    seat,
    opener,
    playersDealt: seats.size,
    stackBb: tenths(Math.min(total(hero), total(them)) / bigBlind),
    handClass,
  }
  const raised = only.type === 'raise' || only.type === 'bet'
  if (them.status === 'allin')
    return raised
      ? {
          kind: 'shove' as const,
          raiseToBb: tenths(only.to / bigBlind),
          ...spot,
          callChart: callFacts(hero, seat, opener, Math.min(total(hero), total(them)) / bigBlind),
        }
      : null
  if (raised) return { kind: 'raise' as const, raiseToBb: tenths(only.to / bigBlind), ...spot }
  if (only.type === 'call' && seats.size === 2 && hand.currentBet === hand.bigBlind)
    return { kind: 'limp' as const, raiseToBb: null, ...spot }
  return null
}

function positions(hand: HandState): Map<string, string> {
  // Include folded/all-in players: positions belong to the original deal.
  const dealt = hand.players.filter((player) => player.hole.length > 0)
  const button = hand.players[hand.buttonIndex]?.id
  const start = dealt.findIndex((player) => player.id === button)
  const labels = dealt.length === 2 ? ['BTN/SB', 'BB'] : ['BTN', 'SB', 'BB']
  const later = dealt.length - 3
  for (let i = 0; i < later; i++) {
    labels.push(i === later - 1 ? 'CO' : i === later - 2 ? 'HJ' : i === 0 ? 'UTG' : `UTG+${i}`)
  }
  return new Map(
    dealt.map((_, offset) => {
      const player = dealt[(start + offset + dealt.length) % dealt.length]
      return [player.id, labels[offset]]
    }),
  )
}

/**
 * The hand as the coach is told it, in chip units (independent of Pip's
 * cosmetic money display), or null when no Hold'em hand is in play.
 */
export function describeHand(hand: HandState | null, context: HandContext) {
  if (!hand) return null
  const seatPositions = positions(hand)
  const hero = hand.players.find((player) => player.id === context.heroId)
  const complete = isHandComplete(hand)
  const actor = complete ? null : (hand.players[hand.toActIndex]?.id ?? null)
  const legal = actor ? legalActions(hand) : null
  const equity = hero ? heroTurnEquity(hand, hero.id, context.displayedEquity) : null
  const remembered = context.lastEquity
  const lastEquity =
    equity !== null
      ? { equity, equityDisplay: formatWinPct(equity), street: hand.street as string }
      : remembered && validEquity(remembered.equity) && typeof remembered.street === 'string'
        ? {
            equity: remembered.equity,
            equityDisplay: formatWinPct(remembered.equity),
            street: remembered.street,
          }
        : null
  const pot = potSize(hand)
  const made = heroMadeHand(hand, hero)
  const board = boardFacts(hand, hero)
  const table = context.table ?? null
  const shownHands = revealedHands(hand, seatPositions)
  // Price to call only on the hero's own turn: the engine's call amount,
  // already capped at the hero's stack.
  const toCall = hero && legal && actor === hero.id ? legal.callAmount : null
  const firstIn = hero && actor === hero.id ? firstInFacts(hand, hero) : null
  const facing = hero && actor === hero.id ? facingFacts(hand, hero, seatPositions) : null
  const potOdds = toCall !== null && toCall > 0 ? toCall / (pot + toCall) : null
  const blindPosts = hand.players.flatMap((player) => {
    const position = seatPositions.get(player.id)
    const amount =
      position === 'BB'
        ? hand.bigBlind
        : position === 'SB' || position === 'BTN/SB'
          ? hand.smallBlind
          : 0
    if (!amount) return []
    const startingStack =
      player.stack + player.committedThisHand - (hand.result?.payouts[player.id] ?? 0)
    return [
      {
        playerId: player.id,
        type: position === 'BB' ? 'big_blind' : 'small_blind',
        amount: Math.min(startingStack, amount),
      },
    ]
  })
  return {
    number: context.handNo,
    variant: hand.variant,
    complete,
    street: hand.street,
    buttonPlayerId: hand.players[hand.buttonIndex]?.id ?? null,
    smallBlind: hand.smallBlind,
    bigBlind: hand.bigBlind,
    blindPosts,
    hero: hero
      ? {
          playerId: hero.id,
          position: seatPositions.get(hero.id) ?? null,
          holeCards: hero.hole.map(cardToString),
          handName: made?.name ?? null,
          // Which hand exactly, and which of the hero's cards are in it: the name
          // alone ("Pair") let the model guess the pair from the hero's own cards.
          madeHand:
            made && hand.variant === 'holdem'
              ? madeHandWords(hero.hole, hand.community, made)
              : null,
          equity,
          equityDisplay: formatWinPct(equity),
          lastEquity,
          stack: hero.stack,
          toCall,
          potOdds,
          // Folded round to the hero before the flop: the spot a chart answers.
          firstIn,
          // One raise in ahead (or the small blind's limp heads-up): the other spot.
          facing,
          // After the flop: what beats the hand now, and the cards that improve it.
          beatenBy: board?.beatenBy ?? null,
          outs: board?.outs ?? null,
        }
      : null,
    communityCards: hand.community.map(cardToString),
    // The engine's potSize is contributions across all streets. After
    // completion it describes the contested pot, which has been awarded.
    pot,
    potAwarded: complete,
    players: hand.players.map((player) => ({
      playerId: player.id,
      name: player.name,
      position: seatPositions.get(player.id) ?? null,
      status: player.status,
      stack: player.stack,
      committedThisStreet: player.committedThisStreet,
      committedThisHand: player.committedThisHand,
      // What opening this player at the table shows: the style line and
      // "Your reads", never the AI's hidden profile. Nobody reads the hero.
      style: table?.players[player.id]?.style ?? null,
      reads: player.id === context.heroId ? [] : [...(table?.players[player.id]?.reads ?? [])],
    })),
    // Remaining chips behind, excluding chips already committed. Per-opponent
    // values avoid inventing a single effective stack for a multiway pot.
    effectiveRemainingStacks: hero
      ? hand.players
          .filter(
            (player) =>
              player.id !== hero.id && player.status !== 'folded' && player.status !== 'out',
          )
          .map((player) => ({
            opponentId: player.id,
            chips: Math.min(hero.stack, player.stack),
          }))
      : [],
    currentBet: hand.currentBet,
    currentPlayerToAct: actor,
    // These legal sizes belong to the current actor, which may be an AI.
    // Bet/raise amounts are TOTAL commitment this street; callAmount is the
    // additional chips to pay, already capped at the actor's remaining stack.
    availableActions: legal ? { playerId: actor, ...legal } : null,
    actionHistory: (hand.actions ?? []).map((action) => ({
      playerId: action.playerId,
      street: action.street,
      type: action.type,
      committedTo: action.to,
      name: hand.players.find((player) => player.id === action.playerId)?.name ?? null,
      position: seatPositions.get(action.playerId) ?? null,
    })),
    // Public results only: never the evaluations wholesale (a folded hand's
    // stays secret), never the review format's all-player hole array.
    // `shownHands` is what the felt turned face up, each with its name.
    result: hand.result
      ? {
          showdown: hand.result.showdown,
          payouts: { ...hand.result.payouts },
          potsAwarded: hand.result.potsAwarded.map((pot) => ({
            amount: pot.amount,
            winners: [...pot.winners],
          })),
          shownHands,
        }
      : null,
    table: table
      ? {
          venue: table.venue,
          format: table.format,
          blindLevel: table.blindLevel,
          status: table.status,
          place: table.place,
          scoreHands: table.scoreHands,
        }
      : null,
    brief: brief(hand, {
      handNo: context.handNo,
      complete,
      actor,
      hero,
      heroPosition: hero ? (seatPositions.get(hero.id) ?? null) : null,
      positions: seatPositions,
      pot,
      toCall,
      potOdds,
      equity,
      lastEquity,
      shownHands,
      made,
      table,
    }),
  }
}

export type CoachHand = NonNullable<ReturnType<typeof describeHand>>

type ShownHand = {
  playerId: string
  name: string
  position: string | null
  holeCards: string[]
  handName?: string
}

/**
 * Exactly the hands the table turned face up when the hand ended, in seat
 * order: the engine's `showsHoleCards`, the rule the felt itself draws by.
 * Empty without a showdown and while the hand is in play.
 *
 * Every shown hand carries its `handName`, the losers' too: the cards and the
 * board are face up, so the name adds nothing the player cannot see. Without it
 * the model ranked a losing straight itself, mid-answer, and corrected itself
 * in the text ("Wait, correction", 2026-11-18).
 */
function revealedHands(hand: HandState, positions: Map<string, string>): ShownHand[] {
  const result = hand.result
  if (!result) return []
  return hand.players
    .filter((player) => showsHoleCards(hand, player))
    .map((player) => {
      const handName = result.evaluations?.[player.id]?.name
      return {
        playerId: player.id,
        name: player.name,
        position: positions.get(player.id) ?? null,
        holeCards: player.hole.map(cardToString),
        ...(handName ? { handName } : {}),
      }
    })
}

/**
 * One plain-English summary for a voice assistant, built only from values the
 * snapshot already carries. Chip counts are bare numbers: play money, never a
 * currency.
 */
function brief(
  hand: HandState,
  facts: {
    handNo: number
    complete: boolean
    actor: string | null
    hero: HandState['players'][number] | undefined
    heroPosition: string | null
    positions: Map<string, string>
    pot: number
    toCall: number | null
    potOdds: number | null
    equity: number | null
    lastEquity: { equityDisplay: string; street: string } | null
    shownHands: ShownHand[]
    made: EvaluatedHand | null
    table: TableContext | null
  },
): string {
  const { hero, complete } = facts
  const name = (id: string) =>
    id === hero?.id ? 'You' : (hand.players.find((player) => player.id === id)?.name ?? id)
  const parts = [`Hand ${facts.handNo}, ${complete ? 'complete' : hand.street}.`]
  if (!hero || hero.hole.length === 0) parts.push('You are not in this hand.')
  else {
    const seat = facts.heroPosition ? `You are ${facts.heroPosition}` : 'You are seated'
    parts.push(`${seat} with ${hero.hole.map(cardToString).join(' ')}, ${hero.stack} behind.`)
    if (hero.status === 'folded') parts.push('You folded.')
    if (!complete && hero.status === 'allin') parts.push('You are all in.')
  }
  if (hand.community.length) parts.push(`Board ${hand.community.map(cardToString).join(' ')}.`)
  if (complete) {
    const pots = hand.result?.potsAwarded ?? []
    const won = pots.map((award) => {
      const winners = award.winners.map(name)
      return `${winners.join(' and ')} ${winners.length > 1 ? 'split' : 'won'} ${award.amount}`
    })
    if (won.length)
      parts.push(
        `${won.join('; ')} ${hand.result?.showdown ? 'at showdown' : 'without a showdown'}.`,
      )
    // Only what the table turned face up: never a folded or unshown hand.
    const shown = facts.shownHands.map(
      (shown, i) =>
        `${shown.playerId === hero?.id ? (i ? 'you' : 'You') : shown.name} showed ${shown.holeCards.join(' ')}`,
    )
    if (shown.length) parts.push(`${shown.join(', ')}.`)
    const run = runClause(facts.table, hero)
    if (run) parts.push(run)
    return parts.join(' ')
  }
  if (facts.made && hero && hero.status !== 'folded') {
    const phrase = hand.variant === 'holdem' ? madeHandLabel(facts.made) : handPhrase(facts.made)
    parts.push(phrase ? `You have ${phrase}.` : `Your hand: ${facts.made.name}.`)
  }
  parts.push(`Pot ${facts.pot}.`)
  if (facts.actor && facts.actor === hero?.id) {
    parts.push(
      facts.toCall && facts.potOdds !== null
        ? `Your turn: ${facts.toCall} to call, pot odds ${pct(facts.potOdds)}.`
        : 'Your turn, nothing to call.',
    )
  } else if (facts.actor) {
    const position = facts.positions.get(facts.actor)
    parts.push(`${name(facts.actor)}${position ? ` (${position})` : ''} to act.`)
  }
  if (facts.equity !== null) parts.push(`Equity ${pct(facts.equity)}.`)
  else if (facts.lastEquity && hero && (hero.status === 'active' || hero.status === 'allin'))
    parts.push(
      `Last estimate ${facts.lastEquity.equityDisplay} ${facts.lastEquity.street === 'preflop' ? 'preflop' : `on the ${facts.lastEquity.street}`}.`,
    )
  const run = runClause(facts.table, hero)
  if (run) parts.push(run)
  return parts.join(' ')
}

/** How the run stands once it is over; null while it goes on. */
function runClause(
  table: TableContext | null,
  hero: HandState['players'][number] | undefined,
): string | null {
  if (!table) return null
  const place = table.place && table.place > 1 ? ordinal(table.place) : null
  switch (table.status) {
    case 'won':
      return 'You won the table.'
    case 'busted':
      return place ? `You are out in ${place}.` : 'You are out of chips.'
    case 'watching':
      return place ? `You are out in ${place}, watching the table play out.` : null
    case 'scored':
      return hero ? `The game is over: you finish with ${hero.stack} chips.` : 'The game is over.'
    default:
      return null
  }
}
