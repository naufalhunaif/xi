import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import {
  newAnalysisRecovery,
  readAnalysisRecovery,
  MAX_ANALYSIS_RETRIES,
} from '#services/analysis_retry_service'
export type GoalRun = { jid: string; version: string; anchor_id: number }

export async function readConversationGoal(jid: string) {
  return db.from('whatsapp_chat_goals').where('jid', jid).first()
}

async function latestExternalMessage(jid: string, client: Pick<typeof db, 'from'> = db) {
  return client
    .from('whatsapp_messages')
    .where('jid', jid)
    .where((query) => query.where('direction', 'in').orWhereNot('sender_type', 'ai'))
    .whereNotIn('status', ['queued', 'failed'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first()
}

/** Persisted success survives reconnect, CS/AI toggles and goal invalidation. */
export async function alreadyAnalyzedMessage(jid: string, messageId?: string) {
  const [goal, anchor] = await Promise.all([readConversationGoal(jid), latestExternalMessage(jid)])
  if (!goal || !anchor || (messageId && anchor.message_id !== messageId)) return false
  return (
    Number(goal.analyzed_anchor_id) === Number(anchor.id) ||
    (goal.status === 'processing' && Number(goal.anchor_id) === Number(anchor.id))
  )
}

/** Sweeps/reconnects cannot retry a failed snapshot; the bounded recovery queue owns retries. */
export async function failedGoalMessage(jid: string, messageId?: string) {
  const [goal, anchor] = await Promise.all([readConversationGoal(jid), latestExternalMessage(jid)])
  return Boolean(
    goal &&
    anchor &&
    (!messageId || anchor.message_id === messageId) &&
    goal.status === 'paused' &&
    goal.last_error &&
    Number(goal.anchor_id) === Number(anchor.id)
  )
}

/** A new external message invalidates both pending follow-ups and in-flight AI output. */
export async function invalidateConversationGoal(jid: string, human = false) {
  await db
    .from('whatsapp_chat_goals')
    .where('jid', jid)
    .update({
      version: randomUUID(),
      ...(human ? { level_state_json: null } : {}),
      status: human ? 'paused' : 'active',
      next_run_at: null,
      waiting_for: '',
      next_action: '',
      last_error: null,
      updated_at: new Date(),
    })
}

export async function beginGoalTurn(
  jid: string,
  messageId: string,
  options: { humanDecision?: boolean; retryFailed?: boolean; autoRetryVersion?: string } = {}
): Promise<GoalRun | null> {
  return db.transaction(async (trx) => {
    const version = randomUUID()
    await trx.rawQuery(
      `INSERT IGNORE INTO whatsapp_chat_goals
    (jid, version, anchor_id, status, objective, waiting_for, next_action, followup_count, created_at, updated_at)
    VALUES (?, ?, 0, 'active', '', '', '', 0, ?, ?)`,
      [jid, version, new Date(), new Date()]
    )
    const goal = await trx.from('whatsapp_chat_goals').where('jid', jid).forUpdate().firstOrFail()
    const anchor = await latestExternalMessage(jid, trx)
    if (!anchor || anchor.message_id !== messageId) return null
    if (options.autoRetryVersion) {
      const recovery = readAnalysisRecovery(goal.recovery_json)
      if (
        goal.version !== options.autoRetryVersion ||
        goal.status !== 'paused' ||
        !goal.next_run_at ||
        new Date(goal.next_run_at) > new Date() ||
        recovery?.status !== 'scheduled' ||
        recovery.anchorId !== Number(anchor.id) ||
        recovery.attempts >= MAX_ANALYSIS_RETRIES
      )
        return null
      const contact = await trx.from('whatsapp_contacts').where('jid', jid).first()
      if (contact?.handling_mode === 'cs' || contact?.ai_excluded) return null
      const sent = await trx
        .from('whatsapp_messages')
        .where('jid', jid)
        .where('direction', 'out')
        .whereNot('status', 'failed')
        .where((q) =>
          q
            .where('created_at', '>', anchor.created_at)
            .orWhere((same) =>
              same.where('created_at', anchor.created_at).where('id', '>', anchor.id)
            )
        )
        .first()
      if (sent) {
        await trx
          .from('whatsapp_chat_goals')
          .where({ jid, version: goal.version })
          .update({
            next_run_at: null,
            recovery_json: JSON.stringify({
              ...recovery,
              status: 'blocked',
              code: 'REPLY_ALREADY_PRESENT',
            }),
          })
        return null
      }
    }
    // Serialize backlog/review/live claims. Silent/waiting is a successful analysis too.
    if (goal.status === 'processing' && Number(goal.anchor_id) === Number(anchor.id)) return null
    if (!options.humanDecision && Number(goal.analyzed_anchor_id) === Number(anchor.id)) return null
    if (
      !options.humanDecision &&
      !options.retryFailed &&
      !options.autoRetryVersion &&
      goal.status === 'paused' &&
      goal.last_error &&
      Number(goal.anchor_id) === Number(anchor.id)
    )
      return null
    await trx
      .from('whatsapp_chat_goals')
      .where('jid', jid)
      .update({
        version,
        anchor_id: anchor.id,
        status: 'processing',
        next_run_at: null,
        last_error: null,
        recovery_json: JSON.stringify(
          newAnalysisRecovery(
            Number(anchor.id),
            goal.recovery_json,
            Boolean(options.autoRetryVersion)
          )
        ),
        updated_at: new Date(),
      })
    return { jid, version, anchor_id: Number(anchor.id) }
  })
}

export async function isCurrentGoalRun(run: GoalRun) {
  const [goal, anchor] = await Promise.all([
    readConversationGoal(run.jid),
    latestExternalMessage(run.jid),
  ])
  return (
    goal?.version === run.version &&
    goal.status === 'processing' &&
    Number(anchor?.id) === run.anchor_id
  )
}

export async function pauseGoalRun(run: GoalRun, reason: string) {
  await db
    .from('whatsapp_chat_goals')
    .where('jid', run.jid)
    .where('version', run.version)
    .update({ status: 'paused', next_run_at: null, last_error: reason, updated_at: new Date() })
}

export async function dueConversationGoals(now = new Date()) {
  // No automatic retry after uncertain sends/crashes. Fresh input can reevaluate the goal.
  await db
    .from('whatsapp_chat_goals')
    .where('status', 'processing')
    .where('updated_at', '<', new Date(now.getTime() - 30 * 60_000))
    .update({
      status: 'paused',
      next_run_at: null,
      last_error: 'Proses terputus; menunggu evaluasi pada pesan baru.',
      updated_at: now,
    })
  return db
    .from('whatsapp_chat_goals as g')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'g.jid')
    .select('g.*')
    .whereIn('g.status', ['waiting', 'waiting_answer', 'waiting_payment'])
    .where('g.next_run_at', '<=', now)
    .where((query) => query.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
    .orderBy('g.next_run_at', 'asc')
    .limit(10)
}
