'use client'

import { useState, useSyncExternalStore } from 'react'
import { COACH_STYLES, coachPrefs, NOTES_MAX } from '@/lib/liveCoaching/coach'
import { livePublisher } from '@/lib/liveCoaching/publisher'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'

export function LiveCoachingSection() {
  const status = useSyncExternalStore(
    livePublisher.subscribe,
    livePublisher.getStatus,
    livePublisher.getServerStatus,
  )
  const [url, setUrl] = useState(process.env.NEXT_PUBLIC_LIVE_STATE_URL ?? '')
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <section className="rounded-2xl border border-foreground/10 bg-foreground/[0.03] p-4">
      <h2 className="font-semibold">Live coaching</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Share your visible cards and game state with your private ChatGPT connection. Play-money
        Hold’em versus the cast only.
      </p>
      <p role="status" className="mt-2 text-sm">
        {status.message}
      </p>
      {/* An involuntary end shows on the table until reconnecting; this puts it
          away, locally only (never a request another tab's session could feel). */}
      {status.ended && !status.connected && !status.resuming && (
        <Button className="mt-2" size="sm" variant="ghost" onClick={() => livePublisher.dismiss()}>
          Dismiss
        </Button>
      )}
      {status.connected ? (
        <Button className="mt-3" variant="outline" onClick={() => void livePublisher.disconnect()}>
          Stop sharing
        </Button>
      ) : status.resuming || status.otherTab ? (
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {status.resuming
              ? 'Your saved session will pick up again as soon as the service can be reached.'
              : 'Another Pip tab in this browser is sharing. Only one tab shares at a time.'}
          </p>
          <div className="flex flex-wrap gap-2">
            {status.otherTab && (
              <Button onClick={() => void livePublisher.restore()}>Share from this tab</Button>
            )}
            <Button variant="outline" onClick={() => void livePublisher.disconnect()}>
              Stop sharing
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="mt-3 flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault()
            setBusy(true)
            setError('')
            try {
              await livePublisher.connect(url, key)
            } catch (error) {
              setError(error instanceof Error ? error.message : 'Connection failed')
            } finally {
              setKey('')
              setBusy(false)
            }
          }}
        >
          <label className="text-sm">
            Private service URL
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
            Pip Live owner key
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
            This browser stays connected while you keep playing, across new tabs and restarts: until
            12 hours after your last activity, and 7 days at most. The owner key is never saved.
            Starting another session replaces the previous one.
          </p>
          <Button disabled={busy} type="submit">
            {busy ? 'Connecting…' : 'Start sharing'}
          </Button>
          {error && (
            <p role="alert" className="text-sm">
              {error}
            </p>
          )}
        </form>
      )}
      <AskPipSettings />
    </section>
  )
}

/**
 * How Ask Pip answers: a length, and the player's own words. Saved in this
 * browser; sent with each question, so a change applies to the next one.
 */
function AskPipSettings() {
  const prefs = useSyncExternalStore(coachPrefs.subscribe, coachPrefs.get, coachPrefs.getServer)
  const picked = COACH_STYLES.findIndex((style) => style.value === prefs.style)
  return (
    <div className="mt-5 flex flex-col gap-3 border-t border-foreground/10 pt-4">
      <div>
        <h3 className="text-sm font-semibold">Ask Pip</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          While you share, Ask Pip at the table gives advice on the hand in front of you. Only when
          you ask.
        </p>
      </div>
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
