// Beta 3 — alur AI CS. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import { ensureLeanTables } from '#beta3/tables'
import { workspaceScope } from '#services/workspace_context'

/**
 * Contoh jawaban CS asli. Ini cara AI "belajar": bukan aturan yang terus
 * bertambah, melainkan 6–8 contoh paling mirip yang ditempel ke prompt.
 */
export type LeanExample = {
  id?: number
  situation: string
  customerText: string
  csText: string
  tags: string
  source?: string
}

const STOPWORDS = new Set(
  'yang di ke dari dan atau ada mau bos om kak min mas kalo kalau saja aja ya yaa nya untuk itu ini sama dong deh sih gimana bagaimana apa berapa brp brapa piro bisa boleh saya aku kami kita nih ok oke siap iya'.split(
    ' '
  )
)

/**
 * v3.7.0 — singkatan chat disamakan ("hrg" = harga, "size" = ukuran) dan akhiran "-nya" dibuang ("hitamnya" = hitam)
 * supaya pesan pendek tetap menemukan contoh CS. "berapa/brp" tetap kata umum (bisa harga, hari, ongkir); topik
 * harga sudah dinilai lewat topicsOf.
 */
const SLANG: Record<string, string> = {
  hrg: 'harga', pricelist: 'harga',
  ukrn: 'ukuran', size: 'ukuran', uk: 'ukuran',
  wrn: 'warna', ongkos: 'ongkir',
  tf: 'transfer', trf: 'transfer', rek: 'rekening', norek: 'rekening',
  stok: 'ready', stock: 'ready', redy: 'ready',
  blazer: 'jas', suit: 'jas', stelan: 'setelan', pants: 'celana', rompi: 'vest', bescap: 'beskap',
  kustom: 'custom', costum: 'custom',
}

export function keywords(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .map((word) => (word.length > 5 ? word.replace(/nya$/, '') : word))
        .map((word) => SLANG[word] || word)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    ),
  ]
}

export const PRODUCT_WORDS = /\b(jas|blazer|suit|setelan|stelan|celana|pants|beskap|bescap|tuxedo|vest|rompi|kemeja|shirt|jaket|batik)\b/g
export const TOPIC_WORDS: Array<[string, RegExp]> = [
  ['harga', /\b(harga|hrg|brp|berapa|brapa|piro|total|diskon|promo|nego|budget)\b/i],
  ['ukuran', /\b(size|ukuran|ukrn|tinggi|berat|tb|bb|xs|s|m|l|xl|xxl|[2-5]xl|lingkar|dada|pinggang|bahu)\b/i],
  ['warna', /\b(warna|wrn|hitam|item|navy|dongker|putih|cream|krem|maroon|marun|abu|grey|gray|coklat|choco|brown|biru|hijau|army|gold)\b/i],
  ['custom', /\b(custom|kancing|kerah|model|detail|bordir|request|ankle|slim)\b/i],
  ['kirim', /\b(ongkir|kirim|alamat|resi|jne|ekspedisi|sampai|paket)\b/i],
  ['bayar', /\b(bayar|tf|transfer|rekening|rek|dp|lunas|pembayaran|cod)\b/i],
  ['waktu', /\b(kapan|lama|hari|tgl|tanggal|jadi|selesai|proses|pre ?order|po|ready|stok)\b/i],
  ['foto', /\b(foto|gambar|pic|contoh|realpic|lihat|liat)\b/i],
]
export const topicsOf = (text: string) => new Set(TOPIC_WORDS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name))
export const productsOf = (text: string) =>
  new Set(
    (text.toLowerCase().match(PRODUCT_WORDS) || []).map((word) =>
      word.replace(/^(stelan)$/, 'setelan').replace(/^(blazer|suit)$/, 'jas').replace(/^(pants)$/, 'celana').replace(/^(bescap)$/, 'beskap').replace(/^(rompi)$/, 'vest').replace(/^(shirt)$/, 'kemeja')
    )
  )

/** Skor kemiripan sederhana: irisan kata kunci pesan pelanggan + situasi + tag. */
export function scoreExample(example: LeanExample, messageWords: string[], stage = '') {
  const own = new Set(
    keywords(`${example.customerText} ${example.situation} ${example.tags.replace(/,/g, ' ')}`)
  )
  let score = messageWords.filter((word) => own.has(word)).length
  if (stage && example.tags.split(',').some((tag) => tag.trim() === stage)) score += 1.5
  return score
}

/** Contoh dari chat CS asli toko (bukan contoh bawaan/uji). */
const isReal = (example: LeanExample) => ['riwayat', 'takeover', 'chat-nyata'].includes(String(example.source || ''))
const foldReply = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

export function pickExamples(
  examples: LeanExample[],
  message: string,
  stage = '',
  limit = 8,
  context = ''
): LeanExample[] {
  const words = keywords(message)
  // v3.7.0 — situasi ikut dinilai: produk & topik yang sama, dan percakapan sebelumnya (pesan toko terakhir) mirip.
  const products = productsOf(`${message}\n${context}`)
  const topics = topicsOf(message)
  const contextWords = keywords(context)
  const scored = examples
    .map((example) => {
      let score = scoreExample(example, words, stage)
      if (score > 0 || isReal(example)) {
        score += 0.5 * [...productsOf(example.customerText)].filter((word) => products.has(word)).length
        score += 0.5 * [...topicsOf(example.customerText)].filter((topic) => topics.has(topic)).length
        if (contextWords.length && example.situation) {
          const own = new Set(keywords(example.situation))
          score += 0.5 * Math.min(2, contextWords.filter((word) => own.has(word)).length)
        }
      }
      // Koreksi pemilik didahulukan bila relevan.
      return { example, score: score > 0 && example.source === 'koreksi' ? score + 2 : score }
    })
    .sort((a, b) => b.score - a.score || (a.example.id || 0) - (b.example.id || 0))
  // v3.6.87: contoh dari riwayat chat (ribuan) hanya dipakai bila cukup mirip (≥ 2).
  const relevant = (item: { example: LeanExample; score: number }) => (item.example.source === 'riwayat' ? item.score >= 2 : item.score > 0)
  // v3.7.0: maks 5 contoh riwayat (dulu 4); jawaban yang sama persis cukup sekali.
  let history = 0
  const seen = new Set<string>()
  const chosen = scored
    .filter(relevant)
    .filter((item) => {
      const key = foldReply(item.example.csText)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .filter((item) => item.example.source !== 'riwayat' || ++history <= 5)
    .slice(0, limit)
  // Sudah ada contoh chat asli yang mirip → contoh bawaan hanya yang benar-benar mirip (≥ 2), bukan sekadar satu kata sama.
  if (chosen.some((item) => isReal(item.example)))
    for (let index = chosen.length - 1; index >= 0; index--)
      if (!isReal(chosen[index].example) && chosen[index].example.source !== 'koreksi' && chosen[index].score < 2) chosen.splice(index, 1)
  // Kalau pesan terlalu pendek untuk dicocokkan, tetap beri contoh tahap saat ini (tidak perlu bila sudah ada chat asli yang mirip).
  if (chosen.length < 3 && !chosen.some((item) => isReal(item.example)))
    for (const item of scored) {
      if (chosen.length >= 3) break
      if (!chosen.includes(item) && item.example.source !== 'riwayat') chosen.push(item)
    }
  // Chat CS asli toko lebih dulu dari contoh bawaan.
  return chosen.map((item) => item.example).sort((a, b) => Number(isReal(b)) - Number(isReal(a)))
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text)

/**
 * v3.7.0 — balasan CS ditampilkan utuh per bubble (dulu dipotong 220 huruf jadi satu baris), dengan percakapan
 * sebelumnya bila ada, supaya AI melihat cara CS memisah bubble dan kenapa CS menjawab begitu.
 */
export function renderExamples(examples: LeanExample[]) {
  if (!examples.length) return ''
  return [
    'CONTOH JAWABAN CS ASLI (tiru nada, panjang, pemisahan bubble, dan satu langkah berikut; harga/stok tetap KATALOG):',
    ...examples.map((example, index) => {
      // Chat asli tampil lebih panjang; contoh bawaan/manual tetap ringkas.
      const real = isReal(example)
      const bubbles = String(example.csText || '')
        .split(/\n+/)
        .map((bubble) => bubble.trim())
        .filter(Boolean)
        .slice(0, 4)
        .map((bubble) => `   CS: ${clip(bubble, real ? 300 : 220)}`)
      return `${index + 1}. ${example.situation ? `[${example.situation}] ` : ''}Pelanggan: ${clip(example.customerText.replace(/\n+/g, ' / '), real ? 300 : 160)}\n${bubbles.join('\n')}`
    }),
  ].join('\n')
}

/** v3.7.0 — daftar contoh di-cache 60 dtk per workspace (dulu dibaca penuh tiap giliran); diperbarui saat ada perubahan. */
const exampleCache = new Map<string, { at: number; rows: LeanExample[] }>()
const EXAMPLE_CACHE_MS = 60_000
export function clearExampleCache() {
  exampleCache.clear()
}

export async function listLeanExamples(): Promise<LeanExample[]> {
  const key = workspaceScope().prefix
  const cached = exampleCache.get(key)
  if (cached && Date.now() - cached.at < EXAMPLE_CACHE_MS) return [...cached.rows]
  const rows = await readLeanExamples()
  exampleCache.set(key, { at: Date.now(), rows })
  return [...rows]
}

async function readLeanExamples(): Promise<LeanExample[]> {
  await ensureLeanTables()
  await compactTakeoverExamples(workspaceScope().prefix).catch(() => {})
  const rows = await db.from('whatsapp_beta3_examples').where('active', 1).orderBy('id', 'asc')
  return rows.map((row) => ({
    id: Number(row.id),
    situation: String(row.situation || ''),
    customerText: String(row.customer_text),
    csText: String(row.cs_text),
    tags: String(row.tags || ''),
    source: String(row.source || 'seed'),
  }))
}

export async function addLeanExample(example: LeanExample) {
  await ensureLeanTables()
  const customerText = example.customerText.trim().slice(0, 2000)
  const csText = example.csText.trim().slice(0, 2000)
  if (!customerText || !csText)
    throw new Error('Contoh harus berisi pesan pelanggan dan jawaban CS.')
  const [id] = await db.table('whatsapp_beta3_examples').insert({
    situation: example.situation.trim().slice(0, 255),
    customer_text: customerText,
    cs_text: csText,
    tags: example.tags.trim().slice(0, 255),
    source: (example.source || 'manual').slice(0, 20),
    active: 1,
    created_at: new Date(),
  })
  clearExampleCache()
  return Number(id)
}

/** v3.6.163 — koreksi jawaban/situasi contoh (pemilik membenarkan koreksi uji). */
export async function updateLeanExample(id: number, patch: { situation?: string; csText?: string; customerText?: string }) {
  await ensureLeanTables()
  const data: Record<string, string> = {}
  if (patch.situation !== undefined) data.situation = String(patch.situation).trim().slice(0, 255)
  if (patch.csText !== undefined) data.cs_text = String(patch.csText).trim().slice(0, 2000)
  if (patch.customerText !== undefined) data.customer_text = String(patch.customerText).trim().slice(0, 2000)
  if (!Object.keys(data).length) return false
  const changed = await db.from('whatsapp_beta3_examples').where('id', id).update(data)
  clearExampleCache()
  return Number(changed) > 0
}

export async function removeLeanExample(id: number) {
  await ensureLeanTables()
  await db.from('whatsapp_beta3_examples').where('id', id).update({ active: 0 })
  clearExampleCache()
}

/** Isi contoh bawaan sekali saja bila tabel masih kosong. */
export async function seedLeanExamples() {
  await ensureLeanTables()
  const existing = await db.from('whatsapp_beta3_examples').count('* as total').first()
  if (Number(existing?.total || 0) > 0) return 0
  return syncSeedExamples()
}

/** Tambahkan contoh dari file seed yang belum ada di tabel (dicocokkan per pasangan teks). */
export async function syncSeedExamples() {
  await ensureLeanTables()
  // Ikut disalin ke build lewat metaFiles (adonisrc.ts), sehingga path root berlaku di dev maupun current.
  const file = app.makePath('resources/beta3/cs_examples.json')
  const list = JSON.parse(await readFile(file, 'utf8')) as LeanExample[]
  const rows = await db.from('whatsapp_beta3_examples').select('customer_text', 'cs_text')
  const known = new Set(
    rows.map((row) => `${String(row.customer_text).trim()}\n${String(row.cs_text).trim()}`)
  )
  let count = 0
  for (const example of list) {
    if (known.has(`${example.customerText.trim()}\n${example.csText.trim()}`)) continue
    await addLeanExample({ ...example, source: 'seed' })
    count += 1
  }
  return count
}

/**
 * Setelah CS mengambil alih dan menjawab, pasangan (pesan pelanggan → jawaban CS)
 * disimpan sebagai kandidat contoh. Ini yang membuat AI ikut membaik tanpa
 * mengedit skill.
 */
export async function learnFromHumanReply(jid: string, csMessageId: string) {
  await ensureLeanTables()
  const reply = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('message_id', csMessageId)
    .where('direction', 'out')
    .where('sender_type', 'cs')
    .first()
  if (!reply?.body || String(reply.body).length < 4) return null
  const question = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .where('id', '<', reply.id)
    .whereNotNull('body')
    .orderBy('id', 'desc')
    .first()
  if (!question?.body || String(question.body).length < 3) return null
  const customerText = String(question.body).trim().slice(0, 2000)
  const csText = String(reply.body).trim().slice(0, 2000)
  const duplicate = await db
    .from('whatsapp_beta3_examples')
    .where('customer_text', customerText)
    .where('cs_text', 'like', `%${csText.replace(/[%_\\]/g, '\\$&')}%`)
    .where('active', 1)
    .first()
  if (duplicate) return null
  // Beberapa bubble CS untuk pesan pelanggan yang sama digabung jadi satu contoh
  // ("Sore" + "Untuk stock habis bos, paling pre order ya").
  const recent = await db
    .from('whatsapp_beta3_examples')
    .where('customer_text', customerText)
    .where('source', 'takeover')
    .where('active', 1)
    .where('created_at', '>', new Date(Date.now() - 60 * 60_000))
    .orderBy('id', 'desc')
    .first()
  if (recent) {
    await db
      .from('whatsapp_beta3_examples')
      .where('id', recent.id)
      .update({ cs_text: `${String(recent.cs_text)}\n${csText}`.slice(0, 2000) })
    clearExampleCache()
    return Number(recent.id)
  }
  const id = await addLeanExample({
    situation: '',
    customerText,
    csText,
    tags: 'cs-takeover',
    source: 'takeover',
  })
  await trimTakeoverExamples()
  return id
}

/** Batas contoh otomatis: yang terlama dinonaktifkan agar daftar tetap ringkas. */
export const TAKEOVER_EXAMPLE_LIMIT = 300
async function trimTakeoverExamples() {
  const old = await db
    .from('whatsapp_beta3_examples')
    .where('source', 'takeover')
    .where('active', 1)
    .orderBy('id', 'desc')
    .offset(TAKEOVER_EXAMPLE_LIMIT)
    .limit(1000)
    .select('id')
  if (old.length)
    await db
      .from('whatsapp_beta3_examples')
      .whereIn('id', old.map((row: any) => row.id))
      .update({ active: 0 })
  if (old.length) clearExampleCache()
}

/**
 * Rapikan contoh takeover lama sekali per proses: bubble berurutan dengan pesan
 * pelanggan yang sama (dibuat berdekatan) digabung jadi satu contoh.
 */
const compacted = new Set<string>()
export async function compactTakeoverExamples(scopeKey: string) {
  if (compacted.has(scopeKey)) return
  compacted.add(scopeKey)
  await ensureLeanTables()
  const rows = await db
    .from('whatsapp_beta3_examples')
    .where('source', 'takeover')
    .where('active', 1)
    .orderBy('id', 'asc')
  let keep: any = null
  for (const row of rows) {
    const near =
      keep &&
      keep.customer_text === row.customer_text &&
      Math.abs(new Date(row.created_at).getTime() - new Date(keep.created_at).getTime()) < 60 * 60_000
    if (!near) {
      keep = row
      continue
    }
    const joined = String(keep.cs_text).includes(String(row.cs_text))
      ? String(keep.cs_text)
      : `${keep.cs_text}\n${row.cs_text}`.slice(0, 2000)
    await db.from('whatsapp_beta3_examples').where('id', keep.id).update({ cs_text: joined })
    await db.from('whatsapp_beta3_examples').where('id', row.id).update({ active: 0 })
    keep = { ...keep, cs_text: joined }
  }
  await trimTakeoverExamples()
}
