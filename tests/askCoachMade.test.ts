import test from 'ava'
import { madeHandLabel, madeHandWords } from '@/lib/askCoach/made'
import { cardFromString } from '@/lib/poker/cards'
import { evaluateHand } from '@/lib/poker/handEval'

const cards = (s: string) => s.split(' ').map(cardFromString)
const words = (hole: string, board: string) =>
  madeHandWords(cards(hole), cards(board), evaluateHand(cards(hole), cards(board)))

test('a pair on the board is not the hero pair: the hand the coach misread', (t) => {
  // A5 on 4 T 8 8: the coach said "a pair of aces". The pair is the board's eights.
  t.is(
    words('5c As', '4h Ts 8c 8s'),
    'A pair of eights. The eights are on the board, not from your cards. Your ace (As) and five (5c) play only as kickers.',
  )
})

test('says which of the hero cards make the hand and which do not play', (t) => {
  t.is(
    words('5c As', '4h Ts 8c 8s Ad'),
    'Two pair, aces and eights. Your ace (As) makes the aces; the eights are on the board. Your five (5c) does not play.',
  )
  t.is(words('Jc Jd', '4h Ts 8c'), 'A pair of jacks. The jacks are both your own cards.')
  t.is(
    words('Kc 7d', 'Kh Ks 7c 2s 3d'),
    'A full house, kings full of sevens. Your king (Kc) makes the kings; your seven (7d) makes the sevens.',
  )
  t.is(
    words('Ac Kd', '7h 6s 2c'),
    'Ace high. Your ace (Ac) is the high card. Your king (Kd) plays only as a kicker.',
  )
})

test('five-card hands name their top card and the hero cards they use', (t) => {
  t.is(
    words('Ac 2d', '3h 4s 5c 9d Kd'),
    'A straight, five high. It uses your two (2d) and ace (Ac).',
  )
  t.is(
    words('Kh Qh', '2h 7h 9h Ts 3c'),
    'A flush in hearts, king high. It uses your king (Kh) and queen (Qh).',
  )
})

test('when the board plays, the hero is told so', (t) => {
  t.true(words('2c 3d', 'Ah Kh Qh Jh Th').startsWith('A royal flush. The board plays'))
  t.true(words('2c 3d', 'Ah Ad Kc Ks Qh').includes('The board plays'))
})

test('the label names the ranks', (t) => {
  const label = (hole: string, board: string) =>
    madeHandLabel(evaluateHand(cards(hole), cards(board)))
  t.is(label('6c 6d', '6h 2s 9c'), 'three of a kind, sixes')
  t.is(label('8h 8d', '8c 8s 2c'), 'four of a kind, eights')
})
