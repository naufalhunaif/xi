import db from '#services/workspace_database'

/**
 * Status WhatsApp milik toko (diunggah dari HP). Disimpan supaya saat pelanggan membalas
 * status ("yang ini berapa?"), AI tahu status mana yang dimaksud — caption dan fotonya.
 * Tabel terpisah dari whatsapp_messages agar tidak muncul sebagai room di kotak masuk.
 */
export type StatusPost = {
  message_id: string
  caption: string
  media_type: string | null
  media_url: string | null
  thumbnail_url: string | null
  media_status: string | null
  created_at: Date
}

export async function saveStatusPost(post: {
  messageId: string
  caption: string
  mediaType?: string | null
  mediaUrl?: string | null
  thumbnailUrl?: string | null
  mediaStatus?: string | null
  createdAt: Date
}) {
  await db.rawQuery(
    `INSERT INTO whatsapp_status_posts (message_id, caption, media_type, media_url, thumbnail_url, media_status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       caption = IF(VALUES(caption) <> '', VALUES(caption), caption),
       media_type = COALESCE(VALUES(media_type), media_type),
       media_url = COALESCE(VALUES(media_url), media_url),
       thumbnail_url = COALESCE(VALUES(thumbnail_url), thumbnail_url),
       media_status = COALESCE(VALUES(media_status), media_status)`,
    [
      post.messageId,
      post.caption || '',
      post.mediaType || null,
      post.mediaUrl || null,
      post.thumbnailUrl || null,
      post.mediaStatus || null,
      post.createdAt,
    ]
  )
}

export async function updateStatusMedia(messageId: string, patch: { media_url?: string | null; media_status: string }) {
  await db.from('whatsapp_status_posts').where('message_id', messageId).update(patch)
}

export async function statusPost(messageId: string): Promise<StatusPost | null> {
  if (!messageId) return null
  const row = await db.from('whatsapp_status_posts').where('message_id', messageId).first()
  return (row as StatusPost) || null
}

export async function statusPostsByIds(ids: string[]): Promise<Map<string, StatusPost>> {
  const clean = [...new Set(ids.filter(Boolean))]
  if (!clean.length) return new Map()
  const rows = await db.from('whatsapp_status_posts').whereIn('message_id', clean)
  return new Map((rows as StatusPost[]).map((row) => [String(row.message_id), row]))
}

/** Teks singkat untuk AI/riwayat: "status WhatsApp toko: "Tuxedo navy ready M"" atau foto tanpa caption. */
export function describeStatus(post: Pick<StatusPost, 'caption' | 'media_type'>) {
  const caption = String(post.caption || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const media = post.media_type === 'video' || post.media_type === 'gif' ? 'video' : post.media_type ? 'foto' : ''
  if (caption) return `status WhatsApp toko${media ? ` (${media})` : ''}: "${caption}"`
  return `status WhatsApp toko (${media || 'tanpa teks'}, tanpa caption)`
}

/** Nama file media/thumbnail status di public/media (null bila belum ada). */
export function statusImageFile(post: Pick<StatusPost, 'media_type' | 'media_url' | 'thumbnail_url'>) {
  const source =
    post.media_type === 'video' || post.media_type === 'gif' ? post.thumbnail_url : post.media_url || post.thumbnail_url
  const name = String(source || '').split('/').pop()
  return name || null
}
