// Public connectivity diagnostic only. Never attach game state or credentials.
// Stateless Streamable HTTP: JSON responses, no SSE stream or server sessions.
const PROTOCOL_VERSION = '2025-06-18'
const headers = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
}

const tool = {
  name: 'get_live_probe',
  description:
    'Test Pip Live connectivity. Call on each request for a fresh server timestamp and request ID. This is a diagnostic with no poker game data.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, ...extraHeaders },
  })
}

function sample() {
  return {
    diagnostic: 'pip-live-probe',
    containsGameState: false,
    requestId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    message: 'Connectivity probe only. No poker game is connected.',
  }
}

export default {
  async fetch(request) {
    const url = new URL(request.url)
    // Server-to-server callers normally have no Origin. Browser callers must
    // originate at this Worker; no cross-origin browser access is needed.
    const origin = request.headers.get('Origin')
    if (origin && origin !== url.origin) return json({ error: 'Forbidden origin' }, 403)

    if (url.pathname === '/probe' && request.method === 'GET') return json(sample())
    if (url.pathname !== '/mcp') return json({ error: 'Not found' }, 404)
    if (request.method !== 'POST') {
      return json({ error: 'Use POST; no SSE stream is offered' }, 405, { Allow: 'POST' })
    }
    if (!request.headers.get('Content-Type')?.includes('application/json')) {
      return json({ error: 'Expected application/json' }, 415)
    }
    const protocol = request.headers.get('MCP-Protocol-Version')
    if (protocol && protocol !== PROTOCOL_VERSION) {
      return json({ error: 'Unsupported MCP protocol version' }, 400)
    }
    // Bound request size without buffering an arbitrarily large request body.
    const reader = request.body?.getReader()
    if (!reader) return json({ error: 'Missing body' }, 400)
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 16_384) {
        await reader.cancel()
        return json({ error: 'Request too large' }, 413)
      }
      chunks.push(value)
    }
    let rpc
    try {
      rpc = JSON.parse(await new Blob(chunks).text())
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
      ('id' in rpc && typeof rpc.id !== 'string' && typeof rpc.id !== 'number')
    ) {
      return json(
        { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } },
        400,
      )
    }
    if (!('id' in rpc)) return new Response(null, { status: 202, headers })
    const reply = (result) => json({ jsonrpc: '2.0', id: rpc.id, result })
    const error = (code, message) => json({ jsonrpc: '2.0', id: rpc.id, error: { code, message } })
    switch (rpc.method) {
      case 'initialize':
        return reply({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'pip-live-probe', version: '0.1.0' },
          instructions: 'Diagnostic only. Call get_live_probe again for each freshness check.',
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: [tool] })
      case 'tools/call': {
        if (rpc.params?.name !== tool.name) return error(-32602, 'Unknown tool')
        const args = rpc.params.arguments ?? {}
        if (
          typeof args !== 'object' ||
          args === null ||
          Array.isArray(args) ||
          Object.keys(args).length
        ) {
          return error(-32602, 'This tool accepts an empty object only')
        }
        const result = sample()
        // Correlate actual tool execution with the spoken response. No user data.
        console.info(JSON.stringify({ event: 'get_live_probe', ...result }))
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] })
      }
      default:
        return error(-32601, 'Method not found')
    }
  },
}
