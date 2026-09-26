// Kualitas balasan tanpa lapor manual: Aturan Toko, Koreksi dari room, Kasus uji (manual),
// dan pemeriksa harga sebelum kirim. Semua berlaku sama untuk model AI mana pun.
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'
import { addLeanExample, listLeanExamples, pickExamples } from '#beta3/examples_service'
import { catalogDigest, type LeanCatalogRow } from '#beta3/catalog_service'
import { buildLeanPrompt, parseLeanDecision, type LeanHistoryRow } from '#beta3/prompt'
import { runLeanProvider } from '#beta3/provider'
import { storeStyle, styleGuide } from '#beta3/style_service'
import { collectContext } from '#beta3/context_service'
import { selectLeanSkill, type LeanSettings } from '#beta3/reply_service'

/* ---------------- Aturan Toko ---------------- */

export type StoreRule = { id: number; text: string; at: string }
const RULES_KEY = 'store_rules'

export async function listRules(): Promise<StoreRule[]> {
  try {
    const list = JSON.parse((await readLeanState(RULES_KEY)) || '[]')
    return Array.isArray(list) ? list.filter((rule) => rule && rule.text) : []
  } catch {
    return []
  }
}

export async function addRule(text: string) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300)
  if (!clean) throw new Error('Aturan kosong.')
  const rules = await listRules()
  if (rules.some((rule) => rule.text.toLowerCase() === clean.toLowerCase())) return rules
  if (rules.length >= 60) throw new Error('Maksimal 60 aturan. Hapus yang tidak dipakai.')
  const id = Math.max(0, ...rules.map((rule) => rule.id)) + 1
  rules.push({ id, text: clean, at: new Date().toISOString() })
  await writeLeanState(RULES_KEY, JSON.stringify(rules))
  return rules
}

export async function removeRule(id: number) {
  const rules = (await listRules()).filter((rule) => rule.id !== id)
  await writeLeanState(RULES_KEY, JSON.stringify(rules))
  return rules
}

/** Bagian prompt: aturan dari pemilik, paling atas setelah profil toko. */
export function renderRules(rules: StoreRule[]) {
  if (!rules.length) return ''
  return `ATURAN TOKO (dari pemilik; WAJIB diikuti, mengalahkan contoh & kebiasaan):\n${rules.map((rule) => `- ${rule.text}`).join('\n')}`
}

/* ---------------- Koreksi dari room ---------------- */

const toRow = (row: Record<string, any>): LeanHistoryRow => ({
  direction: row.direction === 'in' ? 'in' : 'out',
  senderType: row.sender_type,
  body: row.body,
  mediaType: row.media_type,
  createdAt: row.created_at,
})

/**
 * Pemilik mengoreksi satu balasan AI. Selalu jadi kasus uji; lalu disimpan sebagai
 * contoh jawaban (kasus serupa) atau aturan toko (berlaku umum).
 */
export async function saveCorrection(input: {
  messageId: number
  correct: string
  kind: 'example' | 'rule'
  rule?: string
}) {
  await ensureLeanTables()
  const correct = String(input.correct || '').trim().slice(0, 2000)
  const ai = await db.from('whatsapp_messages').where('id', input.messageId).first()
  if (!ai) throw new Error('Pesan tidak ditemukan.')
  if (!correct && input.kind === 'example') throw new Error('Tulis jawaban yang benar.')
  const before = (
    await db
      .from('whatsapp_messages')
      .where('jid', ai.jid)
      .where('id', '<', ai.id)
      .whereNotIn('status', ['failed', 'queued'])
      .orderBy('id', 'desc')
      .limit(16)
  ).reverse()
  // Pesan pelanggan yang dijawab: deretan pesan masuk terakhir sebelum balasan ini.
  const asked: string[] = []
  for (let index = before.length - 1; index >= 0; index--) {
    if (before[index].direction !== 'in') break
    asked.unshift(String(before[index].body || (before[index].media_type ? `[${before[index].media_type}]` : '')))
  }
  const customerText = asked.join('\n').trim() || '(tanpa teks)'
  if (input.kind === 'example')
    await addLeanExample({
      situation: 'Koreksi pemilik',
      customerText,
      csText: correct,
      tags: 'koreksi',
      source: 'koreksi',
    })
  else await addRule(input.rule || correct)
  if (correct) {
    await db.table('whatsapp_beta3_tests').insert({
      jid: String(ai.jid),
      history: JSON.stringify(before.map(toRow)),
      customer_text: customerText,
      wrong_text: String(ai.body || ''),
      expected_text: correct,
      status: 'idle',
      created_at: new Date(),
    })
  }
  return { ok: true }
}

/* ---------------- Kasus uji (dijalankan manual) ---------------- */

export async function listTests() {
  await ensureLeanTables()
  const rows = await db.from('whatsapp_beta3_tests').orderBy('id', 'desc').limit(200)
  return rows.map((row: Record<string, any>) => ({
    id: Number(row.id),
    customerText: String(row.customer_text || ''),
    wrongText: String(row.wrong_text || ''),
    expectedText: String(row.expected_text || ''),
    lastAnswer: row.last_answer ? String(row.last_answer) : '',
    lastPass: row.last_pass === null || row.last_pass === undefined ? null : Boolean(row.last_pass),
    lastReason: String(row.last_reason || ''),
    lastModel: String(row.last_model || ''),
    lastRunAt: row.last_run_at,
    status: String(row.status || 'idle'),
  }))
}

export async function removeTest(id: number) {
  await ensureLeanTables()
  await db.from('whatsapp_beta3_tests').where('id', id).delete()
}

/** Kasus uji dijalankan dengan ChatGPT/Claude saja (bukan model ringan). */
const TEST_PROVIDERS = ['claude', 'chatgpt'] as const

let running = false
export async function runTests(settings: LeanSettings, ids: number[] = []) {
  await ensureLeanTables()
  if (running) return { started: false, reason: 'Uji sedang berjalan.' }
  const query = db.from('whatsapp_beta3_tests').orderBy('id', 'asc')
  if (ids.length) query.whereIn('id', ids)
  const cases = await query
  if (!cases.length) return { started: false, reason: 'Belum ada kasus uji.' }
  await db
    .from('whatsapp_beta3_tests')
    .whereIn('id', cases.map((row: any) => row.id))
    .update({ status: 'queued' })
  running = true
  void (async () => {
    try {
      for (const test of cases) {
        await db.from('whatsapp_beta3_tests').where('id', test.id).update({ status: 'running' })
        const result = await runOne(test, settings).catch((error) => ({
          answer: '',
          pass: false,
          reason: `Gagal dijalankan: ${error instanceof Error ? error.message : String(error)}`.slice(0, 480),
          model: '',
        }))
        await db.from('whatsapp_beta3_tests').where('id', test.id).update({
          last_answer: result.answer.slice(0, 4000),
          last_pass: result.pass ? 1 : 0,
          last_reason: result.reason.slice(0, 480),
          last_model: result.model.slice(0, 80),
          last_run_at: new Date(),
          status: 'idle',
        })
      }
    } finally {
      running = false
    }
  })()
  return { started: true, count: cases.length }
}

async function runOne(test: Record<string, any>, settings: LeanSettings) {
  const rows: LeanHistoryRow[] = JSON.parse(String(test.history || '[]'))
  // Pesan masuk terakhir (yang dijawab) ditandai sebagai pesan sekarang.
  for (let index = rows.length - 1; index >= 0 && rows[index].direction === 'in'; index--)
    rows[index].current = true
  const text = String(test.customer_text || '')
  const skill = selectLeanSkill(settings.skills)
  const [digest, examples, rules] = await Promise.all([catalogDigest(), listLeanExamples(), listRules()])
  const style = await storeStyle(examples).catch(() => null)
  const prompt = buildLeanPrompt({
    skill: skill.content,
    store: await readLeanState('store_profile'),
    fabrics: await readLeanState('fabrics'),
    sizeCharts: await readLeanState('size_charts'),
    catalog: digest.text,
    // Contoh dari koreksi kasus ini sendiri tidak dipakai, supaya uji tetap jujur.
    examples: pickExamples(
      examples.filter((example) => example.source !== 'koreksi'),
      text
    ),
    corrections: examples
      .filter((example) => example.source === 'koreksi')
      .filter((example) => example.csText.trim() !== String(test.expected_text).trim())
      .slice(-12),
    styleGuide: style ? styleGuide(style) : '',
    rules: renderRules(rules),
    customerNote: '',
    chatNote: '',
    history: rows,
    context: collectContext({ history: rows, catalog: digest.rows, text }),
    message: text,
    paymentMethods: settings.paymentMethods.filter((method) => method.enabled),
  })
  const reply = await runLeanProvider(settings, prompt, [], 'beta3-test', undefined, {
    providers: [...TEST_PROVIDERS],
  })
  const answer = parseLeanDecision(reply.text).pesan.join('\n')
  const judgeSchema = {
    type: 'object',
    additionalProperties: false,
    properties: { lulus: { type: 'boolean' }, alasan: { type: 'string' } },
    required: ['lulus', 'alasan'],
  }
  const judge = await runLeanProvider(
    settings,
    {
      system:
        'Kamu penilai jawaban CS toko. Balas HANYA JSON sesuai skema. Lulus bila isi pokok jawaban AI sama dengan jawaban benar dari pemilik: angka (harga, size, ongkir, total), informasi, dan langkah berikutnya. Gaya kata, sapaan, dan urutan boleh berbeda. Tidak lulus bila mengulang kesalahan lama atau isinya berbeda. Alasan: satu kalimat bahasa Indonesia.',
      user: `PESAN PELANGGAN:\n${text}\n\nJAWABAN SALAH SEBELUMNYA:\n${test.wrong_text}\n\nJAWABAN BENAR (pemilik):\n${test.expected_text}\n\nJAWABAN AI SEKARANG:\n${answer || '(tidak membalas / diserahkan ke CS)'}`,
    },
    [],
    'beta3-test-judge',
    judgeSchema,
    { providers: [...TEST_PROVIDERS] }
  )
  const start = judge.text.indexOf('{')
  const verdict = JSON.parse(judge.text.slice(start, judge.text.lastIndexOf('}') + 1)) as {
    lulus?: boolean
    alasan?: string
  }
  return {
    answer,
    pass: verdict.lulus === true,
    reason: String(verdict.alasan || ''),
    model: `${reply.provider} / ${reply.model || 'otomatis'}`,
  }
}

/* ---------------- Pemeriksa harga sebelum kirim ---------------- */

const PRICE_TEXT = /(?<![\d.])(\d{1,3}(?:\.\d{3})+)(?![\d.])/g
const toNumber = (text: string) => Number(text.replace(/\./g, ''))

/** Semua angka rupiah yang sah: katalog (termasuk size besar), ongkir, dan yang sudah disebut di chat. */
export function allowedPrices(catalog: LeanCatalogRow[], texts: string[]) {
  const catalogValues = new Set<number>()
  const other = new Set<number>()
  for (const row of catalog) {
    if (row.price) catalogValues.add(Number(row.price))
    for (const big of String(row.note || '').matchAll(PRICE_TEXT)) catalogValues.add(toNumber(big[1]))
  }
  for (const text of texts) for (const hit of String(text || '').matchAll(PRICE_TEXT)) other.add(toNumber(hit[1]))
  return { catalog: catalogValues, other }
}

/**
 * Harga di balasan AI yang tidak bisa dijelaskan dari data: harga katalog (boleh kali
 * jumlah 1–10), angka yang sudah ada di ongkir/chat, penjumlahan sampai 3 angka,
 * dan DP/pelunasan 50% dari total yang sah. Kosong = aman dikirim.
 */
export function unknownPrices(
  bubbles: string[],
  allowed: { catalog: Set<number>; other: Set<number> }
) {
  const singles = new Set<number>(allowed.other)
  for (const value of allowed.catalog) for (let qty = 1; qty <= 10; qty++) singles.add(value * qty)
  const list = [...singles].filter((value) => value > 0)
  const core = (value: number) => {
    if (singles.has(value)) return true
    for (const a of list) {
      if (a >= value) continue
      if (singles.has(value - a)) return true
      for (const b of list) if (b < value - a && singles.has(value - a - b)) return true
    }
    return false
  }
  const explained = (value: number) => value < 10_000 || core(value) || core(value * 2)
  const unknown: number[] = []
  for (const bubble of bubbles) {
    // Angka yang disebut di bubble itu sendiri sebagai rincian ikut sah untuk totalnya.
    const own = [...bubble.matchAll(PRICE_TEXT)].map((hit) => toNumber(hit[1]))
    for (const value of own) {
      if (explained(value)) continue
      const parts = own.filter((other) => other !== value && explained(other))
      const sum = (target: number, from: number[]): boolean =>
        from.some((x, i) => x === target || (x < target && sum(target - x, from.slice(i + 1))))
      if (parts.length >= 2 && sum(value, parts)) continue
      unknown.push(value)
    }
  }
  return [...new Set(unknown)]
}
