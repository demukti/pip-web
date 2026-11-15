// The table around the shared hand, read from the stores when a snapshot is
// taken. Kept here, outside the publisher and outside the game store, so the
// fork touches neither more than it must: the publisher stays store-free (and
// testable in Node), and the game store keeps its four capture calls.
//
// The rule is the snapshot's own: only what the player can already see. The
// header names the venue and the blinds level; opening a seat shows its style
// line and "Your reads", derived exactly as PlayerDialog derives them. Never a
// seat's AI profile, form or anything else the table does not show.
import { deriveReads } from '@/lib/reads'
import { useGame } from '@/store/game'
import { useProfile } from '@/store/profile'
import { livePublisher, type LivePublisher } from './publisher'
import type { LiveTableContext } from './state'

type Game = ReturnType<typeof useGame.getState>

/**
 * The place the player finished, held from the moment they bust a tournament
 * until they have chips again.
 *
 * Needed because of how spectating ("Watch it out") behaves in the store: each
 * spectated deal sets `status` back to `playing`, and the end of that hand runs
 * the bust branch again, setting `busted` and recomputing `place` from the
 * players left (better than the real finish if someone else went out). The
 * store is upstream's and stays untouched, so the snapshot corrects for it here.
 */
let finish: number | null = null

/** Out of a tournament: the player's own seat has no chips. */
const isOut = ({ venue, seats }: Game) =>
  !!venue && !venue.cash && seats.find((seat) => seat.isHuman)?.stack === 0

function track(game: Game) {
  if (!isOut(game)) finish = null
  else if (finish === null) finish = game.place
}

export function tableContext(): LiveTableContext | null {
  const game = useGame.getState()
  const { venue, seats, seatStats, status, place, blindLevel } = game
  if (!venue) return null
  track(game)
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
 * Give the publisher its context, and publish the last hand again when the run
 * moves on without a new capture: the hand-complete capture comes before the
 * store settles on handover, busted, won or scored, so without this the coach
 * would never hear that the run is over. `playing` is skipped: a deal (and its
 * own capture) always follows it.
 *
 * `publisher` is the app's own except in tests.
 */
export function startTableContext(
  publisher: Pick<LivePublisher, 'setTableContext' | 'refresh'> = livePublisher,
) {
  const remove = publisher.setTableContext(tableContext)
  track(useGame.getState())
  const unsubscribe = useGame.subscribe((state, previous) => {
    // Every change, so the first finishing place is held even while sharing is off.
    track(state)
    if (state.status === previous.status || state.status === 'playing') return
    publisher.refresh(state.hand)
  })
  return () => {
    unsubscribe()
    remove()
  }
}
