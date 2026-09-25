// Beta 3 — gambar referensi per bagian (kerah, saku, …) untuk tim produksi.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import app from '@adonisjs/core/services/app'
import sharp from 'sharp'
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

export async function updateRef(id: number, input: { part?: unknown; note?: unknown; box?: unknown }) {
  await ensureLeanTables()
  const values: Record<string, unknown> = { updated_at: new Date() }
  if (input.part !== undefined) values.part = String(input.part || '').trim().slice(0, 80)
  if (input.note !== undefined) values.note = String(input.note || '').trim().slice(0, 300)
  if (input.box !== undefined) {
    const box = normalizeBox(input.box)
    values.box = box ? JSON.stringify(box) : null
  }
  await db.from('whatsapp_beta3_refs').where('id', id).whereNull('order_id').update(values)
}

export async function removeRef(id: number) {
  await ensureLeanTables()
  await db.from('whatsapp_beta3_refs').where('id', id).whereNull('order_id').delete()
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
  refs: Array<{ gambar: number; bagian: string; catatan: string; kotak?: unknown }>,
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
    if (existing) await updateRef(Number(existing.id), { note: ref.catatan, box: ref.kotak })
    else
      await addRef({
        jid,
        messageId,
        imageUrl: String(message.media_url),
        part,
        note: ref.catatan,
        box: ref.kotak,
      })
    saved++
  }
  return saved
}

/** Gambar chat terakhir (masuk & keluar) untuk dipilih CS sebagai referensi. */
export async function recentChatImages(jid: string, limit = 12) {
  return db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('media_type', 'image')
    .whereNotNull('media_url')
    .orderBy('id', 'desc')
    .limit(limit)
    .select('message_id', 'media_url', 'direction', 'created_at')
}

async function loadImage(url: string) {
  if (/^https?:\/\//i.test(url)) return downloadOutgoingImage(url)
  // Media chat tersimpan di public/media; URL-nya "<base>/media/<file>".
  return readFile(app.makePath('public', 'media', basename(url.split('?')[0])))
}

/**
 * Gambar untuk grup produksi, resolusi asli: (1) gambar utuh dengan kotak merah,
 * (2) bagian yang ditandai diperbesar. Tanpa kotak → hanya gambar utuh.
 */
export async function renderRefImages(ref: LeanRef) {
  // Orientasi EXIF diterapkan dulu supaya koordinat kotak sesuai gambar yang terlihat.
  const source = await sharp(await loadImage(ref.image_url)).rotate().toBuffer()
  const base = sharp(source)
  const meta = await base.metadata()
  const width = meta.width || 0
  const height = meta.height || 0
  if (!ref.box || !width || !height) {
    return { marked: await base.jpeg({ quality: 92 }).toBuffer(), zoom: null as Buffer | null }
  }
  // Letak dari AI hanya perkiraan: kotak dilebarkan sedikit supaya bagiannya pasti
  // masuk, tanpa perlu CS menggeser.
  const [bx, by, bw, bh] = ref.box
  const grow = 0.12
  const x0 = Math.max(0, Math.round(((bx - bw * grow) / 1000) * width))
  const y0 = Math.max(0, Math.round(((by - bh * grow) / 1000) * height))
  const x = x0
  const y = y0
  const w = Math.max(8, Math.min(width - x0, Math.round(((bw * (1 + grow * 2)) / 1000) * width)))
  const h = Math.max(8, Math.min(height - y0, Math.round(((bh * (1 + grow * 2)) / 1000) * height)))
  const stroke = Math.max(4, Math.round(Math.min(width, height) * 0.008))
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#e11d2e" stroke-width="${stroke}" rx="${stroke}"/></svg>`
  )
  const marked = await sharp(source).composite([{ input: svg }]).jpeg({ quality: 92 }).toBuffer()
  // Perbesaran dengan sedikit ruang di sekitar bagian supaya konteksnya terbaca.
  const padX = Math.round(w * 0.3)
  const padY = Math.round(h * 0.3)
  const left = Math.max(0, x - padX)
  const top = Math.max(0, y - padY)
  const cropW = Math.min(width - left, w + padX * 2)
  const cropH = Math.min(height - top, h + padY * 2)
  let zoom = sharp(source).extract({ left, top, width: cropW, height: cropH })
  if (cropW < 900) zoom = zoom.resize({ width: 900, kernel: 'lanczos3' })
  return { marked, zoom: await zoom.jpeg({ quality: 92 }).toBuffer() }
}

export function refCaption(ref: LeanRef) {
  const part = ref.part ? ref.part.charAt(0).toUpperCase() + ref.part.slice(1) : 'Referensi'
  return `${part}: ${ref.note || 'samakan seperti foto'}${ref.box ? ' (yang ditandai merah)' : ''}`
}
