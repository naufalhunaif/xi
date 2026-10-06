import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { saveRecap, type ChatRecap } from '#beta3/recap_service'
import { ensureLeanTables, LEAN_TABLE_STATEMENTS } from '#beta3/tables'
import { reopenUntotaledOrder, totalWasSent } from '#beta3/order_service'

// v3.6.50 — kasus 6 Okt (cs-pelajaran #24): chat dipegang CS, rekap otomatis mencatat order
// "menunggu bayar" padahal total belum pernah dikirim. AI yang melanjutkan bilang "ini totalnya"
// lalu diam karena sistem mengira total sudah terkirim.
const JID = '620000000777@s.whatsapp.net'
const recap = (over: Partial<ChatRecap> = {}): ChatRecap => ({
  status: 'menunggu_bayar',
  rincian: 'Set Jas, Celana, Rompi - Ash Grey\nSize XL, celana menyesuaikan',
  nama: 'Pelanggan Uji',
  hp: '081200000000',
  alamat: 'Jl Contoh 1, Tegalreja, Cilacap Selatan, Cilacap, 53215',
  total: 0,
  ongkir: 0,
  dibayar: 0,
  layanan: 'YES',
  catatan: 'tahap: tunggu_cs',
  ...over,
})
const clean = async () => {
  await db.from('whatsapp_beta3_orders').where('jid', JID).delete()
}

test.group('peralihan CS → AI: total belum terkirim (v3.6.50)', (group) => {
  group.each.setup(async () => {
    await ensureLeanTables()
    await clean()
  })
  group.teardown(async () => {
    await clean()
  })

  test('rekap tanpa total = pending (bukan "menunggu bayar"); dengan total = menunggu bayar', async ({ assert }) => {
    const id = await saveRecap(JID, recap())
    const order = await db.from('whatsapp_beta3_orders').where('id', id!).first()
    assert.equal(order.status, 'pending')
    assert.isFalse(totalWasSent(order))
    // Rekap berikutnya membaca total CS → menunggu bayar.
    await saveRecap(JID, recap({ total: 927000, ongkir: 22000 }))
    const again = await db.from('whatsapp_beta3_orders').where('id', id!).first()
    assert.equal(again.status, 'awaiting_payment')
    assert.equal(Number(again.total), 927000)
    assert.isTrue(totalWasSent(again))
    // Rekap yang tidak membaca angka (0) tidak menghapus total yang sudah tercatat.
    await saveRecap(JID, recap({ total: 0, ongkir: 0 }))
    const kept = await db.from('whatsapp_beta3_orders').where('id', id!).first()
    assert.equal(kept.status, 'awaiting_payment')
    assert.equal(Number(kept.total), 927000)
    assert.equal(Number(kept.shipping_cost), 22000)
  })

  test('data lama: "menunggu bayar" tanpa total & tanpa dana dikembalikan ke pending', async ({ assert }) => {
    const now = new Date()
    const base = { jid: JID, items: 'Jas', status: 'awaiting_payment', group_status: 'none', created_at: now, updated_at: now }
    const [stale] = await db.table('whatsapp_beta3_orders').insert({ ...base, source: 'rekap' })
    const [withTotal] = await db.table('whatsapp_beta3_orders').insert({ ...base, source: 'rekap', total: 500000 })
    const [paidSome] = await db.table('whatsapp_beta3_orders').insert({ ...base, source: 'rekap', paid_amount: 200000 })
    // Perbaikan sekali jalan (pernyataan terakhir daftar tabel).
    await db.rawQuery(LEAN_TABLE_STATEMENTS[LEAN_TABLE_STATEMENTS.length - 1])
    const status = async (id: number) => (await db.from('whatsapp_beta3_orders').where('id', id).first()).status
    assert.equal(await status(stale), 'pending')
    assert.equal(await status(withTotal), 'awaiting_payment')
    assert.equal(await status(paidSome), 'awaiting_payment')
    // Saat AI membalas: order tanpa total dibuka lagi (bila perbaikan belum jalan).
    await db.from('whatsapp_beta3_orders').where('id', stale).update({ status: 'awaiting_payment' })
    assert.isTrue(await reopenUntotaledOrder(stale))
    assert.equal(await status(stale), 'pending')
    assert.isFalse(await reopenUntotaledOrder(withTotal))
  })

  test('total dianggap terkirim hanya bila memang ada; pesanan lama yang selesai tidak dihitung', ({ assert }) => {
    const now = Date.parse('2026-10-06T05:00:00Z')
    assert.isFalse(totalWasSent(null))
    assert.isFalse(totalWasSent({ status: 'awaiting_payment', total: null }))
    assert.isTrue(totalWasSent({ status: 'awaiting_payment', total: 927000 }))
    assert.isTrue(totalWasSent({ status: 'awaiting_payment', total: null, paid_amount: 300000 }))
    assert.isFalse(totalWasSent({ status: 'pending', total: 927000 }))
    assert.isTrue(totalWasSent({ status: 'paid', updated_at: new Date(now - 2 * 86_400_000) }, now))
    // Pelanggan langganan: order bulan lalu sudah terkirim → percakapan baru belum punya total.
    assert.isFalse(totalWasSent({ status: 'sent', updated_at: new Date(now - 30 * 86_400_000) }, now))
  })
})
