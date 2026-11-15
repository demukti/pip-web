import test from 'ava'
import { register } from 'node:module'
import { startHand, applyAction } from '@/lib/poker/engine'
import { mulberry32 } from '@/lib/poker/cards'
import { liveSnapshot } from '@/lib/liveCoaching/state'
import { LivePublisher } from '@/lib/liveCoaching/publisher'

Object.assign(globalThis, {
  Cloudflare: { compatibilityFlags: { global_fetch_strictly_public: true } },
})
register('./cloudflareLoader.mjs', import.meta.url)
const { default: worker, LiveState } = await import('../live-state/worker.mjs')
const base = 'https://state.example'
// The Worker logs one JSON line per OAuth/MCP request; capture them instead of
// printing. Serial tests run before concurrent ones, so they can slice by index.
const logged: string[] = []
console.info = (line: string) => {
  logged.push(line)
}
const key = 'test-owner-key-with-at-least-32-random-characters'

function fixture() {
  const stored = new Map<string, unknown>()
  const kv = new Map<string, string>()
  const writes: string[] = []
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
    setAlarm: async () => {},
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
  return { env, live: () => object, evict, fetcher, kv, stored, writes }
}

const setupSession = async (fetcher: ReturnType<typeof fixture>['fetcher']) => {
  const response = await fetcher(`${base}/sessions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ writerId: 'writer-one' }),
  })
  return response.json()
}

async function oauth(fetcher: ReturnType<typeof fixture>['fetcher'], autoApprove = true) {
  const client = await (
    await fetcher(`${base}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test ChatGPT',
        redirect_uris: ['https://chatgpt.com/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    })
  ).json()
  const verifier = 'x'.repeat(43)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  const challenge = Buffer.from(digest).toString('base64url')
  const query = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'https://chatgpt.com/callback',
    response_type: 'code',
    scope: 'hand:read offline_access',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: 'test-state',
    resource: `${base}/mcp`,
  })
  const page = await fetcher(`${base}/authorize?${query}`)
  const html = await page.text()
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1]
  const cookies = page.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ')
  const approve = async (cookie = cookies, ownerKey = key, origin = base) =>
    fetcher(`${base}/authorize`, {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        handle: handle ?? '',
        decision: 'approve',
        key: ownerKey,
      }).toString(),
    })
  const approved = autoApprove ? await approve() : new Response(null, { status: 204 })
  const code = new URL(approved.headers.get('Location') ?? base).searchParams.get('code')
  const exchange = (codeVerifier = verifier) =>
    fetcher(`${base}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: client.client_id,
        redirect_uri: 'https://chatgpt.com/callback',
        code: code ?? '',
        code_verifier: codeVerifier,
        resource: `${base}/mcp`,
      }).toString(),
    })
  return { page, html, handle, cookies, approved, approve, exchange, client }
}

test('consent preserves its form origin and rejects foreign/null origins and missing cookies', async (t) => {
  const { fetcher, kv } = fixture()
  const flow = await oauth(fetcher, false)
  t.is(flow.page.headers.get('Referrer-Policy'), 'strict-origin')
  t.is(flow.page.headers.get('Content-Security-Policy'), "frame-ancestors 'none'")
  t.is(flow.page.headers.get('X-Frame-Options'), 'DENY')
  t.is((await flow.approve(flow.cookies, key, 'https://evil.example')).status, 403)
  t.is((await flow.approve(flow.cookies, key, 'null')).status, 403)
  t.is((await flow.approve('')).status, 400)
  t.false([...kv.keys()].some((name) => name.startsWith('grant:')))
  t.is((await flow.approve()).status, 302)
})

test('OAuth/PKCE grants read-only access; anonymous and publishing credentials cannot read', async (t) => {
  const { fetcher } = fixture()
  const session = await setupSession(fetcher)
  t.truthy(session.token)
  t.is((await fetcher(`${base}/mcp/current`)).status, 401)
  t.is(
    (
      await fetcher(`${base}/mcp/current`, {
        headers: { Authorization: `Bearer ${session.token}` },
      })
    ).status,
    401,
  )
  const flow = await oauth(fetcher)
  t.is(flow.page.status, 200)
  // Assert the final response header, after the outer Worker's header merge.
  // no-referrer turns navigation form POST origins into null in browsers.
  t.is(flow.page.headers.get('Referrer-Policy'), 'strict-origin')
  t.is(flow.approved.status, 302)
  t.true(flow.html.includes('chatgpt.com'))
  const tokens = await (await flow.exchange()).json()
  t.truthy(tokens.access_token)
  const read = await fetcher(`${base}/mcp/current`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  t.is(read.status, 200)
  t.true(read.headers.get('Cache-Control')!.includes('no-store'))
  t.is((await read.json()).active, true)
  t.is(
    (
      await fetcher(`${base}/publish`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        body: '{}',
      })
    ).status,
    401,
  )
  t.not((await flow.exchange()).status, 200) // codes are single-use
  t.not((await flow.approve('')).status, 302) // consent is browser bound
})

test('wrong PKCE verifier cannot exchange a code; consent cannot be forged or silently granted', async (t) => {
  const { fetcher } = fixture()
  const flow = await oauth(fetcher)
  const invalid = await flow.exchange('wrong'.repeat(12))
  t.is(invalid.status, 400)
  t.falsy((await invalid.json()).access_token)
})

test('real engine moves publish/read during unfinished hands; old versions cannot overwrite', async (t) => {
  const { fetcher } = fixture()
  const session = await setupSession(fetcher)
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'X-Pip-Session': session.sessionId,
    'X-Pip-Writer': 'writer-one',
    'Content-Type': 'application/json',
  }
  let hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })
  for (let version = 1; version <= 5; version++) {
    const snapshot = liveSnapshot(hand, {
      sessionId: session.sessionId,
      version,
      capturedAt: new Date().toISOString(),
      handNo: 1,
      heroId: 'hero',
    })
    t.is(
      (await fetcher(`${base}/publish`, { method: 'PUT', headers, body: JSON.stringify(snapshot) }))
        .status,
      200,
    )
    const read = await (
      await fetcher(`${base}/mcp/current`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json()
    t.is(read.version, version)
    t.false(read.stale)
    t.false(read.state.hand.complete)
    if (version < 5) hand = applyAction(hand, { type: version === 1 ? 'call' : 'check' })
  }
  const older = liveSnapshot(hand, {
    sessionId: session.sessionId,
    version: 1,
    capturedAt: new Date().toISOString(),
    handNo: 1,
    heroId: 'hero',
  })
  t.is(
    (await fetcher(`${base}/publish`, { method: 'PUT', headers, body: JSON.stringify(older) }))
      .status,
    409,
  )
  t.is(
    (
      await (
        await fetcher(`${base}/mcp/current`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
      ).json()
    ).version,
    5,
  )
  const tool = await fetcher(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_current_hand', arguments: {} },
    }),
  })
  const text = (await tool.json()).result.content[0].text
  t.is(JSON.parse(text).version, 5)
  // The tool passes the read body through; only readAt/connectionAgeMs/timing vary.
  const current = await (
    await fetcher(`${base}/mcp/current`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
  ).text()
  const timeless = (body: string) =>
    body
      .replace(/"readAt":"[^"]+","connectionAgeMs":\d+/, '')
      .replace(/,"timing":\{[^{}]*\}\}$/, '}')
  t.is(timeless(text), timeless(current))
  const list = await fetcher(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
  const [described] = (await list.json()).result.tools
  t.is(described.name, 'get_current_hand')
  t.true(described.description.includes('state.hand.brief'))
  t.true(described.description.includes('hand.result.shownHands'))
  t.true(described.description.includes('stale'))
})

test('session replacement and single-tab claiming revoke older publishing authority', async (t) => {
  const { fetcher } = fixture()
  const first = await setupSession(fetcher)
  const headers = {
    Authorization: `Bearer ${first.token}`,
    'X-Pip-Session': first.sessionId,
    'X-Pip-Writer': 'writer-one',
  }
  t.is(
    (
      await fetcher(`${base}/claim`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ writerId: 'writer-two' }),
      })
    ).status,
    200,
  )
  t.is(
    (
      await fetcher(`${base}/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 0 }),
      })
    ).status,
    409,
  )
  await setupSession(fetcher)
  t.is(
    (
      await fetcher(`${base}/heartbeat`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 0 }),
      })
    ).status,
    401,
  )
})

test('publisher connects without persisting owner key and resumes with increasing versions', async (t) => {
  const { fetcher } = fixture()
  const values = new Map<string, string>()
  const storage = () => ({
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
  })
  const publisher = new LivePublisher(storage, fetcher as typeof fetch)
  await publisher.connect(base, key)
  await publisher.flush()
  t.is(publisher.getStatus().acceptedVersion, 1)
  t.false([...values.values()].join('').includes(key))
  const resumed = new LivePublisher(storage, fetcher as typeof fetch)
  await resumed.restore()
  await resumed.flush()
  t.is(resumed.getStatus().acceptedVersion, 2)
  publisher.capture(null, 0)
  await publisher.flush()
  t.false(publisher.getStatus().connected)
  await resumed.disconnect()
})

test('unapproved browser origins cannot provision sessions', async (t) => {
  const { fetcher } = fixture()
  t.is(
    (
      await fetcher(`${base}/sessions`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example', Authorization: `Bearer ${key}` },
        body: '{}',
      })
    ).status,
    403,
  )
  t.is((await fetcher(`${base}/sessions`, { method: 'POST', body: '{}' })).status, 403)
})

test('refresh tokens work, wrong audiences fail, and owner-key rotation revokes prior access', async (t) => {
  const { fetcher, env } = fixture()
  const session = await setupSession(fetcher)
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  t.truthy(tokens.refresh_token)
  const refreshed = await fetcher(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: flow.client.client_id,
      resource: `${base}/mcp`,
    }).toString(),
  })
  t.is(refreshed.status, 200)
  const latest = await refreshed.json()
  const wrongAudience = await fetcher(`${base}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: latest.refresh_token,
      client_id: flow.client.client_id,
      resource: 'https://another.example/mcp',
    }).toString(),
  })
  t.not(wrongAudience.status, 200)
  env.OWNER_KEY = 'replacement-owner-key-with-at-least-32-characters'
  t.is(
    (
      await fetcher(`${base}/mcp/current`, {
        headers: { Authorization: `Bearer ${latest.access_token}` },
      })
    ).status,
    403,
  )
  t.is(
    (
      await fetcher(`${base}/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Pip-Session': session.sessionId,
          'X-Pip-Writer': 'writer-one',
        },
        body: JSON.stringify({ version: 0 }),
      })
    ).status,
    401,
  )
})

test('freshness distinguishes an idle hand from missing uploads; alarms respect new sessions', async (t) => {
  const { fetcher, live, evict, stored } = fixture()
  const session = await setupSession(fetcher)
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'X-Pip-Session': session.sessionId,
    'X-Pip-Writer': 'writer-one',
  }
  const state = liveSnapshot(null, {
    sessionId: session.sessionId,
    version: 1,
    capturedAt: new Date().toISOString(),
    handNo: 0,
    heroId: 'hero',
  })
  await fetcher(`${base}/publish`, { method: 'PUT', headers, body: JSON.stringify(state) })
  const read = async () =>
    (
      await fetcher(`${base}/mcp/current`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json()
  const record = stored.get('meta') as { lastSeenAt: number }
  record.lastSeenAt = Date.now() - 31_000
  evict()
  t.true((await read()).stale)
  await fetcher(`${base}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 1 }),
  })
  t.false((await read()).stale)
  await fetcher(`${base}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 2 }),
  })
  t.true((await read()).pending)
  t.true((await read()).stale)
  await live().alarm()
  t.true((await read()).active)
  const expired = stored.get('meta') as { expiresAt: number }
  expired.expiresAt = Date.now() - 1
  await evict().alarm()
  t.is(stored.size, 0)
  t.false((await read()).active)
})

test('an evicted object reloads the session from storage; heartbeats never rewrite the snapshot', async (t) => {
  const { fetcher, evict, stored, writes } = fixture()
  const session = await setupSession(fetcher)
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'X-Pip-Session': session.sessionId,
    'X-Pip-Writer': 'writer-one',
  }
  const hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(7),
  })
  const snapshot = liveSnapshot(hand, {
    sessionId: session.sessionId,
    version: 1,
    capturedAt: new Date().toISOString(),
    handNo: 1,
    heroId: 'hero',
  })
  await fetcher(`${base}/publish`, { method: 'PUT', headers, body: JSON.stringify(snapshot) })
  t.deepEqual(writes.slice(-2).sort(), ['meta', 'state'])
  const heartbeat = (version: number) =>
    fetcher(`${base}/heartbeat`, { method: 'POST', headers, body: JSON.stringify({ version }) })
  const before = writes.length
  t.is((await heartbeat(1)).status, 200)
  t.is(writes.length, before) // unchanged version, persisted under a minute ago
  t.is((await heartbeat(2)).status, 200)
  t.deepEqual(writes.slice(before), ['meta']) // a new expected version is always saved
  const read = async () =>
    (
      await fetcher(`${base}/mcp/current`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })
    ).json()
  const live = await read()
  evict()
  const reloaded = await read()
  t.true(reloaded.active)
  t.is(reloaded.sessionId, session.sessionId)
  t.is(reloaded.version, 1)
  t.true(reloaded.pending)
  t.deepEqual(reloaded.state, live.state)
  t.deepEqual(reloaded.state, JSON.parse(JSON.stringify(snapshot)))
  t.is(reloaded.lastSeenAt, live.lastSeenAt)
  t.true(reloaded.connectionAgeMs >= 0 && reloaded.connectionAgeMs < 30_000)
  // The reloaded object still accepts the same writer and the next version.
  const next = { ...snapshot, version: 2, capturedAt: new Date().toISOString() }
  t.is(
    (await fetcher(`${base}/publish`, { method: 'PUT', headers, body: JSON.stringify(next) }))
      .status,
    200,
  )
  const after = await read()
  t.is(after.version, 2)
  t.false(after.stale)
  t.false(stored.has('session'))
})

test('a record in the old single-key format reads as no session and is removed', async (t) => {
  const { fetcher, live, stored } = fixture()
  stored.set('session', { id: 'old', ownerEpoch: 'x', expiresAt: Date.now() + 60_000 })
  const read = await live().fetch(
    new Request('https://state/read', { headers: { 'X-Owner-Epoch': 'x' } }),
  )
  t.like(await read.json(), { active: false, state: null, stale: true })
  t.false(stored.has('session'))
  t.truthy((await setupSession(fetcher)).sessionId)
  t.deepEqual([...stored.keys()], ['meta'])
})

test('publisher retries the latest snapshot after an outage without blocking game capture', async (t) => {
  const { fetcher } = fixture()
  const values = new Map<string, string>()
  const storage = () => ({
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v)
    },
    removeItem: (k: string) => {
      values.delete(k)
    },
  })
  let offline = true
  const attempted: number[] = []
  const flaky: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/publish') && init?.method === 'PUT') {
      attempted.push(JSON.parse(init.body as string).version)
      if (offline) throw new Error('offline')
    }
    return fetcher(url, init)
  }
  const publisher = new LivePublisher(storage, flaky)
  await publisher.connect(base, key)
  await publisher.flush()
  t.true(publisher.getStatus().connected)
  t.is(publisher.getStatus().acceptedVersion, 0)
  publisher.capture(null, 0)
  await publisher.flush()
  offline = false
  publisher.capture(null, 0)
  await publisher.flush()
  t.is(publisher.getStatus().acceptedVersion, 3)
  t.true(attempted.includes(3))
  await publisher.disconnect()
})

test('equity survives mid-turn connection and reload, then clears on the next actor', async (t) => {
  const { fetcher } = fixture()
  const values = new Map<string, string>()
  const storage = () => ({
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value)
    },
    removeItem: (name: string) => {
      values.delete(name)
    },
  })
  const hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })
  const publisher = new LivePublisher(storage, fetcher as typeof fetch)
  publisher.capture(hand, 1, 0.72493)
  await publisher.connect(base, key)
  await publisher.flush()
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  const read = async () =>
    (
      await (
        await fetcher(`${base}/mcp/current`, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
      ).json()
    ).state.hand.hero
  t.is((await read()).equity, 0.72493)
  t.is((await read()).equityDisplay, '72%')
  const resumed = new LivePublisher(storage, fetcher as typeof fetch)
  resumed.capture(hand, 1, 0.72493)
  await resumed.restore()
  await resumed.flush()
  t.is((await read()).equity, 0.72493)
  resumed.capture(applyAction(hand, { type: 'call' }), 1)
  await resumed.flush()
  t.is((await read()).equity, null)
  t.is((await read()).equityDisplay, '—')
  await resumed.disconnect()
})

const LOG_KEYS = [
  'event',
  'requestId',
  'method',
  'path',
  'rpcMethod',
  'tool',
  'status',
  'ms',
  'colo',
  'hasBearer',
  'version',
  'stale',
  'pending',
  'stateAgeMs',
]

test.serial('reads carry server timing; request logs hold no cards, tokens or keys', async (t) => {
  const { fetcher } = fixture()
  const session = await setupSession(fetcher)
  const flow = await oauth(fetcher)
  const tokens = await (await flow.exchange()).json()
  const hand = startHand({
    seats: [
      { id: 'hero', name: 'Hero', stack: 200 },
      { id: 'ai', name: 'Other', stack: 200 },
    ],
    buttonIndex: 0,
    smallBlind: 5,
    bigBlind: 10,
    rng: mulberry32(42),
  })
  const snapshot = liveSnapshot(hand, {
    sessionId: session.sessionId,
    version: 1,
    capturedAt: new Date().toISOString(),
    handNo: 1,
    heroId: 'hero',
  })
  const holeCards: string[] = snapshot.hand!.hero!.holeCards
  t.is(holeCards.length, 2)
  t.is(
    (
      await fetcher(`${base}/publish`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${session.token}`,
          'X-Pip-Session': session.sessionId,
          'X-Pip-Writer': 'writer-one',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(snapshot),
      })
    ).status,
    200,
  )
  const mark = logged.length
  const response = await fetcher(`${base}/mcp/current?probe=1`, {
    headers: { Authorization: `Bearer ${tokens.access_token}`, Cookie: 'secret-cookie=1' },
  })
  t.is(response.headers.get('X-Pip-Read-Meta'), null) // internal header never leaves
  const read = await response.json()
  // Existing fields keep their order; timing is appended last.
  t.deepEqual(Object.keys(read), [
    'active',
    'sessionId',
    'version',
    'receivedAt',
    'lastSeenAt',
    'readAt',
    'connectionAgeMs',
    'pending',
    'stale',
    'state',
    'timing',
  ])
  t.deepEqual(Object.keys(read.timing), ['requestId', 'serverMs', 'readMs', 'stateAgeMs'])
  const { timing } = read
  t.regex(timing.requestId, /^[0-9a-f-]{36}$/)
  t.true(Number.isInteger(timing.readMs) && timing.readMs >= 0)
  t.true(Number.isInteger(timing.serverMs) && timing.serverMs >= timing.readMs)
  t.true(timing.serverMs < 10_000)
  t.true(Number.isInteger(timing.stateAgeMs) && timing.stateAgeMs >= 0)
  t.true(timing.stateAgeMs < 60_000)
  t.true(Date.parse(read.readAt) - Date.parse(read.receivedAt) <= timing.stateAgeMs + 1)

  const tool = await fetcher(`${base}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_current_hand', arguments: {} },
    }),
  })
  const toolRead = JSON.parse((await tool.json()).result.content[0].text)
  t.deepEqual(Object.keys(toolRead.timing), ['requestId', 'serverMs', 'readMs', 'stateAgeMs'])
  t.not(toolRead.timing.requestId, timing.requestId)
  t.deepEqual(toolRead.state, read.state)

  const lines = logged.slice(mark)
  t.is(lines.length, 2)
  const [currentLog, toolLog] = lines.map((line) => JSON.parse(line))
  t.like(currentLog, {
    event: 'pip_live_request',
    requestId: timing.requestId,
    method: 'GET',
    path: '/mcp/current',
    status: 200,
    colo: null,
    hasBearer: true,
    version: 1,
    stale: false,
    pending: false,
  })
  t.true(Number.isInteger(currentLog.stateAgeMs) && Number.isInteger(currentLog.ms))
  t.like(toolLog, {
    requestId: toolRead.timing.requestId,
    method: 'POST',
    path: '/mcp',
    rpcMethod: 'tools/call',
    tool: 'get_current_hand',
    status: 200,
    hasBearer: true,
    version: 1,
  })
  for (const [index, line] of lines.entries()) {
    const entry = JSON.parse(line)
    t.true(
      Object.keys(entry).every((name) => LOG_KEYS.includes(name)),
      line,
    )
    for (const card of holeCards) t.false(line.includes(`"${card}"`), `card in log ${index}`)
    for (const secret of [
      tokens.access_token,
      tokens.access_token.split(':').at(-1),
      tokens.refresh_token,
      key,
      session.token,
      session.sessionId,
      flow.client.client_id,
      'secret-cookie',
      'probe',
      'holeCards',
      'Hero',
    ])
      t.false(line.includes(secret), `secret in log ${index}`)
  }
})

test.serial('OAuth rejections are logged by the outer Worker with hasBearer', async (t) => {
  const { fetcher } = fixture()
  const mark = logged.length
  const anonymous = await fetcher(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  t.is(anonymous.status, 401)
  const forged = await fetcher(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer owner:abc:not-a-real-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  t.is(forged.status, 401)
  const health = await fetcher(`${base}/health`)
  t.is(health.status, 200)
  const lines = logged.slice(mark)
  t.is(lines.length, 2) // /health is not logged
  const [first, second] = lines.map((line) => JSON.parse(line))
  t.like(first, { event: 'pip_live_request', method: 'POST', path: '/mcp', status: 401 })
  t.false(first.hasBearer)
  t.like(second, { path: '/mcp', status: 401, hasBearer: true })
  t.false('rpcMethod' in second) // the body is never read before authentication
  t.false('version' in second)
  t.false(lines[1].includes('not-a-real-token'))
})

test('a malformed upload is rejected before the lock and leaves the session usable', async (t) => {
  const { fetcher } = fixture()
  const session = await setupSession(fetcher)
  const headers = {
    Authorization: `Bearer ${session.token}`,
    'Content-Type': 'application/json',
    'X-Pip-Session': session.sessionId,
    'X-Pip-Writer': 'writer-one',
  }
  for (const body of ['not json', 'null', '[]']) {
    const rejected = await fetcher(`${base}/publish`, { method: 'PUT', headers, body })
    t.is(rejected.status, 400)
  }
  const beat = await fetcher(`${base}/heartbeat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ version: 0 }),
  })
  t.is(beat.status, 200)
})
