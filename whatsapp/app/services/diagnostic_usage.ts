import { safeDate } from '#services/diagnostic_contract'

const phases = new Set([
  'analysis',
  'index-analysis',
  'evaluation',
  'learning-replay',
  'business-recheck-run',
  'comparison',
  'cart-notes-repair',
  'skill_edit',
  'followup',
  'shipping-notice',
])
const count = (value: unknown) => {
  if (value === null || value === undefined) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}
const tokens = (row: Record<string, unknown>) => {
  const input = count(row.input_tokens)
  const output = count(row.output_tokens)
  const cached = count(row.cached_tokens)
  return {
    phase: phases.has(String(row.phase)) ? String(row.phase) : 'other',
    input,
    output,
    cached,
    cacheWrite: count(row.cache_write_tokens),
    uncachedInput: input === null || cached === null ? null : Math.max(0, input - cached),
    total: input === null || output === null ? null : input + output,
    durationMs: count(row.duration_ms),
  }
}

/** Export counts only; no model configuration, prompts, customer identifiers or raw DB rows. */
export function diagnosticUsage(
  recent: Record<string, unknown>[],
  totals: Record<string, unknown>[]
) {
  return {
    windowHours: 24,
    recent: recent.slice(0, 20).map((row) => ({
      ...tokens(row),
      status: ['completed', 'failed'].includes(String(row.status)) ? row.status : 'unknown',
      createdAt: safeDate(row.created_at),
    })),
    phases: totals.slice(0, 40).map((row) => ({
      ...tokens(row),
      runs: count(row.runs),
      measuredRuns: count(row.measured_runs),
      failedRuns: count(row.failed_runs),
    })),
    note: 'Input includes cached reads; cached is a subset, not additional tokens. Unknown usage stays null. Totals are provider token counts, not a price estimate.',
  }
}
