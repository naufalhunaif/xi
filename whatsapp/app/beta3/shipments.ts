// Beta 3 — pesan "pesanan sudah dikirim + nomor resi" dari toko (AI/CS/pemilik),
// kata-katanya bebas. Dicatat per pesan supaya tab Selesai dan lacak resi memakainya.
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'

const SHIP_WORDS =
  /\b(resi|awb|no\.?\s*kiriman|kiriman|dikirim|terkirim|kirim|pengiriman|ekspedisi|kurir|jne|j&t|jnt|sicepat|anteraja|tiki|ninja|lion|paket|otw|tracking|lacak)\b/i

/**
 * Nomor resi dalam pesan pengiriman: token 10–20 huruf/angka dengan ≥ 10 angka,
 * bukan nomor HP (08…/62…) dan bukan nomor rekening toko.
 */
export function detectAwb(text: string, accounts: Set<string> = new Set()) {
  const body = String(text || '')
  if (!SHIP_WORDS.test(body)) return ''
  for (const token of body.toUpperCase().match(/\b[A-Z0-9]{10,20}\b/g) || []) {
    const digits = token.replace(/\D/g, '')
    if (digits.length < 10) continue
    if (/^(62|08)\d{8,12}$/.test(token)) continue
    if (accounts.has(digits)) continue
    return token
  }
  return ''
}

async function accountNumbers() {
  const rows = await db.from('whatsapp_payment_methods').select('destination').catch(() => [])
  const numbers = new Set<string>()
  for (const row of rows as any[])
    for (const part of String(row.destination || '').match(/\d[\d\s.-]{8,}\d/g) || []) numbers.add(part.replace(/\D/g, ''))
  return numbers
}

let scanning = false
/** Pindai pesan keluar baru (bertahap) dan catat yang berisi resi pengiriman. */
export async function scanShipments(batch = 3000) {
  if (scanning) return
  scanning = true
  try {
    await ensureLeanTables()
    let last = Number(await readLeanState('shipment_scan_id')) || 0
    const max = await db.from('whatsapp_messages').max('id as id').first()
    if (Number(max?.id || 0) < last) last = 0 // data direset/dipulihkan
    const rows = await db
      .from('whatsapp_messages')
      .where('id', '>', last)
      .where('direction', 'out')
      .whereNotNull('body')
      .orderBy('id', 'asc')
      .limit(batch)
      .select('id', 'message_id', 'jid', 'body', 'created_at')
    if (!rows.length) return
    const accounts = await accountNumbers()
    for (const row of rows as any[]) {
      const awb = detectAwb(String(row.body || ''), accounts)
      if (!awb || !row.message_id) continue
      await db.rawQuery(
        'INSERT IGNORE INTO whatsapp_beta3_shipments (message_id, jid, awb, created_at) VALUES (?, ?, ?, ?)',
        [String(row.message_id), String(row.jid), awb, row.created_at]
      )
    }
    await writeLeanState('shipment_scan_id', String(rows[rows.length - 1].id))
  } finally {
    scanning = false
  }
}
