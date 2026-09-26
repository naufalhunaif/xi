// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import { ensureLeanTables } from '#beta3/tables'

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
  'yang di ke dari dan atau ada mau bos om kak min mas kalo kalau saja aja ya yaa nya untuk itu ini sama dong deh sih gimana bagaimana apa berapa bisa boleh saya aku kami kita nih ok oke siap iya'.split(
    ' '
  )
)

export function keywords(text: string) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !STOPWORDS.has(word))
    ),
  ]
}

/** Skor kemiripan sederhana: irisan kata kunci pesan pelanggan + situasi + tag. */
export function scoreExample(example: LeanExample, messageWords: string[], stage = '') {
  const own = new Set(
    keywords(`${example.customerText} ${example.situation} ${example.tags.replace(/,/g, ' ')}`)
  )
  let score = messageWords.filter((word) => own.has(word)).length
  if (stage && example.tags.split(',').some((tag) => tag.trim() === stage)) score += 1.5
  return score
}

export function pickExamples(
  examples: LeanExample[],
  message: string,
  stage = '',
  limit = 8
): LeanExample[] {
  const words = keywords(message)
  const scored = examples
    .map((example) => {
      const score = scoreExample(example, words, stage)
      // Koreksi pemilik didahulukan bila relevan.
      return { example, score: score > 0 && example.source === 'koreksi' ? score + 2 : score }
    })
    .sort((a, b) => b.score - a.score || (a.example.id || 0) - (b.example.id || 0))
  const chosen = scored.filter((item) => item.score > 0).slice(0, limit)
  // Kalau pesan terlalu pendek untuk dicocokkan, tetap beri contoh tahap saat ini.
  if (chosen.length < 3)
    for (const item of scored) {
      if (chosen.length >= 3) break
      if (!chosen.includes(item)) chosen.push(item)
    }
  return chosen.map((item) => item.example)
}

export function renderExamples(examples: LeanExample[]) {
  if (!examples.length) return ''
  return [
    'CONTOH JAWABAN CS ASLI (tiru panjang, nada, dan caranya memilih satu langkah berikut):',
    ...examples.map(
      (example, index) =>
        `${index + 1}. ${example.situation ? `[${example.situation}] ` : ''}Pelanggan: ${example.customerText}\n   CS: ${example.csText.replace(/\n/g, '\n       ')}`
    ),
  ].join('\n')
}

export async function listLeanExamples(): Promise<LeanExample[]> {
  await ensureLeanTables()
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
  return Number(id)
}

export async function removeLeanExample(id: number) {
  await ensureLeanTables()
  await db.from('whatsapp_beta3_examples').where('id', id).update({ active: 0 })
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
  const duplicate = await db
    .from('whatsapp_beta3_examples')
    .where('customer_text', String(question.body).trim().slice(0, 2000))
    .where('cs_text', String(reply.body).trim().slice(0, 2000))
    .first()
  if (duplicate) return null
  return addLeanExample({
    situation: '',
    customerText: String(question.body),
    csText: String(reply.body),
    tags: 'cs-takeover',
    source: 'takeover',
  })
}
