// Explicit, hero-visible projection of the engine. Never serialize HandState
// directly: it contains the undealt deck and every opponent's private cards.
import { cardToString } from '@/lib/poker/cards'
import { isHandComplete, legalActions, potSize, type HandState } from '@/lib/poker/engine'
import { formatWinPct } from '@/lib/utils'

export interface LiveSnapshotContext {
  sessionId: string
  version: number
  capturedAt: string
  handNo: number
  heroId: string
  /** Exact estimate already computed for Pip's odds panel, never recomputed here. */
  displayedEquity?: number | null
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
 * Schema v1 uses chip units, independent of Pip's cosmetic money display.
 * `version` is allocated by the eventual publisher, not inferred from actions:
 * deals, leaving a table and reconnecting also need distinct snapshots.
 */
export function liveSnapshot(hand: HandState | null, context: LiveSnapshotContext) {
  if (!Number.isSafeInteger(context.version) || context.version < 1) {
    throw new Error('Snapshot version must be a positive safe integer')
  }
  if (!Number.isFinite(Date.parse(context.capturedAt))) throw new Error('Invalid capture time')
  const envelope = {
    schemaVersion: 1 as const,
    sessionId: context.sessionId,
    version: context.version,
    capturedAt: context.capturedAt,
  }
  if (!hand) return { ...envelope, hand: null }
  const seatPositions = positions(hand)
  const hero = hand.players.find((player) => player.id === context.heroId)
  const complete = isHandComplete(hand)
  const actor = complete ? null : (hand.players[hand.toActIndex]?.id ?? null)
  const legal = actor ? legalActions(hand) : null
  const estimate = context.displayedEquity
  const equity =
    hero &&
    actor === hero.id &&
    typeof estimate === 'number' &&
    Number.isFinite(estimate) &&
    estimate >= 0 &&
    estimate <= 1
      ? estimate
      : null
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
    ...envelope,
    hand: {
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
            equity,
            equityDisplay: formatWinPct(equity),
          }
        : null,
      communityCards: hand.community.map(cardToString),
      // The engine's potSize is contributions across all streets. After
      // completion it describes the contested pot, which has been awarded.
      pot: potSize(hand),
      potAwarded: complete,
      players: hand.players.map((player) => ({
        playerId: player.id,
        name: player.name,
        position: seatPositions.get(player.id) ?? null,
        status: player.status,
        stack: player.stack,
        committedThisStreet: player.committedThisStreet,
        committedThisHand: player.committedThisHand,
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
      })),
      // Public results only. Never include evaluations, which can reveal cards
      // beyond what was visible, or the review format's all-player hole array.
      result: hand.result
        ? {
            showdown: hand.result.showdown,
            payouts: { ...hand.result.payouts },
            potsAwarded: hand.result.potsAwarded.map((pot) => ({
              amount: pot.amount,
              winners: [...pot.winners],
            })),
          }
        : null,
    },
  }
}

export type LiveSnapshot = ReturnType<typeof liveSnapshot>
