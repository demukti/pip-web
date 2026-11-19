// The hero's made hand said exactly: which hand, and which of the hero's own cards
// are in it. Added 2026-11-19: sent only the category ("Pair"), the model filled in
// the pair from the hero's ace ("a pair of aces") on 4 T 8 8 with A5, where the
// pair is the board's eights and the ace only a kicker. Twice, by the player's count.
//
// Read off the evaluator's own five, which puts the cards that make the hand first
// and the kickers after (`bestFive`), so nothing here ranks a hand.
import { type Card, type Rank, cardToString, rankName } from '@/lib/poker/cards'
import type { EvaluatedHand } from '@/lib/poker/handEval'
import { rankHoldem } from '@/lib/poker/rank7'

/** How many of the five a category makes, the rest being kickers. */
const MAKES: Record<string, number> = {
  'High Card': 1,
  Pair: 2,
  'Two Pair': 4,
  'Three of a Kind': 3,
  Straight: 5,
  Flush: 5,
  'Full House': 5,
  'Four of a Kind': 4,
  'Straight Flush': 5,
}

const SUIT_PLURAL: Record<Card['suit'], string> = {
  c: 'clubs',
  d: 'diamonds',
  h: 'hearts',
  s: 'spades',
}

/** "eight" → "eights", "six" → "sixes". */
const plural = (rank: Rank) => {
  const word = rankName(rank)
  return word.endsWith('x') ? `${word}es` : `${word}s`
}

/** The ranks in order of first appearance. */
const ranksOf = (cards: readonly Card[]) => [...new Set(cards.map((card) => card.rank))]

const listed = (words: string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : (words[0] ?? '')

/** "your ace (As)", the rank said and the card as the snapshot writes it. */
const yours = (cards: readonly Card[]) =>
  `your ${listed(cards.map((card) => `${rankName(card.rank)} (${cardToString(card)})`))}`

/** The hand in words, e.g. "a pair of eights", "two pair, kings and eights". */
export function madeHandLabel(made: EvaluatedHand): string {
  const best = made.best
  const ranks = ranksOf(best.slice(0, MAKES[made.name] ?? 5))
  switch (made.name) {
    case 'High Card':
      return `${rankName(best[0].rank)} high`
    case 'Pair':
      return `a pair of ${plural(ranks[0])}`
    case 'Two Pair':
      return `two pair, ${plural(ranks[0])} and ${plural(ranks[1])}`
    case 'Three of a Kind':
      return `three of a kind, ${plural(ranks[0])}`
    case 'Straight':
      return `a straight, ${rankName(best[0].rank)} high`
    case 'Flush':
      return `a flush in ${SUIT_PLURAL[best[0].suit]}, ${rankName(best[0].rank)} high`
    case 'Full House':
      return `a full house, ${plural(ranks[0])} full of ${plural(ranks[1])}`
    case 'Four of a Kind':
      return `four of a kind, ${plural(ranks[0])}`
    case 'Straight Flush':
      return made.description === 'Royal Flush'
        ? 'a royal flush'
        : `a straight flush, ${rankName(best[0].rank)} high`
    default:
      return made.name.toLowerCase()
  }
}

/**
 * The hand and the hero's part in it, in two or three short sentences, e.g. "A
 * pair of eights. The eights are on the board, not from your cards. Your ace (As)
 * and five (5c) play only as kickers." Hold'em only: the other games build hands
 * by rules this does not know.
 */
export function madeHandWords(
  hole: readonly Card[],
  board: readonly Card[],
  made: EvaluatedHand,
): string {
  const label = madeHandLabel(made)
  const sentence = `${label[0].toUpperCase()}${label.slice(1)}.`
  if (board.length === 5 && rankHoldem(hole, board) === rankHoldem([], board))
    return `${sentence} The board plays: your cards add nothing to it, so every player still in has at least this.`
  const mine = (card: Card) => hole.some((own) => own.rank === card.rank && own.suit === card.suit)
  const makes = MAKES[made.name] ?? 5
  const making = made.best.slice(0, makes)
  const kickers = made.best.slice(makes).filter(mine)
  const unused = hole.filter(
    (own) => !made.best.some((card) => card.rank === own.rank && card.suit === own.suit),
  )
  const parts = [sentence]
  if (made.name === 'High Card')
    parts.push(
      mine(making[0])
        ? `${capital(yours(making))} is the high card.`
        : `The ${rankName(making[0].rank)} is on the board, not from your cards.`,
    )
  else if (made.name === 'Straight' || made.name === 'Flush' || made.name === 'Straight Flush') {
    const fromHero = making.filter(mine)
    parts.push(fromHero.length ? `It uses ${yours(fromHero)}.` : 'It is all on the board.')
  } else {
    // Each rank that makes the hand, by where it comes from.
    const ranks = ranksOf(making)
    if (!making.some(mine))
      parts.push(`The ${listed(ranks.map(plural))} are on the board, not from your cards.`)
    else {
      const groups = ranks.map((rank) => {
        const cards = making.filter((card) => card.rank === rank)
        const own = cards.filter(mine)
        if (own.length === 0) return `the ${plural(rank)} are on the board`
        if (own.length === cards.length) return `the ${plural(rank)} are both your own cards`
        return `${yours(own)} ${own.length > 1 ? 'make' : 'makes'} the ${plural(rank)}`
      })
      parts.push(`${capital(groups.join('; '))}.`)
    }
  }
  if (kickers.length)
    parts.push(
      `${capital(yours(kickers))} ${kickers.length > 1 ? 'play' : 'plays'} only as ${kickers.length > 1 ? 'kickers' : 'a kicker'}.`,
    )
  if (unused.length)
    parts.push(`${capital(yours(unused))} ${unused.length > 1 ? 'do' : 'does'} not play.`)
  return parts.join(' ')
}

const capital = (words: string) => `${words[0].toUpperCase()}${words.slice(1)}`
