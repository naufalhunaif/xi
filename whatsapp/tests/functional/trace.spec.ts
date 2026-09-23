import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import {
  redactTrace,
  traceProviderEvents,
  startTrace,
  readTrace,
  type TraceEvent,
} from '#services/trace_service'

test.group('AI process audit', () => {
  test('captures MCP lifecycle for both providers but never raw reasoning', ({ assert }) => {
    const events: TraceEvent[] = []
    const observe = traceProviderEvents((event) => events.push(event), 'analysis')
    observe('chatgpt', {
      type: 'item.completed',
      item: { type: 'reasoning', text: 'PRIVATE_THOUGHT' },
    })
    observe('claude', {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: 'PRIVATE_THOUGHT' }] },
    })
    observe('chatgpt', {
      type: 'item.started',
      item: {
        id: 'a',
        type: 'mcp_tool_call',
        server: 'business_store',
        tool: 'get_product',
        arguments: { id: 12 },
      },
    })
    observe('chatgpt', {
      type: 'item.completed',
      item: {
        id: 'a',
        type: 'mcp_tool_call',
        server: 'business_store',
        tool: 'get_product',
        result: { content: [{ type: 'text', text: '{"data":{"name":"Kemeja"}}' }] },
      },
    })
    observe('claude', {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'b', name: 'mcp__store__get_product', input: { id: 12 } },
        ],
      },
    })
    observe('claude', {
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'b', content: 'Tidak ditemukan', is_error: true },
        ],
      },
    })
    assert.deepEqual(
      events.map((event) => event.status),
      ['running', 'completed', 'running', 'failed']
    )
    assert.equal(events[0].key, events[1].key)
    assert.notInclude(JSON.stringify(events), 'PRIVATE_THOUGHT')
  })

  test('redacts nested secrets and signed URLs while preserving business data', ({ assert }) => {
    const safe = JSON.stringify(
      redactTrace({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data: { name: 'Kemeja', price: 100000 },
              access_token: 'secret-value',
            }),
          },
        ],
        authorization: 'Bearer secret-value',
        image: 'https://user:secret@example.com/image?signature=private',
        binary: { type: 'image', data: 'sensitive-base64' },
      })
    )
    assert.include(safe, 'Kemeja')
    assert.include(safe, '100000')
    for (const secret of ['secret-value', 'user:secret', 'signature=private', 'sensitive-base64'])
      assert.notInclude(safe, secret)
  })

  test('persists ordered stages, links replies, scopes rooms, and marks stale runs', async ({
    assert,
    client,
  }) => {
    await initializeDatabase()
    await db.beginGlobalTransaction()
    const jid = 'audit-test@lid'
    try {
      const trace = await startTrace(jid, { text: 'Harga?', skills: ['cs'], provider: 'chatgpt' })
      trace.emit({
        key: 'tool',
        label: 'Store · get_product',
        status: 'running',
        detail: { id: 12 },
      })
      trace.emit({
        key: 'tool',
        label: 'Store · get_product',
        status: 'completed',
        detail: { price: 100000 },
      })
      await trace.finish(
        'completed',
        { decision: 'reply', summary: 'Harga dari Store.' },
        'audit-reply'
      )
      const result = await readTrace(jid, trace.id)
      assert.equal(result?.status, 'completed')
      assert.equal(result?.messageId, 'audit-reply')
      assert.lengthOf(result?.steps, 1)
      assert.equal(result?.steps[0].status, 'completed')
      assert.isNull(await readTrace('different@lid', trace.id))
      const guest = await client.get(`/api/ai/trace?jid=${jid}`).redirects(0)
      guest.assertStatus(302)
      const account = {
        account: {
          sub: 'a'.repeat(64),
          sessionToken: 'b'.repeat(43),
          checkedAt: Date.now(),
          name: 'Pemilik',
          username: 'owner',
        },
      }
      const response = await client
        .get(`/api/ai/trace?jid=${jid}&id=${trace.id}`)
        .withSession(account)
      response.assertStatus(200)
      response.assertHeader('cache-control', 'no-store')
      const other = await client
        .get(`/api/ai/trace?jid=different@lid&id=${trace.id}`)
        .withSession(account)
      other.assertStatus(404)
      await db
        .from('whatsapp_ai_traces')
        .where('id', trace.id)
        .update({ status: 'running', updated_at: new Date(Date.now() - 300_000) })
      const stale = await readTrace(jid, trace.id)
      assert.equal(stale?.status, 'interrupted')
    } finally {
      await db.rollbackGlobalTransaction()
    }
  })
})
