// The hand and the table around it, read from the stores the moment the player
// asks. Kept outside the game store, which the coach never touches: one
// subscription (started in AppBoot) remembers what the store forgets.
//
// The rule is the description's own: only what the player can already see. The
// header names the venue and the blinds level; opening a seat shows its style
// line and "Your reads", derived exactly as PlayerDialog derives them. Never a
// seat's AI profile, form or anything else the table does not show.
import { cardToString } from '@/lib/poker/cards'
import type { HandState } from '@/lib/poker/engine'
import { deriveReads } from '@/lib/reads'
import { useGame } from '@/store/game'
import { useProfile } from '@/store/profile'
import { describeHand, heroTurnEquity, type TableContext } from './hand'

type Game = ReturnType<typeof useGame.getState>

const HERO_ID = 'hero'

/**
 * The place the player finished, held from the moment they bust a tournament
 * until they have chips again.
 *
 * Needed because of how spectating ("Watch it out") behaves in the store: each
 * spectated deal sets `status` back to `playing`, and the end of that hand runs
 * the bust branch again, setting `busted` and recomputing `place` from the
 * players left (better than the real finish if someone else went out). The
 * store is upstream's and stays untouched, so the description corrects for it.
 */
let finish: number | null = null

/**
 * Which deal a remembered estimate belongs to. The hand number alone repeats
 * when a bust re-seats the player at a fresh table, so the hero's cards and the
 * board so far go with it. Both only grow within one deal (a Mystery Card joins
 * the hole at the river), so a later state of the same deal extends them.
 */
interface DealMark {
  handNo: number
  hole: string[]
  board: string[]
}
/** The latest hero-turn estimate in the current deal: "how's my hand?" on an AI turn. */
let lastEquity: { mark: DealMark; equity: number; street: string } | null = null

function markOf(hand: HandState, handNo: number): DealMark {
  const hero = hand.players.find((player) => player.id === HERO_ID)
  return {
    handNo,
    hole: (hero?.hole ?? []).map(cardToString),
    board: hand.community.map(cardToString),
  }
}
const startsWith = (cards: string[], prefix: string[]) =>
  prefix.length <= cards.length && prefix.every((card, i) => cards[i] === card)
const sameDeal = (earlier: DealMark, now: DealMark) =>
  earlier.handNo === now.handNo &&
  startsWith(now.hole, earlier.hole) &&
  startsWith(now.board, earlier.board)

/** Out of a tournament: the player's own seat has no chips. */
const isOut = ({ venue, seats }: Game) =>
  !!venue && !venue.cash && seats.find((seat) => seat.isHuman)?.stack === 0

/** The coach covers Hold'em: other variants are described as no hand. */
const holdem = (game: Game) => (game.hand?.variant === 'holdem' ? game.hand : null)

function track(game: Game) {
  if (!isOut(game)) finish = null
  else if (finish === null) finish = game.place
  const hand = holdem(game)
  if (!hand) return
  const equity = heroTurnEquity(hand, HERO_ID, game.heroEquity)
  if (equity !== null)
    lastEquity = { mark: markOf(hand, game.handIndex), equity, street: hand.street }
}

export function tableContext(game: Game = useGame.getState()): TableContext | null {
  const { venue, seats, seatStats, status, place, blindLevel } = game
  if (!venue) return null
  const out = isOut(game)
  const castRecords = useProfile.getState().castRecords
  return {
    venue: venue.name,
    format: venue.scoreHands !== undefined ? 'score' : venue.cash ? 'cash' : 'tournament',
    blindLevel: blindLevel + 1,
    // Out of the run but hands still dealt: that is spectating, whatever the
    // store says between spectated deals.
    status: out && (status === 'playing' || status === 'watching') ? 'watching' : status,
    place: out ? (finish ?? place) : place,
    scoreHands: venue.scoreHands ?? null,
    players: Object.fromEntries(
      seats.map((seat) => {
        // PlayerDialog: a cast character's career record, else this table's
        // stats; no reads for the player's own seat.
        const career = seat.characterId ? castRecords[seat.characterId]?.stats : undefined
        const reads = seat.isHuman ? null : deriveReads(career ?? seatStats[seat.id])
        return [
          seat.id,
          { style: seat.style ?? null, reads: reads?.map((read) => read.label) ?? [] },
        ]
      }),
    ),
  }
}

/**
 * How many actions the player has committed in the hand on the table. Sizing a
 * raise is not one until it is confirmed. The card closes when this moves.
 */
export const heroActions = ({ hand }: Pick<Game, 'hand'>) =>
  hand?.actions?.filter((action) => action.playerId === HERO_ID).length ?? 0

/** The hand in front of the player, as the coach is told it; null without one. */
export function currentHand(game: Game = useGame.getState()) {
  track(game)
  const hand = holdem(game)
  if (!hand) return null
  const mark = markOf(hand, game.handIndex)
  const remembered = lastEquity && sameDeal(lastEquity.mark, mark) ? lastEquity : null
  return describeHand(hand, {
    handNo: game.handIndex,
    heroId: HERO_ID,
    displayedEquity: game.heroEquity,
    lastEquity: remembered && { equity: remembered.equity, street: remembered.street },
    table: tableContext(game),
  })
}

/**
 * Remember, on every change, what the store forgets: the first finishing place
 * and the last hero-turn estimate of the deal. Returns the unsubscribe.
 */
export function startAskCoach() {
  track(useGame.getState())
  return useGame.subscribe((state) => track(state))
}
