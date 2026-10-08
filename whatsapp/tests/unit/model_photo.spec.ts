import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { ensureLeanTables } from '#beta3/tables'
import { STASH_TTL_MS, prependMissing, stashTurn, takeStashed } from '#beta3/reply_guards'
import { CS_MODEL_CONFIRM, addRef, applyCsModelConfirm, isWholeModelPart, listActiveRefs, refsForOrder, saveAiRefs } from '#beta3/refs_service'

// v3.6.69 — chat Alkhoiri 8 Okt: (A) foto model kedua + "Modelnya gini bs min?" tidak pernah sampai ke
// AI (giliran dilewati karena pesan lebih baru sudah masuk); (B/C) referensi penjahit tetap foto pertama
// walau CS sudah membalas foto kedua "jadi modelnya seperti ini ya bos" dan pelanggan "Ok bos".
const jid = 'model-photo-test@s.whatsapp.net'
const at = new Date()

test.group('foto model terbaru & konfirmasi CS (v3.6.69)', (group) => {
  group.each.setup(async () => {
    await ensureLeanTables()
    const clean = async () => {
      await db.from('whatsapp_beta3_refs').where('jid', jid).delete()
      await db.from('whatsapp_messages').where('jid', jid).delete()
      await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    }
    await clean()
    return clean
  })

  test('A: pesan giliran yang dilewati disimpan lalu ikut giliran berikutnya (sekali, maks 15 menit)', ({ assert }) => {
    const stash = new Map<string, { at: number; items: Array<{ id: string; text: string }> }>()
    const now = Date.now()
    stashTurn(stash, jid, [{ id: 'foto2', text: '' }, { id: 'tanya', text: 'Modelnya gini bs min?' }], now)
    stashTurn(stash, jid, [{ id: 'tanya', text: 'Modelnya gini bs min?' }], now + 1000)
    const next = [{ id: 'biasa', text: 'Kayak biasa min' }]
    prependMissing(next, takeStashed(stash, jid, now + 2000))
    assert.deepEqual(next.map((item) => item.id), ['foto2', 'tanya', 'biasa'])
    assert.deepEqual(takeStashed(stash, jid, now + 3000), [])
    // Terlalu lama (CS kemungkinan sudah menangani) → tidak dihidupkan lagi.
    stashTurn(stash, jid, [{ id: 'lama', text: 'x' }], now)
    assert.deepEqual(takeStashed(stash, jid, now + STASH_TTL_MS + 1), [])
  })

  test('C: CS membalas foto kedua "jadi modelnya seperti ini" → foto itu referensi model, foto pertama diganti', async ({ assert }) => {
    for (const [id, url] of [['foto1', '/media/f1.jpg'], ['foto2', '/media/f2.jpg']])
      await db.table('whatsapp_messages').insert({ jid, message_id: id, direction: 'in', sender_type: 'customer', body: '', media_type: 'image', media_url: url, status: 'received', created_at: at })
    await addRef({ jid, messageId: 'foto1', imageUrl: '/media/f1.jpg', part: 'model' })
    await addRef({ jid, messageId: 'foto1', imageUrl: '/media/f1.jpg', part: 'kerah' })
    assert.isTrue(CS_MODEL_CONFIRM.test('jadi modelnya seperti ini ya bos'))
    // Tanpa balasan (quote) ke foto / bukan konfirmasi model → tidak mengubah apa pun.
    assert.isNull(await applyCsModelConfirm(jid, 'jadi modelnya seperti ini ya bos', null))
    assert.isNull(await applyCsModelConfirm(jid, 'ongkirnya 75.000 bos', 'foto2'))
    const done = await applyCsModelConfirm(jid, 'jadi modelnya seperti ini ya bos', 'foto2')
    assert.equal(done?.removed, 1)
    const refs = await listActiveRefs(jid)
    assert.deepEqual(refs.map((ref) => [ref.message_id, ref.part]).sort(), [['foto1', 'kerah'], ['foto2', 'model']])
  })

  test('C: order sudah lunas (referensi menempel ke order) → referensi model order itu yang diganti', async ({ assert }) => {
    await db.table('whatsapp_messages').insert({ jid, message_id: 'foto2', direction: 'in', sender_type: 'customer', body: '', media_type: 'image', media_url: '/media/f2.jpg', status: 'received', created_at: at })
    const [orderId] = await db.table('whatsapp_beta3_orders').insert({
      jid, customer_name: 'Tes', address: '', district: '', regency: '', postal_code: '', phone: '', items: 'Beskap', status: 'paid', created_at: at, updated_at: at,
    })
    const old = await addRef({ jid, messageId: 'foto1', imageUrl: '/media/f1.jpg', part: 'model' })
    await db.from('whatsapp_beta3_refs').where('id', old).update({ order_id: orderId })
    await applyCsModelConfirm(jid, 'model yang ini ya bos', 'foto2')
    const refs = await refsForOrder(Number(orderId))
    assert.deepEqual(refs.map((ref) => ref.message_id), ['foto2'])
  })

  test('B: pelanggan mengirim foto model baru → referensi model pindah ke foto terbaru', async ({ assert }) => {
    for (const [id, url] of [['foto1', '/media/f1.jpg'], ['foto2', '/media/f2.jpg']])
      await db.table('whatsapp_messages').insert({ jid, message_id: id, direction: 'in', sender_type: 'customer', body: '', media_type: 'image', media_url: url, status: 'received', created_at: at })
    await saveAiRefs(jid, [{ gambar: 1, bagian: 'model' }, { gambar: 1, bagian: 'kerah' }], ['foto1'])
    await saveAiRefs(jid, [{ gambar: 1, bagian: 'model' }], ['foto2'])
    const refs = await listActiveRefs(jid)
    assert.deepEqual(refs.map((ref) => [ref.message_id, ref.part]).sort(), [['foto1', 'kerah'], ['foto2', 'model']])
  })

  test('B: bagian "model keseluruhan" dikenali; detail (kerah, saku) tidak ikut diganti', ({ assert }) => {
    for (const part of ['', 'model', 'Model', 'model keseluruhan', 'beskap']) assert.isTrue(isWholeModelPart(part), part)
    for (const part of ['kerah', 'model kerah', 'saku', 'kancing']) assert.isFalse(isWholeModelPart(part), part)
  })
})
