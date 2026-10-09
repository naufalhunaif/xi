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

// v3.6.116 — server mendorong status & perubahan pesan lama; browser hanya bertanya sebagai cadangan.
test.group('dorongan kejadian v3.6.116', (group) => {
  const jid = 'tmplive1@s.whatsapp.net'
  const clean = async () => {
    await db.from('whatsapp_messages').where('jid', jid).delete()
  }
  group.setup(async () => {
    await initializeDatabase()
    await clean()
  })
  group.teardown(clean)

  test('tanda pesan berubah saat status kirim / media selesai, bukan hanya pesan baru', async ({ assert }) => {
    const { RECENT_MESSAGES_SQL } = await import('#services/inbox_changes')
    const read = async () => String(((await db.rawQuery(`SELECT ${RECENT_MESSAGES_SQL} AS sig`))[0] as any[])[0].sig)
    const id = `live-${Date.now()}`
    await db.table('whatsapp_messages').insert({ message_id: id, jid, direction: 'out', body: 'tes', status: 'queued', created_at: new Date() })
    const a = await read()
    await db.from('whatsapp_messages').where('message_id', id).update({ status: 'sent' })
    const b = await read()
    assert.notEqual(a, b)
    await db.from('whatsapp_messages').where('message_id', id).update({ media_type: 'image', media_status: 'ready', media_url: '/media/x.jpg' })
    assert.notEqual(b, await read())
  })

  test('tanda status hanya bagian yang terlihat (detak worker tidak memicu kiriman)', async ({ assert }) => {
    const { statusSignature, statusPayload } = await import('#services/live_status')
    const base = { status: 'connected', status_label: 'Terhubung', desired_connected: 1, worker_online: true, phone: '62800', pendingOrders: 2, linesConnected: 1 }
    assert.equal(statusSignature({ ...base, worker_heartbeat_at: 1, updated_at: 1 }), statusSignature({ ...base, worker_heartbeat_at: 2, updated_at: 2 }))
    assert.notEqual(statusSignature(base), statusSignature({ ...base, status: 'disconnected' }))
    assert.notEqual(statusSignature(base), statusSignature({ ...base, pendingOrders: 3 }))
    const live = await statusPayload()
    assert.properties(live, ['status', 'pendingOrders', 'linesConnected'])
  })

  test('tab tersambung menerima "changed" saat pesan masuk', async ({ assert }) => {
    const { subscribeInbox } = await import('#services/inbox_changes')
    const events: string[] = []
    const stop = subscribeInbox((event) => events.push(event))
    await new Promise((resolve) => setTimeout(resolve, 1800))
    await db.table('whatsapp_messages').insert({ message_id: `live2-${Date.now()}`, jid, direction: 'in', body: 'halo', status: 'received', created_at: new Date() })
    await new Promise((resolve) => setTimeout(resolve, 3300))
    stop()
    assert.include(events, 'changed')
  }).timeout(10_000)
})
