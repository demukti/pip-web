export const noCache = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
  // no-referrer makes ordinary form POSTs send Origin: null. Preserve the
  // origin for consent CSRF checks while withholding paths and OAuth queries.
  'Referrer-Policy': 'strict-origin',
}

export function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...noCache, 'Content-Type': 'application/json' },
  })
}

export async function bodyText(request, limit = 131_072) {
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new Error('Request too large')
    }
    chunks.push(value)
  }
  return new Blob(chunks).text()
}

export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}

export async function secretMatches(value, expected) {
  if (typeof value !== 'string' || !expected) return false
  const a = await hash(value)
  const b = await hash(expected)
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

export function bearer(request) {
  return request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1] ?? ''
}

export function randomSecret() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}
