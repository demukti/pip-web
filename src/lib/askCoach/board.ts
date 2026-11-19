// After the flop, how the hero's hand stands on this board: every holding that
// beats it right now, and the next cards that would improve it. Exact, by
// enumeration, from the hero's own cards and the board only, so it says nothing
// the player cannot work out from the felt. Added 2026-11-19: left to itself, the
// model said a straight beat the hero's full house, and corrected itself mid-answer.
//
// It counts what exists, not what an opponent holds: how likely an opponent is to
// hold one of these is the equity's and the reads' to say. About a quarter of a
// millisecond a question, through the fast evaluator.
import { type Card, RANKS } from '@/lib/poker/cards'
import { CARD_AT, COMBO_A, COMBO_B, COMBOS, comboCards, deadMask } from '@/lib/poker/combos'
import { categoryOf, rankHoldem } from '@/lib/poker/rank7'

/** `rank7`'s categories by number, named as the felt (pokersolver) names them. */
const MADE = [
  'High Card',
  'Pair',
  'Two Pair',
  'Three of a Kind',
  'Straight',
  'Flush',
  'Full House',
  'Four of a Kind',
  'Straight Flush',
] as const

/** Past this many hole-card classes in one made hand, only the count is sent. */
export const CLASSES_MAX = 8

export interface BeatenBy {
  /** Holdings that beat the hero now; a chop is not a beat. */
  holdings: number
  /** Every holding the hero cannot rule out. */
  of: number
  /** Strongest first, by the hand each makes. */
  hands: { made: string; holdings: number; classes?: string[] }[]
}

export interface Outs {
  /** Next cards that improve the hero's hand, by the hand they make. */
  cards: number
  /** Cards the hero cannot see. */
  of: number
  /**
   * Strongest first. `suit` when every card of the group is one suit (a flush
   * draw's "any heart"), otherwise the `ranks` that do it. Never card names: a
   * list of unseen cards would read like the deck.
   */
  improvesTo: { made: string; cards: number; suit?: string; ranks?: string[] }[]
}

const rankOrder = (rank: string) => RANKS.indexOf(rank as Card['rank'])

/**
 * The class a holding belongs to, by rank pair, high card first ("KJ", "KK").
 * Suit is added after, and only when it matters (`classesOf`).
 */
function rankPair([a, b]: readonly [Card, Card]): string {
  return rankOrder(a.rank) >= rankOrder(b.rank) ? `${a.rank}${b.rank}` : `${b.rank}${a.rank}`
}

/** "KJ" when any KJ does it, "KJs" when only suited ones do, by rank pair, high first. */
function classesOf(holdings: [Card, Card][]): string[] {
  const suited = new Map<string, boolean>()
  for (const holding of holdings) {
    const key = rankPair(holding)
    const same = holding[0].suit === holding[1].suit
    suited.set(key, (suited.get(key) ?? true) && same)
  }
  return [...suited]
    .sort(([x], [y]) => rankOrder(y[0]) - rankOrder(x[0]) || rankOrder(y[1]) - rankOrder(x[1]))
    .map(([key, onlySuited]) => (onlySuited && key[0] !== key[1] ? `${key}s` : key))
}

/** Every holding the hero cannot rule out that beats the hero's hand on this board now. */
export function beatenBy(hole: readonly Card[], board: readonly Card[]): BeatenBy {
  const dead = deadMask([...hole, ...board])
  const mine = rankHoldem(hole, board)
  const byMade = new Map<number, [Card, Card][]>()
  let of = 0
  for (let combo = 0; combo < COMBOS; combo++) {
    if (dead[COMBO_A[combo]] || dead[COMBO_B[combo]]) continue
    of++
    const cards = comboCards(combo)
    const theirs = rankHoldem(cards, board)
    if (theirs <= mine) continue
    const made = categoryOf(theirs)
    byMade.set(made, [...(byMade.get(made) ?? []), cards])
  }
  const hands = [...byMade]
    .sort(([x], [y]) => y - x)
    .map(([made, holdings]) => {
      const classes = classesOf(holdings)
      return {
        made: MADE[made],
        holdings: holdings.length,
        ...(classes.length <= CLASSES_MAX ? { classes } : {}),
      }
    })
  return { holdings: hands.reduce((sum, hand) => sum + hand.holdings, 0), of, hands }
}

/**
 * The next cards that move the hero up a made hand, and only where the hero's own
 * cards play: a card that pairs the board for everyone improves nobody. Flop and
 * turn only; null on the river, with no card to come.
 */
export function outs(hole: readonly Card[], board: readonly Card[]): Outs | null {
  if (board.length < 3 || board.length > 4) return null
  const dead = deadMask([...hole, ...board])
  const now = categoryOf(rankHoldem(hole, board))
  const byMade = new Map<number, Card[]>()
  let of = 0
  for (let i = 0; i < 52; i++) {
    if (dead[i]) continue
    of++
    const card = CARD_AT[i]
    const next = [...board, card]
    const made = categoryOf(rankHoldem(hole, next))
    // The board alone (four or five cards): what every player now has.
    if (made <= now || made <= categoryOf(rankHoldem([], next))) continue
    byMade.set(made, [...(byMade.get(made) ?? []), card])
  }
  const improvesTo = [...byMade]
    .sort(([x], [y]) => y - x)
    .map(([made, cards]) => {
      const suits = new Set(cards.map((card) => card.suit))
      const ranks = [...new Set(cards.map((card) => card.rank))].sort(
        (x, y) => rankOrder(y) - rankOrder(x),
      )
      return {
        made: MADE[made],
        cards: cards.length,
        ...(suits.size === 1 && ranks.length > 1 ? { suit: cards[0].suit } : { ranks }),
      }
    })
  return { cards: improvesTo.reduce((sum, group) => sum + group.cards, 0), of, improvesTo }
}
