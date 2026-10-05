// v3.6.31 — peran kontak: pelanggan, vendor (toko membeli bahan/jasa dari mereka), lainnya.
// Dinilai Jev dari isi percakapan dua arah; vendor otomatis tidak dibalas AI dan tidak masuk
// penanda pembayaran/order. CS bisa mengubah manual di room.
import db from '#services/workspace_database'
import { readLeanState, writeLeanState } from '#beta3/tables'
import { contactRole } from '#beta3/jev_decisions'
import { setAiExcluded } from '#services/ai_exclusion_service'

export type ContactRole = 'pelanggan' | 'vendor' | 'lainnya'
const ROLES: ContactRole[] = ['pelanggan', 'vendor', 'lainnya']
const MIN_MESSAGES = 4
const RECHECK_EVERY = 8

export async function setContactRole(jid: string, role: ContactRole | '', manual = false) {
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid|ig)$/.test(jid)) throw new Error('Kontak tidak valid.')
  if (role && !ROLES.includes(role)) throw new Error('Peran tidak valid.')
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, role, role_manual, updated_at) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE role = VALUES(role), role_manual = VALUES(role_manual), updated_at = VALUES(updated_at)`,
    [jid, role || null, manual ? 1 : 0, new Date()]
  )
  // Vendor/lainnya: AI tidak membalas (bukan pelanggan). Kembali ke pelanggan: AI boleh membalas lagi.
  if (role === 'vendor' || role === 'lainnya') await setAiExcluded(jid, true).catch(() => {})
  else if (manual && role === 'pelanggan') await setAiExcluded(jid, false).catch(() => {})
}

/**
 * Dipanggil listener tiap pesan masuk (di latar). Menilai sekali setelah ≥4 pesan, lalu tiap
 * 8 pesan sampai Jev yakin; peran yang diatur manual CS tidak disentuh.
 */
export async function detectContactRole(jid: string) {
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid)) return null
  const contact = await db.from('whatsapp_contacts').where('jid', jid).select('role', 'role_manual').first().catch(() => null)
  if (contact?.role || Number(contact?.role_manual)) return null
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
  const role = await contactRole(jid, rows.reverse() as any[])
  if (!role) return null
  await setContactRole(jid, role)
  return role
}
