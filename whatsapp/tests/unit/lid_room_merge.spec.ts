import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { canonicalRoomJid, mergeLidRoom } from '#services/customer_identity_service'

// Satu pelanggan dua room (LID & nomor) → digabung ke room nomor (v3.6.19).
test.group('room LID ↔ nomor (database)', () => {
  test('pesan room LID pindah ke room nomor; state berkunci jid: room nomor menang', async ({ assert }) => {
    const lid = '777000111@lid'
    const phone = '6281200009999@s.whatsapp.net'
    const clean = async () => {
      for (const table of ['whatsapp_messages', 'whatsapp_contacts', 'whatsapp_beta3_customers'])
        await db.from(table).whereIn('jid', [lid, phone]).delete()
    }
    await clean()
    await db.table('whatsapp_contacts').insert({ jid: lid, phone_jid: phone, name: 'Budi LID', updated_at: new Date() })
    await db.table('whatsapp_messages').multiInsert([
      { jid: phone, message_id: 'lm1', direction: 'in', sender_type: 'customer', body: 'halo', status: 'received', created_at: new Date(Date.now() - 60_000) },
      { jid: lid, message_id: 'lm2', direction: 'in', sender_type: 'customer', body: 'lagi', status: 'received', created_at: new Date() },
    ])
    await db.table('whatsapp_beta3_customers').multiInsert([
      { jid: phone, note: 'catatan nomor', updated_at: new Date() },
      { jid: lid, note: 'catatan lid', updated_at: new Date() },
    ])
    assert.equal(await canonicalRoomJid(lid), phone)
    assert.equal(await canonicalRoomJid('6281200009999:5@s.whatsapp.net'), phone)
    assert.equal(await mergeLidRoom(lid, phone), 1)
    const rooms = await db.from('whatsapp_messages').whereIn('jid', [lid, phone]).select('jid')
    assert.deepEqual([...new Set(rooms.map((r) => r.jid))], [phone])
    const notes = await db.from('whatsapp_beta3_customers').whereIn('jid', [lid, phone])
    assert.deepEqual(notes.map((r) => `${r.jid}:${r.note}`), [`${phone}:catatan nomor`])
    const contact = await db.from('whatsapp_contacts').where('jid', phone).first()
    assert.equal(contact?.name, 'Budi LID')
    await clean()
  })
})
