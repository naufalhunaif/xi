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

/** Referensi pesanan yang sedang berjalan (belum menempel ke order lunas). */
export async function listActiveRefs(jid: string) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('jid', jid).whereNull('order_id').orderBy('id', 'asc')
  return rows.map(parseRow)
}

export async function refsForOrder(orderId: number) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('order_id', orderId).orderBy('id', 'asc')
  return rows.map(parseRow)
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
  let saved = 0
  for (const ref of refs.slice(0, 6)) {
    const messageId = imageIds[Math.round(ref.gambar) - 1]
    if (!messageId) continue
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
  const part = ref.part.trim().toLowerCase().replace(/^model\s+/, '')
  return part ? `Model ${part} seperti ini` : 'Model seperti ini'
}

