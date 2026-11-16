import { COACH_MODEL, coachPrefs, streamCoach } from './coach.mjs'
import { bearer, bodyText, hash, json, noCache, secretMatches } from './http.mjs'
export { LiveState } from './devices.mjs'

// The coach's service. The game signs a browser in once with the owner key, then
// sends the hand with each question; this Worker keeps the Claude API key and
// streams the answer back. Four routes:
//
//   GET  /health
//   POST /connect     Authorization: Bearer <owner key>     → a browser token
//   POST /disconnect  Authorization: Bearer <browser token>
//   POST /coach       Authorization: Bearer <browser token> → NDJSON answer

// The question: the hand (at most a few kilobytes) and the player's settings.
const QUESTION_MAX = 32_768

// An exception's class name only, never its message or stack: V8's JSON.parse
// messages quote the input, and other messages can carry URLs or values.
const errorClass = (error) => {
  const name = error?.constructor?.name
  return typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : 'unknown'
}
const object = (env) => env.LIVE_STATE.get(env.LIVE_STATE.idFromName('owner'))

// Hashed once per isolate and keyed on the key itself, so rotating OWNER_KEY
// signs every browser out on the very next request.
let epochMemo
const ownerEpoch = (env) => {
  if (epochMemo?.key !== env.OWNER_KEY)
    epochMemo = { key: env.OWNER_KEY, value: hash(env.OWNER_KEY) }
  return epochMemo.value
}

/** Asks the Durable Object, carrying the browser's token and the owner epoch only. */
async function devices(env, path, request) {
  const headers = new Headers({ 'X-Owner-Epoch': await ownerEpoch(env) })
  const token = bearer(request)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return object(env).fetch(new Request(`https://devices${path}`, { method: 'POST', headers }))
}

async function coach(request, env, ctx, trace) {
  if (!env.ANTHROPIC_API_KEY)
    return json({ error: 'The coach is not set up on the service', code: 'coach_off' }, 503)
  let question
  try {
    question = JSON.parse(await bodyText(request, QUESTION_MAX))
  } catch {
    return json({ error: 'Invalid question' }, 400)
  }
  const hand = question?.hand
  if (hand === undefined || (hand !== null && (typeof hand !== 'object' || Array.isArray(hand))))
    return json({ error: 'Invalid question' }, 400)
  const admitted = await devices(env, '/coach', request)
  if (!admitted.ok) return admitted
  const { body, finished } = streamCoach(env, hand, coachPrefs(question.settings), request.signal)
  // The request line is written when the answer starts; this one when it ends.
  ctx?.waitUntil?.(
    finished.then((outcome) =>
      console.info(
        JSON.stringify({
          event: 'ask_coach_answer',
          requestId: trace.requestId,
          model: COACH_MODEL,
          firstTextMs: outcome.firstTextMs,
          totalMs: outcome.totalMs,
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          stop: outcome.stop,
          code: outcome.code,
          error: outcome.error ? errorClass(outcome.error) : undefined,
        }),
      ),
    ),
  )
  return new Response(body, {
    headers: { ...noCache, 'Content-Type': 'application/x-ndjson; charset=utf-8' },
  })
}

async function route(request, env, ctx, trace) {
  const path = new URL(request.url).pathname
  if (path === '/health' && request.method === 'GET')
    return json({ ok: true, service: 'pip-live-state' })
  if (request.method !== 'POST') return json({ error: 'Not found' }, 404)
  if (path === '/connect') {
    if (!(await secretMatches(bearer(request), env.OWNER_KEY)))
      return json({ error: 'Incorrect owner key', code: 'wrong_key' }, 403)
    // The owner key is not passed on: the object sees only the epoch.
    return object(env).fetch(
      new Request('https://devices/connect', {
        method: 'POST',
        headers: { 'X-Owner-Epoch': await ownerEpoch(env) },
      }),
    )
  }
  if (path === '/disconnect') return devices(env, '/disconnect', request)
  if (path === '/coach') return coach(request, env, ctx, trace)
  return json({ error: 'Not found' }, 404)
}

async function serve(request, env, ctx, trace) {
  try {
    if (!env.OWNER_KEY || env.OWNER_KEY.length < 32)
      return json({ error: 'Service not configured' }, 503)
    const origin = request.headers.get('Origin')
    const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim())
    if (origin && !allowed.includes(origin)) return json({ error: 'Forbidden origin' }, 403)
    if (request.method === 'OPTIONS') {
      if (!origin) return json({ error: 'Origin required' }, 403)
      return new Response(null, {
        status: 204,
        headers: {
          ...noCache,
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        },
      })
    }
    const response = await route(request, env, ctx, trace)
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

export default {
  async fetch(request, env, ctx) {
    const trace = { start: Date.now(), requestId: crypto.randomUUID() }
    const path = new URL(request.url).pathname
    let status = 500
    try {
      const response = await serve(request, env, ctx, trace)
      status = response.status
      return response
    } finally {
      if (path !== '/health' || trace.error) {
        // Allow-listed fields only: never the hand, settings, tokens, keys, cookies,
        // query string, body, IP address or error message.
        console.info(
          JSON.stringify({
            event: 'ask_coach_request',
            requestId: trace.requestId,
            method: request.method,
            path,
            status,
            error: trace.error,
            ms: Date.now() - trace.start,
            colo: request.cf?.colo ?? null,
            hasBearer: /^Bearer\s/i.test(request.headers.get('Authorization') ?? ''),
          }),
        )
      }
    }
  },
}
