// Beta 3 — pesan "pesanan sudah dikirim + nomor resi" dari toko (AI/CS/pemilik),
// kata-katanya bebas. Dicatat per pesan supaya tab Selesai dan lacak resi memakainya.
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'
import { storeDeliversItself } from '#beta3/jev_decisions'

/** Penanda pengiriman tanpa resi (diantar tim / diambil) di kolom awb. */
export const SELF_DELIVERY_AWB = 'ANTAR'

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

/**
 * v3.6.31 — pesan toko "pesanan diantar tim sendiri / diambil pelanggan" (tanpa resi): pola kata
 * sebagai saringan awal, Jev (`kirim_sendiri`) yang memutuskan bila aktif.
 */
const SELF_WORDS =
  /\b(diantar|di antar|dianter|di anter|antar sendiri|antar langsung|kami antar|kami anter|tim kami|kurir toko|kurir kami|ambil sendiri|diambil|ambil di toko|ambil di store|diambil di store|datang ke toko|datang ke store|sudah diterima|cod|ketemuan|kami bawa|dibawa langsung)\b/i
const SELF_SENT = /\b(sudah|sdh|udah|sedang|lagi|otw|hari ini|besok|siang|sore|malam|pagi|dalam perjalanan|siap|meluncur|berangkat)\b/i

export function looksSelfDelivery(text: string) {
  const body = String(text || '')
  return SELF_WORDS.test(body) && SELF_SENT.test(body) && !/\b(resi|awb|jne|j&t|jnt|sicepat|tiki|anteraja|ninja|lion|pos)\b/i.test(body)
}

export async function detectSelfDelivery(jid: string, text: string) {
  if (!looksSelfDelivery(text)) return false
  const verdict = await storeDeliversItself(jid, text).catch(() => undefined)
  return verdict !== false
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
    // Chat vendor/lainnya ("kain sudah diterima") bukan pengiriman pesanan pelanggan (v3.6.33).
    const notCustomers = new Set<string>(
      (
        await db
          .from('whatsapp_contacts')
          .whereIn('role', ['vendor', 'lainnya'])
          .whereIn('jid', [...new Set((rows as any[]).map((row) => String(row.jid)))])
          .select('jid')
          .catch(() => [])
      ).map((row: any) => String(row.jid))
    )
    for (const row of rows as any[]) {
      if (notCustomers.has(String(row.jid))) continue
      if (!row.message_id) continue
      const body = String(row.body || '')
      let awb = detectAwb(body, accounts)
      let method = 'kurir'
      if (!awb && (await detectSelfDelivery(String(row.jid), body))) {
        awb = SELF_DELIVERY_AWB
        method = 'antar'
      }
      if (!awb) continue
      await db.rawQuery(
        'INSERT IGNORE INTO whatsapp_beta3_shipments (message_id, jid, awb, method, created_at) VALUES (?, ?, ?, ?, ?)',
        [String(row.message_id), String(row.jid), awb, method, row.created_at]
      )
    }
    await writeLeanState('shipment_scan_id', String(rows[rows.length - 1].id))
  } finally {
    scanning = false
  }
}
