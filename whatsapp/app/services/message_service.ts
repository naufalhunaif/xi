import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { invalidateConversationGoal } from '#services/conversation_goal_service'
import { requestAiReview, type ReviewReason } from '#services/ai_review_service'
import type { CsMedia } from '#services/cs_media_service'

export function isDirectContactJid(jid: string) {
  return /@(?:s\.whatsapp\.net|lid|ig)$/.test(jid)
}

export async function setHandlingMode(
  jid: string,
  mode: 'ai' | 'cs',
  reason = '',
  reviewReason: ReviewReason = 'enabled'
) {
  if (!isDirectContactJid(jid)) throw new Error('Kontak tidak valid.')
  if (mode === 'ai') {
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    if (contact?.ai_excluded)
      throw new Error('Hapus kontak dari daftar Jangan dibalas AI terlebih dahulu.')
  }
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts
     (jid, name, profile_picture_url, activity, activity_updated_at, handling_mode,
      handoff_reason, handoff_at, updated_at)
     VALUES (?, NULL, NULL, NULL, NULL, ?, NULLIF(?, ''), ?, ?)
     ON DUPLICATE KEY UPDATE handling_mode = IF(ai_excluded = 1, 'cs', VALUES(handling_mode)),
       handoff_reason = VALUES(handoff_reason), handoff_at = VALUES(handoff_at),
       updated_at = VALUES(updated_at)`,
    [jid, mode, reason, mode === 'cs' ? new Date() : null, new Date()]
  )
  if (mode === 'cs') await invalidateConversationGoal(jid, true)
  else await requestAiReview(jid, reviewReason)
}

/** A confirmed human reply closes the handoff, without enabling global AI. */
export async function resumeAiAfterHumanReply(
  jid: string,
  reason: 'human_reply' | 'human_decision' = 'human_reply'
) {
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (contact?.ai_excluded) return
  // Another CS bubble is still waiting to be sent. Keep AI paused until it is sent.
  const pending = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'out')
    .where('sender_type', 'cs')
    .where('status', 'queued')
    .first()
  if (pending) return
  // Never resurrect a model run or follow-up prepared before the human answered.
  await invalidateConversationGoal(jid, true)
  await setHandlingMode(jid, 'ai', '', reason)
}

export async function queueOutgoingMessage(input: {
  jid: string
  body: string
  replyToId?: number
  replyToMessageId?: string
  media?: CsMedia
}) {
  if (!isDirectContactJid(input.jid)) throw new Error('Kontak tidak valid.')
  if ((!input.body && !input.media) || input.body.length > (input.media ? 1024 : 4096))
    throw new Error(input.media ? 'Caption maksimal 1.024 karakter.' : 'Pesan tidak valid.')

  let target: Record<string, any> | undefined
  if (input.replyToId || input.replyToMessageId) {
    target = input.replyToId
      ? await db.from('whatsapp_messages').where('id', input.replyToId).first()
      : await db
          .from('whatsapp_messages')
          .where('message_id', String(input.replyToMessageId))
          .first()
  }
  if ((input.replyToId || input.replyToMessageId) && (!target || target.jid !== input.jid))
    throw new Error('Pesan reply tidak ditemukan di room ini.')

  await db.table('whatsapp_messages').insert({
    message_id: `queued-${randomUUID()}`,
    jid: input.jid,
    contact_name: null,
    direction: 'out',
    sender_type: 'cs',
    body: input.body,
    ...(input.media
      ? {
          media_upload_id: input.media.id,
          media_name: input.media.name,
          media_size: input.media.size,
          media_type: input.media.type,
          media_mime: input.media.mime,
          media_url: input.media.url,
          media_status: 'ready',
        }
      : {}),
    reply_to_message_id: target?.message_id || null,
    status: 'queued',
    created_at: new Date(),
  })
  await setHandlingMode(input.jid, 'cs')
}
