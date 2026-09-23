import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { alreadyAnalyzedMessage, failedGoalMessage } from '#services/conversation_goal_service'

export type ReviewReason =
  'enabled' | 'human_reply' | 'human_decision' | 'reconnected' | 'schedule_open'

export async function requestAiReview(jid: string, reason: ReviewReason) {
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (contact?.ai_excluded) return
  if (reason !== 'human_decision' && (await alreadyAnalyzedMessage(jid))) return
  if (!['human_decision', 'enabled'].includes(reason) && (await failedGoalMessage(jid))) return
  await db.rawQuery(
    `INSERT INTO whatsapp_ai_reviews (jid, version, reason, status, requested_at)
     VALUES (?, ?, ?, 'pending', ?)
     ON DUPLICATE KEY UPDATE version=VALUES(version), reason=VALUES(reason),
       status='pending', requested_at=VALUES(requested_at)`,
    [jid, randomUUID(), reason, new Date()]
  )
}

export async function requestRecentAiReviews(reason: ReviewReason, maxAgeHours: number) {
  const since = new Date(Date.now() - Math.max(1, maxAgeHours) * 3_600_000)
  const rooms = await db
    .from('whatsapp_messages as m')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'm.jid')
    .where('m.created_at', '>=', since)
    .where((query) => query.whereNull('c.ai_excluded').orWhere('c.ai_excluded', false))
    .where((query) => query.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
    .where((query) =>
      query.where('m.jid', 'like', '%@lid').orWhere('m.jid', 'like', '%@s.whatsapp.net')
    )
    .distinct('m.jid')
  for (const room of rooms) {
    if (reason === 'reconnected' || reason === 'schedule_open') {
      const latest = await db
        .from('whatsapp_messages')
        .where('jid', room.jid)
        .whereNotIn('status', ['queued', 'failed'])
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .first()
      if (latest?.direction !== 'in') continue
    }
    await requestAiReview(room.jid, reason)
  }
}

export async function finishAiReview(jid: string, version: string, failed = false) {
  // Never discard a newer request that arrived while the model was running.
  const query = db.from('whatsapp_ai_reviews').where('jid', jid).where('version', version)
  if (failed) await query.update({ status: 'failed' })
  else await query.delete()
}
