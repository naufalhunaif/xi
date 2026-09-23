import test from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { fetchDiagnostics, diagnosticsServer } from './diagnostics_mcp.mjs'

const config = {
  url: 'https://keepbelanja.com/whatsapp/api/ops/diagnostics',
  token: 'x'.repeat(43),
  workspaceId: 2,
  expiresAt: Date.now() + 60000,
}
test('MCP exposes only fixed read-only diagnostics and sends credentials in headers', async () => {
  let calls = 0
  const fetcher = async (url, init) => {
    calls++
    assert.equal(url.origin, 'https://keepbelanja.com')
    assert.equal(url.pathname, '/whatsapp/api/ops/diagnostics')
    assert.equal(url.toString().includes(config.token), false)
    assert.equal(init.headers.authorization, `Bearer ${config.token}`)
    assert.equal(init.redirect, 'error')
    return Response.json({
      workspaceId: 2,
      database: { status: 'unavailable', code: 'ECONNREFUSED' },
    })
  }
  const server = diagnosticsServer(config, fetcher)
  const client = new Client({ name: 'fixture', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(a)
    await client.connect(b)
    const list = await client.listTools()
    assert.equal(list.tools.length, 1)
    assert.equal(list.tools[0].annotations.readOnlyHint, true)
    const result = await client.callTool({ name: 'get_whatsapp_diagnostics', arguments: {} })
    assert.ok(JSON.stringify(result).includes('ECONNREFUSED'))
    assert.equal(JSON.stringify(result).includes(config.token), false)
    const denied = await client.callTool({
      name: 'get_whatsapp_diagnostics',
      arguments: { url: 'https://attacker.invalid' },
    })
    assert.equal(denied.isError, true)
    assert.equal(calls, 1)
  } finally {
    await client.close()
    await server.close()
  }
})
test('adapter rejects expired tokens, arbitrary paths, HTTP and workspace mismatch', async () => {
  const noFetch = async () => {
    throw new Error('MUST_NOT_FETCH')
  }
  for (const changed of [
    { expiresAt: 0 },
    { url: 'http://keepbelanja.com/whatsapp/api/ops/diagnostics' },
    { url: 'https://keepbelanja.com/delete' },
    { url: config.url + '?token=secret' },
  ])
    await assert.rejects(
      () => fetchDiagnostics({ ...config, ...changed }, undefined, noFetch),
      (error) => error.message !== 'MUST_NOT_FETCH'
    )
  await assert.rejects(
    () => fetchDiagnostics(config, undefined, async () => Response.json({ workspaceId: 3 })),
    /workspace mismatch/
  )
  await assert.rejects(
    () => fetchDiagnostics(config, undefined, async () => new Response('secret', { status: 401 })),
    /HTTP 401/
  )
})
