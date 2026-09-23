import db from '#services/workspace_database'
import { DateTime } from 'luxon'
import { initializeDatabase } from '#services/init_model'

export type TokenUsage = { input: number; output: number; cached: number; cacheWrite: number }

function tokens(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/** Codex input includes cache hits; Claude reports cache reads/writes separately.
 * Writes are tracked apart from reads: paying the write premium without ever reading
 * back is a different problem from not caching at all, and needs a different fix.
 */
export function usageFromEvent(provider: string, event: Record<string, any>): TokenUsage | null {
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

export async function readUsage() {
  await initializeDatabase()
  const since = DateTime.now().setZone('Asia/Jakarta').startOf('day').minus({ days: 29 }).toJSDate()
  const [rows, recent] = await Promise.all([
    db
      .from('whatsapp_ai_usage')
      .where('created_at', '>=', since)
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
    db.from('whatsapp_ai_usage').where('created_at', '>=', since).orderBy('id', 'desc').limit(10),
  ])
  // Where the tokens actually go: one customer message can trigger several full runs.
  const phases = await db
    .from('whatsapp_ai_usage')
    .where('created_at', '>=', since)
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
  return {
    days: 30,
    providers: ['chatgpt', 'claude'].map((provider) => {
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
    recent: recent.map((row) => ({
      id: Number(row.id),
      provider: row.provider,
      phase: row.phase || '',
      model: row.model || 'Otomatis',
      status: row.status,
      tokens:
        row.input_tokens === null ? null : Number(row.input_tokens) + Number(row.output_tokens),
      input: row.input_tokens === null ? null : Number(row.input_tokens),
      output: row.output_tokens === null ? null : Number(row.output_tokens),
      cached: row.cached_tokens === null ? null : Number(row.cached_tokens),
      cacheWrite: row.cache_write_tokens === null ? null : Number(row.cache_write_tokens),
      durationMs: Number(row.duration_ms),
      createdAt: new Date(row.created_at).toISOString(),
    })),
  }
}
