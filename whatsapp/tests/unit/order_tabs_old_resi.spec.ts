import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { ensureLeanTables } from '#beta3/tables'
import { countLeanOrders, listLeanOrders } from '#beta3/order_service'

// v3.6.53 — tab Menunggu total / Menunggu bayar di halaman Order kosong: order rekap pelanggan
// langganan dianggap "sudah dikirim" karena ada resi dari pembelian sebelumnya di chat yang sama.
const JID = '620000000779@s.whatsapp.net'
const clean = async () => {
  await db.from('whatsapp_beta3_orders').where('jid', JID).delete()
  await db.from('whatsapp_beta3_shipments').where('jid', JID).delete()
}

test.group('tab Order: resi lama tidak menutup order rekap yang belum bayar (v3.6.53)', (group) => {
  group.each.setup(async () => {
    await ensureLeanTables()
    await clean()
  })
  group.teardown(clean)

  test('menunggu total & menunggu bayar tetap tampil; order lunas lama tetap Selesai', async ({ assert }) => {
    const before = await countLeanOrders()
    const now = new Date()
    const old = new Date(Date.now() - 20 * 86_400_000)
    // Resi pembelian bulan lalu di chat yang sama.
    await db.table('whatsapp_beta3_shipments').insert({ message_id: 'OT-RESI-1', jid: JID, awb: '000000000001', created_at: old })
    const base = { jid: JID, items: 'Jas', source: 'rekap', group_status: 'none', created_at: now, updated_at: now }
    const [waitTotal] = await db.table('whatsapp_beta3_orders').insert({ ...base, status: 'pending' })
    const [waitPay] = await db.table('whatsapp_beta3_orders').insert({ ...base, status: 'awaiting_payment', total: 927000 })
    // Rekap pesanan lama yang sudah lunas (dibuat belakangan oleh rekap) → resi lama tetap berarti Selesai.
    const [paidOld] = await db.table('whatsapp_beta3_orders').insert({ ...base, status: 'paid', total: 500000 })

    const ids = (rows: any[]) => rows.filter((r) => r.jid === JID).map((r) => r.id)
    assert.deepEqual(ids(await listLeanOrders('pending', '620000000779')), [waitTotal])
    assert.deepEqual(ids(await listLeanOrders('awaiting_payment', '620000000779')), [waitPay])
    assert.deepEqual(ids(await listLeanOrders('done', '620000000779')), [paidOld])
    const rows = (await listLeanOrders('all', '620000000779')) as any[]
    assert.isNull(rows.find((r: any) => r.id === waitPay).shipped_awb)
    assert.equal(rows.find((r: any) => r.id === paidOld).shipped_awb, '000000000001')

    const after = await countLeanOrders()
    assert.equal(after.pending - before.pending, 1)
    assert.equal(after.awaiting_payment - before.awaiting_payment, 1)
    assert.equal(after.done - before.done, 1)

    // Resi baru sesudah order dibuat → order itu benar-benar dikirim → Selesai.
    await db.table('whatsapp_beta3_shipments').insert({ message_id: 'OT-RESI-2', jid: JID, awb: '000000000002', created_at: new Date(Date.now() + 60_000) })
    assert.deepEqual(ids(await listLeanOrders('awaiting_payment', '620000000779')), [])
  })
})
