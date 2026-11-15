'use client'

import { useState, useSyncExternalStore } from 'react'
import { livePublisher } from '@/lib/liveCoaching/publisher'
import { Button } from '@/components/ui/button'

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
      <h2 className="font-semibold">Live coaching · proof of concept</h2>
      <p className="mt-2 text-sm text-muted-foreground">
        Share your visible cards and game state with your private ChatGPT connection. Play-money
        Hold’em versus the cast only.
      </p>
      <p role="status" className="mt-2 text-sm">
        {status.message}
      </p>
      {status.connected ? (
        <Button className="mt-3" variant="outline" onClick={() => void livePublisher.disconnect()}>
          Stop sharing
        </Button>
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
            Connect once per browser tab. Sessions expire after 12 hours. Starting another session
            replaces the previous one.
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
    </section>
  )
}
