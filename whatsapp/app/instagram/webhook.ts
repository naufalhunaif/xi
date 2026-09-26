// Webhook Instagram: DM masuk/echo → whatsapp_messages (room "<igsid>@ig"),
// komentar → antrean whatsapp_instagram_comments. Balasan AI dikerjakan listener.
import { createHash } from 'node:crypto'
import db from '#services/workspace_database'
import { inWorkspace } from '#services/workspace_context'
import { activeWorkspace } from '#services/workspace_service'
import { invalidateConversationGoal } from '#services/conversation_goal_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import { ensureInstagramTables, instagramJid, readInstagram } from '#instagram/store'
import { userProfile } from '#instagram/api'
import { downloadIncoming } from '#instagram/media'

/** mid Instagram bisa sangat panjang; kolom message_id maks. 190. */
export function igMessageId(mid: string) {
  const value = String(mid || '')
  return value.length <= 180 ? value : `igh_${createHash('sha256').update(value).digest('hex')}`
}

type Attachment = { type?: string; payload?: { url?: string; title?: string } }
type MessagingEvent = {
  sender?: { id?: string }
  recipient?: { id?: string }
  timestamp?: number
  message?: {
    mid?: string
    text?: string
    is_echo?: boolean
    is_deleted?: boolean
    is_unsupported?: boolean
    attachments?: Attachment[]
    reply_to?: { mid?: string; story?: { url?: string } }
  }
}
type CommentChange = {
  field?: string
  value?: {
    id?: string
    text?: string
    parent_id?: string
    from?: { id?: string; username?: string }
    media?: { id?: string }
  }
}
export type InstagramWebhook = {
  object?: string
  entry?: Array<{ id?: string; time?: number; messaging?: MessagingEvent[]; changes?: CommentChange[] }>
}

const ATTACHMENT_NOTE: Record<string, string> = {
  video: '[video]',
  audio: '[pesan suara]',
  file: '[file]',
  share: '[membagikan postingan]',
  ig_reel: '[membagikan reel]',
  reel: '[membagikan reel]',
  story_mention: '[menyebut akun kita di story]',
  animated_image_share: '[stiker]',
  ig_post: '[membagikan postingan]',
}

export async function handleInstagramWebhook(payload: InstagramWebhook) {
  if (payload?.object !== 'instagram') return
  const scope = await activeWorkspace()
  if (!scope.id) return
  await inWorkspace(scope, async () => {
    await ensureInstagramTables()
    const config = await readInstagram()
    if (!config.connected) return
    for (const entry of payload.entry || []) {
      for (const event of entry.messaging || []) {
        try {
          await ingestMessage(config, event)
        } catch (error) {
          console.error(`Instagram DM: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      for (const change of entry.changes || []) {
        if (change.field !== 'comments' || !config.commentsEnabled) continue
        const value = change.value || {}
        if (!value.id || !value.from?.id || value.from.id === config.igUserId) continue
        if (config.username && value.from.username === config.username) continue
        await db.rawQuery(
          `INSERT IGNORE INTO whatsapp_instagram_comments
            (comment_id, media_id, parent_id, from_id, username, text, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
          [
            value.id,
            value.media?.id || '',
            value.parent_id || null,
            value.from.id,
            value.from.username || '',
            String(value.text || '').slice(0, 4000),
            new Date(),
            new Date(),
          ]
        )
      }
    }
  })
}

async function ingestMessage(
  config: Awaited<ReturnType<typeof readInstagram>>,
  event: MessagingEvent
) {
  const message = event.message
  if (!message?.mid || message.is_deleted) return
  const echo = Boolean(message.is_echo) || event.sender?.id === config.igUserId
  const customerId = echo ? event.recipient?.id : event.sender?.id
  if (!customerId || customerId === config.igUserId) return
  const jid = instagramJid(customerId)
  const messageId = igMessageId(message.mid)
  if (await db.from('whatsapp_messages').where('message_id', messageId).first()) return
  const createdAt = new Date(Number(event.timestamp) || Date.now())

  const notes: string[] = []
  let image: { url: string; mime: string; size: number } | null = null
  for (const attachment of message.attachments || []) {
    const type = String(attachment.type || '')
    if (type === 'image' && attachment.payload?.url && !image) {
      image = await downloadIncoming(attachment.payload.url, messageId).catch(() => null)
      if (!image) notes.push('[gambar tidak bisa diunduh]')
    } else notes.push(ATTACHMENT_NOTE[type] || `[${type || 'lampiran'}]`)
  }
  if (message.reply_to?.story) notes.unshift('[membalas story]')
  if (message.is_unsupported) notes.push('[pesan tidak didukung]')
  const body = [String(message.text || '').trim(), ...notes].filter(Boolean).join('\n')
  if (!body && !image) return

  if (echo) {
    // Balasan yang dikirim aplikasi ini sendiri (AI/CS) juga kembali sebagai echo.
    // Pencocokan isi mencegah dobel bila echo datang sebelum id tersimpan.
    const recent = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .where('created_at', '>=', new Date(Date.now() - 5 * 60_000))
      .where((query) => {
        if (image) query.where('media_type', 'image')
        else query.where('body', body)
      })
      .first()
    if (recent) return
  }

  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  let name = String(contact?.name || '')
  if (!name && config.accessToken) {
    const profile = await userProfile(config.accessToken, customerId)
    name = profile.username ? `IG @${profile.username}` : profile.name ? `IG ${profile.name}` : ''
  }
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, name, updated_at) VALUES (?, NULLIF(?, ''), ?)
     ON DUPLICATE KEY UPDATE name = COALESCE(name, VALUES(name)), updated_at = VALUES(updated_at)`,
    [jid, name, new Date()]
  )
  try {
    await db.table('whatsapp_messages').insert({
      message_id: messageId,
      jid,
      contact_name: echo ? null : name || null,
      direction: echo ? 'out' : 'in',
      sender_type: echo ? 'owner' : 'customer',
      body,
      media_type: image ? 'image' : null,
      media_url: image?.url || null,
      thumbnail_url: image?.url || null,
      media_mime: image?.mime || null,
      media_status: image ? 'ready' : null,
      reply_to_message_id: message.reply_to?.mid ? igMessageId(message.reply_to.mid) : null,
      status: echo ? 'sent' : 'received',
      created_at: createdAt,
    })
  } catch (error) {
    if ((error as any)?.errno === 1062) return
    throw error
  }
  if (echo) await resumeAiAfterHumanReply(jid)
  else await invalidateConversationGoal(jid)
}
