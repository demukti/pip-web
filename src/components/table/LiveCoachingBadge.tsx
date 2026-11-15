'use client'

import { useSyncExternalStore } from 'react'
import { livePublisher } from '@/lib/liveCoaching/publisher'
import { cn } from '@/lib/utils'

/**
 * Whether ChatGPT has the table as it stands, for a player sharing it through
 * Live coaching (Settings). Nothing at all unless sharing is on, so a player
 * who never turned it on sees the same table as before.
 *
 * Both labels share one grid cell, the hidden one invisible, so the badge is
 * the same width whichever it shows and never nudges anything as it flips.
 */
export function LiveCoachingBadge({ className }: { className?: string }) {
  const status = useSyncExternalStore(
    livePublisher.subscribe,
    livePublisher.getStatus,
    livePublisher.getServerStatus,
  )
  if (!status.connected) return null
  const current = status.acceptedVersion >= status.version
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
          current ? 'bg-pip' : 'bg-muted-foreground motion-safe:animate-pulse',
        )}
      />
      <span aria-hidden className="grid">
        <span className={cn('col-start-1 row-start-1', !current && 'invisible')}>Live</span>
        <span className={cn('col-start-1 row-start-1', current && 'invisible')}>Syncing</span>
      </span>
      <span className="sr-only">
        {current ? 'Live coaching: up to date' : 'Live coaching: sending the latest hand'}
      </span>
    </span>
  )
}
