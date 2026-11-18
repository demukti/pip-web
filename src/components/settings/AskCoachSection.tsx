'use client'

import { useState, useSyncExternalStore } from 'react'
import { Lightbulb, MessageSquareText, SlidersHorizontal } from 'lucide-react'
import { COACH_STYLES, coachPrefs, NOTES_MAX } from '@/lib/askCoach/coach'
import { askCoachConnection } from '@/lib/askCoach/connection'
import { SettingsGroup, SettingsRow } from '@/components/settings/group'
import { Segmented } from '@/components/ui/segmented'
import { sound } from '@/lib/sound'

// The same field and buttons as the account rows, so the coach's sign-in reads
// as part of Settings rather than a form dropped into it.
const field =
  'w-full rounded-xl bg-foreground/[0.04] px-3 py-3 text-base outline-none ring-primary/40 focus:ring-2'
const smallButton =
  'min-h-11 shrink-0 rounded-xl bg-foreground/[0.06] px-4 text-sm font-medium transition hover:bg-foreground/[0.12] active:scale-[0.97] disabled:opacity-40'
const primaryButton =
  'min-h-11 w-full rounded-xl bg-primary py-3 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 active:scale-[0.98] disabled:opacity-40'

/**
 * The coach: sign this browser in once, then shape how it answers. Signed out,
 * the table shows no coach button at all.
 */
export function AskCoachSection() {
  const status = useSyncExternalStore(
    askCoachConnection.subscribe,
    askCoachConnection.get,
    askCoachConnection.getServer,
  )
  return (
    <SettingsGroup label="Coach">
      {status.signedIn ? <SignedIn url={status.url} /> : <SignIn message={status.message} />}
      <StyleRow />
      <NotesRow />
    </SettingsGroup>
  )
}

const ABOUT =
  'Advice on the hand in front of you, only when you ask: the lightbulb in the corner of your panel at the table (A on a keyboard).'

function SignedIn({ url }: { url: string | null }) {
  return (
    <SettingsRow
      icon={Lightbulb}
      tint="pip"
      label={url ? `Signed in to ${new URL(url).host}` : 'Signed in'}
      hint={ABOUT}
      control={
        <button
          type="button"
          onClick={() => {
            sound.play('tap')
            void askCoachConnection.disconnect()
          }}
          className={smallButton}
        >
          Sign out
        </button>
      }
    />
  )
}

function SignIn({ message }: { message: string }) {
  const [url, setUrl] = useState(process.env.NEXT_PUBLIC_ASK_COACH_URL ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <SettingsRow icon={Lightbulb} tint="pip" label="Sign in to the coach" hint={ABOUT}>
      <form
        className="mt-3 flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          sound.play('tap')
          setBusy(true)
          setError('')
          try {
            await askCoachConnection.connect(url, key)
          } catch (error) {
            setError(error instanceof Error ? error.message : 'Couldn’t sign in. Try again.')
          } finally {
            setKey('')
            setBusy(false)
          }
        }}
      >
        {message && (
          <p role="status" className="text-xs leading-relaxed">
            {message}
          </p>
        )}
        <input
          className={field}
          type="url"
          aria-label="Service URL"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Service URL"
          required
        />
        <input
          className={field}
          type="password"
          aria-label="Owner key"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="Owner key"
          minLength={32}
          required
        />
        <button disabled={busy} type="submit" className={primaryButton}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs leading-relaxed text-muted-foreground/70">
          Asked once: this browser keeps its own sign-in, never the key, and stays signed in until
          30 days after you last ask.
        </p>
        {error && (
          <p role="alert" className="text-xs leading-relaxed text-suit-red">
            {error}
          </p>
        )}
      </form>
    </SettingsRow>
  )
}

/**
 * How long the coach answers. Saved in this browser and sent with each
 * question, so a change applies to the next one.
 */
function StyleRow() {
  const prefs = useSyncExternalStore(coachPrefs.subscribe, coachPrefs.get, coachPrefs.getServer)
  const picked = Math.max(
    COACH_STYLES.findIndex((style) => style.value === prefs.style),
    0,
  )
  return (
    <SettingsRow
      icon={SlidersHorizontal}
      tint="pip"
      label="Answers"
      hint={COACH_STYLES[picked].about}
    >
      <div className="mt-3">
        <Segmented
          options={COACH_STYLES.map((style, index) => ({ value: index, label: style.label }))}
          value={picked}
          onPick={(index) => coachPrefs.set({ style: COACH_STYLES[index].value })}
        />
      </div>
    </SettingsRow>
  )
}

/** The player's own words, sent with every question. */
function NotesRow() {
  const prefs = useSyncExternalStore(coachPrefs.subscribe, coachPrefs.get, coachPrefs.getServer)
  return (
    <SettingsRow
      icon={MessageSquareText}
      tint="pip"
      label="Your notes"
      hint="How you want to be coached. Sent with every question."
    >
      <textarea
        aria-label="How do you want to be coached?"
        className={`${field} mt-3 block min-h-24 resize-y`}
        value={prefs.notes}
        maxLength={NOTES_MAX}
        onChange={(event) => coachPrefs.set({ notes: event.target.value })}
        placeholder="I’m working on 3-bets. Be blunt."
      />
    </SettingsRow>
  )
}
