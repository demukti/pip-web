// The real Worker, Durable Object and OAuth library in Node with in-memory
// bindings, shared by the live-state test files. Importing this registers the
// `cloudflare:workers` loader and loads the Worker once per test process.
import type { ExecutionContext } from 'ava'
import { register } from 'node:module'

Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
})
register('./cloudflareLoader.mjs', import.meta.url)
const { default: worker, LiveState } = await import('../live-state/worker.mjs')
export const base = 'https://state.example'

export const key = 'test-owner-key-with-at-least-32-random-characters'

// `extra` adds or overrides bindings, e.g. a test's ANTHROPIC_API_KEY.
export function fixture(extra: Record<string, unknown> = {}) {
  const stored = new Map<string, unknown>()
  const kv = new Map<string, string>()
  const writes: string[] = []
  const alarms: number[] = []
  const storage = {
    get: async (names: string[]) =>
      new Map(
        names
          .filter((name) => stored.has(name))
          .map((name) => [name, structuredClone(stored.get(name))]),
      ),
    put: async (name: string | Record<string, unknown>, value?: unknown) => {
      for (const [entry, data] of Object.entries(
        typeof name === 'string' ? { [name]: value } : name,
      )) {
        writes.push(entry)
        stored.set(entry, structuredClone(data))
      }
    },
    deleteAll: async () => {
      stored.clear()
    },
    setAlarm: async (time: number) => {
      alarms.push(time)
    },
  }
  const build = () =>
    new LiveState({ blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn(), storage })
  let object = build()
  const env = {
    PUBLIC_URL: base,
    OWNER_KEY: key,
    ALLOWED_ORIGINS: 'http://localhost:3000',
    LIVE_STATE: { idFromName: () => 'owner', get: () => object },
    OAUTH_KV: {
      get: async (name: string, options?: { type?: string } | string) => {
        const value = kv.get(name)
        if (value === undefined) return null
        return options === 'json' || (typeof options === 'object' && options.type === 'json')
          ? JSON.parse(value)
          : value
      },
      put: async (name: string, value: string) => {
        kv.set(name, value)
      },
      delete: async (name: string) => {
        kv.delete(name)
      },
      list: async ({ prefix = '' } = {}) => ({
        keys: [...kv.keys()].filter((name) => name.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      }),
    },
    ...extra,
  }
  const context = {
    waitUntil: (_promise: Promise<unknown>) => {},
    passThroughOnException: () => {},
  }
  const fetcher = async (url: string | URL | Request, init?: RequestInit) =>
    worker.fetch(new Request(url, init), env, context)
  // Simulates eviction: a fresh object instance over the same durable storage.
  const evict = () => {
    object = build()
    return object
  }
  return { env, live: () => object, evict, fetcher, kv, stored, writes, alarms }
}

// Freezes Date.now for one serial test. Concurrent tests run only after every serial
// one, and the teardown restores the real clock, so no other test sees it.
export function freezeClock(t: ExecutionContext) {
  const real = Date.now
  let now = real()
  const start = now
  Date.now = () => now
  t.teardown(() => {
    Date.now = real
  })
  return {
    start,
    at: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

// The publishing calls a game tab makes, with a hand-built schema-v1 envelope so these
// tests exercise only the Worker.
export function writer(
  fetcher: ReturnType<typeof fixture>['fetcher'],
  session: { sessionId: string; token: string },
) {
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
    'X-Pip-Session': session.sessionId,
    'X-Pip-Writer': 'writer-one',
  }
  return {
    heartbeat: (version = 0) =>
      fetcher(`${base}/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ version }) }),
    publish: (version: number) =>
      fetcher(`${base}/publish`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          schemaVersion: 1,
          sessionId: session.sessionId,
          version,
          capturedAt: new Date(Date.now()).toISOString(),
          hand: null,
        }),
      }),
    claim: () =>
      fetcher(`${base}/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ writerId: 'writer-one' }),
      }),
  }
}

export const setupSession = async (fetcher: ReturnType<typeof fixture>['fetcher']) => {
  const response = await fetcher(`${base}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writerId: 'writer-one' }),
  })
  return response.json()
}
