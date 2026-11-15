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
const key = 'test-owner-key-with-at-least-32-random-characters'

function fixture() {
  const stored = new Map<string, unknown>()
  const kv = new Map<string, string>()
  const object = new LiveState({
    blockConcurrencyWhile: async (fn: () => Promise<Response>) => fn(),
    storage: {
      get: async (name: string) => structuredClone(stored.get(name)),
      put: async (name: string, value: unknown) => {
        stored.set(name, structuredClone(value))
      },
      deleteAll: async () => {
        stored.clear()
      },
      setAlarm: async () => {},
    },
  })
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
  return { env, object, fetcher, kv, stored }
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
  t.is(JSON.parse((await tool.json()).result.content[0].text).version, 5)
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
  const { fetcher, object, stored } = fixture()
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
  const record = stored.get('session') as { lastSeenAt: number; expiresAt: number }
  record.lastSeenAt = Date.now() - 31_000
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
  await object.alarm()
  t.true((await read()).active)
  const expired = stored.get('session') as { expiresAt: number }
  expired.expiresAt = Date.now() - 1
  await object.alarm()
  t.false((await read()).active)
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
