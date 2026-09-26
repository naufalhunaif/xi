import { randomUUID, createHash } from 'node:crypto'
import { makeLevelCheckpoint, levelPolicyHash } from '#services/conversation_levels'
import db from '#services/workspace_database'
import type { AiDecision } from '#services/ai_service'
import {
  newAnalysisRecovery,
  readAnalysisRecovery,
  MAX_ANALYSIS_RETRIES,
} from '#services/analysis_retry_service'
import {
  nextFollowUpAt,
  parseGoal,
  validPolicy,
  withinSendingHours,
  type FollowUpPolicy,
} from '#services/goal_contract'

type Skill = { name: string; content: string }
export type GoalRun = { jid: string; version: string; anchor_id: number }
const hashSkill = (skill: Skill) => createHash('sha256').update(skill.content).digest('hex')

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

export async function saveGoalDecision(
  run: GoalRun,
  decision: AiDecision,
  skills: Skill[],
  scheduled = false
) {
  if (!(await isCurrentGoalRun(run))) return null
  const previous = await readConversationGoal(run.jid)
  // Recheck at persistence too, after cart/shipping guards may have changed the plan.
  const plan = parseGoal(decision.goal)
  const policy = plan?.follow_up
  const source = policy && skills.find((skill) => skill.name === policy.skill_name)
  const latest = await db
    .from('whatsapp_messages')
    .where('jid', run.jid)
    .orderBy('id', 'desc')
    .first()
  const canSchedule =
    plan &&
    ['waiting', 'waiting_answer', 'waiting_payment'].includes(plan.status) &&
    plan.waiting_for &&
    source &&
    validPolicy(policy) &&
    decision.decision !== 'handoff' &&
    !(scheduled && decision.decision === 'silent')
  // A successful follow-up's next interval starts at delivery, not before model/tool work.
  const previousAttempt = previous.last_followup_at ? new Date(previous.last_followup_at) : null
  const lastAttempt =
    scheduled && decision.decision === 'reply'
      ? new Date(Math.max(new Date(latest.created_at).getTime(), previousAttempt?.getTime() || 0))
      : previousAttempt
  const next = canSchedule
    ? nextFollowUpAt(
        policy,
        Number(previous.followup_count),
        new Date(latest.created_at),
        lastAttempt
      )
    : null
  const currentCart = await db.from('whatsapp_carts').where('jid', run.jid).first()
  const values = {
    level_state_json:
      decision.localResolution === 'closed_ack'
        ? null // A local acknowledgment is consumed once; it is not a new CS reply.
        : JSON.stringify(
            makeLevelCheckpoint({
              decision,
              goal: plan || null,
              source: latest,
              anchorId: run.anchor_id,
              cartVersion: String(currentCart?.version || ''),
              policyHash: levelPolicyHash(skills),
            })
          ),
    analyzed_anchor_id: run.anchor_id,
    objective: plan?.objective ?? previous.objective,
    status: decision.decision === 'handoff' ? 'paused' : plan?.status || 'paused',
    waiting_for: plan?.waiting_for || '',
    next_action: plan?.next_action || '',
    policy_json: source && policy ? JSON.stringify(policy) : null,
    skill_hash: source ? hashSkill(source) : null,
    next_run_at: next,
    last_followup_at: lastAttempt,
    last_error: null,
    updated_at: new Date(),
  }
  const changed = await db
    .from('whatsapp_chat_goals')
    .where('jid', run.jid)
    .where('version', run.version)
    .update(values)
  if (!Number(changed)) return null
  return {
    ...values,
    ...(plan?.stage ? { stage: plan.stage } : {}),
    ...(plan?.current_task ? { current_task: plan.current_task } : {}),
    next_run_at: next?.toISOString() || null,
    last_followup_at: lastAttempt?.toISOString() || null,
    updated_at: values.updated_at.toISOString(),
    followup_count: Number(previous.followup_count),
  }
}

export async function dueConversationGoals(now = new Date(), channel: 'wa' | 'ig' = 'wa') {
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
    // Room Instagram dijadwalkan terpisah (tanpa soket WhatsApp).
    .where('g.jid', channel === 'ig' ? 'like' : 'not like', '%@ig')
    .orderBy('g.next_run_at', 'asc')
    .limit(10)
}

export async function claimConversationGoal(
  jid: string,
  skills: Skill[],
  now = new Date()
): Promise<GoalRun | null> {
  const goal = await readConversationGoal(jid)
  if (
    !goal ||
    !['waiting', 'waiting_answer', 'waiting_payment'].includes(goal.status) ||
    !goal.next_run_at ||
    new Date(goal.next_run_at) > now
  )
    return null
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (contact?.handling_mode === 'cs') return null
  const run = { jid, version: String(goal.version), anchor_id: Number(goal.anchor_id) }
  let policy: FollowUpPolicy | null = null
  try {
    policy = JSON.parse(goal.policy_json)
  } catch {}
  const source = skills.find((skill) => skill.name === policy?.skill_name)
  const anchor = await latestExternalMessage(jid)
  if (
    !validPolicy(policy) ||
    !source ||
    hashSkill(source) !== goal.skill_hash ||
    Number(goal.followup_count) >= policy.max_attempts ||
    Number(anchor?.id) !== run.anchor_id
  ) {
    await pauseGoalRun(run, 'Jadwal tidak berlaku: skill, batas, atau percakapan berubah.')
    return null
  }
  if (!withinSendingHours(policy, now)) {
    await db
      .from('whatsapp_chat_goals')
      .where('jid', jid)
      .where('version', run.version)
      .update({
        next_run_at: nextFollowUpAt(
          policy,
          Number(goal.followup_count),
          new Date(0),
          new Date(0),
          now
        ),
      })
    return null
  }
  const version = randomUUID()
  const changed = await db
    .from('whatsapp_chat_goals')
    .where('jid', jid)
    .where('version', run.version)
    .whereIn('status', ['waiting', 'waiting_answer', 'waiting_payment'])
    .update({
      version,
      status: 'processing',
      next_run_at: null,
      followup_count: Number(goal.followup_count) + 1,
      last_followup_at: now,
      updated_at: now,
    })
  return Number(changed) ? { ...run, version } : null
}

export async function scheduledGoalStillAllowed(run: GoalRun, skills: Skill[], now = new Date()) {
  const goal = await readConversationGoal(run.jid)
  if (!goal || goal.version !== run.version || goal.status !== 'processing') return false
  let policy: FollowUpPolicy | null = null
  try {
    policy = JSON.parse(goal.policy_json)
  } catch {}
  const source = skills.find((skill) => skill.name === policy?.skill_name)
  return Boolean(
    source &&
    hashSkill(source) === goal.skill_hash &&
    validPolicy(policy) &&
    withinSendingHours(policy, now) &&
    Number(goal.followup_count) <= policy.max_attempts
  )
}
