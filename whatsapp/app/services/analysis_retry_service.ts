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
