import test from 'ava'
import worker from '../live-probe/worker.mjs'

const endpoint = 'https://probe.example/mcp'
const call = (method: string, params?: object) =>
  worker.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  )

test('probe initializes and advertises only the diagnostic read tool', async (t) => {
  const init = await (await call('initialize', { protocolVersion: '2025-06-18' })).json()
  t.is(init.result.protocolVersion, '2025-06-18')
  const listed = await (await call('tools/list')).json()
  t.deepEqual(
    listed.result.tools.map((tool: { name: string }) => tool.name),
    ['get_live_probe'],
  )
  t.true(listed.result.tools[0].annotations.readOnlyHint)
})

test('separate tool executions return distinct uncached diagnostic responses', async (t) => {
  const first = await call('tools/call', { name: 'get_live_probe', arguments: {} })
  const second = await call('tools/call', { name: 'get_live_probe', arguments: {} })
  t.true(first.headers.get('Cache-Control')?.includes('no-store') ?? false)
  const a = JSON.parse((await first.json()).result.content[0].text)
  const b = JSON.parse((await second.json()).result.content[0].text)
  t.not(a.requestId, b.requestId)
  t.false(a.containsGameState)
  t.true(Number.isFinite(Date.parse(a.generatedAt)))
})

test('unknown tools and nonempty arguments are rejected', async (t) => {
  for (const params of [
    { name: 'get_current_hand' },
    { name: 'get_live_probe', arguments: { gameState: 'must not be accepted' } },
  ]) {
    t.is((await (await call('tools/call', params)).json()).error.code, -32602)
  }
})

test('foreign browser origins and oversized requests are rejected', async (t) => {
  const foreign = await worker.fetch(
    new Request(endpoint, { headers: { Origin: 'https://other.example' } }),
  )
  t.is(foreign.status, 403)
  const large = await worker.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(16_385),
    }),
  )
  t.is(large.status, 413)
})

test('notifications are accepted and unsupported SSE returns 405', async (t) => {
  const notification = await worker.fetch(
    new Request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }),
  )
  t.is(notification.status, 202)
  t.is(await notification.text(), '')
  t.is((await worker.fetch(new Request(endpoint))).status, 405)
})

test('primitive JSON and malformed JSON return protocol errors instead of throwing', async (t) => {
  for (const body of ['true', '42', '"hello"', 'null', '[]', '{']) {
    const response = await worker.fetch(
      new Request(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
    )
    t.is(response.status, 400)
    t.is((await response.json()).error.code, body === '{' ? -32700 : -32600)
  }
})
