import db from '#services/workspace_database'
import { DateTime } from 'luxon'
import { initializeDatabase } from '#services/init_model'
import { workspaceScope } from '#services/workspace_context'

export type TokenUsage = { input: number; output: number; cached: number; cacheWrite: number }

function tokens(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Codex input includes cache hits; Claude reports cache reads/writes separately.
 * Writes are tracked apart from reads: paying the write premium without ever reading
 * back is a different problem from not caching at all, and needs a different fix.
 */
export function usageFromEvent(provider: string, event: Record<string, any>): TokenUsage | null {
  if (event.type === 'gemini.usage') {
    const usage = event.usage || {}
    return {
      input: tokens(usage.input),
      output: tokens(usage.output),
      cached: tokens(usage.cached),
      cacheWrite: 0,
    }
  }
  if (event.type !== (provider === 'claude' ? 'result' : 'turn.completed')) return null
  const usage = event.usage
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number')
    return null
  const cached = tokens(
    provider === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens
  )
  // Codex does not report cache writes separately; they are already inside input_tokens.
  const cacheWrite = provider === 'claude' ? tokens(usage.cache_creation_input_tokens) : 0
  return {
    input: tokens(usage.input_tokens) + (provider === 'claude' ? cached + cacheWrite : 0),
    output: tokens(usage.output_tokens),
    cached,
    cacheWrite,
  }
}

export async function recordUsage(input: {
  provider: string
  phase?: string
  model?: string
  status: 'completed' | 'failed'
  usage: TokenUsage | null
  durationMs: number
}) {
  await initializeDatabase()
  await db.table('whatsapp_ai_usage').insert({
    provider: input.provider,
    phase: input.phase?.slice(0, 40) || null,
    model: input.model?.slice(0, 120) || null,
    status: input.status,
    input_tokens: input.usage?.input ?? null,
    output_tokens: input.usage?.output ?? null,
    cached_tokens: input.usage?.cached ?? null,
    cache_write_tokens: input.usage?.cacheWrite ?? null,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    created_at: new Date(),
  })
}

const ZONE = 'Asia/Jakarta'
export const USAGE_RANGES = [7, 30, 90, 365]

/**
 * Ringkasan pemakaian untuk satu rentang (7/30/90/365 hari) atau satu tanggal (YYYY-MM-DD, WIB).
 * Kalender 1 tahun (seperti grafik kontribusi GitHub) dihitung terpisah dan di-cache.
 */
export async function readUsage(options: { days?: number; date?: string } = {}) {
  await initializeDatabase()
  const days = USAGE_RANGES.includes(Number(options.days)) ? Number(options.days) : 30
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || '')) ? DateTime.fromISO(String(options.date), { zone: ZONE }) : null
  const since = (day?.isValid ? day : DateTime.now().setZone(ZONE).minus({ days: days - 1 })).startOf('day').toJSDate()
  const until = day?.isValid ? day.endOf('day').toJSDate() : null
  const range = <T>(query: T): T => {
    const builder = (query as any).where('created_at', '>=', since)
    return (until ? builder.where('created_at', '<=', until) : builder) as T
  }
  const [rows, recent] = await Promise.all([
    range(db.from('whatsapp_ai_usage'))
      .select('provider')
      .count('* as runs')
      .count('input_tokens as measured')
      .sum('input_tokens as input')
      .sum('output_tokens as output')
      .sum('cached_tokens as cached')
      .sum('cache_write_tokens as cacheWrite')
      .select(db.raw("SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed"))
      .avg('duration_ms as duration')
      .groupBy('provider'),
    range(db.from('whatsapp_ai_usage')).orderBy('id', 'desc').limit(10),
  ])
  // Where the tokens actually go: one customer message can trigger several full runs.
  const phases = await range(db.from('whatsapp_ai_usage'))
    .select('phase')
    .count('* as runs')
    .sum('input_tokens as input')
    .sum('output_tokens as output')
    .sum('cached_tokens as cached')
    .sum('cache_write_tokens as cacheWrite')
    .avg('duration_ms as duration')
    .groupBy('phase')
    .orderByRaw('SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) DESC')
    .limit(12)
  // Model yang benar-benar dipakai (mode Otomatis memilih model per tugas).
  const models = await range(db.from('whatsapp_ai_usage'))
    .select('provider', 'model')
    .count('* as runs')
    .sum('input_tokens as input')
    .sum('output_tokens as output')
    .sum('cached_tokens as cached')
    .groupBy('provider', 'model')
    .orderByRaw('COUNT(*) DESC')
    .limit(12)
  return {
    days: day?.isValid ? 1 : days,
    date: day?.isValid ? day.toISODate() : '',
    calendar: await usageCalendar().catch(() => []),
    models: models.map((row) => ({
      provider: row.provider,
      model: row.model || 'bawaan akun',
      runs: Number(row.runs || 0),
      input: Number(row.input || 0),
      output: Number(row.output || 0),
      cached: Number(row.cached || 0),
    })),
    providers: ['chatgpt', 'claude', 'gemini', 'typesafe'].map((provider) => {
      const row = rows.find((item) => item.provider === provider)
      return {
        provider,
        runs: Number(row?.runs || 0),
        measured: Number(row?.measured || 0),
        input: Number(row?.input || 0),
        output: Number(row?.output || 0),
        cached: Number(row?.cached || 0),
        cacheWrite: Number(row?.cacheWrite || 0),
        failed: Number(row?.failed || 0),
        durationMs: Math.round(Number(row?.duration || 0)),
      }
    }),
    phases: phases.map((row) => ({
      phase: row.phase || 'lainnya',
      runs: Number(row.runs || 0),
      input: Number(row.input || 0),
      output: Number(row.output || 0),
      cached: Number(row.cached || 0),
      cacheWrite: Number(row.cacheWrite || 0),
      durationMs: Math.round(Number(row.duration || 0)),
    })),
    recent: recent.map(mapRun),
  }
}

/** Token per hari (WIB) 1 tahun terakhir; dihitung per jam lalu digeser ke WIB. Cache 10 menit. */
type CalendarDay = { date: string; tokens: number; runs: number; by: Record<string, number> }
const calendarCache = new Map<string, { at: number; data: CalendarDay[] }>()
export async function usageCalendar() {
  const key = workspaceScope().prefix || 'default'
  const cached = calendarCache.get(key)
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.data
  const since = DateTime.now().setZone(ZONE).startOf('day').minus({ days: 371 }).toJSDate()
  const rows = (await db
    .from('whatsapp_ai_usage')
    .where('created_at', '>=', since)
    .select(db.raw("DATE_FORMAT(created_at, '%Y-%m-%d %H') as hour"), 'provider')
    .count('* as runs')
    .select(db.raw('SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)) as tokens'))
    .groupBy('hour', 'provider')) as any[]
  const byDate = new Map<string, CalendarDay>()
  for (const row of rows) {
    // created_at tersimpan dalam zona waktu server (mysql2 "local").
    const [date, hour] = String(row.hour).split(' ')
    const local = new Date(`${date}T${hour}:00:00`)
    const wib = DateTime.fromJSDate(local).setZone(ZONE).toISODate() || date
    const entry = byDate.get(wib) || { date: wib, tokens: 0, runs: 0, by: {} }
    const tokens = Number(row.tokens || 0)
    entry.tokens += tokens
    entry.runs += Number(row.runs || 0)
    // Per penyedia (ChatGPT, Claude, Gemini, Jev) untuk grafik naik-turun.
    const provider = String(row.provider || 'lain')
    entry.by[provider] = (entry.by[provider] || 0) + tokens
    byDate.set(wib, entry)
  }
  const data = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  calendarCache.set(key, { at: Date.now(), data })
  return data
}

const mapRun = (row: any) => ({
  id: Number(row.id),
  provider: row.provider,
  phase: row.phase || '',
  model: row.model || 'bawaan akun',
  status: row.status,
  tokens: row.input_tokens === null ? null : Number(row.input_tokens) + Number(row.output_tokens),
  input: row.input_tokens === null ? null : Number(row.input_tokens),
  output: row.output_tokens === null ? null : Number(row.output_tokens),
  cached: row.cached_tokens === null ? null : Number(row.cached_tokens),
  cacheWrite: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
  durationMs: Number(row.duration_ms),
  createdAt: new Date(row.created_at).toISOString(),
})

/** Riwayat proses (Pengaturan → Usage → Proses terbaru): per halaman, bisa difilter model/fase. */
export async function readRuns(options: { days?: number; date?: string; before?: number; model?: string; phase?: string; provider?: string; limit?: number } = {}) {
  await initializeDatabase()
  const days = USAGE_RANGES.includes(Number(options.days)) ? Number(options.days) : 30
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(options.date || '')) ? DateTime.fromISO(String(options.date), { zone: ZONE }) : null
  const since = (day?.isValid ? day : DateTime.now().setZone(ZONE).minus({ days: days - 1 })).startOf('day').toJSDate()
  const limit = Math.min(100, Math.max(1, Number(options.limit) || 20))
  const filtered = () => {
    const query = db.from('whatsapp_ai_usage').where('created_at', '>=', since)
    if (day?.isValid) query.where('created_at', '<=', day.endOf('day').toJSDate())
    if (options.provider) query.where('provider', options.provider)
    if (options.model) options.model === 'bawaan akun' ? query.whereNull('model') : query.where('model', options.model)
    if (options.phase) options.phase === 'lainnya' ? query.whereNull('phase') : query.where('phase', options.phase)
    return query
  }
  const page = filtered().orderBy('id', 'desc').limit(limit + 1)
  if (Number(options.before) > 0) page.where('id', '<', Number(options.before))
  const [rows, total] = await Promise.all([page, filtered().count('* as total').first()])
  const more = rows.length > limit
  const runs = rows.slice(0, limit).map(mapRun)
  return { runs, total: Number((total as any)?.total || 0), next: more ? runs[runs.length - 1].id : 0 }
}
