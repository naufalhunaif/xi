import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { ensureLeanTables, writeLeanState } from '#beta3/tables'
import { repairAutoRoles, setContactRole, detectContactRole } from '#beta3/contact_role'

// v3.6.33 (kasus Mauldy): pelanggan yang pesanannya diantar tim ditandai vendor otomatis.
test.group('peran kontak · pelanggan tidak boleh tertandai vendor (database)', () => {
  const jids = ['tmprole1@s.whatsapp.net', 'tmprole2@s.whatsapp.net', 'tmprole3@s.whatsapp.net']
  const clean = async () => {
    await db.from('whatsapp_messages').whereIn('jid', jids).delete()
    await db.from('whatsapp_contacts').whereIn('jid', jids).delete()
    await db.from('whatsapp_beta3_orders').whereIn('jid', jids).delete()
    await db.from('whatsapp_beta3_shipments').whereIn('jid', jids).delete()
    for (const jid of jids) {
      await writeLeanState(`role-excluded:${jid}`, '')
      await writeLeanState(`role-recheck-v2:${jid}`, '')
    }
  }

  test('vendor otomatis + riwayat order/antar → kembali pelanggan, AI tidak lagi dikecualikan; manual tidak disentuh', async ({ assert }) => {
    await initializeDatabase()
    await ensureLeanTables()
    await clean()
    const at = new Date()
    for (const jid of jids)
      await db.table('whatsapp_messages').insert({ jid, message_id: `m-${jid}`, direction: 'in', sender_type: 'customer', body: 'halo', status: 'received', created_at: at })
    // 1: pelanggan dengan pengiriman "diantar tim" (Mauldy), ditandai vendor otomatis (v3.6.31).
    await db.rawQuery('INSERT INTO whatsapp_beta3_shipments (message_id, jid, awb, method, created_at) VALUES (?, ?, ?, ?, ?)', ['antar-x', jids[0], 'ANTAR', 'antar', at])
    await db.table('whatsapp_contacts').insert({ jid: jids[0], role: 'vendor', role_manual: 0, ai_excluded: 1, handling_mode: 'cs', updated_at: at })
    // 2: vendor otomatis tanpa riwayat, Jev tidak tersedia di tes → ragu = pelanggan.
    await db.table('whatsapp_contacts').insert({ jid: jids[1], role: 'vendor', role_manual: 0, ai_excluded: 1, handling_mode: 'cs', updated_at: at })
    // 3: vendor yang ditandai manual CS → tetap vendor.
    await setContactRole(jids[2], 'vendor', true)

    assert.isAtLeast(await repairAutoRoles(), 2)
    const rows = new Map((await db.from('whatsapp_contacts').whereIn('jid', jids).select('jid', 'role', 'ai_excluded')).map((row: any) => [row.jid, row]))
    assert.equal(rows.get(jids[0]).role, 'pelanggan')
    assert.equal(Number(rows.get(jids[0]).ai_excluded), 0)
    assert.equal(rows.get(jids[1]).role, 'pelanggan')
    assert.equal(Number(rows.get(jids[1]).ai_excluded), 0)
    assert.equal(rows.get(jids[2]).role, 'vendor')
    assert.equal(Number(rows.get(jids[2]).ai_excluded), 1)

    // Deteksi berikutnya: kontak dengan riwayat pelanggan tidak ditanyakan lagi dan tetap pelanggan.
    await db.from('whatsapp_contacts').where('jid', jids[0]).update({ role: 'lainnya' })
    assert.equal(await detectContactRole(jids[0]), 'pelanggan')
    await clean()
  })
})
