'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import { askPipConnection } from '@/lib/askPip/connection'
import { askPip } from '@/lib/askPip/session'
import { sound } from '@/lib/sound'
import { cn } from '@/lib/utils'

/*
 * Ask Pip: a coaching answer on the hand in front of you, only when you ask,
 * once this browser is signed in (Settings → Ask Pip). Two pieces that share
 * one answer (`lib/askPip/session.ts`): the button in the table's top-left
 * corner, and the card over your own hand, the one part of the table the
 * advice already speaks for. It never covers a seat, the board or the pot.
 */

const useAnswer = () => useSyncExternalStore(askPip.subscribe, askPip.get, askPip.getServer)

/** The button, in the table's top-left corner. `hand` is the deal being played. */
export function AskPipButton({ hand, className }: { hand: number; className?: string }) {
  const status = useSyncExternalStore(
    askPipConnection.subscribe,
    askPipConnection.get,
    askPipConnection.getServer,
  )
  const answer = useAnswer()
  // A new deal retires the last one's answer (and stops one still being written).
  useEffect(() => () => askPip.leave(hand), [hand])
  if (!status.signedIn) return null
  const busy = answer.phase === 'asking' || answer.phase === 'answering'
  const showing = answer.phase !== 'idle' && answer.hand === hand
  return (
    <button
      type="button"
      onClick={() => {
        sound.play('tap')
        void askPip.start(hand)
      }}
      disabled={busy}
      className={cn(
        'inline-flex items-center rounded-full border border-foreground/10 bg-background/60 px-2.5 py-0.5 text-2xs font-medium text-foreground backdrop-blur-sm transition hover:bg-foreground/10 active:scale-[0.97] disabled:opacity-60',
        className,
      )}
    >
      {busy ? 'Pip is thinking…' : showing ? 'Ask again' : 'Ask Pip'}
    </button>
  )
}

/**
 * The answer, laid over the hero's row (cards and panel) and anchored to its
 * foot: as tall as the row, or 12rem when the row is shorter, scrolling past
 * that. Place it inside a positioned box around the hero's row that sets no
 * z-index: at z-40 the answer, which the player asked for, lies over the
 * hand's result banner (z-30) and under the end-of-run overlay (z-40, later).
 */
export function AskPipCard({ hand }: { hand: number }) {
  const answer = useAnswer()
  const open = answer.phase !== 'idle' && answer.hand === hand
  const busy = answer.phase === 'asking' || answer.phase === 'answering'
  const lines = open ? answer.text.trimStart().split('\n') : []
  const advice = lines[0] ?? ''
  const why = lines.slice(1).join('\n').trim()
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          key="answer"
          aria-label="Pip’s advice"
          aria-live="polite"
          aria-busy={busy}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-x-0 bottom-0 z-40 mx-auto max-h-[max(100%,12rem)] w-[min(26rem,calc(100%-1.5rem))] overflow-y-auto rounded-2xl border border-foreground/10 bg-background/95 p-3 pr-8 text-sm shadow-lg backdrop-blur-sm"
        >
          <button
            type="button"
            onClick={() => askPip.close()}
            aria-label="Close Pip’s advice"
            className="absolute right-1.5 top-1.5 rounded-full p-1 text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
          {answer.phase === 'asking' ? (
            <p className="text-muted-foreground motion-safe:animate-pulse">Reading the table…</p>
          ) : (
            <>
              {advice && <p className="font-semibold text-foreground">{advice}</p>}
              {why && <p className="mt-1 whitespace-pre-line text-muted-foreground">{why}</p>}
            </>
          )}
          {answer.phase === 'failed' && (
            <p className="mt-1 text-muted-foreground">{answer.message}</p>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  )
}
