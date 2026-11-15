'use client'

import { useSyncExternalStore } from 'react'
import { livePublisher } from '@/lib/liveCoaching/publisher'
import { cn } from '@/lib/utils'

type BadgeState = 'live' | 'syncing' | 'offline' | 'reconnecting' | 'ended'

const LABELS: Record<BadgeState, { text: string; spoken: string }> = {
  live: { text: 'Live', spoken: 'Live coaching: up to date' },
  syncing: { text: 'Syncing', spoken: 'Live coaching: sending the latest hand' },
  offline: {
    text: 'Offline',
    spoken: 'Live coaching: cannot reach the service; ChatGPT may be behind',
  },
  reconnecting: { text: 'Reconnecting', spoken: 'Live coaching: reconnecting your saved session' },
  ended: { text: 'Sharing ended', spoken: 'Live coaching: sharing ended; reconnect in Settings' },
}
const ORDER = Object.keys(LABELS) as BadgeState[]

/**
 * Whether ChatGPT has the table as it stands, for a player sharing it through
 * Live coaching (Settings). Nothing at all unless sharing is on or ended on its
 * own, so a player who never turned it on, stopped it, or shares from another
 * tab sees the same table as before.
 *
 * - Live: connected, reachable, the latest state accepted.
 * - Syncing: an upload is on its way.
 * - Offline: connected, but the last heartbeat or upload did not get through.
 * - Reconnecting: a saved session is waiting for the service.
 * - Sharing ended: it expired or was revoked without the player stopping it.
 *
 * Every label shares one grid cell, the hidden ones invisible, so the badge is
 * the same width whichever it shows and never nudges anything as it flips.
 */
export function LiveCoachingBadge({ className }: { className?: string }) {
  const status = useSyncExternalStore(
    livePublisher.subscribe,
    livePublisher.getStatus,
    livePublisher.getServerStatus,
  )
  const state: BadgeState | null = status.connected
    ? !status.reachable
      ? 'offline'
      : status.acceptedVersion >= status.version
        ? 'live'
        : 'syncing'
    : status.resuming
      ? 'reconnecting'
      : status.ended && !status.otherTab
        ? 'ended'
        : null
  if (!state) return null
  return (
    <span
      title={status.message}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-foreground/10 bg-background/60 px-2 py-0.5 text-3xs font-medium text-muted-foreground backdrop-blur-sm',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          state === 'live' && 'bg-pip',
          (state === 'syncing' || state === 'reconnecting') &&
            'bg-muted-foreground motion-safe:animate-pulse',
          state === 'offline' && 'bg-muted-foreground/60',
          state === 'ended' && 'border border-muted-foreground/60',
        )}
      />
      <span aria-hidden className="grid">
        {ORDER.map((key) => (
          <span key={key} className={cn('col-start-1 row-start-1', key !== state && 'invisible')}>
            {LABELS[key].text}
          </span>
        ))}
      </span>
      <span className="sr-only">{LABELS[state].spoken}</span>
    </span>
  )
}
