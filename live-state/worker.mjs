import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
} from '@cloudflare/workers-oauth-provider'
import { bearer, bodyText, hash, json, noCache, READ_META, secretMatches } from './http.mjs'
export { LiveState } from './session.mjs'

const READ = 'hand:read'
// One line per request to these paths, for an ad-hoc `wrangler tail`; any other
// path logs only when it failed with an exception.
const LOGGED = new Set(['/mcp', '/mcp/current', '/token', '/register'])
const RPC_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'ping',
  'tools/list',
  'tools/call',
])
// Per-request trace, keyed on the incoming Request object, which the OAuth library
// hands unchanged to the API handler. Unlike a header, a client cannot set it.
// Holds only timings and freshness figures: never cards, tokens or bodies.
const traces = new WeakMap()
// An exception's class name only, never its message or stack: V8's JSON.parse
// messages quote the input, and other messages can carry URLs or values.
const errorClass = (error) => {
  const name = error?.constructor?.name
  return typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : 'unknown'
}
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const object = (env) => env.LIVE_STATE.get(env.LIVE_STATE.idFromName('owner'))
const internal = (env, path, request) =>
  object(env).fetch(new Request(`https://state${path}`, request))

// Hashed once per isolate and keyed on the key itself, so rotating OWNER_KEY
// takes effect on the very next request.
let epochMemo
const ownerEpoch = (env) => {
  if (epochMemo?.key !== env.OWNER_KEY)
    epochMemo = { key: env.OWNER_KEY, value: hash(env.OWNER_KEY) }
  return epochMemo.value
}

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER
  if (request.method === 'GET') {
    const auth = await oauth.parseAuthRequest(request)
    const details = await oauth.describeConsent(auth)
    const consent = await oauth.beginConsent(auth)
    consent.headers.set('Content-Type', 'text/html; charset=utf-8')
    consent.headers.set('Cache-Control', 'no-store')
    consent.headers.set('Referrer-Policy', 'strict-origin')
    consent.headers.set('Content-Security-Policy', "frame-ancestors 'none'")
    consent.headers.set('X-Frame-Options', 'DENY')
    return new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1"><title>Pip Live access</title>
      <h1>Allow read-only access to your Pip game?</h1>
      <p>Client: <strong>${escapeHtml(details.clientName)}</strong></p>
      <p>${details.clientDomain ? `Published by ${escapeHtml(details.clientDomain)}` : 'Client name is self-reported.'}</p>
      <p>Return to: <strong>${escapeHtml(details.redirectHost)}</strong></p>
      ${details.redirectIsLoopback ? '<p>This returns access to an app on your computer.</p>' : ''}
      <p>Requested scopes: ${details.scope.map(escapeHtml).join(', ')}</p>
      <p>This allows reading your visible cards, betting history, and stacks. It cannot play a move.</p>
      <form method="post" action="/authorize">
      <input type="hidden" name="handle" value="${escapeHtml(consent.handle)}">
      <label>Your Pip Live owner key <input type="password" name="key" required autocomplete="current-password"></label>
      <button name="decision" value="approve">Allow read access</button>
      <button name="decision" value="deny" formnovalidate>Deny</button></form></html>`,
      { headers: consent.headers },
    )
  }
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (request.headers.get('Origin') !== env.PUBLIC_URL)
    return json({ error: 'Forbidden origin' }, 403)
  const form = new URLSearchParams(await bodyText(request, 16_384))
  const handle = form.get('handle') ?? ''
  if (form.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  if (!(await secretMatches(form.get('key'), env.OWNER_KEY)))
    return json({ error: 'Incorrect owner key; restart connection to try again' }, 403)
  const approved = await oauth.approveConsent(request, handle)
  if (approved.request.scope.some((scope) => ![READ, 'offline_access'].includes(scope))) {
    return json({ error: 'Unsupported scope' }, 400)
  }
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: 'owner',
    scope: approved.request.scope,
    metadata: {},
    props: { ownerEpoch: await ownerEpoch(env) },
  })
  approved.headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers: approved.headers })
}

const tool = {
  name: 'get_current_hand',
  description:
    "Fetch the latest actual Pip poker state. Call again on every game question or follow-up. Check active, stale, pending and timestamps. If stale or inactive, say so; never imply cached cards are current. If state.hand.table.status says the hero busted or won, the run is over: say so instead of advising a live decision. Otherwise lead your answer with state.hand.brief, the game's one-sentence summary; hero.toCall, hero.potOdds and hero.stack give the price, and action-history entries carry name and position. Trust hero.handName, the made hand as the table names it (null preflop); do not re-derive it from the cards. hero.lastEquity is an earlier turn's estimate, not current equity. For advice about an opponent, use their players[].style and reads, the player's own observed reads; if reads is empty there is no read yet, so do not invent tendencies. After a showdown, hand.result.shownHands lists the hands turned face up; opponents' cards are never present at any other time, so never guess them. Explain the state; do not play moves. timing.serverMs is the server's own execution time and readAt is when the server answered, so a long wait with a small serverMs happened outside the server.",
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

const protectedApi = {
  async fetch(request, env, ctx) {
    if (!ctx.auth.scope.includes(READ) || ctx.props?.ownerEpoch !== (await ownerEpoch(env))) {
      return json({ error: 'Read access missing or revoked; reconnect Pip Live' }, 403)
    }
    const trace = traces.get(request) ?? { start: Date.now(), requestId: crypto.randomUUID() }
    // Returns the read payload as JSON text with `timing` appended as its last field;
    // every other field and its order stay exactly as the Durable Object wrote them.
    const read = async () => {
      const begin = Date.now()
      const response = await internal(env, '/read', {
        headers: { 'X-Owner-Epoch': ctx.props.ownerEpoch },
      })
      const body = await response.text()
      const readMs = Date.now() - begin
      let meta = {}
      try {
        meta = JSON.parse(response.headers.get(READ_META) ?? '{}')
      } catch {}
      trace.read = {
        version: meta.version ?? null,
        stale: meta.stale ?? null,
        pending: meta.pending ?? null,
        stateAgeMs: meta.stateAgeMs ?? null,
      }
      const timing = {
        requestId: trace.requestId,
        serverMs: Date.now() - trace.start,
        readMs,
        stateAgeMs: trace.read.stateAgeMs,
      }
      const text =
        body.startsWith('{') && body.endsWith('}') && body.length > 2
          ? `${body.slice(0, -1)},"timing":${JSON.stringify(timing)}}`
          : body
      return { status: response.status, text }
    }
    const path = new URL(request.url).pathname
    if (path === '/mcp/current' && request.method === 'GET') {
      const { status, text } = await read()
      return new Response(text, {
        status,
        headers: { ...noCache, 'Content-Type': 'application/json' },
      })
    }
    if (path !== '/mcp') return json({ error: 'Not found' }, 404)
    if (request.method !== 'POST')
      return new Response(null, { status: 405, headers: { Allow: 'POST' } })
    const protocol = request.headers.get('MCP-Protocol-Version')
    if (protocol && protocol !== '2025-06-18')
      return json({ error: 'Unsupported MCP version' }, 400)
    if (!request.headers.get('Content-Type')?.includes('application/json'))
      return json({ error: 'Expected JSON' }, 415)
    let rpc
    try {
      rpc = JSON.parse(await bodyText(request, 16_384))
    } catch {
      return json(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        400,
      )
    }
    if (
      !rpc ||
      typeof rpc !== 'object' ||
      Array.isArray(rpc) ||
      rpc.jsonrpc !== '2.0' ||
      typeof rpc.method !== 'string' ||
      ('id' in rpc && !['number', 'string'].includes(typeof rpc.id))
    ) {
      return json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
        400,
      )
    }
    trace.rpcMethod = RPC_METHODS.has(rpc.method) ? rpc.method : 'other'
    if (!('id' in rpc)) return new Response(null, { status: 202 })
    const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id, result })
    const error = (code, message) => json({ jsonrpc: '2.0', id: rpc.id, error: { code, message } })
    switch (rpc.method) {
      case 'initialize':
        return reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'pip-live-state', version: '0.1.0' },
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: [tool] })
      case 'tools/call': {
        const args = rpc.params?.arguments ?? {}
        trace.tool = rpc.params?.name === tool.name ? tool.name : 'other'
        if (
          rpc.params?.name !== tool.name ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length
        )
          return error(-32602, 'Unknown tool or invalid arguments')
        // The read body is already the JSON payload; pass it through as text.
        return reply({ content: [{ type: 'text', text: (await read()).text }] })
      }
      default:
        return error(-32601, 'Method not found')
    }
  },
}

const defaultHandler = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname
    if (path === '/health' && request.method === 'GET')
      return json({ ok: true, service: 'pip-live-state' })
    if (path === '/authorize') {
      try {
        return await authorize(request, env)
      } catch (error) {
        if (error instanceof AuthorizationError && error.redirectTo)
          return Response.redirect(error.redirectTo, 302)
        if (error instanceof AuthorizationError || error instanceof CimdFetchError)
          return json(
            { error: 'Connection expired or could not be verified; restart sign-in' },
            400,
          )
        throw error
      }
    }
    if (path === '/sessions' && request.method === 'POST') {
      if (!(await secretMatches(bearer(request), env.OWNER_KEY)))
        return json({ error: 'Incorrect owner key' }, 403)
      const data = JSON.parse(await bodyText(request, 4096))
      if (typeof data.writerId !== 'string' || data.writerId.length > 100)
        return json({ error: 'Invalid writer' }, 400)
      return internal(env, '/create', {
        method: 'POST',
        body: JSON.stringify({ writerId: data.writerId, ownerEpoch: await ownerEpoch(env) }),
      })
    }
    const routes = {
      'PUT /publish': '/publish',
      'DELETE /publish': '/revoke',
      'POST /heartbeat': '/heartbeat',
      'POST /claim': '/claim',
    }
    const route = routes[`${request.method} ${path}`]
    if (route) {
      const forwarded = new Request(request)
      forwarded.headers.set('X-Owner-Epoch', await ownerEpoch(env))
      return internal(env, route, forwarded)
    }
    return json({ error: 'Not found' }, 404)
  },
}

const createProvider = (publicUrl) =>
  new OAuthProvider({
    apiRoute: '/mcp',
    apiHandler: protectedApi,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    scopesSupported: [READ, 'offline_access'],
    requiredScopes: [READ],
    resourceMetadata: {
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      resource_name: 'Pip Live',
    },
    clientIdMetadataDocumentEnabled: true,
    // Owner-key rotation still revokes at once: every read re-checks the epoch.
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    // No request bodies, card data, tokens, or OAuth callback URLs in logs. These
    // are OAuth error responses, not exceptions, and the hook is handed the request
    // only in some cases, so it cannot be tied to a log line; the logged status
    // still shows them on the endpoints that log.
    onError: () => {},
  })

// One provider per isolate, rebuilt only if PUBLIC_URL changes.
let providerMemo
const provider = (env) => {
  if (providerMemo?.url !== env.PUBLIC_URL)
    providerMemo = { url: env.PUBLIC_URL, value: createProvider(env.PUBLIC_URL) }
  return providerMemo.value
}

export default {
  async fetch(request, env, ctx) {
    const trace = { start: Date.now(), requestId: crypto.randomUUID() }
    traces.set(request, trace)
    const path = new URL(request.url).pathname
    let status = 500
    try {
      const response = await serve(request, env, ctx, trace)
      status = response.status
      return response
    } finally {
      if (LOGGED.has(path) || trace.error) {
        // Allow-listed fields only: no cards, snapshot, tokens, Authorization, cookies,
        // query string, body, client ID, IP address or error message.
        console.info(
          JSON.stringify({
            event: 'pip_live_request',
            requestId: trace.requestId,
            method: request.method,
            path,
            rpcMethod: trace.rpcMethod,
            tool: trace.tool,
            status,
            error: trace.error,
            ms: Date.now() - trace.start,
            colo: request.cf?.colo ?? null,
            hasBearer: /^Bearer\s/i.test(request.headers.get('Authorization') ?? ''),
            ...trace.read,
          }),
        )
      }
    }
  },
}

async function serve(request, env, ctx, trace) {
  try {
    if (!env.PUBLIC_URL || !env.OWNER_KEY || env.OWNER_KEY.length < 32)
      return json({ error: 'Service not configured' }, 503)
    const origin = request.headers.get('Origin')
    const allowed = [env.PUBLIC_URL, ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())]
    if (origin && !allowed.includes(origin)) return json({ error: 'Forbidden origin' }, 403)
    if (request.method === 'OPTIONS') {
      if (!origin) return json({ error: 'Origin required' }, 403)
      return new Response(null, {
        status: 204,
        headers: {
          ...noCache,
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers':
            'Authorization, Content-Type, X-Pip-Session, X-Pip-Writer',
          Vary: 'Origin',
        },
      })
    }
    const response = await provider(env).fetch(request, env, ctx)
    const headers = new Headers(response.headers)
    for (const [name, value] of Object.entries(noCache)) headers.set(name, value)
    if (origin) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Vary', 'Origin')
    }
    return new Response(response.body, { status: response.status, headers })
  } catch (error) {
    trace.error = errorClass(error)
    return json({ error: 'Request failed; check configuration or retry' }, 400)
  }
}
