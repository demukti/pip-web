'use client'

import { useState, useSyncExternalStore } from 'react'
import { COACH_STYLES, coachPrefs, NOTES_MAX } from '@/lib/askPip/coach'
import { askPipConnection } from '@/lib/askPip/connection'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

/**
 * Ask Pip: sign this browser in once, then shape how Pip answers. Signed out,
 * the table shows no Ask Pip button at all.
 */
export function AskPipSection() {
  const status = useSyncExternalStore(
    askPipConnection.subscribe,
    askPipConnection.get,
    askPipConnection.getServer,
  )
  return (
    <section className="rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4">
      <h2 className="font-semibold">Ask Pip</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Advice on the hand in front of you, only when you ask: press Ask Pip at the table.
        Play-money Hold’em against the cast.
      </p>
      {status.signedIn ? <SignedIn url={status.url} /> : <SignIn message={status.message} />}
      <AskPipSettings />
    </section>
  )
}

function SignedIn({ url }: { url: string | null }) {
  return (
    <div className="mt-3 flex flex-col items-start gap-2">
      <p role="status" className="text-sm">
        This browser is signed in{url ? ` to ${new URL(url).host}` : ''}.
      </p>
      <Button variant="outline" onClick={() => void askPipConnection.disconnect()}>
        Sign out
      </Button>
    </div>
  )
}

function SignIn({ message }: { message: string }) {
  const [url, setUrl] = useState(process.env.NEXT_PUBLIC_ASK_PIP_URL ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault()
        setBusy(true)
        setError('')
        try {
          await askPipConnection.connect(url, key)
        } catch (error) {
          setError(error instanceof Error ? error.message : 'Couldn’t sign in. Try again.')
        } finally {
          setKey('')
          setBusy(false)
        }
      }}
    >
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      <label className="text-sm">
        Service URL
        <input
          className="mt-1 w-full rounded-lg border border-foreground/20 bg-background p-2"
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://pip-live-state.tizav.workers.dev"
          required
        />
      </label>
      <label className="text-sm">
        Owner key
        <input
          className="mt-1 w-full rounded-lg border border-foreground/20 bg-background p-2"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          minLength={32}
          required
        />
      </label>
      <p className="text-xs text-muted-foreground">
        Asked once: this browser keeps its own sign-in, never the key, and stays signed in until 30
        days after you last ask.
      </p>
      <Button disabled={busy} type="submit">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
    </form>
  )
}

/**
 * How Pip answers: a length, and the player's own words. Saved in this
 * browser; sent with each question, so a change applies to the next one.
 */
function AskPipSettings() {
  const prefs = useSyncExternalStore(coachPrefs.subscribe, coachPrefs.get, coachPrefs.getServer)
  const picked = COACH_STYLES.findIndex((style) => style.value === prefs.style)
  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-foreground/10 pt-4">
      <h3 className="text-sm font-semibold">How Pip answers</h3>
      <Segmented
        options={COACH_STYLES.map((style, index) => ({
          value: index,
          label: style.label,
          sub: style.sub,
        }))}
        value={Math.max(picked, 0)}
        onPick={(index) => coachPrefs.set({ style: COACH_STYLES[index].value })}
      />
      <label className="text-sm">
        How should Pip coach you?
        <textarea
          className="mt-1 block min-h-20 w-full rounded-lg border border-foreground/20 bg-background p-2 text-sm"
          value={prefs.notes}
          maxLength={NOTES_MAX}
          onChange={(event) => coachPrefs.set({ notes: event.target.value })}
          placeholder="I’m working on 3-bets. Be blunt."
        />
      </label>
    </div>
  )
}
