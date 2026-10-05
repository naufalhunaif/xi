// Beta 3.5 — Jev (TypeSafe AI): keputusan bertipe untuk hal kecil yang dulu ditebak pola kata.
// Jev hanya memutuskan; kode TypeScript yang bertindak. Jev gagal/lambat/ragu → cara lama.
import encryption from '@adonisjs/core/services/encryption'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'
import { recordUsage } from '#services/usage_service'
import { recordAiEvent } from '#services/ai_accounts'

/** Id akun semu Jev di whatsapp_ai_events (untuk orkestra); bukan akun AI sungguhan. */
export const JEV_ACCOUNT_ID = 0
import { workspaceScope } from '#services/workspace_context'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_DEFAULT_MODEL = 'jev-latest'
const PURPOSE = 'jev'
const TIMEOUT_MS = 800

/** Sepuluh keputusan yang dipegang Jev, dengan nama yang tampil di Pengaturan. */
export const JEV_DECISIONS = {
  layanan: 'Layanan ongkir pilihan pelanggan',
  total_toko: 'Pesan toko berisi total/rekening',
  janji_total: 'Balasan menjanjikan total',
  varian: 'Varian yang dimaksud pelanggan',
  setuju: 'Pelanggan setuju total/tawaran',
  form: 'Pesan berisi data pengiriman',
  terjawab: 'Pertanyaan pelanggan sudah terjawab',
  maksud: 'Maksud pesan (pilih model)',
  serah_cs: 'Perlu diserahkan ke CS',
  komentar_ig: 'Komentar Instagram',
  warna_gambar: 'Warna produk di gambar pelanggan',
  tanggapan: 'Pesan singkat cukup tanda terima',
  topik: 'Topik pesan (bagian prompt)',
  kesulitan: 'Tingkat kesulitan (pilih model)',
  tujuan_baru: 'Pesan berisi tujuan pengiriman baru',
  sudah_tf: 'Pelanggan bilang sudah transfer',
  dana_masuk: 'Toko menyatakan dana masuk',
  lanjut: 'Pelanggan menunda / membatalkan',
  urgensi: 'Prioritas chat di kotak masuk',
  harga_konteks: 'Seri & barang yang ditanya harganya',
  bukti_transfer: 'Gambar pelanggan = bukti pembayaran',
  kirim_sendiri: 'Pesanan diantar tim sendiri / diambil (tanpa resi)',
  peran_kontak: 'Peran kontak (pelanggan / vendor)',
} as const
export type JevDecision = keyof typeof JEV_DECISIONS

/** Ambang keyakinan per keputusan; keputusan uang paling ketat. */
export const JEV_THRESHOLD: Record<JevDecision, number> = {
  layanan: 0.9,
  total_toko: 0.9,
  janji_total: 0.8,
  varian: 0.85,
  setuju: 0.85,
  form: 0.8,
  terjawab: 0.8,
  maksud: 0.8,
  serah_cs: 0.85,
  komentar_ig: 0.9,
  warna_gambar: 0.8,
  tanggapan: 0.85,
  topik: 0.8,
  kesulitan: 0.8,
  tujuan_baru: 0.85,
  sudah_tf: 0.85,
  dana_masuk: 0.9,
  lanjut: 0.9,
  urgensi: 0.7,
  harga_konteks: 0.8,
  bukti_transfer: 0.9,
  kirim_sendiri: 0.85,
  peran_kontak: 0.95,
}

export type JevNoul = {
  type: 'noul'
  instructions: string
  criteria?: { true: string; false: string }
}
export type JevChoice = { type: 'choice'; instructions: string; criteria: Record<string, string> }
export type JevScore = { type: 'score'; instructions: string; criteria: string[] }
export type JevQuestion = JevNoul | JevChoice | JevScore

export type JevAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; confidence: number }

export type JevConfig = { apiKey: string; model: string; enabled: boolean; off: JevDecision[] }

type Fetcher = typeof fetch
let fetcher: Fetcher = (...args) => fetch(...args)
/** Untuk tes: ganti panggilan jaringan dengan tiruan. */
export function setJevFetcher(next: Fetcher | null) {
  fetcher = next || ((...args) => fetch(...args))
}

// Dibaca beberapa kali per giliran: simpan sebentar per workspace (dihapus saat disimpan).
const configCache = new Map<string, { at: number; config: JevConfig }>()
const cacheKey = () => {
  try {
    return workspaceScope().prefix
  } catch {
    return ''
  }
}

/** Untuk tes dan setelah kunci dihapus langsung di database. */
export function resetJevCache() {
  configCache.clear()
}

export async function readJevConfig(): Promise<JevConfig> {
  const cached = configCache.get(cacheKey())
  if (cached && Date.now() - cached.at < 5000) return cached.config
  const config = await loadJevConfig()
  configCache.set(cacheKey(), { at: Date.now(), config })
  return config
}

async function loadJevConfig(): Promise<JevConfig> {
  const raw = await readLeanState('jev_settings').catch(() => null)
  let parsed: Partial<JevConfig> = {}
  try {
    parsed = raw ? JSON.parse(String(raw)) : {}
  } catch {
    parsed = {}
  }
  let apiKey = ''
  const stored = await readLeanState('jev_key').catch(() => null)
  if (stored) {
    try {
      apiKey = String(encryption.decrypt<string>(String(stored), PURPOSE) || '')
    } catch {
      apiKey = ''
    }
  }
  const off = Array.isArray(parsed.off)
    ? (parsed.off.filter((key) => key in JEV_DECISIONS) as JevDecision[])
    : []
  return {
    apiKey,
    model: String(parsed.model || '').trim() || JEV_DEFAULT_MODEL,
    enabled: parsed.enabled !== false,
    off,
  }
}

export async function saveJevConfig(input: {
  apiKey?: string
  model?: string
  enabled?: boolean
  off?: string[]
}) {
  const current = await readJevConfig()
  if (input.apiKey !== undefined) {
    const key = String(input.apiKey || '').trim()
    await writeLeanState('jev_key', key ? encryption.encrypt(key, undefined, PURPOSE) : '')
  }
  const next = {
    model:
      input.model !== undefined
        ? String(input.model || '')
            .trim()
            .slice(0, 60)
        : current.model,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
    off: input.off !== undefined ? input.off.filter((key) => key in JEV_DECISIONS) : current.off,
  }
  await writeLeanState('jev_settings', JSON.stringify(next))
  configCache.clear()
  return jevStatus()
}

export async function jevStatus() {
  const config = await readJevConfig()
  return {
    configured: Boolean(config.apiKey),
    enabled: config.enabled,
    model: config.model,
    off: config.off,
    decisions: Object.entries(JEV_DECISIONS).map(([key, label]) => ({ key, label })),
    lastError: String((await readLeanState('jev_last_error').catch(() => '')) || ''),
  }
}

/** Keputusan ini boleh memakai Jev sekarang (kunci ada, aktif, tidak dimatikan). */
export async function jevOn(decision: JevDecision) {
  const config = await readJevConfig()
  return Boolean(config.apiKey) && config.enabled && !config.off.includes(decision)
}

/** Nomor HP, nomor rekening, dan email disamarkan sebelum dikirim ke layanan luar. */
export function maskPii(text: string) {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(\+?62|0)8[\d\s-]{7,13}\d/g, '[nomor hp]')
    .replace(/\b\d{9,}\b/g, '[angka panjang]')
}

/** Jawaban cukup yakin untuk dipakai (noul: peluang ya atau tidak di atas ambang). */
export function confident(decision: JevDecision, answer: JevAnswer | undefined | null) {
  if (!answer) return false
  const threshold = JEV_THRESHOLD[decision]
  if (answer.type === 'noul') return answer.noul >= threshold || 1 - answer.noul >= threshold
  return Number(answer.confidence) >= threshold
}

export function answerConfidence(answer: JevAnswer | undefined | null) {
  if (!answer) return 0
  return answer.type === 'noul'
    ? Math.max(answer.noul, 1 - answer.noul)
    : Number(answer.confidence) || 0
}

/**
 * Skor Jev dimulai dari 0 (tiga tingkat → 0 … 2, bisa di antara dua tingkat). Diubah ke tingkat
 * 1 … n sesuai urutan kriteria: tingkat 1 = kriteria pertama.
 */
export function scoreLevel(answer: { score: number }, levels: number) {
  return Math.min(levels, Math.max(1, Math.round(Number(answer.score) || 0) + 1))
}

export function answerText(answer: JevAnswer | undefined | null) {
  if (!answer) return ''
  if (answer.type === 'noul') return answer.noul >= 0.5 ? 'ya' : 'tidak'
  if (answer.type === 'choice') return answer.choice
  return `tingkat ${scoreLevel(answer, 10)}`
}

/**
 * Satu permintaan ke Jev (semua pertanyaan dinilai paralel atas state yang sama).
 * Mengembalikan null bila Jev mati, tanpa kunci, gagal, atau melewati batas waktu.
 */
export async function askJev<K extends string>(
  phase: string,
  state: unknown,
  questions: Record<K, JevQuestion>,
  options: { timeoutMs?: number; jid?: string } = {}
): Promise<Partial<Record<K, JevAnswer>> | null> {
  if (!Object.keys(questions).length) return null
  const config = await readJevConfig()
  if (!config.apiKey || !config.enabled) return null
  const started = Date.now()
  try {
    const response = await fetcher(JEV_URL, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`)
    const data = (await response.json()) as {
      model?: string
      answers?: Record<string, any>
      usage?: { input_tokens?: number; output_tokens?: number }
    }
    await recordUsage({
      provider: 'typesafe',
      phase: `jev-${phase}`,
      model: String(data.model || config.model),
      status: 'completed',
      usage: {
        input: Number(data.usage?.input_tokens || 0),
        output: Number(data.usage?.output_tokens || 0),
        cached: 0,
        cacheWrite: 0,
      },
      durationMs: Date.now() - started,
    }).catch(() => {})
    // Orkestra: Jev tampil sebagai simpul sendiri; tiap keputusan = satu denyut ke pelanggan.
    await recordAiEvent(
      JEV_ACCOUNT_ID,
      'ok',
      `jev-${phase}`,
      '',
      Number(data.usage?.input_tokens || 0) + Number(data.usage?.output_tokens || 0),
      options.jid || ''
    ).catch(() => {})
    const answers: Partial<Record<K, JevAnswer>> = {}
    for (const key of Object.keys(questions) as K[]) {
      const raw = data.answers?.[key]
      if (!raw) continue
      if (raw.type === 'noul' && Number.isFinite(Number(raw.noul)))
        answers[key] = { type: 'noul', noul: Number(raw.noul) }
      else if (raw.type === 'choice' && typeof raw.choice === 'string')
        answers[key] = {
          type: 'choice',
          choice: raw.choice,
          probabilities: raw.probabilities || {},
          confidence: Number(raw.confidence) || 0,
        }
      else if (raw.type === 'score' && Number.isFinite(Number(raw.score)))
        answers[key] = {
          type: 'score',
          score: Number(raw.score),
          confidence: Number(raw.confidence) || 0,
        }
    }
    return answers
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeLeanState(
      'jev_last_error',
      `${new Date().toISOString()} ${message}`.slice(0, 300)
    ).catch(() => {})
    await recordUsage({
      provider: 'typesafe',
      phase: `jev-${phase}`,
      model: config.model,
      status: 'failed',
      usage: null,
      durationMs: Date.now() - started,
    }).catch(() => {})
    await recordAiEvent(JEV_ACCOUNT_ID, 'fail', `jev-${phase}`, message.slice(0, 120), null, options.jid || '').catch(() => {})
    return null
  }
}

let tableReady = false
async function ensureDecisionTable() {
  if (tableReady) return
  await ensureLeanTables()
  await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_beta3_decisions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    jid VARCHAR(190) NOT NULL DEFAULT '',
    decision VARCHAR(40) NOT NULL,
    answer VARCHAR(190) NOT NULL DEFAULT '',
    confidence DECIMAL(5,4) NOT NULL DEFAULT 0,
    used TINYINT(1) NOT NULL DEFAULT 0,
    fallback VARCHAR(190) NOT NULL DEFAULT '',
    detail TEXT NULL,
    wrong TINYINT(1) NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL,
    KEY whatsapp_beta3_decisions_created (created_at),
    KEY whatsapp_beta3_decisions_decision (decision, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  // v3.6.36: teks yang dinilai, peluang tiap jawaban, dan penilaian CS (benar/salah + jawaban yang benar).
  await db.rawQuery(`ALTER TABLE whatsapp_beta3_decisions
    ADD COLUMN IF NOT EXISTS input_text TEXT NULL AFTER detail,
    ADD COLUMN IF NOT EXISTS alternatives VARCHAR(600) NULL AFTER input_text,
    ADD COLUMN IF NOT EXISTS verdict VARCHAR(10) NULL AFTER wrong,
    ADD COLUMN IF NOT EXISTS correct_answer VARCHAR(80) NULL AFTER verdict`)
  tableReady = true
}

/** Catat satu keputusan Jev (dipakai atau tidak) untuk halaman Akurasi. */
export async function logDecision(input: {
  jid?: string
  decision: JevDecision
  answer: JevAnswer | null | undefined
  used: boolean
  fallback?: string
  detail?: string
  /** Teks yang dinilai Jev (pesan pelanggan/toko, keterangan gambar) — ditampilkan ke CS. */
  input?: string
}) {
  if (!input.answer) return
  try {
    await ensureDecisionTable()
    await db.table('whatsapp_beta3_decisions').insert({
      jid: String(input.jid || '').slice(0, 190),
      decision: input.decision,
      answer: answerText(input.answer).slice(0, 190),
      confidence: Math.round(answerConfidence(input.answer) * 10000) / 10000,
      used: input.used,
      fallback: String(input.fallback || '').slice(0, 190),
      detail: input.detail ? String(input.detail).slice(0, 2000) : null,
      input_text: input.input ? maskPii(String(input.input)).slice(0, 2000) : null,
      alternatives: alternativesOf(input.answer),
      created_at: new Date(),
    })
  } catch {
    /* Catatan opsional; jangan mengganggu balasan. */
  }
}

/** Peluang tiap jawaban (pilihan ganda: 3 teratas; ya/tidak: peluang "ya"), untuk ditampilkan. */
function alternativesOf(answer: JevAnswer) {
  if (answer.type === 'choice')
    return JSON.stringify(
      Object.entries(answer.probabilities || {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([key, value]) => [key, Math.round(value * 100)])
    ).slice(0, 600)
  if (answer.type === 'noul') return JSON.stringify([['ya', Math.round(answer.noul * 100)], ['tidak', Math.round((1 - answer.noul) * 100)]])
  return null
}

/**
 * Log keputusan untuk dinilai CS. filter: '' semua · 'cek' perlu dicek (ragu, soal uang, peran kontak,
 * belum dinilai) · 'dinilai' sudah dinilai · kunci keputusan.
 */
export async function listDecisions(limit = 50, decision?: string) {
  await ensureDecisionTable()
  const query = db
    .from('whatsapp_beta3_decisions as d')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'd.jid')
    .select('d.*', 'c.name as contact_name')
    .orderBy('d.id', 'desc')
    .limit(Math.max(1, Math.min(200, limit)))
  if (decision === 'cek')
    query.whereNull('d.verdict').where((inner) =>
      inner
        .where('d.confidence', '<', 0.9)
        .orWhereIn('d.decision', ['dana_masuk', 'bukti_transfer', 'total_toko', 'layanan', 'peran_kontak', 'kirim_sendiri'])
    )
  else if (decision === 'dinilai') query.whereNotNull('d.verdict')
  else if (decision && decision in JEV_DECISIONS) query.where('d.decision', decision)
  const rows = (await query) as Array<Record<string, any>>
  const { explainDecision, answerLabel, decisionSource } = await import('#beta3/jev_explain')
  // Log lama (sebelum v3.6.36) belum menyimpan pesan yang dibaca Jev: diambil pesan terakhir
  // dari chat itu sebelum keputusan dibuat (pesan toko untuk keputusan atas pesan toko).
  await Promise.all(
    rows
      .filter((row) => !row.input_text && row.jid)
      .map(async (row) => {
        const fromStore = decisionSource(String(row.decision)) === 'toko'
        const message = await db
          .from('whatsapp_messages')
          .where('jid', row.jid)
          .where('direction', fromStore ? 'out' : 'in')
          .where('created_at', '<=', row.created_at)
          .orderBy('id', 'desc')
          .select('body', 'media_type')
          .first()
          .catch(() => null)
        const text = String(message?.body || '').trim() || (message?.media_type ? `(${message.media_type})` : '')
        if (text) row.input_text = maskPii(text).slice(0, 2000)
      })
  )
  return rows.map((row): Record<string, any> => {
    let pairs: Array<[string, number]> = []
    try {
      pairs = JSON.parse(String(row.alternatives || '[]'))
    } catch {}
    const alternatives = (Array.isArray(pairs) ? pairs : [])
      .filter((pair) => Array.isArray(pair) && String(pair[0]) !== String(row.answer))
      .map(([key, pct]) => ({ key: String(key), pct: Number(pct) || 0, label: answerLabel(row.decision, String(key)) }))
    return { ...row, alternatives, ...explainDecision(row as any) }
  })
}

/** Penilaian CS: benar / salah (+ jawaban yang benar) / kosong = batal menilai. */
export async function markDecision(id: number, verdict: 'benar' | 'salah' | '' , correct = '') {
  await ensureDecisionTable()
  await db
    .from('whatsapp_beta3_decisions')
    .where('id', id)
    .update({
      verdict: verdict || null,
      wrong: verdict === 'salah',
      correct_answer: verdict === 'salah' && correct ? correct.slice(0, 80) : null,
    })
}

/** Akurasi 30 hari per keputusan: jumlah keputusan, ditandai salah, persen benar. */
export async function accuracySummary() {
  await ensureDecisionTable()
  // Akurasi hanya dari keputusan yang sudah dinilai CS (v3.6.36); sisanya "belum dinilai".
  const [result] = await db.rawQuery(
    `SELECT decision, COUNT(*) AS total, SUM(used) AS used,
        SUM(verdict = 'benar') AS benar,
        SUM(verdict = 'salah' OR (verdict IS NULL AND wrong = 1)) AS salah
       FROM whatsapp_beta3_decisions WHERE created_at >= ? GROUP BY decision`,
    [new Date(Date.now() - 30 * 86_400_000)]
  )
  return (result as any[]).map((row) => {
    const total = Number(row.total || 0)
    const benar = Number(row.benar || 0)
    const salah = Number(row.salah || 0)
    const reviewed = benar + salah
    return {
      decision: String(row.decision),
      label: JEV_DECISIONS[row.decision as JevDecision] || String(row.decision),
      total,
      used: Number(row.used || 0),
      wrong: salah,
      benar,
      reviewed,
      unreviewed: total - reviewed,
      accuracy: reviewed ? Math.round((benar / reviewed) * 1000) / 10 : null,
    }
  })
}
