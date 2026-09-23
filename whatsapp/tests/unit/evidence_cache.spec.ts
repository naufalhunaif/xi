import { test } from '@japa/runner'
import {
  EvidenceCache,
  createTurnEvidenceCache,
  evidenceKey,
  type CacheEntry,
  type EvidenceStore,
} from '#services/evidence_cache'
import {
  mcpCacheTtl,
  cacheableMcpResult,
  mcpTurnCacheTtl,
  cacheableTurnMcpResult,
} from '#services/mcp_cache_policy'
import { inWorkspace } from '#services/workspace_context'
import { shippingEvidence, matchShippingQuote } from '#services/shipping_evidence_service'

export function memoryStore() {
  const entries = new Map<string, CacheEntry>()
  const store: EvidenceStore = {
    get: async (key) => entries.get(key) || null,
    put: async (key, value) => {
      entries.set(key, value)
    },
  }
  return { store, entries }
}
const args = { destination_code: 'DEST-A', weight_kg: 1 }
const result = {
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        prices: [
          { service: 'REG23', name: 'REG', price: 8000 },
          { service: 'YES23', name: 'YES', price: 9000 },
        ],
      }),
    },
  ],
}

test.group('Verified evidence cache', () => {
  test('temporary catalogue cache is narrow and rejects negative, malformed or failed evidence', ({
    assert,
  }) => {
    const valid = (data: any) => ({ structuredContent: data })
    assert.equal(mcpTurnCacheTtl('list_products', { query: 'navy' }), 60000)
    assert.equal(mcpTurnCacheTtl('get_product', { id: 'p1' }), 60000)
    assert.equal(mcpTurnCacheTtl('get_record', { resource: 'products', id: 'p1' }), 60000)
    for (const tool of [
      'verify_payment',
      'list_orders',
      'track_awb',
      'create_order',
      'unknown',
      'get_record',
      'list_records',
    ])
      assert.equal(mcpTurnCacheTtl(tool, { id: 'p1' }), 0)
    assert.equal(mcpTurnCacheTtl('get_product', {}), 0)
    for (const data of [
      { rows: [] },
      { rows: ['bad'] },
      { error: 'down', rows: [{ id: 'p1' }] },
      { ok: false, rows: [{ id: 'p1' }] },
    ])
      assert.isFalse(cacheableTurnMcpResult('list_products', { query: 'navy' }, valid(data)))
    for (const key of ['rows', 'products', 'data'])
      assert.isTrue(
        cacheableTurnMcpResult(
          'list_products',
          { query: 'navy' },
          valid({ [key]: [{ id: 'p1', name: 'Navy' }] })
        )
      )
    assert.isTrue(
      cacheableTurnMcpResult(
        'get_product',
        { id: 'p1' },
        valid({ id: 'p1', name: 'Navy', price: 10 })
      )
    )
    assert.isFalse(
      cacheableTurnMcpResult('get_product', { id: 'p1' }, valid({ id: 'p1', success: false }))
    )
    assert.isFalse(
      cacheableTurnMcpResult('get_product', { id: 'p1' }, { ...valid({ id: 'p1' }), isError: true })
    )
    assert.isFalse(
      cacheableMcpResult('list_products', {}, valid({ rows: [{ id: 'p1' }], ok: false }))
    )
  })
  test('temporary entries preserve originals, stay bounded and never return expired results on failure', async ({
    assert,
  }) => {
    let now = 1000
    const cache = createTurnEvidenceCache(() => now)
    let calls = 0
    const input = {
      key: 'p1',
      ttl: 60_000,
      fetch: async () => {
        calls++
        return { id: 'p1', price: 100 }
      },
      valid: () => true,
    }
    const first = await cache.readThrough(input)
    first.value.price = 999
    const cached = await cache.readThrough(input)
    assert.equal(cached.value.price, 100)
    for (let index = 0; index < 64; index++) await cache.readThrough({ ...input, key: index })
    await cache.readThrough(input)
    assert.equal(calls, 66)
    now += 60_000
    await assert.rejects(
      () =>
        cache.readThrough({
          ...input,
          fetch: async () => {
            throw new Error('upstream down')
          },
        }),
      /upstream down/
    )
  })
  test('stable keys keep all inputs and types, not just weight', ({ assert }) => {
    assert.equal(evidenceKey(args), evidenceKey({ weight_kg: 1, destination_code: 'DEST-A' }))
    for (const changed of [
      { ...args, weight_kg: 2 },
      { ...args, destination_code: 'DEST-B' },
      { ...args, origin: 'B' },
      { ...args, weight_kg: '1' },
      { ...args, length: 20 },
    ])
      assert.notEqual(evidenceKey(args), evidenceKey(changed))
  })
  test('reuses all rates until expiry; a different service can select the same result without a remote call', async ({
    assert,
  }) => {
    const { store } = memoryStore()
    let now = 100
    let calls = 0
    const cache = new EvidenceCache(store, () => now)
    const input = {
      key: ['orion', args],
      ttl: 50,
      fetch: async () => {
        calls++
        return result
      },
      valid: (value: any) => cacheableMcpResult('check_shipping_rates', args, value),
    }
    const first = await cache.readThrough(input)
    const second = await new EvidenceCache(store, () => now).readThrough(input)
    assert.equal(calls, 1)
    assert.equal(first.report.source, 'mcp')
    assert.equal(second.report.source, 'cache')
    assert.equal(second.report.expiresAt, 150)
    const evidence = shippingEvidence([
      { tool: 'check_shipping_rates', arguments: args, result: second.value },
    ])
    assert.exists(matchShippingQuote(evidence, 'REG', 8000))
    assert.exists(matchShippingQuote(evidence, 'YES', 9000))
    now = 150
    const expired = await cache.readThrough(input)
    assert.equal(expired.report.status, 'expired')
    assert.equal(calls, 2)
  })
  test('scopes persisted values by WhatsApp workspace; source identity and schema belong in key', async ({
    assert,
  }) => {
    const { store } = memoryStore()
    let calls = 0
    const cache = new EvidenceCache(store)
    const input = {
      key: ['url-A', 'auth-A', 'schema-A', args],
      ttl: 1000,
      fetch: async () => ++calls,
      valid: () => true,
    }
    for (const id of [2, 3, 2])
      await inWorkspace({ id, prefix: `w${id}_`, phone: null, version: '' }, () =>
        cache.readThrough(input)
      )
    assert.equal(calls, 2)
    for (const key of [
      ['url-B', 'auth-A', 'schema-A', args],
      ['url-A', 'auth-B', 'schema-A', args],
      ['url-A', 'auth-A', 'schema-B', args],
    ])
      await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, () =>
        cache.readThrough({ ...input, key })
      )
    assert.equal(calls, 5)
  })
  test('does not cache writes, stock, payment, AWB tracking or unknown tools', ({ assert }) => {
    for (const tool of [
      'create_awb',
      'track_awb',
      'list_records',
      'get_product',
      'verify_payment',
      'delete_record',
      'unknown',
    ])
      assert.equal(mcpCacheTtl(tool, args), 0)
    assert.equal(mcpCacheTtl('check_shipping_rates', args), 900000)
    assert.equal(mcpCacheTtl('check_shipping_rates', { weight_kg: 1 }), 0)
    assert.equal(mcpCacheTtl('fit_advisor', { type: 'pants', height: 168, weight: 84 }), 86400000)
    assert.equal(mcpCacheTtl('search_destinations', { query: 'Cirebon' }), 86400000)
  })
  test('rejects empty, failed, malformed and disguised failed results', ({ assert }) => {
    for (const value of [
      { isError: true, ...result },
      { structuredContent: { ok: false, prices: [{ service: 'YES', price: 9000 }] } },
      { content: [{ type: 'text', text: 'Error' }] },
      { content: [] },
      null,
    ])
      assert.isFalse(cacheableMcpResult('check_shipping_rates', args, value))
    assert.isFalse(
      cacheableMcpResult('search_destinations', { query: 'A' }, { structuredContent: { data: [] } })
    )
    assert.isTrue(
      cacheableMcpResult(
        'fit_advisor',
        { type: 'pants' },
        { structuredContent: { ok: true, data: { recommended_pants_no: 34 } } }
      )
    )
  })
  test('cache failure falls back live, not stale; tool exceptions propagate and invalid results are not saved', async ({
    assert,
  }) => {
    const { store, entries } = memoryStore()
    let calls = 0
    let fail = false
    let now = 1
    const cache = new EvidenceCache(store, () => now)
    const input = {
      key: 'failure',
      ttl: 10,
      fetch: async () => {
        calls++
        if (fail) throw new Error('upstream down')
        return result
      },
      valid: () => true,
    }
    await cache.readThrough(input)
    now = 20
    fail = true
    await assert.rejects(() => cache.readThrough(input), /upstream down/)
    assert.equal(calls, 2)
    const broken = new EvidenceCache({
      get: async () => {
        throw new Error('DB down')
      },
      put: async () => {
        throw new Error('DB down')
      },
    })
    fail = false
    const unavailable = await broken.readThrough(input)
    assert.equal(unavailable.report.status, 'unavailable')
    const count = entries.size
    await cache.readThrough({ ...input, key: 'bad', valid: () => false })
    assert.equal(entries.size, count)
  })
  test('deduplicates concurrent identical reads without extending persisted expiry', async ({
    assert,
  }) => {
    const { store } = memoryStore()
    const cache = new EvidenceCache(store)
    let calls = 0
    const input = {
      key: 'parallel',
      ttl: 1000,
      fetch: async () => {
        calls++
        return result
      },
      valid: () => true,
    }
    const results = await Promise.all([cache.readThrough(input), cache.readThrough(input)])
    assert.equal(calls, 1)
    assert.equal(results[1].report.status, 'coalesced')
    assert.equal(results[0].report.expiresAt, results[1].report.expiresAt)
  })
})
