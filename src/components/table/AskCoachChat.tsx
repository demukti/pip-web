'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Dialog } from '@base-ui/react/dialog'
import { Menu } from '@base-ui/react/menu'
import { ArrowUp, MessageCircleQuestionMark, XIcon } from 'lucide-react'
import { PlayingCard } from '@/components/PlayingCard'
import { FOLLOW_UP_MAX, FOLLOW_UPS_MAX } from '@/lib/askCoach/coach'
import { QUICK_QUESTIONS } from '@/lib/askCoach/questions'
import { type AskCoachState, askCoach, canReply, followUps } from '@/lib/askCoach/session'
import { isHandComplete, legalActions, potSize } from '@/lib/poker/engine'
import { sound } from '@/lib/sound'
import { useMoney } from '@/lib/useMoney'
import { cn } from '@/lib/utils'
import { useGame } from '@/store/game'

/*
 * The conversation with the coach on one deal: full screen on a phone, so the
 * keyboard (and its dictation mic) has room; a panel in the middle of a wider
 * screen. It opens from the card's Reply. The hand stays pinned at the top,
 * the questions and answers scroll under it, and the question box sits at the
 * foot with the quick questions (`lib/askCoach/questions.ts`) behind a small
 * button beside it, out of the way until wanted.
 */

/**
 * The part of the screen the keyboard leaves. iOS Safari keeps the layout
 * viewport when the keyboard opens and lays it over the page, so a sheet
 * sized to the screen would put its question box under the keys; sized to
 * the visual viewport, the box sits right above them.
 */
let viewport = ''
function subscribeViewport(changed: () => void) {
  const visual = window.visualViewport
  if (!visual) return () => {}
  const update = () => {
    viewport = `${visual.height},${visual.offsetTop}`
    changed()
  }
  update()
  visual.addEventListener('resize', update)
  visual.addEventListener('scroll', update)
  return () => {
    visual.removeEventListener('resize', update)
    visual.removeEventListener('scroll', update)
  }
}
function useVisualViewport() {
  const key = useSyncExternalStore(
    subscribeViewport,
    () => viewport,
    () => '',
  )
  if (!key) return null
  const [height, top] = key.split(',').map(Number)
  return { height, top }
}

const scrollToEnd = (element: HTMLElement | null) => {
  if (element) element.scrollTop = element.scrollHeight
}

/** A precise pointer: a desktop, where the question box takes the focus on opening. */
const finePointer = () =>
  typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches

/** The hand as it stands, small: your cards, the board, the pot and the price. */
function HandStrip() {
  const hand = useGame((s) => (s.hand?.variant === 'holdem' ? s.hand : null))
  const money = useMoney()
  if (!hand) return null
  const hero = hand.players.find((player) => player.id === 'hero')
  const yourTurn = !isHandComplete(hand) && hand.players[hand.toActIndex]?.id === 'hero'
  const toCall = yourTurn ? (legalActions(hand)?.callAmount ?? 0) : null
  return (
    <div className="flex items-center gap-3 overflow-x-auto px-4 pb-3 sm:px-5">
      <div className="flex shrink-0 gap-1">
        {(hero?.hole ?? []).map((card) => (
          <PlayingCard key={`${card.rank}${card.suit}`} card={card} size="xs" />
        ))}
      </div>
      {hand.community.length > 0 && (
        <div className="flex shrink-0 gap-1 border-l border-foreground/10 pl-3">
          {hand.community.map((card) => (
            <PlayingCard key={`${card.rank}${card.suit}`} card={card} size="xs" />
          ))}
        </div>
      )}
      <dl className="ml-auto shrink-0 text-right text-xs leading-tight text-muted-foreground">
        <div>
          <dt className="inline">Pot </dt>
          <dd className="inline font-semibold text-foreground tabular-nums">
            {money(potSize(hand))}
          </dd>
        </div>
        {toCall !== null && (
          <div>
            <dt className="inline">{toCall > 0 ? 'To call ' : ''}</dt>
            <dd className="inline font-semibold text-foreground tabular-nums">
              {toCall > 0 ? money(toCall) : 'Free to check'}
            </dd>
          </div>
        )}
      </dl>
    </div>
  )
}

/** What the player asked: the button's own question has no words, so it is named. */
function Asked({ question }: { question: string | null }) {
  return (
    <p className="ml-auto w-fit max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-foreground/[0.08] px-3 py-2 text-foreground">
      {question ?? 'What should I do here?'}
    </p>
  )
}

/** An answer: the first answer's opening line is the advice, set apart. */
function Answer({ text, advice }: { text: string; advice: boolean }) {
  const body = text.trim()
  if (!advice) return <p className="whitespace-pre-line text-foreground/90">{body}</p>
  const [first, ...rest] = body.split('\n')
  const why = rest.join('\n').trim()
  return (
    <div>
      <p className="font-semibold text-foreground">{first}</p>
      {why && <p className="mt-1 whitespace-pre-line text-foreground/80">{why}</p>}
    </div>
  )
}

/** The quick questions, behind one small button beside the question box. */
function QuickQuestions({ disabled, ask }: { disabled: boolean; ask: (q: string) => void }) {
  if (QUICK_QUESTIONS.length === 0) return null
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        aria-label="Quick questions"
        className="grid size-10 shrink-0 place-items-center rounded-full text-muted-foreground transition hover:bg-foreground/[0.08] hover:text-foreground disabled:opacity-40 data-popup-open:bg-foreground/[0.08] data-popup-open:text-foreground"
      >
        <MessageCircleQuestionMark className="size-5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={8} className="z-[60] outline-none">
          <Menu.Popup className="max-w-[min(20rem,calc(100vw-2rem))] origin-(--transform-origin) rounded-2xl bg-popover p-1 text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none transition data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {QUICK_QUESTIONS.map((question) => (
              <Menu.Item
                key={question}
                onClick={() => ask(question)}
                className="cursor-default select-none rounded-xl px-3 py-2.5 outline-none data-highlighted:bg-foreground/[0.08]"
              >
                {question}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}

/**
 * The conversation, open while `answer.chat` is (`open`); kept mounted so a
 * half-typed question survives closing it. Closing it (✕, Escape, or a
 * click outside on a wide screen) goes back to the table with the card open on
 * the latest answer; the conversation is kept until the player acts or the
 * deal ends, as the card's is.
 */
export function AskCoachChat({
  answer,
  open: shown,
}: {
  answer: Extract<AskCoachState, { hand: number }>
  open: boolean
}) {
  const [draft, setDraft] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const visual = useVisualViewport()

  const busy = answer.phase === 'asking' || answer.phase === 'answering'
  const open = canReply(answer)
  // A failed follow-up is replaced, so it does not use one up.
  const left = FOLLOW_UPS_MAX - followUps(answer) + (answer.phase === 'failed' ? 1 : 0)
  const send = (words: string) => {
    if (!words.trim() || !open) return
    sound.play('tap')
    void askCoach.reply(words)
    setDraft('')
  }

  // The newest words in view: on opening (the list mounts with the sheet, so
  // its ref does it), as they arrive, and when the keyboard opens.
  const toEnd = useCallback((element: HTMLDivElement | null) => {
    scroller.current = element
    scrollToEnd(element)
    // Once more when the opened sheet has settled its layout.
    requestAnimationFrame(() => scrollToEnd(element))
  }, [])
  const latest = `${answer.earlier.length}:${answer.question}:${answer.text.length}:${answer.phase}`
  useEffect(() => {
    void latest
    void visual?.height
    scrollToEnd(scroller.current)
  }, [latest, visual?.height])

  // The box grows with what is typed or dictated, up to a few lines.
  useLayoutEffect(() => {
    void draft
    const element = box.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 128)}px`
  }, [draft])

  const placeholder = !open
    ? busy
      ? 'The coach is answering…'
      : answer.phase === 'failed'
        ? 'Ask again above first'
        : 'That’s all the follow-ups for this hand'
    : 'Ask the coach…'

  return (
    <Dialog.Root open={shown} onOpenChange={(next) => !next && askCoach.closeChat()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-background/60 backdrop-blur-xs transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          initialFocus={() => (finePointer() ? box.current : true)}
          aria-label="Conversation with the coach"
          // On a phone: the whole of the screen the keyboard leaves.
          style={
            visual
              ? ({ '--chat-top': `${visual.top}px`, '--chat-h': `${visual.height}px` } as object)
              : undefined
          }
          className={cn(
            'fixed inset-x-0 top-(--chat-top,0px) z-50 flex h-(--chat-h,100dvh) flex-col bg-popover text-popover-foreground outline-none',
            'pt-[env(safe-area-inset-top)] transition duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0 max-sm:data-ending-style:translate-y-4 max-sm:data-starting-style:translate-y-4',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(40rem,calc(100dvh-4rem))] sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[2rem] sm:pt-0 sm:shadow-[0_30px_80px_-30px_rgba(0,0,0,0.7)] sm:ring-1 sm:ring-foreground/10',
          )}
        >
          <div className="flex shrink-0 items-center justify-between gap-3 px-4 pt-3 pb-3 sm:px-5 sm:pt-4">
            <Dialog.Title className="text-lg font-semibold tracking-tight">Coach</Dialog.Title>
            <Dialog.Close className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground/[0.06] text-muted-foreground transition hover:bg-foreground/[0.12] hover:text-foreground active:scale-95">
              <XIcon className="size-4" />
              <span className="sr-only">Back to the table</span>
            </Dialog.Close>
          </div>
          <HandStrip />

          <div
            ref={toEnd}
            aria-live="polite"
            aria-busy={busy}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain border-t border-foreground/10 px-4 py-4 text-[0.9375rem] leading-relaxed sm:px-5"
          >
            {answer.earlier.map((exchange, i) => (
              // The conversation only grows, and only at its end.
              <div key={i} className="space-y-3">
                <Asked question={exchange.question} />
                <Answer text={exchange.answer} advice={exchange.question === null} />
              </div>
            ))}
            <Asked question={answer.question} />
            {answer.phase === 'asking' ? (
              <p className="text-muted-foreground motion-safe:animate-pulse">
                {answer.question === null ? 'Reading the table…' : 'Thinking…'}
              </p>
            ) : (
              answer.text.trim() && <Answer text={answer.text} advice={answer.question === null} />
            )}
            {answer.phase === 'failed' && (
              <p className="text-muted-foreground">
                {answer.message}{' '}
                <button
                  type="button"
                  onClick={() => {
                    sound.play('tap')
                    void askCoach.again()
                  }}
                  className="font-medium text-foreground underline underline-offset-2"
                >
                  Try again
                </button>
              </p>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              send(draft)
            }}
            className="shrink-0 border-t border-foreground/10 px-2 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:px-3 sm:pb-3"
          >
            {open && left <= 2 && (
              <p className="px-2 pb-1 text-2xs text-muted-foreground">
                {left === 1 ? 'One follow-up left on this hand' : `${left} follow-ups left`}
              </p>
            )}
            <div className="flex items-end gap-1">
              <QuickQuestions disabled={!open} ask={send} />
              <textarea
                ref={box}
                rows={1}
                value={draft}
                maxLength={FOLLOW_UP_MAX}
                disabled={!open}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
                  e.preventDefault()
                  send(draft)
                }}
                enterKeyHint="send"
                aria-label="Your question"
                placeholder={placeholder}
                // 16px at least: smaller, and iOS zooms the page in on focus.
                className="min-h-10 flex-1 resize-none rounded-2xl bg-foreground/[0.06] px-3.5 py-2 text-base leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-foreground/20 disabled:opacity-60"
              />
              <button
                type="submit"
                disabled={!open || !draft.trim()}
                aria-label="Send"
                className="grid size-10 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground transition active:scale-95 disabled:bg-foreground/[0.08] disabled:text-muted-foreground"
              >
                <ArrowUp className="size-5" />
              </button>
            </div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
