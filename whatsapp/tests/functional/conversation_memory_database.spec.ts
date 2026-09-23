import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { inWorkspace } from '#services/workspace_context'
import {
  readCustomerMemory,
  saveCustomerMemory,
  conversationHistoryTools,
} from '#services/conversation_memory'
import { buildTurnContext } from '#services/context_service'

test.group('Customer memory isolated database', (group) => {
  group.setup(async () => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database required')
    await initializeDatabase()
    await db.table('whatsapp_contacts').insert({ jid: 'memory-room@lid', updated_at: new Date() })
    for (const [index, row] of [
      { message_id: 'height', body: 'Tinggi saya 168 cm' },
      { message_id: 'ai', body: 'Berat 70 kg', direction: 'out', sender_type: 'ai' },
      { message_id: 'foreign', body: 'Tinggi 190 cm', jid: 'other-room@lid' },
      { message_id: 'corrected', body: 'Ralat tinggi saya 170 cm' },
      { message_id: 'future', body: 'Pesan setelah anchor' },
    ].entries())
      await db
        .table('whatsapp_messages')
        .insert({
          jid: 'memory-room@lid',
          direction: 'in',
          sender_type: 'customer',
          status: 'received',
          created_at: new Date(Date.now() - 5000 + index * 1000),
          ...row,
        })
  })
  test('persists source-bound facts, rejects AI/other room/future sources and stale corrections', async ({
    assert,
  }) => {
    const anchor = await db.from('whatsapp_messages').where('message_id', 'corrected').first()
    const fact = {
      key: 'self_height',
      topic: 'measurements',
      value: '168 cm',
      messageIds: ['height'],
    }
    assert.equal(await saveCustomerMemory('memory-room@lid', anchor.id, [fact]), 1)
    for (const id of ['ai', 'foreign', 'future', 'missing'])
      assert.equal(
        await saveCustomerMemory('memory-room@lid', anchor.id, [{ ...fact, messageIds: [id] }]),
        0
      )
    assert.equal(
      await saveCustomerMemory('memory-room@lid', anchor.id, [
        { ...fact, value: '170 cm', messageIds: ['corrected'] },
      ]),
      1
    )
    assert.equal(await saveCustomerMemory('memory-room@lid', anchor.id, [fact]), 0)
    const memory = await readCustomerMemory('memory-room@lid')
    assert.equal(memory[0].value, '170 cm')
    assert.equal(memory[0].sources[0].text, 'Ralat tinggi saya 170 cm')
    const context = await buildTurnContext('memory-room@lid', ['corrected'])
    assert.include(context.prompt, 'MEMORI PELANGGAN')
    assert.include(context.prompt, 'self_height')
    assert.equal(context.efficiency.memoryFacts, 1)
    assert.isAtLeast(context.efficiency.contextMs, 0)
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, async () => {
      await initializeDatabase()
      assert.deepEqual(await readCustomerMemory('memory-room@lid'), [])
    })
    await db
      .from('whatsapp_messages')
      .where('message_id', 'corrected')
      .update({ body: 'Pesan telah diubah' })
    assert.deepEqual(await readCustomerMemory('memory-room@lid'), [])
    assert.equal(
      await saveCustomerMemory('memory-room@lid', anchor.id, [
        { ...fact, messageIds: ['corrected'] },
      ]),
      1
    )
    await db.from('whatsapp_messages').where('message_id', 'corrected').delete()
    assert.deepEqual(await readCustomerMemory('memory-room@lid'), [])
  })
  test('history retrieval is read-only, anchor-bound, room-bound and validates arguments', async ({
    assert,
  }) => {
    const anchor = await db.from('whatsapp_messages').where('message_id', 'ai').first()
    const history = conversationHistoryTools({ jid: 'memory-room@lid', anchorId: anchor.id })
    const response = await history.callTool({ name: 'read_conversation_history', arguments: {} })
    const rows = JSON.parse(response.content[0].text).messages
    assert.deepEqual(
      rows.map((row: any) => row.message_id),
      ['height', 'ai']
    )
    const read = async (args: any) =>
      JSON.parse(
        (await history.callTool({ name: 'read_conversation_history', arguments: args })).content[0]
          .text
      )
    assert.deepEqual((await read({ messageIds: ['foreign', 'future'] })).messages, [])
    assert.equal((await read({ query: '168 cm' })).messages[0].message_id, 'height')
    assert.deepEqual((await read({ query: "' OR 1=1 --" })).messages, [])
    assert.deepEqual((await read({ beforeId: rows[0].id })).messages, [])
    await assert.rejects(() => read({ jid: 'other-room@lid' }), /Invalid history/)
    await assert.rejects(() => read({ beforeId: -1 }), /Invalid history/)
    await assert.rejects(() => history.callTool({ name: 'delete_messages' }), /not allowed/)
  })

  test('a current quote restores the end of a form outside the recent window with its original source', async ({
    assert,
  }) => {
    const jid = 'long-context-room@lid'
    const sourceId = 'long-context-form'
    const currentId = 'long-context-reference'
    const finalDetail = 'Celana kedua: panjang 99 cm. Angka ini dari pakaian jadi, bukan badan.'
    const body =
      'Jas pertama mengikuti rincian bahan dan ukuran yang telah disebut. '.repeat(15) +
      '\n' +
      finalDetail
    await db.table('whatsapp_contacts').insert({ jid, updated_at: new Date() })
    const messages = [
      { message_id: sourceId, body, reply_to_message_id: null },
      ...Array.from({ length: 7 }, (_, index) => ({
        message_id: `long-context-between-${index}`,
        body: 'Pembicaraan pengiriman tanpa perubahan ukuran.',
        reply_to_message_id: null,
      })),
      {
        message_id: currentId,
        body: 'Warnanya saja yang diganti navy.',
        reply_to_message_id: sourceId,
      },
    ]
    for (const [index, message] of messages.entries()) {
      await db.table('whatsapp_messages').insert({
        ...message,
        jid,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        created_at: new Date(Date.UTC(2026, 8, 20, 1, 0, index)),
      })
    }
    const context = await buildTurnContext(jid, [currentId], 5)
    assert.equal(context.efficiency.historyRead, 5)
    assert.equal(context.efficiency.memoryFacts, 0)
    assert.include(context.prompt, finalDetail)
    assert.include(context.prompt, `quoted_message_id: ${sourceId}`)
    assert.notInclude(context.prompt, 'TEKS_DIPOTONG')
    const history = conversationHistoryTools(context.access)
    const result = await history.callTool({
      name: 'read_conversation_history',
      arguments: { messageIds: [sourceId] },
    })
    const stored = JSON.parse(result.content[0].text).messages
    assert.lengthOf(stored, 1)
    assert.equal(stored[0].body, body)
    assert.isFalse(stored[0].truncated)
    const unchanged = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('message_id', sourceId)
      .first()
    assert.equal(unchanged.body, body)
  })
})
