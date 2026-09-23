import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'
import { latestInboxMessages, markRoomRead } from '#services/contact_inbox_service'

const firstJid = '10000000778891@lid'
const secondJid = '10000000778892@lid'
const session = {
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Pemilik',
    username: 'owner',
  },
}
async function message(jid: string, time: string, direction = 'in', status = 'received') {
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: messageId,
    jid,
    contact_name: jid === firstJid ? 'Inbox Satu' : 'Inbox Dua',
    direction,
    sender_type: direction === 'in' ? 'customer' : 'ai',
    body: 'Pesan uji',
    status,
    created_at: new Date(time),
  })
  return db.from('whatsapp_messages').where('message_id', messageId).firstOrFail()
}
test.group('Workspace inbox unread counts', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('unanswered is independent from read and only successful replies clear it, including media', async ({
    assert,
  }) => {
    const first = await message(firstJid, '2030-01-02T10:00:00Z')
    const second = await message(firstJid, '2030-01-02T10:01:00Z')
    await markRoomRead(firstJid, Number(second.id))
    await message(firstJid, '2030-01-02T10:02:00Z', 'out', 'failed')
    const queued = await message(firstJid, '2030-01-02T10:03:00Z', 'out', 'queued')
    let rows = await latestInboxMessages()
    assert.equal(rows.find((row) => row.jid === firstJid)!.unanswered_count, 2)
    assert.equal(rows.find((row) => row.jid === firstJid)!.unread_count, 0)
    await db
      .from('whatsapp_messages')
      .where('id', queued.id)
      .update({ status: 'sent', body: '', media_type: 'image' })
    // A late history import is not a new unanswered question.
    await message(firstJid, '2020-01-02T10:00:00Z')
    rows = await latestInboxMessages()
    assert.equal(rows.find((row) => row.jid === firstJid)!.unanswered_count, 0)
    await message(firstJid, '2030-01-02T10:04:00Z')
    rows = await latestInboxMessages()
    assert.equal(rows.find((row) => row.jid === firstJid)!.unanswered_count, 1)
    assert.isAbove(Number(second.id), Number(first.id))
  })

  test('payment and order queues use recorded workflow state and do not duplicate rooms', async ({
    client,
    assert,
  }) => {
    await message(firstJid, '2030-01-02T10:00:00Z')
    await message(secondJid, '2030-01-02T10:01:00Z')
    await db
      .table('whatsapp_contacts')
      .insert({ jid: firstJid, handling_mode: 'cs', updated_at: new Date() })
    await db.table('whatsapp_carts').insert({
      jid: firstJid,
      version: randomUUID(),
      items_json: '[{"name":"Jas"}]',
      recipient_json: '{}',
      shipping_json: '{}',
      note: '',
      payment_status: 'reported',
      updated_at: new Date(),
    })
    for (let i = 0; i < 2; i++)
      await db.table('whatsapp_orders').insert({
        jid: secondJid,
        snapshot_json: '{}',
        total: 100,
        paid: 20,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      })
    const response = await client.get('/api/contacts').withSession(session)
    response.assertStatus(200)
    const rows = response.body().contacts
    const first = rows.find((row: any) => row.jid === firstJid)
    assert.isTrue(first.needs_payment)
    assert.isTrue(first.has_order)
    assert.equal(first.handling_mode, 'cs')
    assert.lengthOf(
      rows.filter((row: any) => row.jid === secondJid),
      1
    )
    assert.isFalse(rows.find((row: any) => row.jid === secondJid).needs_payment)
    assert.isTrue(rows.find((row: any) => row.jid === secondJid).has_order)
    await db
      .from('whatsapp_carts')
      .where('jid', firstJid)
      .update({ items_json: '[]', payment_status: 'none' })
    await db.from('whatsapp_orders').where('jid', secondJid).update({ status: 'cancelled' })
    const after = await latestInboxMessages()
    assert.isFalse(after.find((row) => row.jid === firstJid)!.needs_payment)
    assert.isFalse(after.find((row) => row.jid === firstJid)!.has_order)
    assert.isFalse(after.find((row) => row.jid === secondJid)!.has_order)
  })

  test('unconfirmed order payment review exits payment queue after proof is used or review becomes stale', async ({
    assert,
  }) => {
    await message(firstJid, '2030-01-02T10:00:00Z')
    const version = randomUUID()
    await db.table('whatsapp_carts').insert({
      jid: firstJid,
      version,
      items_json: '[]',
      recipient_json: '{}',
      shipping_json: '{}',
      note: '',
      updated_at: new Date(),
    })
    const [orderId] = await db.table('whatsapp_orders').insert({
      jid: firstJid,
      snapshot_json: '{}',
      total: 100,
      paid: 20,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const proof = randomUUID()
    await db.table('whatsapp_payment_reviews').insert({
      id: randomUUID(),
      jid: firstJid,
      cart_version: version,
      order_id: orderId,
      order_paid: 20,
      proof_message_id: proof,
      proof_hash: 'a'.repeat(64),
      methods_signature: '{}',
      reading_json: '{}',
      created_at: new Date(),
    })
    const state = async () => {
      const inbox = await latestInboxMessages()
      return inbox.find((row) => row.jid === firstJid)!.needs_payment
    }
    assert.isTrue(await state())
    await db.from('whatsapp_carts').where('jid', firstJid).update({ version: randomUUID() })
    assert.isFalse(await state())
    await db.from('whatsapp_carts').where('jid', firstJid).update({ version })
    await db.table('whatsapp_order_payments').insert({
      order_id: orderId,
      request_key: randomUUID(),
      amount: 20,
      method_id: 1,
      method_json: '{}',
      reference: randomUUID(),
      proof_message_id: proof,
      confirmed_by: 'test',
      created_at: new Date(),
    })
    assert.isFalse(await state())
  })

  test('sorts rooms by latest message time, not insertion order; AI replies also move a room up', async ({
    assert,
  }) => {
    await message(firstJid, '2030-01-02T10:00:00Z')
    await message(secondJid, '2030-01-02T11:00:00Z')
    await message(firstJid, '2020-01-02T10:00:00Z')
    let inbox = await latestInboxMessages()
    assert.deepEqual(
      inbox.slice(0, 2).map((row) => row.jid),
      [secondJid, firstJid]
    )
    assert.equal(inbox[1].unread_count, 2)
    await message(firstJid, '2030-01-02T12:00:00Z', 'out', 'sent')
    inbox = await latestInboxMessages()
    assert.equal(inbox[0].jid, firstJid)
    assert.equal(inbox[0].unread_count, 2)
    await message(secondJid, '2030-01-02T12:00:00Z', 'out', 'sent')
    inbox = await latestInboxMessages()
    assert.equal(inbox[0].jid, secondJid)
  })

  test('marks only through the rendered message, preserves newer incoming and WhatsApp receipts, and never rolls back a watermark', async ({
    assert,
  }) => {
    const first = await message(firstJid, '2030-01-02T10:00:00Z', 'in', 'read')
    const second = await message(firstJid, '2030-01-02T11:00:00Z')
    await message(secondJid, '2030-01-02T12:00:00Z')
    await markRoomRead(firstJid, Number(first.id))
    let inbox = await latestInboxMessages()
    assert.equal(inbox.find((row) => row.jid === firstJid)!.unread_count, 1)
    assert.equal(inbox.find((row) => row.jid === secondJid)!.unread_count, 1)
    await markRoomRead(firstJid, Number(second.id))
    await markRoomRead(firstJid, Number(first.id))
    inbox = await latestInboxMessages()
    assert.equal(inbox.find((row) => row.jid === firstJid)!.unread_count, 0)
    const stored = await db.from('whatsapp_messages').where('id', second.id).firstOrFail()
    assert.equal(stored.status, 'received')
    await message(firstJid, '2030-01-02T13:00:00Z')
    inbox = await latestInboxMessages()
    assert.equal(inbox.find((row) => row.jid === firstJid)!.unread_count, 1)
    await assert.rejects(() => markRoomRead(secondJid, Number(first.id)), /room ini/)
    await assert.rejects(() => markRoomRead(firstJid, -1))
  })

  test('AI border state follows live runs, not customer typing or a stale activity label', async ({
    client,
    assert,
  }) => {
    await message(firstJid, new Date().toISOString())
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    await db
      .from('whatsapp_connection')
      .where('id', 1)
      .update({ status: 'connected', worker_heartbeat_at: new Date() })
    await db.table('whatsapp_contacts').insert({
      jid: firstJid,
      handling_mode: 'ai',
      activity: 'typing',
      activity_updated_at: new Date(),
      updated_at: new Date(),
    })
    const state = async () => {
      const response = await client.get('/api/contacts').withSession(session)
      response.assertStatus(200)
      return response.body().contacts.find((row: any) => row.jid === firstJid).ai_running
    }
    assert.isFalse(await state())
    const id = randomUUID()
    await db.table('whatsapp_ai_traces').insert({
      id,
      jid: firstJid,
      status: 'running',
      input_json: '{}',
      steps_json: '[]',
      created_at: new Date(Date.now() - 60000),
      updated_at: new Date(),
    })
    await db
      .from('whatsapp_contacts')
      .where('jid', firstJid)
      .update({ activity_updated_at: new Date(Date.now() - 60000) })
    assert.isTrue(await state())
    const rendered = await client.get('/').withSession(session)
    rendered.assertTextIncludes('wa-contact  ai-running')
    await db.from('whatsapp_contacts').where('jid', firstJid).update({ handling_mode: 'cs' })
    assert.isFalse(await state())
    await db.from('whatsapp_contacts').where('jid', firstJid).update({ handling_mode: 'ai' })
    await db
      .from('whatsapp_ai_traces')
      .where('id', id)
      .update({ updated_at: new Date(Date.now() - 300000) })
    assert.isFalse(await state())
    await db
      .from('whatsapp_ai_traces')
      .where('id', id)
      .update({ updated_at: new Date(), status: 'completed' })
    assert.isFalse(await state())
    await db.from('whatsapp_ai_traces').where('id', id).update({ status: 'running' })
    await db.from('whatsapp_connection').where('id', 1).update({ worker_heartbeat_at: null })
    assert.isFalse(await state())
    await db.from('whatsapp_connection').where('id', 1).update({ worker_heartbeat_at: new Date() })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    assert.isFalse(await state())
  })

  test('GET room/history never marks read; authenticated CSRF-protected POST updates the badge', async ({
    client,
    assert,
  }) => {
    const first = await message(firstJid, '2030-01-02T10:00:00Z')
    const page = await client.get(`/?jid=${firstJid}`).withSession(session)
    page.assertStatus(200)
    page.assertTextIncludes('1 pesan belum dibaca')
    const history = await client
      .get(`/api/messages?jid=${firstJid}&before=9999999`)
      .withSession(session)
    history.assertStatus(200)
    const before = await client.get('/api/contacts').withSession(session)
    before.assertHeader('cache-control', 'no-store')
    assert.equal(before.body().contacts.find((row: any) => row.jid === firstJid).unread_count, 1)
    const denied = await client
      .post('/api/contacts/read')
      .withSession(session)
      .json({ jid: firstJid, throughId: first.id })
      .redirects(0)
    assert.isAtLeast(denied.status(), 300)
    const read = await client
      .post('/api/contacts/read')
      .withSession(session)
      .withCsrfToken()
      .json({ jid: firstJid, throughId: first.id })
    read.assertStatus(200)
    const after = await client.get('/api/contacts').withSession(session)
    assert.equal(after.body().contacts.find((row: any) => row.jid === firstJid).unread_count, 0)
  })
})
