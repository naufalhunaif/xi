// Beta 3.5 — Jev (TypeSafe AI): keputusan bertipe untuk hal kecil yang dulu ditebak pola kata.
// Jev hanya memutuskan; kode TypeScript yang bertindak. Jev gagal/lambat/ragu → cara lama.
import encryption from '@adonisjs/core/services/encryption'
import db from '#services/workspace_database'
import { ensureLeanTables, readLeanState, writeLeanState } from '#beta3/tables'
import { recordUsage } from '#services/usage_service'
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

export function answerText(answer: JevAnswer | undefined | null) {
  if (!answer) return ''
  if (answer.type === 'noul') return answer.noul >= 0.5 ? 'ya' : 'tidak'
  if (answer.type === 'choice') return answer.choice
  return String(Math.round(answer.score))
}

/**
 * Satu permintaan ke Jev (semua pertanyaan dinilai paralel atas state yang sama).
 * Mengembalikan null bila Jev mati, tanpa kunci, gagal, atau melewati batas waktu.
 */
export async function askJev<K extends string>(
  phase: string,
  state: unknown,
  questions: Record<K, JevQuestion>,
  options: { timeoutMs?: number } = {}
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
      created_at: new Date(),
    })
  } catch {
    /* Catatan opsional; jangan mengganggu balasan. */
  }
}

export async function listDecisions(limit = 50, decision?: string) {
  await ensureDecisionTable()
  const query = db
    .from('whatsapp_beta3_decisions as d')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'd.jid')
    .select('d.*', 'c.name as contact_name')
    .orderBy('d.id', 'desc')
    .limit(Math.max(1, Math.min(200, limit)))
  if (decision && decision in JEV_DECISIONS) query.where('d.decision', decision)
  return query
}

export async function markDecision(id: number, wrong: boolean) {
  await ensureDecisionTable()
  await db.from('whatsapp_beta3_decisions').where('id', id).update({ wrong })
}

/** Akurasi 30 hari per keputusan: jumlah keputusan, ditandai salah, persen benar. */
export async function accuracySummary() {
  await ensureDecisionTable()
  const rows = await db
    .from('whatsapp_beta3_decisions')
    .where('created_at', '>=', new Date(Date.now() - 30 * 86_400_000))
    .groupBy('decision')
    .select('decision')
    .count('* as total')
    .sum('wrong as wrong')
    .sum('used as used')
  return (rows as any[]).map((row) => {
    const total = Number(row.total || 0)
    const wrong = Number(row.wrong || 0)
    return {
      decision: String(row.decision),
      label: JEV_DECISIONS[row.decision as JevDecision] || String(row.decision),
      total,
      used: Number(row.used || 0),
      wrong,
      accuracy: total ? Math.round(((total - wrong) / total) * 1000) / 10 : null,
    }
  })
}
