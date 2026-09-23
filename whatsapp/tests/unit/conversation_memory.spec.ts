import { test } from '@japa/runner'
import { parseMemoryFacts, selectMemoryContext, memoryDigest } from '#services/conversation_memory'
import { needsBusinessVerification } from '#services/skill_runtime_service'

test('memory parser bounds optional metadata and does not grant business verification', ({
  assert,
}) => {
  const fact = { key: 'height', topic: 'measurements', value: '168 cm', messageIds: ['original'] }
  assert.deepEqual(parseMemoryFacts([fact]), [fact])
  for (const value of [
    null,
    {},
    Array(17).fill(fact),
    [{ ...fact, messageIds: [] }],
    [{ ...fact, topic: 'payment_approved' }],
    [{ ...fact, value: 'a'.repeat(601) }],
  ])
    assert.deepEqual(parseMemoryFacts(value), [])
  assert.notEqual(
    memoryDigest({ body: '168', message_id: '1' }),
    memoryDigest({ body: '170', message_id: '1' })
  )
  assert.isTrue(
    needsBusinessVerification(
      {
        text: JSON.stringify({ decision: 'reply', business_lookup_required: true }),
        toolCalls: [{ server: 'business_conversation_history', tool: 'read_conversation_history' }],
      },
      [{ slug: 'store', enabled: true, authenticated: true }]
    )
  )
})

test('context only deduplicates cited older customer text; recaps, recent turns and unknown context stay', ({
  assert,
}) => {
  const rows = Array.from({ length: 40 }, (_, i) => ({
    message_id: String(i),
    direction: i % 2 ? 'out' : 'in',
    sender_type: i % 2 ? 'ai' : 'customer',
    reply_to_message_id: null as string | null,
  }))
  rows[39].reply_to_message_id = '0'
  const facts = [
    {
      key: 'height',
      topic: 'measurements',
      value: '168',
      sources: [
        { messageId: '0', speaker: 'customer', text: '168' },
        { messageId: '2', speaker: 'customer', text: '56' },
      ],
    },
  ]
  assert.deepEqual(selectMemoryContext(rows, [], new Set()), rows)
  const shown = selectMemoryContext(rows, facts, new Set(['2']))
  assert.deepEqual(shown, rows)
  // Removing an older source is allowed only because the exact original is retained in memoryContext.
  const isolated = [...rows]
  isolated[3] = { ...rows[3], direction: 'in', sender_type: 'customer' }
  const more = [
    ...facts,
    {
      ...facts[0],
      key: 'weight',
      sources: [{ messageId: '3', speaker: 'customer', text: 'fact' }],
    },
  ]
  const compact = selectMemoryContext(isolated, more, new Set())
  assert.isTrue(compact.length <= rows.length)
  for (const row of isolated.filter((row) => row.direction === 'out')) assert.include(compact, row)
  assert.deepEqual(compact.slice(-24), isolated.slice(-24))
})
