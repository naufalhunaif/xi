import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('contacts expose internal handoff context only while CS has an active reason', async ({
  client,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000990116@lid'
  const session = {
    account: {
      sub: 'a'.repeat(64),
      sessionToken: 'b'.repeat(43),
      checkedAt: Date.now(),
      name: 'Test',
      username: 'test',
    },
  }
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'handling-api',
      jid,
      direction: 'in',
      body: 'Custom',
      status: 'received',
      created_at: new Date(),
    })
    await db.table('whatsapp_contacts').insert({
      jid,
      handling_mode: 'cs',
      handoff_reason: 'Perlu persetujuan harga custom',
      chat_note: 'Jas peak lapel, ukuran khusus, 1 pcs',
      updated_at: new Date(),
    })
    const response = await client.get('/api/contacts').withSession(session)
    const contact = response.body().contacts.find((row: any) => row.jid === jid)
    assert.equal(contact.handling_note, 'Jas peak lapel, ukuran khusus, 1 pcs')
    const room = await client.get(`/?jid=${jid}`).withSession(session)
    room.assertTextIncludes('data-reason="Perlu persetujuan harga custom"')
    room.assertTextIncludes('data-note="Jas peak lapel, ukuran khusus, 1 pcs"')
    for (const update of [
      { handling_mode: 'ai' },
      { handling_mode: 'cs', ai_excluded: true },
      { ai_excluded: false, handoff_reason: '' },
    ]) {
      await db.from('whatsapp_contacts').where('jid', jid).update(update)
      const changed = await client.get('/api/contacts').withSession(session)
      assert.equal(changed.body().contacts.find((row: any) => row.jid === jid).handling_note, '')
    }
  } finally {
    await db.rollbackGlobalTransaction()
  }
})
