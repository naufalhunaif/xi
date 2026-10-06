// Beta 3 — gambar referensi per bagian (kerah, saku, …) untuk tim produksi.
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { ensureLeanTables } from '#beta3/tables'
import { imageIsPaymentProof } from '#beta3/jev_decisions'

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
  // Gambar yang sudah dipilah dari ISINYA (screenIncomingImage, v3.6.30) tidak ditimpa tebakan giliran.
  const judged = new Set<string>(
    (
      await db
        .from('whatsapp_beta3_proofs')
        .whereIn('message_id', imageIds.slice(0, 10))
        .where('note', '<>', '')
        .where('note', '<>', '?')
        .select('message_id')
        .catch(() => [])
    ).map((row: any) => String(row.message_id))
  )
  for (const [index, id] of imageIds.slice(0, 10).entries()) {
    if (judged.has(id)) continue
    const ref = refs.find((item) => item.gambar === index + 1)
    const kind = proofs.has(id) ? 'bukti' : ref ? (SIZE_PART.test(ref.bagian) ? 'ukuran' : 'model') : 'dilihat'
    await saveImageKind(jid, id, kind)
  }
}

/**
 * v3.6.30 — setiap gambar masuk dipilah dari ISINYA begitu filenya siap (mode AI maupun CS):
 * AI melihat gambar (jenis + keterangan), lalu Jev menilai "bukti pembayaran atau bukan" dari
 * keterangan + teks pelanggan. Bukan dari urutan "setelah rekening pasti bukti". Hasil Jev yang
 * yakin menang; selain itu jenis dari AI dipakai. Dipanggil listener di latar.
 */
export async function screenIncomingImage(jid: string, messageId: string, mediaUrl: string, caption = '') {
  await ensureLeanTables()
  const kinds = await classifyImages(jid, [{ message_id: messageId, media_url: mediaUrl }]).catch(() => new Map<string, string>())
  const kind = kinds.get(messageId)
  if (!kind) return null
  const row = await db.from('whatsapp_beta3_proofs').where('message_id', messageId).first().catch(() => null)
  const note = String(row?.note || '')
  const order = await db
    .from('whatsapp_beta3_orders')
    .where('jid', jid)
    .whereIn('status', ['awaiting_payment', 'paid'])
    .orderBy('id', 'desc')
    .first()
    .catch(() => null)
  const awaiting = Boolean(order) && (order.status === 'awaiting_payment' || Number(order.paid_amount || 0) < Number(order.total || 0))
  const verdict = await imageIsPaymentProof({ jid, kind, note, customerText: caption, awaitingPayment: awaiting }).catch(() => undefined)
  const final = verdict === true ? 'bukti' : verdict === false && kind === 'bukti' ? 'lain' : kind
  // Hasil pilah isi (+Jev) menang atas tebakan giliran AI yang mungkin sudah tersimpan ("bukti" lengket).
  if (String(row?.kind || '') !== final)
    await db.from('whatsapp_beta3_proofs').where('message_id', messageId).update({ kind: final }).catch(() => {})
  return { kind: final, note, jev: verdict }
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
        'Satu keterangan per gambar (maks 15 kata), urut sesuai lampiran: nama produk yang tertulis di gambar lalu ciri pakaian (warna, kerah, kancing). JANGAN tulis harga dari gambar (bisa kedaluwarsa; harga selalu dari katalog). Bukti transfer = nominal dan tujuan; tabel ukuran = "size chart" + label kolomnya.',
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
      // Harga di gambar (poster lama) tidak dipakai; bukti transfer tetap menyimpan nominal.
      let note = String(parsed.keterangan?.[index] || '').replace(/\s+/g, ' ').trim()
      if (kind !== 'bukti')
        note = note
          .replace(/\b(?:harga|idr|rp\.?)\s*:?\s*\d[\d.,]*(?:\s*(?:rb|ribu|k)\b)?/gi, '')
          .replace(/\b\d{1,3}(?:[.,]\d{3})+\b/g, '')
          .replace(/\s*,\s*(,|$)/g, '$1')
          .replace(/\s+/g, ' ')
          .trim()
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
 * v3.6.52 — gambar yang dikirim CS (web atau HP) adalah produk yang DITAWARKAN toko ("ada seperti
 * ini bos"). Dulu tidak pernah dilihat AI, sehingga sebutan pelanggan ("ash grey") dipakai sebagai
 * produk. Kini dicocokkan sekali ke KATALOG; hasilnya tampil di riwayat sebagai
 * "contoh dari toko: <Produk> - <Warna>". Tidak cocok → keterangan ciri saja.
 */
export const STORE_IMAGE_SCHEMA = {
  type: 'object',
  properties: {
    produk: {
      type: 'array',
      description:
        'Satu per gambar, urut sesuai lampiran: "Produk - Warna" PERSIS dari daftar KATALOG yang paling cocok (model & warna), atau "" bila tidak yakin / bukan foto pakaian.',
      items: { type: 'string' },
    },
    keterangan: {
      type: 'array',
      description: 'Satu per gambar (maks 12 kata): ciri pakaian (warna, kerah, kancing, bahan doff/kilap). Tanpa harga.',
      items: { type: 'string' },
    },
  },
  required: ['produk', 'keterangan'],
  additionalProperties: false,
} as const

/** Daftar katalog ringkas untuk pencocokan foto: satu baris per produk, warnanya dipisah koma. */
export function storeImageCatalog(rows: Array<{ product: string; color: string; material?: string; active?: boolean }>) {
  const byProduct = new Map<string, Set<string>>()
  for (const row of rows) {
    if (row.active === false) continue
    const key = `${row.product}${row.material ? ` [bahan ${row.material}]` : ''}`
    if (!byProduct.has(key)) byProduct.set(key, new Set())
    byProduct.get(key)!.add(row.color)
  }
  return [...byProduct].map(([product, colors]) => `${product}: ${[...colors].join(', ')}`).join('\n').slice(0, 9000)
}

/** Teks catatan gambar CS: produk katalog yang cocok (nama persis) atau ciri saja. */
export function storeImageNote(
  match: { product: string; color: string } | undefined,
  description: string
) {
  const ciri = String(description || '').replace(/\b\d{1,3}(?:[.,]\d{3})+\b/g, '').replace(/\s+/g, ' ').trim()
  if (match) return `contoh dari toko: ${match.product} - ${match.color}`.slice(0, 200)
  return ciri ? `contoh dari toko (tidak cocok katalog): ${ciri}`.slice(0, 200) : 'contoh dari toko'
}

const storeClassifying = new Set<string>()
export async function classifyStoreImages(jid: string, rows: Array<{ message_id: string; media_url: string }>) {
  const todo = rows.filter((row) => row.media_url && !storeClassifying.has(row.message_id)).slice(0, 3)
  if (!todo.length) return
  todo.forEach((row) => storeClassifying.add(row.message_id))
  try {
    const paths = todo.map((row) => app.makePath('public', 'media', basename(String(row.media_url).split('?')[0])))
    const [{ runLeanProvider }, { readSettings }, { catalogDigest, findCatalogVariant }] = await Promise.all([
      import('#beta3/provider'),
      import('#services/settings_service'),
      import('#beta3/catalog_service'),
    ])
    const [raw, digest] = await Promise.all([readSettings(true), catalogDigest()])
    const result = await runLeanProvider(
      { ...raw, aiProvider: raw.aiProvider === 'claude' ? 'claude' : 'chatgpt' } as any,
      {
        system:
          'Gambar-gambar ini dikirim CS toko jas ke pelanggan sebagai contoh produk yang ditawarkan. Cocokkan tiap gambar dengan produk & warna di KATALOG (model dan warna paling mirip). Jawab hanya JSON sesuai schema.',
        user: `KATALOG (Produk [bahan]: warna, …):\n${storeImageCatalog(digest.rows)}\n\nAda ${todo.length} gambar terlampir, urut.`,
      },
      paths,
      'beta3-image',
      STORE_IMAGE_SCHEMA,
      { jid }
    )
    const parsed = JSON.parse(result.text) as { produk?: string[]; keterangan?: string[] }
    for (const [index, row] of todo.entries()) {
      const label = String(parsed.produk?.[index] || '').trim()
      const match = label ? findCatalogVariant(digest.rows, label) : undefined
      await saveImageKind(jid, row.message_id, 'contoh', storeImageNote(match, String(parsed.keterangan?.[index] || '')))
    }
  } catch {
    // Gagal dilihat: tandai agar tidak dicoba terus; riwayat tetap "[image]".
    for (const row of todo) await saveImageKind(jid, row.message_id, 'contoh', '?').catch(() => {})
  } finally {
    todo.forEach((row) => storeClassifying.delete(row.message_id))
  }
}

/**
 * Keterangan gambar pelanggan untuk riwayat AI ("[image: Peak Suit Black, harga 450.000]").
 * Gambar yang belum punya keterangan dilihat AI (maks 4, terbaru), ditunggu sebentar saja;
 * yang belum selesai tetap diproses di latar untuk giliran berikutnya.
 */
export async function imageNotes(
  jid: string,
  rows: Array<{ message_id: string; media_url?: string | null; media_type?: string | null; direction?: string; sender_type?: string | null }>,
  skip: Set<string> = new Set(),
  waitMs = 15_000
) {
  await ensureLeanTables()
  const isStore = (row: { direction?: string; sender_type?: string | null }) =>
    row.direction === 'out' && ['cs', 'owner'].includes(String(row.sender_type || ''))
  const images = rows.filter((row) => (row.direction === 'in' || isStore(row)) && row.media_type === 'image' && row.message_id)
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
  const unseen = images.filter((row) => !skip.has(String(row.message_id)) && row.media_url && !known.get(String(row.message_id))?.note)
  const missing = unseen
    .filter((row) => !isStore(row))
    .slice(-4)
    .map((row) => ({ message_id: String(row.message_id), media_url: String(row.media_url) }))
  const storeMissing = unseen
    .filter(isStore)
    .slice(-3)
    .map((row) => ({ message_id: String(row.message_id), media_url: String(row.media_url) }))
  if (missing.length || storeMissing.length) {
    // Berurutan (bukan bersamaan): satu proses AI pada satu waktu, hemat RAM server kecil.
    const jobs = (async () => {
      if (missing.length) await classifyImages(jid, missing).catch(() => null)
      if (storeMissing.length) await classifyStoreImages(jid, storeMissing).catch(() => null)
    })()
    await Promise.race([jobs, new Promise((resolve) => setTimeout(resolve, waitMs))])
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
  // v3.6.30: gambar yang belum dipilah tidak lagi ditebak dari waktu ("setelah rekening") — hanya
  // caption pelanggan yang tegas ("ini bukti tf") yang dihitung, sampai pemilahan isi selesai.
  void payInfo
  void PAY_INFO
  void PROOF_WINDOW
  for (const image of images as any[]) {
    const id = String(image.message_id)
    if (kinds.has(id)) continue // sudah dilihat AI (bukan bukti bila tidak ditandai)
    if (PROOF_CAPTION.test(String(image.body || ''))) ids.add(id)
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


/**
 * Gambar bukti transfer untuk order yang menunggu pembayaran: gambar pelanggan sejak order
 * dibuat yang dikenali sebagai bukti, atau dikirim setelah total. Gambar yang belum terunduh
 * penuh memakai thumbnail-nya.
 */
export async function orderProofImages(jid: string, order: { created_at: unknown; updated_at: unknown }) {
  const totalAt = new Date(String(order.updated_at)).getTime()
  // Order dari form terlewat bisa tercatat belakangan: mulai dari yang lebih awal.
  const since = new Date(Math.min(new Date(String(order.created_at)).getTime(), totalAt))
  const [rows, ids] = await Promise.all([
    db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .where('media_type', 'image')
      .where('created_at', '>=', since)
      .orderBy('id', 'desc')
      .limit(8)
      .select('message_id', 'media_url', 'thumbnail_url', 'created_at'),
    paymentProofIds(jid).catch(() => new Set<string>()),
  ])
  return rows
    .filter((row: any) => ids.has(String(row.message_id)) || new Date(row.created_at).getTime() > totalAt)
    .map((row: any) => ({ media_url: String(row.media_url || row.thumbnail_url || '') }))
    .filter((row) => row.media_url)
    .slice(0, 3)
}

/** Nominal di keterangan bukti transfer ("transfer Rp250.000 ke …") — angka ribuan terbesar. */
export function proofAmount(note: string) {
  const values = (String(note || '').match(/\d{1,3}(?:[.,]\d{3})+/g) || []).map((part) => Number(part.replace(/[.,]/g, '')))
  return values.length ? Math.max(...values) : 0
}

/**
 * Jumlah nominal bukti transfer pelanggan sejak `since` (dibaca AI dari gambarnya).
 * Gambar bukti yang belum punya keterangan dilihat dulu (maks 4). 0 = tidak terbaca.
 */
export async function proofTotalSince(jid: string, since: Date) {
  await ensureLeanTables()
  const images = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .where('media_type', 'image')
    .whereNotNull('media_url')
    .where('created_at', '>=', since)
    .orderBy('id', 'asc')
    .limit(12)
    .select('message_id', 'media_url')
  if (!images.length) return 0
  const ids = images.map((row: any) => String(row.message_id))
  const known = async () =>
    new Map<string, { kind: string; note: string }>(
      (await db.from('whatsapp_beta3_proofs').whereIn('message_id', ids).select('message_id', 'kind', 'note')).map(
        (row: any) => [String(row.message_id), { kind: String(row.kind), note: String(row.note || '') }]
      )
    )
  let rows = await known()
  const proofs = await paymentProofIds(jid).catch(() => new Set<string>())
  // Belum dinilai, atau bukti tanpa nominal: dilihat AI (jenis + keterangan).
  const unclear = images.filter((row: any) => {
    const item = rows.get(String(row.message_id))
    return !item || item.kind === 'dilihat' || (item.kind === 'bukti' && !proofAmount(item.note)) || (!item && proofs.has(String(row.message_id)))
  })
  if (unclear.length) {
    await classifyImages(jid, unclear.slice(0, 4).map((row: any) => ({ message_id: String(row.message_id), media_url: String(row.media_url) }))).catch(() => null)
    rows = await known()
  }
  let total = 0
  for (const id of ids) {
    const item = rows.get(id)
    if (item?.kind === 'bukti') total += proofAmount(item.note)
  }
  return total
}
