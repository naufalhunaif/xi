import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { latestInboxMessages, setRoomsReadState } from '#services/contact_inbox_service'

// Pilih chat di kotak masuk → Tandai dibaca / belum dibaca (v3.6.16).
test.group('kotak masuk · tandai dibaca / belum dibaca (database)', () => {
  test('dibaca = 0 belum dibaca; belum dibaca = pesan masuk terakhir terhitung 1', async ({ assert }) => {
    const jid = 'tmpread@s.whatsapp.net'
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_contacts').where('jid', jid).delete()
    const at = (min: number) => new Date(Date.now() - min * 60_000)
    await db.table('whatsapp_messages').multiInsert([
      { jid, message_id: 'rs1', direction: 'in', sender_type: 'customer', body: 'halo', status: 'received', created_at: at(30) },
      { jid, message_id: 'rs2', direction: 'out', sender_type: 'ai', body: 'halo bos', status: 'sent', created_at: at(29) },
      { jid, message_id: 'rs3', direction: 'in', sender_type: 'customer', body: 'harga?', status: 'received', created_at: at(10) },
      { jid, message_id: 'rs4', direction: 'in', sender_type: 'customer', body: 'tuxedo', status: 'received', created_at: at(9) },
    ])
    const unread = async () => Number((await latestInboxMessages()).find((row) => row.jid === jid)?.unread_count)
    assert.equal(await unread(), 3)
    assert.equal(await setRoomsReadState([jid], 'read'), 1)
    assert.equal(await unread(), 0)
    assert.equal(await setRoomsReadState([jid], 'unread'), 1)
    assert.equal(await unread(), 1)
    await assert.rejects(() => setRoomsReadState(['bukan jid'], 'read'))
    await db.from('whatsapp_messages').where('jid', jid).delete()
    await db.from('whatsapp_contacts').where('jid', jid).delete()
  })
})
