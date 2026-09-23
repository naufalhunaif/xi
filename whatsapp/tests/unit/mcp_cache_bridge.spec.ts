import { test } from '@japa/runner'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startMcpCacheBridge } from '#services/mcp_cache_bridge'
import { EvidenceCache, createTurnEvidenceCache, type CacheEntry } from '#services/evidence_cache'
import type { TraceEvent } from '#services/trace_service'

test('price patterns are app-side review metadata and preserve original MCP product evidence', async ({
  assert,
}) => {
  const events: TraceEvent[] = []
  let reads = 0
  const bridge = await startMcpCacheBridge(
    [{ slug: 'catalog', url: 'https://fixture.invalid/mcp', enabled: true, authenticated: true }],
    { catalog: 'fixture-token' },
    (event) => events.push(event),
    'fixture',
    {
      turnCache: createTurnEvidenceCache(),
      connect: async () => ({
        listTools: async () => ({
          tools: [{ name: 'get_product', inputSchema: { type: 'object' as const } }],
        }),
        callTool: async (request) => {
          reads++
          const row = {
            id: request.arguments?.id,
            name: `Double Breasted - ${request.arguments?.id === '1' ? 'Navy' : 'BW'}`,
            sizes: [{ size_name: 'S', price: 535000 }],
            img: '/product.jpg',
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(row) }],
            structuredContent: row,
          }
        },
        close: async () => {},
      }),
    }
  )
  const client = new Client({ name: 'price-pattern-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.catalog}` } },
      })
    )
    await client.listTools()
    const first = await client.callTool({ name: 'get_product', arguments: { id: '1' } })
    assert.lengthOf(first.content as any[], 1)
    const second = await client.callTool({ name: 'get_product', arguments: { id: '2' } })
    const blocks = second.content as Array<{ type: string; text: string }>
    assert.deepEqual(JSON.parse(blocks[0].text), second.structuredContent)
    assert.equal((second.structuredContent as any).id, '2')
    assert.notProperty(second.structuredContent, 'unitPrice')
    const pattern = JSON.parse(blocks[1].text).appInternalPricePattern
    assert.equal(pattern.status, 'internal_review_only')
    assert.equal(pattern.patterns[0].dominantPrice, 535000)
    assert.equal(reads, 2)
    assert.isTrue(
      events.some((event) => (event.detail as any)?.pricePattern?.status === 'internal_review_only')
    )
  } finally {
    await client.close()
    await bridge.close()
  }
})

test('catalog reads and discovery reuse one reply snapshot across bridges, expire and isolate new replies/auth', async ({
  assert,
}) => {
  let now = 1000
  let reads = 0
  let discoveries = 0
  const turnCache = createTurnEvidenceCache(() => now)
  const events: TraceEvent[] = []
  const connection = {
    slug: 'fixture',
    url: 'https://fixture.invalid/mcp',
    enabled: true,
    authenticated: true,
  }
  const phase = async (token: string, shared = turnCache, id = 'p1') => {
    const bridge = await startMcpCacheBridge(
      [connection],
      { fixture: token },
      (event) => events.push(event),
      'analysis',
      {
        turnCache: shared,
        connect: async () => ({
          listTools: async () => {
            discoveries++
            return { tools: [{ name: 'get_product', inputSchema: { type: 'object' as const } }] }
          },
          callTool: async () => {
            reads++
            return {
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({ id, name: 'Original Product', price: reads * 100 }),
                },
              ],
            }
          },
          close: async () => {},
        }),
      }
    )
    const client = new Client({ name: 'turn-cache-fixture', version: '1' })
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
          requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.fixture}` } },
        })
      )
      await client.listTools()
      await client.listTools()
      const [first, second] = await Promise.all([
        client.callTool({ name: 'get_product', arguments: { id, lang: 'id' } }),
        client.callTool({ name: 'get_product', arguments: { lang: 'id', id } }),
      ])
      assert.deepEqual(first, second)
      return first
    } finally {
      await client.close()
      await bridge.close()
    }
  }
  const first = await phase('auth-A')
  assert.deepEqual(await phase('auth-A'), first)
  assert.equal(reads, 1)
  assert.equal(discoveries, 1)
  await phase('auth-A', turnCache, 'p2')
  assert.equal(reads, 2)
  await phase('auth-B')
  assert.equal(reads, 3)
  assert.equal(discoveries, 2)
  now += 60_000
  assert.notDeepEqual(await phase('auth-A'), first)
  assert.equal(reads, 4)
  assert.equal(discoveries, 3)
  await phase(
    'auth-A',
    createTurnEvidenceCache(() => now)
  )
  assert.equal(reads, 5)
  assert.equal(discoveries, 4)
  assert.isTrue(
    events.some(
      (event) =>
        (event.detail as any)?.cache?.scope === 'reply' &&
        (event.detail as any)?.cache?.status === 'hit'
    )
  )
  assert.notInclude(JSON.stringify(events), 'auth-A')
})

test('stalled MCP cleanup cannot hold the provider result and closes the local listener first', async ({
  assert,
}) => {
  const events: TraceEvent[] = []
  let release!: () => void
  let closes = 0
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const bridge = await startMcpCacheBridge(
    [{ slug: 'fixture', url: 'https://fixture.invalid/mcp', enabled: true, authenticated: true }],
    {},
    (event) => events.push(event),
    'analysis',
    {
      closeTimeoutMs: 25,
      connect: async () => ({
        listTools: async () => ({ tools: [] }),
        callTool: async () => ({ content: [] }),
        close: async () => {
          closes++
          await blocked
        },
      }),
    }
  )
  const client = new Client({ name: 'cleanup-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.fixture}` } },
      })
    )
    await client.listTools()
    await bridge.close()
    assert.equal(closes, 1)
    const failure = events.find((event) => event.key === 'analysis:mcp-cleanup')
    assert.equal((failure?.detail as any)?.code, 'MCP_CLEANUP_TIMEOUT')
    await assert.rejects(() =>
      fetch(bridge.connections[0].url, { method: 'POST', signal: AbortSignal.timeout(1000) })
    )
    await bridge.close()
    assert.equal(closes, 1)
  } finally {
    release()
    await client.close()
    await bridge.close()
  }
}).timeout(5000)

test('bridge filters unused schemas for either provider and rejects direct calls to hidden tools', async ({
  assert,
}) => {
  const events: TraceEvent[] = []
  const calls: string[] = []
  const bridge = await startMcpCacheBridge(
    [{ slug: 'store', url: 'https://fixture.invalid/mcp', enabled: true, authenticated: true }],
    {},
    (event) => events.push(event),
    'analysis',
    {
      connect: async () => ({
        listTools: async () => ({
          tools: ['delete_record', 'get_record', 'list_records'].map((name) => ({
            name,
            description: 'schema'.repeat(100),
            inputSchema: { type: 'object' as const },
          })),
        }),
        callTool: async ({ name }) => {
          calls.push(name)
          return { content: [{ type: 'text' as const, text: '{"id":"product-1","price":250000}' }] }
        },
        close: async () => {},
      }),
    }
  )
  const client = new Client({ name: 'filtered-fixture', version: '1' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.store}` } },
      })
    )
    const listed = await client.listTools()
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ['get_record', 'list_records']
    )
    const evidence = await client.callTool({ name: 'get_record', arguments: { id: 'product-1' } })
    assert.include(JSON.stringify(evidence), '250000')
    const denied = await client.callTool({ name: 'delete_record', arguments: { id: 'product-1' } })
    assert.isTrue(denied.isError)
    assert.deepEqual(calls, ['get_record'])
    const details = events.find((event) => event.key === 'analysis:mcp-tools:store')?.detail as any
    assert.equal(details.toolsBefore, 3)
    assert.equal(details.tools, 2)
    assert.isAbove(details.savedTokens, 0)
  } finally {
    await client.close()
    await bridge.close()
  }
})

test('local history capability is ephemeral and cannot connect to a configured impostor', async ({
  assert,
}) => {
  let calls = 0
  const bridge = await startMcpCacheBridge(
    [
      {
        slug: 'conversation_history',
        url: 'https://impostor.invalid',
        enabled: true,
        authenticated: true,
      },
    ],
    {},
    undefined,
    'analysis',
    {
      connect: async () => {
        throw new Error('Network must not be used')
      },
      history: {
        listTools: async () => ({
          tools: [{ name: 'read_conversation_history', inputSchema: { type: 'object' as const } }],
        }),
        callTool: async () => {
          calls++
          return { content: [{ type: 'text' as const, text: '{"messages":[]}' }] }
        },
        close: async () => {},
      },
    }
  )
  const client = new Client({ name: 'history-fixture', version: '1' })
  try {
    assert.lengthOf(bridge.connections, 1)
    assert.match(bridge.connections[0].url, /^http:\/\/127\.0\.0\.1:/)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.conversation_history}` } },
      })
    )
    const listed = await client.listTools()
    assert.equal(listed.tools[0].name, 'read_conversation_history')
    await client.callTool({ name: 'read_conversation_history', arguments: {} })
    await client.callTool({ name: 'read_conversation_history', arguments: {} })
    assert.equal(calls, 2) // history stays live, no cached conversation output
  } finally {
    await client.close()
    await bridge.close()
  }
})

test('MCP HTTP bridge preserves tool results, caches exact reads across runs/providers and rejects unauthorized requests', async ({
  assert,
}) => {
  const entries = new Map<string, CacheEntry>()
  const cache = () =>
    new EvidenceCache({
      get: async (key) => entries.get(key) || null,
      put: async (key, value) => {
        entries.set(key, value)
      },
    })
  const events: TraceEvent[] = []
  let calls = 0
  let closes = 0
  const connection = {
    slug: 'orion',
    url: 'https://fixture.invalid/mcp',
    enabled: true,
    authenticated: true,
  }
  const connect = async () =>
    ({
      getInstructions: () => 'Upstream instructions',
      getServerCapabilities: () => ({ tools: {}, resources: {}, prompts: {} }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      readResource: async () => ({ contents: [{ uri: 'fixture://data', text: 'live resource' }] }),
      listPrompts: async () => ({ prompts: [] }),
      getPrompt: async () => ({ messages: [] }),
      listTools: async () => ({
        tools: ['check_shipping_rates', 'track_awb'].map((name) => ({
          name,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      }),
      callTool: async ({ name }: { name: string }) => {
        calls++
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                name === 'check_shipping_rates'
                  ? { prices: [{ service: 'YES', price: 9000 }] }
                  : { status: 'pending' }
              ),
            },
          ],
        }
      },
      close: async () => {
        closes++
      },
    }) as any
  for (const [index, token] of ['identity-A', 'identity-A', 'identity-B'].entries()) {
    const bridge = await startMcpCacheBridge(
      [connection],
      { orion: token },
      (event) => events.push(event),
      'analysis',
      { cache: cache(), connect }
    )
    const client = new Client({
      name: index === 0 ? 'codex-fixture' : 'claude-fixture',
      version: '1',
    })
    try {
      const url = bridge.connections[0].url
      const unauthorized = await fetch(url, { method: 'POST', body: '{}' })
      assert.equal(unauthorized.status, 403)
      const crossOrigin = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bridge.tokens.orion}`,
          Origin: 'https://attacker.invalid',
        },
        body: '{}',
      })
      assert.equal(crossOrigin.status, 403)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.orion}` } },
        })
      )
      const list = await client.listTools()
      assert.equal(client.getInstructions(), 'Upstream instructions')
      const resources = await client.listResources()
      const prompts = await client.listPrompts()
      assert.deepEqual(resources.resources, [])
      assert.deepEqual(prompts.prompts, [])
      assert.equal(list.tools[0].name, 'check_shipping_rates')
      const before = calls
      const first = await client.callTool({
        name: 'check_shipping_rates',
        arguments: { destination_code: 'DEST', weight_kg: 1 },
      })
      const second = await client.callTool({
        name: 'check_shipping_rates',
        arguments: { weight_kg: 1, destination_code: 'DEST' },
      })
      assert.deepEqual(first, second)
      assert.equal(calls - before, index === 1 ? 0 : 1)
      await client.callTool({
        name: 'check_shipping_rates',
        arguments: { destination_code: 'DEST', weight_kg: 2 },
      })
      await client.callTool({
        name: 'check_shipping_rates',
        arguments: { destination_code: 'OTHER', weight_kg: 1 },
      })
      const trackingStart = calls
      await client.callTool({ name: 'track_awb', arguments: { awb: 'fixture' } })
      await client.callTool({ name: 'track_awb', arguments: { awb: 'fixture' } })
      assert.equal(calls - trackingStart, 2)
    } finally {
      await client.close()
      await bridge.close()
    }
  }
  assert.equal(closes, 3)
  assert.isTrue(events.some((event) => (event.detail as any)?.cache?.status === 'hit'))
  assert.isTrue(events.some((event) => (event.detail as any)?.cache?.status === 'miss'))
  assert.isTrue(events.some((event) => (event.detail as any)?.cache?.status === 'bypass'))
  assert.notInclude(JSON.stringify([...entries, events]), 'identity-A')
})
