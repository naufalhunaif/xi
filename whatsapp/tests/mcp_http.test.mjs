import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mcpOAuthFetch, mcpBusinessFetch } from '../app/services/mcp_oauth_fetch.ts'

test('pinned OAuth HTTP transport: Fit fallback, streaming SSE, cancellation, redirect and size limits', async () => {
  let targetHits = 0
  const server = createServer((req, res) => {
    if (req.url === '/fit/.well-known/oauth-authorization-server') { res.writeHead(404); res.end('missing'); return }
    if (req.url === '/fit/index.php/.well-known/oauth-authorization-server') { res.setHeader('Content-Type', 'application/json'); res.end('{"issuer":"fixture"}'); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/target' }); res.end(); return }
    if (req.url === '/target') { targetHits++; res.end(); return }
    if (req.url === '/large') { res.end('x'.repeat(1_048_577)); return }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('event: message\ndata: {"id":1}\n\n')
      // Deliberately leave SSE open: fetch must resolve at headers, not EOF.
      return
    }
    res.writeHead(401); res.end()
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const fetchFn = mcpOAuthFetch(`${base}/fit/mcp`)
    assert.deepEqual(await (await fetchFn(`${base}/fit/.well-known/oauth-authorization-server`)).json(), { issuer: 'fixture' })
    const response = await fetchFn(`${base}/stream`)
    const reader = response.body.getReader()
    assert.match(new TextDecoder().decode((await reader.read()).value), /message/)
    await reader.cancel()
    await assert.rejects(() => fetchFn(`${base}/redirect`, { method: 'POST', body: 'code=fixture' }), /ditolak/)
    assert.equal(targetHits, 0)
    await assert.rejects(async () => (await fetchFn(`${base}/large`)).text(), /terlalu besar/)
    assert.equal((await (await mcpBusinessFetch(base)(`${base}/large`)).text()).length, 1_048_577)
    const external = mcpOAuthFetch('https://business.example/mcp')
    await assert.rejects(() => external(`${base}/target`), /tidak aman/)
    assert.equal(targetHits, 0)
  } finally { server.closeAllConnections(); server.close(); await once(server, 'close') }
})
