'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Lightbulb, RotateCw, X } from 'lucide-react'
import { askCoachConnection } from '@/lib/askCoach/connection'
import { askCoach } from '@/lib/askCoach/session'
import { heroActions } from '@/lib/askCoach/table'
import { sound } from '@/lib/sound'
import { type KeyTarget, keysReachTable } from '@/lib/tableKeys'
import { cn } from '@/lib/utils'
import { useGame } from '@/store/game'
import { useTableKeyboard, useTableKeys } from './keys'

/*
 * The coach: an answer on the hand in front of you, only when you ask, once
 * this browser is signed in (Settings → Coach). Two pieces that share one
 * answer (`lib/askCoach/session.ts`): the button, in the bottom-left corner of
 * your own panel beside its other corner controls, and the card over your own
 * row, the one part of the table the advice already speaks for. It never
 * covers a seat, the board or the pot.
 */

/** The desktop key for the button: A, for ask. Free in `lib/tableKeys`. */
const ASK_KEY = 'a'

const useAnswer = () => useSyncExternalStore(askCoach.subscribe, askCoach.get, askCoach.getServer)
const useSignedIn = () =>
  useSyncExternalStore(
    askCoachConnection.subscribe,
    askCoachConnection.get,
    askCoachConnection.getServer,
  ).signedIn
/** The coach reads Hold'em hands only. */
const useHoldem = () => useGame((s) => s.hand?.variant === 'holdem')

const press = (hand: number) => {
  sound.play('tap')
  askCoach.press(hand)
}

/**
 * The button, for a corner of the player's own panel (`HeroPanel` corners).
 * It asks, or brings back an answer the player closed; a dot says one is kept.
 */
export function AskCoachButton({ hand }: { hand: number }) {
  const answer = useAnswer()
  const keyboard = useTableKeyboard()
  const signedIn = useSignedIn()
  const holdem = useHoldem()
  if (!signedIn || !holdem) return null
  const mine = answer.phase !== 'idle' && answer.hand === hand && !answer.shown
  const thinking = mine && (answer.phase === 'asking' || answer.phase === 'answering')
  const waiting = mine && answer.phase === 'done'
  const label = waiting || thinking ? 'Show the coach’s advice' : 'Ask the coach'
  return (
    <button
      type="button"
      onClick={() => press(hand)}
      aria-label={label}
      aria-keyshortcuts={keyboard ? 'A' : undefined}
      title={keyboard ? `${label} (A)` : undefined}
      // The slot sits a little in from the corner; this lines the icon up with
      // the panel's top corners, which hold the same kind of button.
      className="relative -mb-1 -ml-1.5 rounded-full p-1.5 text-muted-foreground transition hover:bg-foreground/5 hover:text-foreground"
    >
      <Lightbulb
        className={cn('size-4', thinking && 'text-foreground motion-safe:animate-pulse')}
      />
      {waiting && (
        <span className="absolute right-1 top-1 size-1.5 rounded-full bg-foreground/80" />
      )}
    </button>
  )
}

/** Taps on these are the table's controls, not a tap away from the card. */
const CONTROLS =
  'button, a[href], input, select, textarea, label, [role="button"], [role="slider"], [role="dialog"], [role="alertdialog"]'

/**
 * The answer, laid over the hero's row (cards and panel) and anchored to its
 * foot: as tall as the row, or 12rem when the row is shorter, scrolling past
 * that. Place it inside a positioned box around the hero's row that sets no
 * z-index: at z-40 the answer, which the player asked for, lies over the
 * hand's result banner (z-30) and under the end-of-run overlay (z-40, later).
 *
 * Esc, ✕ or a tap on the table away from it closes it and keeps the answer;
 * ↻ asks again. Acting on the advice, the next deal or leaving the table drops
 * it. Sizing a raise is not acting yet: the card stays while the sizer is open.
 */
export function AskCoachCard({ hand }: { hand: number }) {
  const answer = useAnswer()
  const signedIn = useSignedIn()
  const holdem = useHoldem()
  const keyboard = useTableKeyboard()
  const card = useRef<HTMLElement>(null)
  const open = answer.phase !== 'idle' && answer.hand === hand && answer.shown

  // Each of these ends the answer: the player's next action, and the table
  // closing (the cleanup runs on unmount)...
  useEffect(() => {
    let acted = heroActions(useGame.getState())
    const stop = useGame.subscribe((state) => {
      if (heroActions(state) === acted) return
      acted = heroActions(state)
      askCoach.retire()
    })
    return () => {
      stop()
      askCoach.retire()
    }
  }, [])
  // ...and the next deal, even one where the player never acted.
  useEffect(() => () => askCoach.leave(hand), [hand])

  useTableKeys(signedIn, (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return
    if (!keysReachTable(e, e.target as KeyTarget | null, document)) return
    if (e.key === 'Escape' && open) {
      e.preventDefault()
      askCoach.hide()
    } else if (keyboard && holdem && !e.repeat && e.key.toLowerCase() === ASK_KEY) {
      e.preventDefault()
      press(hand)
    }
  })

  useEffect(() => {
    if (!open) return
    const away = (event: PointerEvent) => {
      const target = event.target as Element | null
      if (!target || card.current?.contains(target) || target.closest?.(CONTROLS)) return
      askCoach.hide()
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [open])

  const asking = answer.phase === 'asking'
  const busy = asking || answer.phase === 'answering'
  const lines = open ? answer.text.trimStart().split('\n') : []
  const advice = lines[0] ?? ''
  const why = lines.slice(1).join('\n').trim()
  const corner =
    'rounded-full p-1 text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground disabled:opacity-40'
  return (
    <AnimatePresence>
      {open && (
        <motion.section
          ref={card}
          key="answer"
          aria-label="The coach’s advice"
          aria-live="polite"
          aria-busy={busy}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 6 }}
          transition={{ duration: 0.15 }}
          className="absolute inset-x-0 bottom-0 z-40 mx-auto max-h-[max(100%,12rem)] w-[min(26rem,calc(100%-1.5rem))] overflow-y-auto rounded-2xl border border-foreground/10 bg-background/95 p-3 pr-14 text-sm shadow-lg backdrop-blur-sm"
        >
          <div className="absolute right-1.5 top-1.5 flex gap-0.5">
            <button
              type="button"
              onClick={() => {
                sound.play('tap')
                void askCoach.start(hand)
              }}
              disabled={asking}
              aria-label="Ask the coach again"
              className={corner}
            >
              <RotateCw className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={() => askCoach.hide()}
              aria-label="Close the coach’s advice"
              aria-keyshortcuts={keyboard ? 'Escape' : undefined}
              className={corner}
            >
              <X className="size-3.5" />
            </button>
          </div>
          {asking ? (
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
