import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import type { GoalRun } from '#services/conversation_goal_service'
import type { AiFailureDetail } from '#services/ai_failure_service'
import { workspaceScope } from '#services/workspace_context'

export const MAX_ANALYSIS_RETRIES = 2
const owner = { pid: process.pid, host: hostname(), instance: randomUUID() }
export type AnalysisRecovery = {
  anchorId: number
  attempts: number
  phase: 'analysis' | 'delivery'
  status: 'running' | 'scheduled' | 'exhausted' | 'blocked'
  code?: string
  startedAt: string
  owner: typeof owner
  technicalRecovered?: boolean
  catalogWordingRecovered?: boolean
  catalogNotesRecovered?: boolean
}
export function readAnalysisRecovery(value: unknown): AnalysisRecovery | null {
  try {
    const state = JSON.parse(String(value))
    return Number.isSafeInteger(state.anchorId) &&
      Number.isSafeInteger(state.attempts) &&
      state.attempts >= 0 &&
      ['analysis', 'delivery'].includes(state.phase) &&
      ['running', 'scheduled', 'exhausted', 'blocked'].includes(state.status) &&
      state.owner &&
      typeof state.startedAt === 'string' &&
      Number.isFinite(Date.parse(state.startedAt))
      ? state
      : null
  } catch {
    return null
  }
}
export function newAnalysisRecovery(
  anchorId: number,
  previous: unknown,
  retry = false
): AnalysisRecovery {
  const old = readAnalysisRecovery(previous)
  return {
    anchorId,
    attempts: old?.anchorId === anchorId ? old.attempts + (retry ? 1 : 0) : 0,
    phase: 'analysis',
    status: 'running',
    startedAt: new Date().toISOString(),
    owner,
    ...(old?.anchorId === anchorId && old.technicalRecovered ? { technicalRecovered: true } : {}),
    ...(old?.anchorId === anchorId && old.catalogWordingRecovered
      ? { catalogWordingRecovered: true }
      : {}),
    ...(old?.anchorId === anchorId && old.catalogNotesRecovered
      ? { catalogNotesRecovered: true }
      : {}),
  }
}

export function presentedAnalysisStatus(goal: any) {
  const state = readAnalysisRecovery(goal?.recovery_json)
  return goal?.status === 'paused' && goal.next_run_at && state?.status === 'scheduled'
    ? 'retrying'
    : goal?.status || ''
}
export function analysisRetryDelay(
  failure: Pick<AiFailureDetail, 'code' | 'stage'>,
  attempts: number
) {
  if (attempts >= MAX_ANALYSIS_RETRIES) return null
  if (failure.code === 'USAGE_LIMIT') return 15 * 60_000
  if (
    [
      'AI_UNAVAILABLE',
      'MCP_UNAVAILABLE',
      'DATABASE_UNAVAILABLE',
      'MEDIA_UNAVAILABLE',
      'AI_TIMEOUT',
      'AI_OUTPUT_INVALID',
      'AI_OUTPUT_EMPTY',
      'AI_PROCESS_INTERRUPTED',
    ].includes(failure.code) ||
    (failure.code === 'AI_PROCESS_FAILED' && failure.stage === 'provider')
  )
    return attempts === 0 ? 30_000 : 120_000
  return null
}

/** Persist BEFORE any cart/payment/message effects. Failure here prevents delivery. */
export async function markGoalDelivery(run: GoalRun) {
  const row = await db
    .from('whatsapp_chat_goals')
    .where({ jid: run.jid, version: run.version })
    .first()
  if (!row || row.status !== 'processing') return false
  const state = readAnalysisRecovery(row.recovery_json)
  if (!state) return true // scheduled follow-ups use their existing delivery/idempotency path
  const changed = await db
    .from('whatsapp_chat_goals')
    .where({ jid: run.jid, version: run.version, status: 'processing' })
    .update({
      recovery_json: JSON.stringify({ ...state, phase: 'delivery' }),
      updated_at: new Date(),
    })
  return Number(changed) > 0
}

/** Only analysis failures retry. A delivery failure never regenerates and resends a reply. */
export async function scheduleAnalysisRetry(
  run: GoalRun,
  failure: AiFailureDetail,
  now = new Date()
) {
  return db.transaction(async (trx) => {
    const goal = await trx
      .from('whatsapp_chat_goals')
      .where({ jid: run.jid, version: run.version })
      .forUpdate()
      .first()
    if (!goal || goal.status !== 'processing' || Number(goal.analyzed_anchor_id) === run.anchor_id)
      return null
    const state = readAnalysisRecovery(goal.recovery_json)
    const delay = state?.phase === 'analysis' ? analysisRetryDelay(failure, state.attempts) : null
    const next = delay === null ? null : new Date(now.getTime() + delay)
    const status = next
      ? 'scheduled'
      : (state?.attempts || 0) >= MAX_ANALYSIS_RETRIES
        ? 'exhausted'
        : 'blocked'
    await trx
      .from('whatsapp_chat_goals')
      .where({ jid: run.jid, version: run.version })
      .update({
        status: 'paused',
        next_run_at: next,
        last_error: failure.message,
        ...(state
          ? { recovery_json: JSON.stringify({ ...state, status, code: failure.code }) }
          : {}),
        updated_at: now,
      })
    return {
      status,
      attempt: state?.attempts || 0,
      maximum: MAX_ANALYSIS_RETRIES,
      code: failure.code,
      nextAttemptAt: next?.toISOString() || null,
    }
  })
}

const pendingFailures = new Map<string, { scope: string; run: GoalRun; failure: AiFailureDetail }>()
export async function recordAnalysisFailure(run: GoalRun, failure: AiFailureDetail) {
  const scope = workspaceScope().prefix
  const key = `${scope}:${run.version}`
  try {
    const result = await scheduleAnalysisRetry(run, failure)
    pendingFailures.delete(key)
    return result
  } catch {
    // A DB outage must not strand an otherwise live worker or trigger another paid run.
    pendingFailures.set(key, { scope, run, failure })
    return null
  }
}
export async function flushAnalysisFailures() {
  for (const [key, entry] of pendingFailures) {
    if (entry.scope !== workspaceScope().prefix) continue
    await scheduleAnalysisRetry(entry.run, entry.failure)
    pendingFailures.delete(key)
  }
}

export async function dueAnalysisRetries(now = new Date()) {
  return db
    .from('whatsapp_chat_goals as g')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'g.jid')
    .where('g.status', 'paused')
    .where('g.next_run_at', '<=', now)
    .whereNotNull('g.recovery_json')
    .whereRaw('g.analyzed_anchor_id <> g.anchor_id')
    .where((q) => q.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
    .where((q) => q.whereNull('c.ai_excluded').orWhere('c.ai_excluded', false))
    .whereNotExists((q) =>
      q
        .from('whatsapp_ai_reviews as r')
        .whereColumn('r.jid', 'g.jid')
        .whereIn('r.status', ['pending', 'processing'])
    )
    .select('g.*')
    .orderBy('g.next_run_at')
    .limit(20)
}

export function analysisOwnerExited(state: AnalysisRecovery) {
  if (
    state.owner.host !== hostname() ||
    !Number.isSafeInteger(state.owner.pid) ||
    state.owner.pid < 1
  )
    return false
  try {
    process.kill(state.owner.pid, 0)
    return false
  } catch (error: any) {
    return error.code === 'ESRCH'
  }
}

/** Recover only recorded analysis owners proven absent on this host, never by trace age alone. */
export async function recoverInterruptedAnalyses(exited = analysisOwnerExited) {
  const rows = await db
    .from('whatsapp_chat_goals')
    .where('status', 'processing')
    .whereNotNull('recovery_json')
    .limit(100)
  for (const goal of rows) {
    const state = readAnalysisRecovery(goal.recovery_json)
    if (!state || state.phase !== 'analysis' || !exited(state)) continue
    const run = { jid: goal.jid, version: goal.version, anchor_id: Number(goal.anchor_id) }
    const recoveredAt = new Date()
    const retry = await scheduleAnalysisRetry(run, {
      code: 'AI_PROCESS_INTERRUPTED',
      stage: 'provider',
      message: 'Worker analisis sebelumnya telah berhenti.',
      action: 'Menunggu jadwal pemulihan analisis.',
      retryable: true,
    })
    if (retry) {
      // Invalidate stale audit state; never rewrite a newer trace or pretend it completed.
      await db
        .from('whatsapp_ai_traces')
        .where('jid', goal.jid)
        .where('status', 'running')
        .where('created_at', '>=', new Date(Math.floor(Date.parse(state.startedAt) / 1000) * 1000))
        .where('created_at', '<=', recoveredAt)
        .update({ status: 'cancelled', updated_at: new Date() })
    }
  }
}

/** One-time upgrade of paused provider failures. Completed handoffs/business failures stay untouched. */
export async function recoverLegacyPausedAnalyses() {
  const rows = await db
    .from('whatsapp_chat_goals as g')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'g.jid')
    .where('g.status', 'paused')
    .whereNull('g.recovery_json')
    .whereNotNull('g.last_error')
    .whereRaw('g.analyzed_anchor_id <> g.anchor_id')
    .where((q) => q.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
    .where((q) => q.whereNull('c.ai_excluded').orWhere('c.ai_excluded', false))
    .select('g.*')
    .limit(100)
  for (const goal of rows) {
    const trace = await db
      .from('whatsapp_ai_traces')
      .where('jid', goal.jid)
      .orderBy('created_at', 'desc')
      .first()
    let failure: AiFailureDetail | undefined
    try {
      failure = JSON.parse(trace?.decision_json || '{}').failure
    } catch {}
    const state = newAnalysisRecovery(Number(goal.anchor_id), null)
    // Mark examined rows, even if not retryable, so sweeps cannot repeatedly reopen them.
    const eligible =
      trace?.status === 'failed' &&
      failure &&
      ['provider', 'mcp_auth'].includes(failure.stage) &&
      Math.abs(new Date(trace.updated_at).getTime() - new Date(goal.updated_at).getTime()) < 60_000
    const delay = eligible ? analysisRetryDelay(failure!, 0) : null
    await db
      .from('whatsapp_chat_goals')
      .where({ jid: goal.jid, version: goal.version, status: 'paused' })
      .whereNull('recovery_json')
      .update({
        recovery_json: JSON.stringify({
          ...state,
          status: delay === null ? 'blocked' : 'scheduled',
          code: failure?.code,
        }),
        next_run_at: delay === null ? null : new Date(Date.now() + delay),
      })
  }
}

/** Revisit the known catalog-consent validation defect once, only after the room is already AI. */
export async function recoverCatalogConsentHandoffs() {
  const rows = await db
    .from('whatsapp_chat_goals as g')
    .join('whatsapp_contacts as c', 'c.jid', 'g.jid')
    .where('g.status', 'paused')
    .whereNull('g.last_error')
    .where('c.handling_mode', 'ai')
    .where('c.ai_excluded', false)
    .select('g.*')
    .limit(100)
  for (const goal of rows) {
    const old = readAnalysisRecovery(goal.recovery_json)
    if ((old?.attempts || 0) >= MAX_ANALYSIS_RETRIES) continue
    const trace = await db
      .from('whatsapp_ai_traces')
      .where('jid', goal.jid)
      .orderBy('created_at', 'desc')
      .first()
    let decision: any
    try {
      decision = JSON.parse(trace?.decision_json || '{}')
    } catch {
      continue
    }
    const reason = decision.summary || decision.reason
    const wordingFailure =
      reason === 'Detail desain katalog tidak cocok dengan permintaan yang disetujui CS.'
    const notesFailure =
      reason ===
      'Catatan desain katalog memuat detail yang belum cocok dengan permintaan yang disetujui CS.'
    if (
      trace?.status !== 'completed' ||
      trace.message_id ||
      decision.decision !== 'handoff' ||
      (!wordingFailure && !notesFailure && reason !== 'Referensi persetujuan model tidak valid.') ||
      (notesFailure
        ? old?.catalogNotesRecovered
        : wordingFailure
          ? old?.catalogWordingRecovered
          : old?.technicalRecovered)
    )
      continue
    const state = {
      ...newAnalysisRecovery(Number(goal.anchor_id), goal.recovery_json),
      technicalRecovered: true,
      ...(wordingFailure ? { catalogWordingRecovered: true } : {}),
      ...(notesFailure ? { catalogNotesRecovered: true } : {}),
      status: 'scheduled',
      code: 'CATALOG_CONSENT_RECHECK',
    }
    await db
      .from('whatsapp_chat_goals')
      .where({ jid: goal.jid, version: goal.version, status: 'paused' })
      .update({
        recovery_json: JSON.stringify(state),
        analyzed_anchor_id: 0,
        next_run_at: new Date(Date.now() + 30_000),
        last_error: 'Pemeriksaan ulang bukti persetujuan warna katalog.',
      })
  }
}
