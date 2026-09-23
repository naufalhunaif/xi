import { test } from '@japa/runner'
import {
  buildCompactReplyPlan,
  policySourceHash,
  matchesCompiledSources,
  compactReplySchema,
  planCompactReply,
  CompactContextIncomplete,
  replyOutputSchema,
} from '#services/compact_reply_policy'
import {
  createDeferredBusinessTools,
  deferredReadAllowed,
  businessResultForModel,
} from '#services/deferred_business_tools'
import { needsBusinessVerification } from '#services/skill_runtime_service'
import { startDeferredMcpBridge } from '#services/deferred_business_tools'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { EvidenceCache } from '#services/evidence_cache'

const source = {
  name: 'fixture-policy',
  content: '# Original\nDo not guess.\n## Refund\nOnly a human may refund.\n',
}
const hashes = { [source.name]: [policySourceHash(source.content)] }
const sections = {
  'Core': 'CORE',
  'Transactions': 'TRANSACTION_RULES',
  'Custom': 'CUSTOM_INTENT_RULES',
  'Shipping': 'SHIPPING_RULES',
  'Visual': 'VISUAL_RULES',
  'Special terms': 'Read the source.',
}
const schema = {
  properties: {
    cartIntent: {
      description: 'Original cart contract',
      type: 'object',
      required: ['action'],
      properties: { action: { enum: ['sync'] } },
    },
    approvalWait: {},
    businessMedia: {},
    customSizeQuestion: {},
    checkoutContinuity: {},
    images: { description: 'Use a verified source image URL.' },
  },
}
const plan = () =>
  buildCompactReplyPlan(
    [source],
    hashes,
    sections,
    'hello',
    { runtimeRules: 'APP_RULES' },
    false,
    schema
  )!
const data = (value: any) => JSON.parse(value.content[0].text)

test('color and price modules follow context without loading for every acknowledgement', ({
  assert,
}) => {
  const available = { ...sections, Catalog: 'COLOR_AND_INTERNAL_PRICE_REVIEW' }
  for (const text of ['Putih gading ada?', 'BW?', 'Harga custom model ini?', '𝐁𝐖']) {
    const selected = buildCompactReplyPlan([source], hashes, available, text, {}, false, schema)!
    assert.include(selected.skills[0].content, 'COLOR_AND_INTERNAL_PRICE_REVIEW')
  }
  const simple = buildCompactReplyPlan([source], hashes, available, 'Halo', {}, false, schema)!
  assert.notInclude(simple.skills[0].content, 'COLOR_AND_INTERNAL_PRICE_REVIEW')
})

test('custom rules follow context or action contracts without loading them for ordinary checkout', async ({
  assert,
}) => {
  const ordinary = buildCompactReplyPlan(
    [source],
    hashes,
    sections,
    'Sama',
    { hasCart: true, lastQuestion: 'Nama penerima?' },
    false,
    schema
  )!
  assert.notInclude(ordinary.skills[0].content, 'CUSTOM_INTENT_RULES')
  for (const context of [
    { lastQuestion: 'Mau dicek kemungkinan custom?' },
    {
      savedCart: {
        items: [{ size: 'custom', modelType: 'catalog' }],
        recipient: { address: '' },
        shipping: { service: '', cost: null },
      },
    },
    {
      savedCart: {
        items: [
          { size: 'S', modelType: 'catalog', modelConsentEvidence: { fingerprint: 'fixture' } },
        ],
        recipient: { address: '' },
        shipping: { service: '', cost: null },
      },
    },
  ]) {
    const scoped = buildCompactReplyPlan([source], hashes, sections, 'Iya', context, false, schema)!
    assert.include(scoped.skills[0].content, 'CUSTOM_INTENT_RULES')
    assert.notInclude(scoped.skills[0].content, 'VISUAL_RULES')
  }
  // Unrecognized wording is not a bypass: emitting an action still requires its contract.
  const phase = ordinary.phase()
  assert.throws(
    () => phase.assertCovered(JSON.stringify({ cartIntent: { action: 'sync' } })),
    CompactContextIncomplete
  )
  const first = data(
    await phase.tools.callTool({
      name: 'read_reply_contract',
      arguments: { fields: ['cartIntent'] },
    })
  )
  assert.include(first.policy, 'CUSTOM_INTENT_RULES')
  const next = data(
    await phase.tools.callTool({
      name: 'read_reply_contract',
      arguments: { fields: ['customSizeQuestion'] },
    })
  )
  assert.notInclude(next.policy, 'CUSTOM_INTENT_RULES')
})

test('compilation refuses missing, unknown, duplicate and edited policies including frontmatter', async ({
  assert,
}) => {
  assert.isTrue(matchesCompiledSources([source], hashes))
  for (const skills of [
    [],
    [source, source],
    [{ ...source, content: source.content + 'New instruction' }],
    [{ ...source, content: '---\ndescription: New instruction\n---\n' + source.content }],
    [source, { name: 'new', content: 'new' }],
  ]) {
    assert.isFalse(matchesCompiledSources(skills, hashes))
    assert.isNull(buildCompactReplyPlan(skills, hashes, sections, '', undefined, false, schema))
  }
  assert.isNull(await planCompactReply([source], '', undefined, false, schema))
})

test('compact schema preserves structural validation while contracts remain retrievable', async ({
  assert,
}) => {
  assert.deepEqual(
    compactReplySchema({
      description: 'schema prose',
      properties: { description: { type: 'string', description: 'field prose' } },
      required: ['description'],
      const: { description: 'literal value' },
    }),
    {
      properties: { description: { type: 'string' } },
      required: ['description'],
      const: { description: 'literal value' },
    }
  )
  const compact = compactReplySchema(schema)
  assert.deepEqual(compact, {
    properties: {
      ...schema.properties,
      images: {},
      cartIntent: {
        type: 'object',
        required: ['action'],
        properties: { action: { enum: ['sync'] } },
      },
    },
  })
  assert.include(JSON.stringify(schema), 'Original cart contract')
  const phase = plan().phase()
  const output = JSON.stringify({ cartIntent: { action: 'sync' } })
  assert.throws(() => phase.assertCovered(output), CompactContextIncomplete)
  const response = data(
    await phase.tools.callTool({
      name: 'read_reply_contract',
      arguments: { fields: ['cartIntent'] },
    })
  )
  assert.deepEqual(response.fields.cartIntent, { $: 'Original cart contract' })
  assert.equal(response.runtime, 'APP_RULES')
  phase.assertCovered(output)
  assert.throws(() => plan().phase().assertCovered(output), CompactContextIncomplete)
  assert.isTrue(
    data(
      await phase.tools.callTool({
        name: 'read_reply_contract',
        arguments: { fields: ['cartIntent'] },
      })
    ).alreadyLoaded
  )
})

test('catalog photo delivery and its field docs do not require visual analysis or cart contracts', async ({
  assert,
}) => {
  const phase = plan().phase()
  const output = JSON.stringify({
    images: [{ url: 'https://catalog.invalid/image.jpg', caption: '' }],
    needsVisualInspection: false,
  })
  phase.assertCovered(output)
  const result = data(
    await phase.tools.callTool({ name: 'read_reply_contract', arguments: { fields: ['images'] } })
  )
  assert.deepEqual(result.fields.images, { $: 'Use a verified source image URL.' })
  assert.equal(result.runtime, '')
  assert.equal(result.policy, '')
  assert.notInclude(JSON.stringify(result), 'TRANSACTION_RULES')
  // Deferring image docs must not mark transaction contracts as read.
  assert.throws(
    () => phase.assertCovered(JSON.stringify({ cartIntent: { action: 'sync' } })),
    CompactContextIncomplete
  )
  const cart = data(
    await phase.tools.callTool({
      name: 'read_reply_contract',
      arguments: { fields: ['cartIntent'] },
    })
  )
  assert.equal(cart.runtime, 'APP_RULES')
})

test('a targeted retry loads only missing modules and preserves compact schema for visual input', ({
  assert,
}) => {
  const p = buildCompactReplyPlan(
    [source],
    hashes,
    sections,
    'hello',
    undefined,
    false,
    schema,
    false,
    [],
    ['Visual']
  )!
  assert.include(p.skills[0].content, 'VISUAL_RULES')
  assert.notInclude(p.skills[0].content, 'TRANSACTION_RULES')
  assert.notInclude(p.skills[0].content, 'SHIPPING_RULES')
  p.phase().assertCovered(JSON.stringify({ needsVisualInspection: true }))
  const base = { ...schema, required: ['cartIntent'] as const }
  const visual = { type: 'object', description: 'Actual visual contract' }
  const combined = replyOutputSchema(base, true, visual)
  assert.deepEqual(combined.required, ['cartIntent', 'visualMatch'])
  assert.deepEqual((combined.properties as Record<string, unknown>).visualMatch, visual)
  assert.notInclude(JSON.stringify(combined.properties.cartIntent), 'Original cart contract')
  assert.deepEqual(
    replyOutputSchema(base, false).properties.cartIntent,
    schema.properties.cartIntent
  )
  const output = JSON.stringify({ cartIntent: { action: 'sync' }, needsVisualInspection: true })
  let missing: CompactContextIncomplete | undefined
  try {
    plan().phase().assertCovered(output)
  } catch (error) {
    assert.instanceOf(error, CompactContextIncomplete)
    missing = error as CompactContextIncomplete
  }
  assert.deepEqual(missing?.fields, ['cartIntent'])
  assert.deepEqual(missing?.modules, ['Visual'])
  const expanded = buildCompactReplyPlan(
    [source],
    hashes,
    sections,
    'hello',
    undefined,
    false,
    schema,
    false,
    missing?.fields,
    missing?.modules
  )!
  expanded.phase().assertCovered(output)
})

test('exact source retrieval is paginated, phase-local and refuses out-of-snapshot sources', async ({
  assert,
}) => {
  const p = plan(),
    phase = p.phase()
  const read = (args: any) => phase.tools.callTool({ name: 'read_business_skill', arguments: args })
  const original = await read({ skill: source.name, startLine: 1, lineCount: 100 })
  assert.equal(data(original).content, source.content)
  assert.equal(data(original).nextLine, null)
  const query = data(await read({ skill: source.name, query: 'Refund' }))
  assert.equal(query.matches[0].line, 3)
  assert.isTrue((await read({ skill: 'other-room' })).isError)
  assert.isTrue((await read({ skill: source.name, startLine: -1 })).isError)
  assert.throws(
    () => phase.assertCovered(JSON.stringify({ needsVisualInspection: true })),
    CompactContextIncomplete
  )
  assert.include(data(await read({ modules: ['Visual'] })).policy, 'VISUAL_RULES')
  phase.assertCovered(JSON.stringify({ needsVisualInspection: true }))
  assert.throws(
    () => p.phase().assertCovered(JSON.stringify({ visualMatch: { status: 'matched' } })),
    CompactContextIncomplete
  )
})

test('oversized source requests return a bounded page and explicit continuation without losing lines', async ({
  assert,
}) => {
  const source = {
    name: 'waiting-notices',
    content: Array.from({ length: 180 }, (_, i) => `Line ${i + 1}`).join('\n'),
  }
  const p = buildCompactReplyPlan(
    [source],
    { [source.name]: [policySourceHash(source.content)] },
    sections,
    '',
    undefined,
    false,
    schema
  )!
  const read = (args: any) =>
    p
      .phase()
      .tools.callTool({ name: 'read_business_skill', arguments: { skill: source.name, ...args } })
  const page = await read({ startLine: 1, lineCount: 180 })
  assert.isFalse(page.isError)
  assert.equal(data(page).pageLimit, 100)
  assert.equal(data(page).requestedLineCount, 180)
  assert.equal(data(page).nextLine, 101)
  const tail = data(await read({ startLine: data(page).nextLine, lineCount: 180 }))
  assert.isNull(tail.nextLine)
  assert.equal(`${data(page).content}\n${tail.content}`, source.content)
  for (const lineCount of [0, -1, 1.5, '180'])
    assert.isTrue((await read({ startLine: 1, lineCount })).isError)
})

const connection = (slug: string) => ({
  slug,
  url: `https://${slug}.invalid/mcp`,
  enabled: true,
  authenticated: true,
})
const tool = (name: string, extra = {}) => ({
  name,
  inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } } },
  annotations: { readOnlyHint: true },
  ...extra,
})
function gateway() {
  const upstreamCalls: any[] = [],
    connects: string[] = []
  const gateway = createDeferredBusinessTools(
    [connection('catalog'), connection('other')],
    async (c) => {
      connects.push(c.slug)
      return {
        async listTools() {
          return {
            tools: [
              tool('get_product'),
              tool('list_products'),
              tool('delete_record'),
              tool('get_unsafe', { annotations: { readOnlyHint: false } }),
            ],
          }
        },
        async callTool(args: any) {
          upstreamCalls.push([c.slug, args])
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  id: args.arguments.id,
                  name: 'Synthetic product',
                  price: 123,
                }),
              },
            ],
            structuredContent: { id: args.arguments.id, price: 123 },
          }
        },
        async close() {},
      }
    }
  )
  const invoke = async (name: string, args: any) =>
    gateway.tools.callTool({ name, arguments: args })
  return { ...gateway, invoke, upstreamCalls, connects }
}

test('deferred tools load no upstream until discovery and never expose a write', async ({
  assert,
}) => {
  const g = gateway()
  assert.lengthOf((await g.tools.listTools()).tools, 2)
  assert.lengthOf(g.connects, 0)
  const index = data(await g.invoke('find_business_tools', { server: 'catalog' }))
  assert.deepEqual(
    index.matches.map((t: any) => t.name),
    ['get_product', 'list_products']
  )
  assert.deepEqual(g.connects, ['catalog'])
  assert.isTrue(
    (await g.invoke('find_business_tools', { server: 'catalog', names: ['delete_record'] })).isError
  )
  assert.isFalse(deferredReadAllowed(connection('orion'), tool('create_awb')))
  assert.isFalse(deferredReadAllowed(connection('orion'), tool('get_unlisted')))
  assert.isFalse(
    deferredReadAllowed(
      connection('catalog'),
      tool('get_bad', { annotations: { destructiveHint: true } })
    )
  )
})

test('failed discovery connection can be retried without retaining the rejected client', async ({
  assert,
}) => {
  let attempts = 0
  const g = createDeferredBusinessTools([connection('catalog')], async () => {
    if (++attempts === 1) throw new Error('Temporary connection failure')
    return {
      listTools: async () => ({ tools: [tool('get_product')] }),
      callTool: async () => ({ content: [] }),
      close: async () => {},
    }
  })
  const discover = () =>
    g.tools.callTool({
      name: 'find_business_tools',
      arguments: { server: 'catalog', names: ['get_product'] },
    })
  await assert.rejects(discover, 'Temporary connection failure')
  assert.equal(data(await discover()).tools[0].name, 'get_product')
  assert.equal(attempts, 2)
  assert.lengthOf(g.calls, 0)
  await g.tools.close()
})

test('discovery batches schemas across sources without redundant name queries or data reads', async ({
  assert,
}) => {
  const g = gateway()
  const response = data(
    await g.invoke('find_business_tools', {
      requests: [
        { server: 'catalog', names: ['list_products', 'get_product'] },
        { server: 'other', names: ['get_product'] },
      ],
    })
  )
  assert.lengthOf(response.sources, 2)
  assert.lengthOf(response.sources[0].tools, 2)
  assert.lengthOf(response.sources[1].tools, 1)
  assert.lengthOf(g.upstreamCalls, 0)
  const invalid = gateway()
  assert.isTrue(
    (
      await invalid.invoke('find_business_tools', {
        requests: [
          { server: 'catalog', names: ['get_product'] },
          { server: 'missing', names: ['get_product'] },
        ],
      })
    ).isError
  )
  assert.lengthOf(invalid.connects, 0)
})

test('model payload deduplicates identical JSON while retaining distinct text, images and original receipts', ({
  assert,
}) => {
  const original = {
    structuredContent: { product: { id: 'P', sizes: ['S', 'M'] }, price: 485000 },
    content: [
      { type: 'text', text: '{"price":485000,"product":{"sizes":["S","M"],"id":"P"}}' },
      { type: 'text', text: 'Only size S is in stock.' },
      { type: 'text', text: '{"price":500000}' },
      { type: 'image', data: 'SYNTHETIC', mimeType: 'image/png' },
    ],
  }
  const reduced = businessResultForModel(original)
  assert.deepEqual(reduced.structuredContent, original.structuredContent)
  assert.deepEqual(reduced.content, original.content.slice(1))
  assert.lengthOf(original.content, 4)
  const plain = { content: original.content }
  assert.strictEqual(businessResultForModel(plain), plain)
})

test('discovery is not business evidence, invalid batches do not execute, canonical read receipts survive', async ({
  assert,
}) => {
  const g = gateway(),
    call = { server: 'catalog', tool: 'get_product', argumentsJson: '{"id":"A"}' }
  assert.isTrue((await g.invoke('read_business_data', { calls: [call] })).isError)
  await g.invoke('find_business_tools', { server: 'catalog', names: ['get_product'] })
  assert.lengthOf(g.calls, 0)
  assert.isTrue(
    needsBusinessVerification(
      {
        text: JSON.stringify({ decision: 'reply', business_lookup_required: true }),
        toolCalls: g.calls,
      },
      [connection('catalog')]
    )
  )
  assert.isTrue(
    (await g.invoke('read_business_data', { calls: [call, { ...call, tool: 'delete_record' }] }))
      .isError
  )
  assert.lengthOf(g.upstreamCalls, 0)
  await g.invoke('read_business_data', { calls: [call] })
  assert.equal(g.calls[0].server, 'business_catalog')
  assert.equal(g.calls[0].tool, 'get_product')
  assert.equal(g.calls[0].result.structured_content.price, 123)
  assert.isFalse(
    needsBusinessVerification(
      {
        text: JSON.stringify({ decision: 'reply', business_lookup_required: true }),
        toolCalls: g.calls,
      },
      [connection('catalog')]
    )
  )
})

test('duplicate reads are single-flight, data is reusable, arguments and phase isolate results', async ({
  assert,
}) => {
  const g = gateway(),
    call = { server: 'catalog', tool: 'get_product', argumentsJson: '{"id":"A","size":"S"}' }
  await g.invoke('find_business_tools', { server: 'catalog', names: ['get_product'] })
  const first = data(
    await g.invoke('read_business_data', {
      calls: [call, { ...call, argumentsJson: '{"size":"S","id":"A"}' }],
    })
  )
  assert.lengthOf(g.upstreamCalls, 1)
  assert.isDefined(first[0].result)
  assert.isTrue(first[1].alreadyRead)
  assert.isDefined(
    data(await g.invoke('read_business_data', { calls: [{ ...call, repeat: true }] }))[0].result
  )
  await g.invoke('read_business_data', { calls: [{ ...call, argumentsJson: '{"id":"B"}' }] })
  assert.lengthOf(g.upstreamCalls, 2)
  const another = gateway()
  assert.isTrue((await another.invoke('read_business_data', { calls: [call] })).isError)
  assert.lengthOf(another.calls, 0)
})

test('HTTP gateway retains canonical shipping evidence and counts only visible schemas', async ({
  assert,
}) => {
  const events: any[] = [],
    entries = new Map<string, any>()
  let reads = 0
  const bridge = await startDeferredMcpBridge(
    [connection('orion')],
    { orion: 'PRIVATE_UPSTREAM_TOKEN' },
    (event) => events.push(event),
    'fixture',
    {
      cache: new EvidenceCache({
        get: async (key) => entries.get(key) || null,
        put: async (key, value) => {
          entries.set(key, value)
        },
      }),
      connect: async () => ({
        listTools: async () => ({ tools: [tool('check_shipping_rates')] }),
        callTool: async () => {
          reads++
          return {
            content: [{ type: 'text' as const, text: '{"rates":[{"service":"REG","cost":8000}]}' }],
          }
        },
        close: async () => {},
      }),
    }
  )
  const client = new Client({ name: 'compact-http-fixture', version: '1' })
  try {
    assert.lengthOf(bridge.connections, 1)
    assert.equal(bridge.connections[0].slug, 'business_data')
    assert.notInclude(JSON.stringify(bridge.connections), 'orion.invalid')
    assert.notInclude(JSON.stringify(bridge.tokens), 'PRIVATE_UPSTREAM_TOKEN')
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.connections[0].url), {
        requestInit: { headers: { Authorization: `Bearer ${bridge.tokens.business_data}` } },
      })
    )
    assert.lengthOf((await client.listTools()).tools, 2)
    assert.equal(reads, 0)
    await client.callTool({
      name: 'find_business_tools',
      arguments: { server: 'orion', names: ['check_shipping_rates'] },
    })
    const response = await client.callTool({
      name: 'read_business_data',
      arguments: {
        calls: [
          {
            server: 'orion',
            tool: 'check_shipping_rates',
            argumentsJson: '{"destination_code":"FIXTURE","weight_kg":1}',
          },
        ],
      },
    })
    assert.isFalse(Boolean(response.isError))
    assert.equal(reads, 1)
    assert.equal(bridge.canonicalCalls[0].server, 'business_orion')
    assert.equal(bridge.canonicalCalls[0].tool, 'check_shipping_rates')
    assert.include(JSON.stringify(bridge.canonicalCalls[0].result), '8000')
    const upstream = events.find((e) => e.key === 'fixture:upstream:mcp-tools:orion')
    assert.equal(upstream.detail.estimatedTokens, 0)
    assert.isFalse(upstream.detail.modelVisible)
    assert.isAbove(
      events.find((e) => e.key === 'fixture:mcp-tools:business_data').detail.estimatedTokens,
      0
    )
    const readsFinished = events.filter(
      (e) => e.key.includes(':mcp-cache:') && e.status === 'completed'
    )
    assert.lengthOf(readsFinished, 3)
    assert.equal(new Set(readsFinished.map((e) => e.key)).size, 3)
    const upstreamRead = readsFinished.find((e) => e.detail.tool === 'check_shipping_rates')
    assert.isFalse(upstreamRead.detail.modelVisible)
    assert.equal(upstreamRead.detail.estimatedTokens, 0)
    assert.isAbove(upstreamRead.detail.upstreamEstimatedTokens, 0)
  } finally {
    await client.close()
    await bridge.close()
  }
})
