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

/**
 * Simpan penilaian AI balasan untuk gambar giliran ini: bukti, model/ukuran (ditandai
 * referensi), atau "dilihat" (tidak ditandai; jenisnya dicek lagi bila dibutuhkan).
 */
export async function recordImageKinds(
  jid: string,
  imageIds: string[],
  proofIds: string[],
  refs: Array<{ gambar: number; bagian: string }> = []
) {
  if (!imageIds.length) return
  await ensureLeanTables()
  const proofs = new Set(proofIds)
  for (const [index, id] of imageIds.slice(0, 10).entries()) {
    const ref = refs.find((item) => item.gambar === index + 1)
    const kind = proofs.has(id) ? 'bukti' : ref ? (SIZE_PART.test(ref.bagian) ? 'ukuran' : 'model') : 'dilihat'
    await saveImageKind(jid, id, kind)
  }
}

async function saveImageKind(jid: string, id: string, kind: string, note = '') {
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_proofs (message_id, jid, kind, note, created_at) VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE kind = IF(kind = 'bukti', kind, VALUES(kind)),
       note = IF(VALUES(note) <> '', VALUES(note), note)`,
    [id, jid, kind, note.slice(0, 200), new Date()]
  )
}

const IMAGE_KIND_SCHEMA = {
  type: 'object',
  properties: {
    jenis: {
      type: 'array',
      description:
        'Satu jenis per gambar, urut sesuai lampiran. model = foto/screenshot pakaian sebagai contoh model; ukuran = tabel ukuran/size chart/catatan ukuran; bukti = bukti transfer/pembayaran; lain = selain itu.',
      items: { type: 'string', enum: ['model', 'ukuran', 'bukti', 'lain'] },
    },
    keterangan: {
      type: 'array',
      description:
        'Satu keterangan per gambar (maks 15 kata), urut sesuai lampiran: tulisan penting di gambar (nama produk, warna, harga) lalu ciri pakaian (warna, kerah, kancing); bukti transfer = nominal dan tujuan; tabel ukuran = "size chart" + label kolomnya.',
      items: { type: 'string' },
    },
  },
  required: ['jenis', 'keterangan'],
  additionalProperties: false,
}

const classifying = new Set<string>()
/** AI melihat gambar yang belum jelas jenisnya (maks 4 per panggilan); jenis + keterangan disimpan. */
export async function classifyImages(jid: string, rows: Array<{ message_id: string; media_url: string }>) {
  const todo = rows.filter((row) => row.media_url && !classifying.has(row.message_id)).slice(0, 4)
  if (!todo.length) return new Map<string, string>()
  todo.forEach((row) => classifying.add(row.message_id))
  try {
    const paths = todo.map((row) => app.makePath('public', 'media', basename(String(row.media_url).split('?')[0])))
    const [{ runLeanProvider }, { readSettings }] = await Promise.all([
      import('#beta3/provider'),
      import('#services/settings_service'),
    ])
    const raw = await readSettings(true)
    const result = await runLeanProvider(
      { ...raw, aiProvider: raw.aiProvider === 'claude' ? 'claude' : 'chatgpt' } as any,
      {
        system:
          'Kamu memilah gambar yang dikirim pelanggan toko jas untuk tim produksi. Baca tulisan di gambar dengan teliti (nama produk bisa tertulis di gambar). Jawab hanya JSON sesuai schema.',
        user: `Ada ${todo.length} gambar terlampir. Tentukan jenis dan keterangan tiap gambar sesuai urutan.`,
      },
      paths,
      'beta3-image',
      IMAGE_KIND_SCHEMA
    )
    const parsed = JSON.parse(result.text) as { jenis?: string[]; keterangan?: string[] }
    const kinds = new Map<string, string>()
    for (const [index, row] of todo.entries()) {
      const kind = String(parsed.jenis?.[index] || '')
      if (!['model', 'ukuran', 'bukti', 'lain'].includes(kind)) continue
      kinds.set(row.message_id, kind)
      const note = String(parsed.keterangan?.[index] || '').replace(/\s+/g, ' ').trim()
      await saveImageKind(jid, row.message_id, kind, note)
    }
    return kinds
  } catch (error) {
    // Gagal dilihat (AI tidak tersedia): tandai "?" agar balasan berikutnya tidak menunggu lagi.
    for (const row of todo)
      await db
        .rawQuery(
          `INSERT INTO whatsapp_beta3_proofs (message_id, jid, kind, note, created_at) VALUES (?, ?, 'dilihat', '?', ?)
           ON DUPLICATE KEY UPDATE note = IF(note = '', '?', note)`,
          [row.message_id, jid, new Date()]
        )
        .catch(() => {})
    throw error
  } finally {
    todo.forEach((row) => classifying.delete(row.message_id))
  }
}

/**
 * Keterangan gambar pelanggan untuk riwayat AI ("[image: Peak Suit Black, harga 450.000]").
 * Gambar yang belum punya keterangan dilihat AI (maks 4, terbaru), ditunggu sebentar saja;
 * yang belum selesai tetap diproses di latar untuk giliran berikutnya.
 */
export async function imageNotes(
  jid: string,
  rows: Array<{ message_id: string; media_url?: string | null; media_type?: string | null; direction?: string }>,
  skip: Set<string> = new Set(),
  waitMs = 15_000
) {
  await ensureLeanTables()
  const images = rows.filter((row) => row.direction === 'in' && row.media_type === 'image' && row.message_id)
  if (!images.length) return new Map<string, string>()
  const load = async () =>
    new Map<string, { kind: string; note: string }>(
      (
        await db
          .from('whatsapp_beta3_proofs')
          .whereIn('message_id', images.map((row) => String(row.message_id)))
          .select('message_id', 'kind', 'note')
          .catch(() => [])
      ).map((row: any) => [String(row.message_id), { kind: String(row.kind), note: String(row.note || '') }])
    )
  let known = await load()
  const missing = images
    .filter((row) => !skip.has(String(row.message_id)) && row.media_url && !known.get(String(row.message_id))?.note)
    .slice(-4)
    .map((row) => ({ message_id: String(row.message_id), media_url: String(row.media_url) }))
  if (missing.length) {
    const job = classifyImages(jid, missing).catch(() => null)
    await Promise.race([job, new Promise((resolve) => setTimeout(resolve, waitMs))])
    known = await load()
  }
  const label = { bukti: 'bukti transfer', ukuran: 'tabel ukuran' } as Record<string, string>
  return new Map<string, string>(
    [...known].map(([id, row]) => [id, [label[row.kind] || '', row.note === '?' ? '' : row.note].filter(Boolean).join(': ')])
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
    if (kinds.has(id)) continue // sudah dilihat AI (bukan bukti bila tidak ditandai)
    const at = new Date(image.created_at).getTime()
    const afterPayInfo = payTimes.some((time) => at >= time && at - time <= PROOF_WINDOW)
    if (PROOF_CAPTION.test(String(image.body || '')) || afterPayInfo) ids.add(id)
  }
  return ids
}

// Gambar tabel ukuran hanya ikut bila pelanggan memakai ukurannya sendiri: spesifikasi
// (ditulis ulang AI tiap giliran) menyebut "Ukuran sesuai gambar". Hanya membandingkan
// atau akhirnya pakai ukuran toko → tidak ikut ke data pesanan/grup.
const SIZE_PART = /ukuran|size|tabel|chart|lingkar/i
const SIZE_USED = /ukuran\s+(sesuai|dari|seperti)\s+(gambar|tabel|foto)|ukuran\s+pelanggan\s+sendiri/i

async function withoutProofs(jid: string, refs: LeanRef[], spec?: string | null) {
  if (!refs.length) return refs
  const sizeUsed = SIZE_USED.test(String(spec || ''))
  refs = refs.filter((ref) => sizeUsed || !SIZE_PART.test(ref.part))
  if (!refs.some((ref) => ref.message_id)) return refs
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  return refs.filter((ref) => !ref.message_id || !proofs.has(ref.message_id))
}

/** Referensi pesanan yang sedang berjalan (belum menempel ke order lunas). */
export async function listActiveRefs(jid: string) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('jid', jid).whereNull('order_id').orderBy('id', 'asc')
  const spec = await db.from('whatsapp_beta3_specs').where('jid', jid).select('spec').first().catch(() => null)
  return withoutProofs(jid, rows.map(parseRow), spec?.spec)
}

export async function refsForOrder(orderId: number) {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_refs').where('order_id', orderId).orderBy('id', 'asc')
  const refs = rows.map(parseRow)
  if (!refs.length) return refs
  const order = await db.from('whatsapp_beta3_orders').where('id', orderId).select('spec').first().catch(() => null)
  return withoutProofs(refs[0].jid, refs, order?.spec)
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
  if (SIZE_PART.test(part)) return 'Ukuran sesuai gambar ini'
  return part ? `Model ${part} seperti ini` : 'Model seperti ini'
}


/**
 * Cadangan bila order tidak punya foto katalog maupun referensi: gambar yang dikirim
 * pelanggan di percakapan order ini (7 hari sebelum order dibuat, setelah order
 * sebelumnya). Gambar setelah order dibuat dilewati karena biasanya bukti transfer.
 */
export async function customerImagesForOrder(
  order: Record<string, any>,
  limit = 4,
  options: { classify?: boolean } = {}
) {
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
  // Hanya gambar model (dan tabel ukuran bila pelanggan memakai ukurannya sendiri).
  // Jenis gambar dari AI: saat membalas, atau dilihat khusus di sini bila belum jelas.
  // `classify` false (halaman order): tidak menunggu AI; pemeriksaan jalan di latar.
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  const stored = new Map<string, string>(
    (await db.from('whatsapp_beta3_proofs').where('jid', jid).select('message_id', 'kind').catch(() => [])).map(
      (row: any) => [String(row.message_id), String(row.kind)]
    )
  )
  const candidates = rows.filter((row: any) => !proofs.has(String(row.message_id)))
  const unclear = candidates.filter((row: any) => {
    const kind = stored.get(String(row.message_id))
    return !kind || kind === 'dilihat'
  })
  if (unclear.length) {
    const job = classifyImages(jid, unclear.map((row: any) => ({ message_id: String(row.message_id), media_url: String(row.media_url) })))
    if (options.classify) {
      const kinds = await job.catch(() => new Map<string, string>())
      for (const [id, kind] of kinds) stored.set(id, kind)
    } else void job.catch(() => {})
  }
  const sizeUsed = SIZE_USED.test(String(order.spec || ''))
  const images = candidates
    .filter((row: any) => {
      const kind = stored.get(String(row.message_id))
      if (kind === 'model') return true
      if (kind === 'ukuran') return sizeUsed
      if (kind === 'bukti' || kind === 'lain') return false
      return !kind // belum pernah dinilai (AI tidak tersedia): tetap tampil
    })
    .slice(0, limit)
  return images.reverse().map((row: any) => ({
    url: String(row.media_url),
    // Teks chat pelanggan (mis. "size L masih ada?") bukan keterangan model.
    caption: 'Model seperti ini',
  }))
}
