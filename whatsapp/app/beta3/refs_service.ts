// Beta 3 — gambar referensi per bagian (kerah, saku, …) untuk tim produksi.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { ensureLeanTables } from '#beta3/tables'

/** Kotak [x, y, lebar, tinggi] dalam skala 0–1000 terhadap gambar. */
export type RefBox = [number, number, number, number]

export type LeanRef = {
  id: number
  jid: string
  order_id: number | null
  message_id: string | null
  image_url: string
  part: string
  note: string
  box: RefBox | null
}

export function normalizeBox(value: unknown): RefBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  let [x, y, w, h] = value.map((n) => Math.round(Number(n)))
  if (![x, y, w, h].every(Number.isFinite)) return null
  x = Math.min(Math.max(x, 0), 990)
  y = Math.min(Math.max(y, 0), 990)
  w = Math.min(Math.max(w, 10), 1000 - x)
  h = Math.min(Math.max(h, 10), 1000 - y)
  return [x, y, w, h]
}

function parseRow(row: Record<string, any>): LeanRef {
  let box: RefBox | null = null
  try {
    box = normalizeBox(JSON.parse(row.box || 'null'))
  } catch {}
  return {
    id: Number(row.id),
    jid: String(row.jid),
    order_id: row.order_id ? Number(row.order_id) : null,
    message_id: row.message_id ? String(row.message_id) : null,
    image_url: String(row.image_url),
    part: String(row.part || ''),
    note: String(row.note || ''),
    box,
  }
}

// Bukti transfer bukan gambar model. Utama: penilaian AI yang melihat gambarnya
// (disimpan per gambar: bukti / lain). Gambar yang belum pernah dilihat AI (riwayat lama)
// memakai cadangan: caption ("tf", "bukti", …) atau dikirim ≤48 jam setelah toko kirim rekening.
const PROOF_CAPTION = /\b(tf|transfer|trf|bukti|bayar|dibayar|lunas|dp|struk|pelunasan)\b/i
const PAY_INFO = /rekening|no\.?\s*rek|transfer ke|atas nama|\ba\.\s?n\.|\b(bca|bri|bni|mandiri|bsi|dana|ovo|gopay|qris|seabank)\b/i
const PROOF_WINDOW = 48 * 3_600_000

/** Simpan penilaian AI untuk gambar giliran ini: bukti pembayaran atau bukan. */
export async function recordImageKinds(jid: string, imageIds: string[], proofIds: string[]) {
  if (!imageIds.length) return
  await ensureLeanTables()
  const proofs = new Set(proofIds)
  for (const id of imageIds.slice(0, 10))
    await db.rawQuery(
      `INSERT INTO whatsapp_beta3_proofs (message_id, jid, kind, created_at) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE kind = IF(kind = 'bukti', kind, VALUES(kind))`,
      [id, jid, proofs.has(id) ? 'bukti' : 'lain', new Date()]
    )
}

/** message_id gambar masuk di chat ini yang merupakan bukti transfer. */
export async function paymentProofIds(jid: string) {
  await ensureLeanTables()
  const [judged, images, payInfo] = await Promise.all([
    db.from('whatsapp_beta3_proofs').where('jid', jid).select('message_id', 'kind').catch(() => []),
    db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .where('media_type', 'image')
      .orderBy('id', 'desc')
      .limit(60)
      .select('message_id', 'body', 'created_at'),
    db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .whereNotNull('body')
      .orderBy('id', 'desc')
      .limit(200)
      .select('body', 'created_at'),
  ])
  const kinds = new Map<string, string>(judged.map((row: any) => [String(row.message_id), String(row.kind)]))
  const ids = new Set<string>([...kinds].filter(([, kind]) => kind === 'bukti').map(([id]) => id))
  const payTimes = payInfo
    .filter((row: any) => PAY_INFO.test(String(row.body || '')))
    .map((row: any) => new Date(row.created_at).getTime())
  for (const image of images as any[]) {
    const id = String(image.message_id)
    if (kinds.has(id)) continue // sudah dinilai AI
    const at = new Date(image.created_at).getTime()
    const afterPayInfo = payTimes.some((time) => at >= time && at - time <= PROOF_WINDOW)
    if (PROOF_CAPTION.test(String(image.body || '')) || afterPayInfo) ids.add(id)
  }
  return ids
}

async function withoutProofs(jid: string, refs: LeanRef[]) {
  if (!refs.some((ref) => ref.message_id)) return refs
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  return refs.filter((ref) => !ref.message_id || !proofs.has(ref.message_id))
}

/** Referensi pesanan yang sedang berjalan (belum menempel ke order lunas). */
export async function listActiveRefs(jid: string) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('jid', jid).whereNull('order_id').orderBy('id', 'asc')
  return withoutProofs(jid, rows.map(parseRow))
}

export async function refsForOrder(orderId: number) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('order_id', orderId).orderBy('id', 'asc')
  const refs = rows.map(parseRow)
  return refs.length ? withoutProofs(refs[0].jid, refs) : refs
}

export async function addRef(input: {
  jid: string
  imageUrl: string
  messageId?: string | null
  part?: string
  note?: string
  box?: unknown
}) {
  await ensureLeanTables()
  const now = new Date()
  const [id] = await db.table('whatsapp_beta3_refs').insert({
    jid: input.jid,
    message_id: input.messageId || null,
    image_url: input.imageUrl.slice(0, 1000),
    part: String(input.part || '').trim().slice(0, 80),
    note: String(input.note || '').trim().slice(0, 300),
    box: normalizeBox(input.box) ? JSON.stringify(normalizeBox(input.box)) : null,
    created_at: now,
    updated_at: now,
  })
  return Number(id)
}

/** Order lunas: referensi chat ini ikut ke order (dikirim ke grup bersama order). */
export async function attachRefsToOrder(jid: string, orderId: number) {
  await ensureLeanTables()
  await db
    .from('whatsapp_beta3_refs')
    .where('jid', jid)
    .whereNull('order_id')
    .update({ order_id: orderId, updated_at: new Date() })
}

/**
 * Referensi dari AI: `gambar` = nomor lampiran giliran ini (1..n). Gambar yang sama
 * dengan bagian yang sama diperbarui, bukan ditambah dobel.
 */
export async function saveAiRefs(
  jid: string,
  refs: Array<{ gambar: number; bagian: string }>,
  imageIds: string[]
) {
  if (!refs.length || !imageIds.length) return 0
  await ensureLeanTables()
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  let saved = 0
  for (const ref of refs.slice(0, 6)) {
    const messageId = imageIds[Math.round(ref.gambar) - 1]
    if (!messageId || proofs.has(messageId)) continue
    const message = await db
      .from('whatsapp_messages')
      .where('message_id', messageId)
      .whereNotNull('media_url')
      .select('media_url')
      .first()
    if (!message?.media_url) continue
    const part = String(ref.bagian || '').trim().slice(0, 80)
    const existing = await db
      .from('whatsapp_beta3_refs')
      .where('jid', jid)
      .whereNull('order_id')
      .where('message_id', messageId)
      .where('part', part)
      .first()
    if (!existing) await addRef({ jid, messageId, imageUrl: String(message.media_url), part })
    saved++
  }
  return saved
}

/** Gambar referensi apa adanya (resolusi asli) untuk dikirim ke grup produksi. */
export async function loadImage(url: string) {
  if (/^https?:\/\//i.test(url)) return downloadOutgoingImage(url)
  // Media chat tersimpan di public/media; URL-nya "<base>/media/<file>".
  return readFile(app.makePath('public', 'media', basename(url.split('?')[0])))
}

/** Caption singkat untuk penjahit: "Model kerah seperti ini". */
export function refCaption(ref: LeanRef) {
  const part = ref.part.trim().toLowerCase().replace(/^model\s*/, '')
  return part ? `Model ${part} seperti ini` : 'Model seperti ini'
}


/**
 * Cadangan bila order tidak punya foto katalog maupun referensi: gambar yang dikirim
 * pelanggan di percakapan order ini (7 hari sebelum order dibuat, setelah order
 * sebelumnya). Gambar setelah order dibuat dilewati karena biasanya bukti transfer.
 */
export async function customerImagesForOrder(order: Record<string, any>, limit = 4) {
  const jid = String(order.jid || '')
  if (!jid || !order.created_at) return []
  const createdAt = new Date(order.created_at)
  const previous = await db
    .from('whatsapp_beta3_orders')
    .where('jid', jid)
    .where('id', '<', Number(order.id))
    .orderBy('id', 'desc')
    .select('created_at')
    .first()
    .catch(() => null)
  const since = new Date(
    Math.max(createdAt.getTime() - 7 * 86_400_000, previous?.created_at ? new Date(previous.created_at).getTime() : 0)
  )
  const rows = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .where('media_type', 'image')
    .whereNotNull('media_url')
    .where('created_at', '>=', since)
    .where('created_at', '<=', createdAt)
    .orderBy('id', 'desc')
    .limit(limit + 6)
    .select('media_url', 'body', 'message_id')
    .catch(() => [])
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  const images = rows.filter((row: any) => !proofs.has(String(row.message_id))).slice(0, limit)
  return images.reverse().map((row: any) => ({
    url: String(row.media_url),
    caption: String(row.body || '').trim() || 'Model seperti ini',
  }))
}
