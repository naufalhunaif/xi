import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { latestInboxMessages } from '#services/contact_inbox_service'
import { changedRooms, currentCursor, decodeCursor, encodeCursor } from '#services/inbox_changes'

// v3.6.44 — kotak masuk berbasis kejadian: per room, per halaman, dan "yang berubah sejak cursor".
test.group('kotak masuk per kejadian', (group) => {
  const jids = ['tmpinbox1@s.whatsapp.net', 'tmpinbox2@s.whatsapp.net']
  const clean = async () => {
    await db.from('whatsapp_messages').whereIn('jid', jids).delete()
  }
  group.setup(async () => {
    await initializeDatabase()
    await clean()
  })
  group.teardown(clean)

  test('room tertentu & halaman terbaru; cursor menangkap room yang berubah', async ({ assert }) => {
    const stamp = Date.now()
    await db.table('whatsapp_messages').insert([
      { message_id: `inb1-${stamp}`, jid: jids[0], direction: 'in', body: 'pertama', status: 'received', created_at: new Date(Date.now() + 60_000) },
      { message_id: `inb2-${stamp}`, jid: jids[1], direction: 'in', body: 'kedua', status: 'received', created_at: new Date(Date.now() + 120_000) },
    ])
    const one = await latestInboxMessages({ jids: [jids[0]] })
    assert.deepEqual([...new Set(one.map((row) => row.jid))], [jids[0]])
    assert.equal(one[0].body, 'pertama')
    assert.equal(one[0].unread_count >= 1, true)
    // Halaman 1 room terbaru = room kedua (pesan paling baru).
    const page = await latestInboxMessages({ limit: 1 })
    assert.lengthOf(page, 1)
    assert.equal(page[0].jid, jids[1])
    assert.deepEqual(await latestInboxMessages({ jids: [] }), [])

    const before = await currentCursor()
    assert.deepEqual(decodeCursor(encodeCursor(before)), before)
    await db.table('whatsapp_messages').insert({
      message_id: `inb3-${stamp}`, jid: jids[0], direction: 'in', body: 'baru', status: 'received', created_at: new Date(),
    })
    const change = await changedRooms(before)
    assert.include(change.jids, jids[0])
    assert.isFalse(change.full)
    assert.isAbove(change.cursor.messageId, before.messageId)
    assert.isNull(decodeCursor('bukan-cursor'))
  })
})
