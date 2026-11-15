import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
} from '@cloudflare/workers-oauth-provider'
import { bearer, bodyText, hash, json, noCache, secretMatches } from './http.mjs'
export { LiveState } from './session.mjs'

const READ = 'hand:read'
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const object = (env) => env.LIVE_STATE.get(env.LIVE_STATE.idFromName('owner'))
const internal = (env, path, request) =>
  object(env).fetch(new Request(`https://state${path}`, request))

async function authorize(request, env) {
  const oauth = env.OAUTH_PROVIDER
  if (request.method === 'GET') {
    const auth = await oauth.parseAuthRequest(request)
    const details = await oauth.describeConsent(auth)
    const consent = await oauth.beginConsent(auth)
    consent.headers.set('Content-Type', 'text/html; charset=utf-8')
    consent.headers.set('Cache-Control', 'no-store')
    consent.headers.set('Referrer-Policy', 'strict-origin')
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
    props: { ownerEpoch: await hash(env.OWNER_KEY) },
  })
  approved.headers.set('Location', redirectTo)
  return new Response(null, { status: 302, headers: approved.headers })
}

const tool = {
  name: 'get_current_hand',
  description:
    'Fetch the latest actual Pip poker state. Call again on every game question or follow-up. Check active, stale, pending and timestamps. If stale or inactive, say so; never imply cached cards are current. Explain the state; do not play moves.',
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
    if (!ctx.auth.scope.includes(READ) || ctx.props?.ownerEpoch !== (await hash(env.OWNER_KEY))) {
      return json({ error: 'Read access missing or revoked; reconnect Pip Live' }, 403)
    }
    const read = () =>
      internal(env, '/read', { headers: { 'X-Owner-Epoch': ctx.props.ownerEpoch } })
    const path = new URL(request.url).pathname
    if (path === '/mcp/current' && request.method === 'GET') return read()
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
        if (
          rpc.params?.name !== tool.name ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length
        )
          return error(-32602, 'Unknown tool or invalid arguments')
        const state = await (await read()).json()
        return reply({ content: [{ type: 'text', text: JSON.stringify(state) }] })
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
        body: JSON.stringify({ writerId: data.writerId, ownerEpoch: await hash(env.OWNER_KEY) }),
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
      forwarded.headers.set('X-Owner-Epoch', await hash(env.OWNER_KEY))
      return internal(env, route, forwarded)
    }
    return json({ error: 'Not found' }, 404)
  },
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.PUBLIC_URL || !env.OWNER_KEY || env.OWNER_KEY.length < 32)
        return json({ error: 'Service not configured' }, 503)
      const origin = request.headers.get('Origin')
      const allowed = [
        env.PUBLIC_URL,
        ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()),
      ]
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
      const provider = new OAuthProvider({
        apiRoute: '/mcp',
        apiHandler: protectedApi,
        defaultHandler,
        authorizeEndpoint: '/authorize',
        tokenEndpoint: '/token',
        clientRegistrationEndpoint: '/register',
        scopesSupported: [READ, 'offline_access'],
        requiredScopes: [READ],
        resourceMetadata: {
          resource: `${env.PUBLIC_URL}/mcp`,
          authorization_servers: [env.PUBLIC_URL],
          resource_name: 'Pip Live',
        },
        clientIdMetadataDocumentEnabled: true,
        accessTokenTTL: 300,
        refreshTokenTTL: 7 * 24 * 60 * 60,
        // No request bodies, card data, tokens, or OAuth callback URLs in logs.
        onError: () => {},
      })
      const response = await provider.fetch(request, env, ctx)
      const headers = new Headers(response.headers)
      for (const [name, value] of Object.entries(noCache)) headers.set(name, value)
      if (origin) {
        headers.set('Access-Control-Allow-Origin', origin)
        headers.set('Vary', 'Origin')
      }
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return json({ error: 'Request failed; check configuration or retry' }, 400)
    }
  },
}
