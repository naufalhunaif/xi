// v3.6.31 — peran kontak: pelanggan, vendor (toko membeli bahan/jasa dari mereka), lainnya.
// Dinilai Jev dari isi percakapan dua arah; vendor otomatis tidak dibalas AI dan tidak masuk
// penanda pembayaran/order. CS bisa mengubah manual di room.
//
// v3.6.33 — kasus Mauldy: pelanggan yang pesanannya DIANTAR tim ditandai vendor (percakapan antar,
// alamat, "sudah diterima" mirip urusan dengan pemasok). Sekarang bukti transaksi pelanggan menang:
// kontak yang punya order / pengiriman / bukti bayar ke toko tidak pernah ditandai vendor otomatis,
// dan pengecualian AI karena peran otomatis dicatat supaya bisa dikembalikan.
import db from '#services/workspace_database'
import { readLeanState, writeLeanState } from '#beta3/tables'
import { contactRole } from '#beta3/jev_decisions'
import { setAiExcluded } from '#services/ai_exclusion_service'

export type ContactRole = 'pelanggan' | 'vendor' | 'lainnya'
const ROLES: ContactRole[] = ['pelanggan', 'vendor', 'lainnya']
const MIN_MESSAGES = 4
const RECHECK_EVERY = 8
const autoExcludedKey = (jid: string) => `role-excluded:${jid}`

/** Bukti kontak ini pelanggan toko: pernah punya order (tidak batal), pengiriman, atau bukti bayar. */
export async function hasCustomerHistory(jid: string) {
  const [order, shipment, proof] = await Promise.all([
    db.from('whatsapp_beta3_orders').where('jid', jid).whereNot('status', 'cancelled').first().catch(() => null),
    db.from('whatsapp_beta3_shipments').where('jid', jid).first().catch(() => null),
    db.from('whatsapp_beta3_proofs').where('jid', jid).where('kind', 'bukti').first().catch(() => null),
  ])
  return Boolean(order || shipment || proof)
}

export async function setContactRole(jid: string, role: ContactRole | '', manual = false) {
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid|ig)$/.test(jid)) throw new Error('Kontak tidak valid.')
  if (role && !ROLES.includes(role)) throw new Error('Peran tidak valid.')
  const before = await db.from('whatsapp_contacts').where('jid', jid).select('ai_excluded').first().catch(() => null)
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, role, role_manual, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), role_manual = VALUES(role_manual), updated_at = VALUES(updated_at)`,
    [jid, role || null, manual ? 1 : 0, new Date()]
  )
  if (role === 'vendor' || role === 'lainnya') {
    // Dicatat hanya bila pengecualian AI dibuat oleh penandaan peran (bukan pilihan CS sebelumnya).
    if (!Number(before?.ai_excluded)) await writeLeanState(autoExcludedKey(jid), '1')
    await setAiExcluded(jid, true).catch(() => {})
  } else if (role === 'pelanggan') {
    const auto = (await readLeanState(autoExcludedKey(jid))) === '1'
    if (manual || auto) await setAiExcluded(jid, false).catch(() => {})
    if (auto) await writeLeanState(autoExcludedKey(jid), '')
  }
}

/**
 * Dipanggil listener tiap pesan masuk (di latar). Menilai sekali setelah ≥4 pesan, lalu tiap
 * 8 pesan sampai Jev yakin; peran yang diatur manual CS tidak disentuh. Kontak dengan riwayat
 * transaksi pelanggan langsung "pelanggan" tanpa bertanya Jev.
 */
export async function detectContactRole(jid: string) {
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid)) return null
  const contact = await db.from('whatsapp_contacts').where('jid', jid).select('role', 'role_manual').first().catch(() => null)
  if (Number(contact?.role_manual)) return null
  if (await hasCustomerHistory(jid)) {
    // Peran otomatis yang keliru (vendor/lainnya) pada pelanggan dikembalikan.
    if (contact?.role && contact.role !== 'pelanggan') {
      await setContactRole(jid, 'pelanggan')
      return 'pelanggan' as ContactRole
    }
    return null
  }
  if (contact?.role) return null
  const countRow = await db.from('whatsapp_messages').where('jid', jid).count('* as n').first()
  const total = Number(countRow?.n || 0)
  if (total < MIN_MESSAGES) return null
  const key = `role-check:${jid}`
  const last = Number(await readLeanState(key)) || 0
  if (last && total - last < RECHECK_EVERY) return null
  await writeLeanState(key, String(total))
  const rows = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('id', 'desc')
    .limit(14)
    .select('direction', 'body', 'media_type')
  const chat = (rows as any[]).reverse().map((row) => ({ direction: row.direction, body: row.body, mediaType: row.media_type }))
  const role = await contactRole(jid, chat)
  if (!role) return null
  await setContactRole(jid, role)
  return role
}

/**
 * Sekali per proses: peran otomatis vendor/lainnya pada kontak yang ternyata punya riwayat
 * transaksi pelanggan dikembalikan ke pelanggan (perbaikan penandaan keliru v3.6.31).
 */
export async function repairAutoRoles() {
  const rows = await db
    .from('whatsapp_contacts')
    .whereIn('role', ['vendor', 'lainnya'])
    .where('role_manual', 0)
    .select('jid', 'role')
    .catch(() => [])
  let fixed = 0
  for (const row of rows as any[]) {
    const jid = String(row.jid)
    if (!(await hasCustomerHistory(jid).catch(() => false))) {
      // Tanpa riwayat transaksi: tanya Jev sekali lagi dengan instruksi baru (antar/ambil = pelanggan,
      // ragu = pelanggan, ambang 0,95). Vendor hanya tetap bila Jev yakin vendor.
      const key = `role-recheck-v2:${jid}`
      if (await readLeanState(key)) continue
      await writeLeanState(key, '1')
      const recent = await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .whereNotIn('status', ['failed', 'queued'])
        .orderBy('id', 'desc')
        .limit(14)
        .select('direction', 'body', 'media_type')
        .catch(() => [])
      const chat = (recent as any[]).reverse().map((item) => ({ direction: item.direction, body: item.body, mediaType: item.media_type }))
      const again = await contactRole(jid, chat).catch(() => undefined)
      if (again === row.role) continue
      await writeLeanState(autoExcludedKey(jid), '1')
      await setContactRole(jid, again && again !== 'pelanggan' ? again : 'pelanggan').catch(() => {})
      fixed++
      continue
    }
    // Penandaan v3.6.31 selalu ikut mematikan AI; pengecualian itu dicabut bersama perannya.
    await writeLeanState(autoExcludedKey(jid), '1')
    await setContactRole(jid, 'pelanggan').catch(() => {})
    fixed++
  }
  return fixed
}
