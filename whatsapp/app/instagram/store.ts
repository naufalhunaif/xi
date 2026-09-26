// Instagram (DM + komentar) — konfigurasi & tabel per workspace.
import { randomBytes } from 'node:crypto'
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'

export const IG_SUFFIX = '@ig'
export const isInstagramJid = (jid: unknown) => String(jid || '').endsWith(IG_SUFFIX)
export const instagramJid = (igsid: string) => `${igsid}${IG_SUFFIX}`
export const instagramUserId = (jid: string) => jid.slice(0, -IG_SUFFIX.length)

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS whatsapp_instagram (
    id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
    app_id VARCHAR(40) NOT NULL DEFAULT '',
    app_secret VARCHAR(120) NOT NULL DEFAULT '',
    verify_token VARCHAR(64) NOT NULL DEFAULT '',
    ig_user_id VARCHAR(40) NOT NULL DEFAULT '',
    username VARCHAR(120) NOT NULL DEFAULT '',
    access_token TEXT NULL,
    token_expires_at DATETIME NULL,
    dm_enabled TINYINT(1) NOT NULL DEFAULT 1,
    comments_enabled TINYINT(1) NOT NULL DEFAULT 1,
    comment_target VARCHAR(10) NOT NULL DEFAULT 'both',
    hide_spam TINYINT(1) NOT NULL DEFAULT 0,
    last_error VARCHAR(300) NULL,
    connected_at DATETIME NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_instagram_comments (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    comment_id VARCHAR(64) NOT NULL,
    media_id VARCHAR(64) NOT NULL DEFAULT '',
    parent_id VARCHAR(64) NULL,
    from_id VARCHAR(64) NOT NULL DEFAULT '',
    username VARCHAR(120) NOT NULL DEFAULT '',
    text TEXT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'new',
    kind VARCHAR(20) NULL,
    public_reply TEXT NULL,
    private_reply TEXT NULL,
    error VARCHAR(300) NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY whatsapp_instagram_comments_comment (comment_id),
    KEY whatsapp_instagram_comments_status (status, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

const ready = new Set<string>()
export async function ensureInstagramTables() {
  const key = workspaceScope().prefix
  if (ready.has(key)) return
  for (const statement of STATEMENTS) await db.rawQuery(statement)
  await db.rawQuery(
    `INSERT IGNORE INTO whatsapp_instagram (id, verify_token, updated_at) VALUES (1, ?, ?)`,
    [randomBytes(16).toString('hex'), new Date()]
  )
  // Kolom tambahan (instalasi lama): id DM penerima balasan pribadi komentar.
  try {
    await db.rawQuery(
      'ALTER TABLE whatsapp_instagram_comments ADD COLUMN dm_igsid VARCHAR(64) NULL'
    )
  } catch (error) {
    if ((error as any)?.errno !== 1060) throw error
  }
  ready.add(key)
}

/** Komentar terakhir yang menjadi asal DM ini (konteks AI; tidak tampil di chat). */
export async function commentOrigin(jid: string) {
  if (!isInstagramJid(jid)) return null
  await ensureInstagramTables()
  const row = await db
    .from('whatsapp_instagram_comments')
    .where('dm_igsid', instagramUserId(jid))
    .where('updated_at', '>=', new Date(Date.now() - 7 * 24 * 3_600_000))
    .orderBy('id', 'desc')
    .first()
  return row ? { text: String(row.text || ''), privateReply: String(row.private_reply || '') } : null
}

export type InstagramConfig = {
  appId: string
  appSecret: string
  verifyToken: string
  igUserId: string
  username: string
  accessToken: string
  tokenExpiresAt: Date | null
  dmEnabled: boolean
  commentsEnabled: boolean
  commentTarget: 'dm' | 'wa' | 'both'
  hideSpam: boolean
  lastError: string
  connected: boolean
}

export async function readInstagram(): Promise<InstagramConfig> {
  await ensureInstagramTables()
  const row = (await db.from('whatsapp_instagram').where('id', 1).first()) || {}
  const target = ['dm', 'wa', 'both'].includes(String(row.comment_target)) ? row.comment_target : 'both'
  return {
    appId: String(row.app_id || ''),
    appSecret: String(row.app_secret || ''),
    verifyToken: String(row.verify_token || ''),
    igUserId: String(row.ig_user_id || ''),
    username: String(row.username || ''),
    accessToken: String(row.access_token || ''),
    tokenExpiresAt: row.token_expires_at ? new Date(row.token_expires_at) : null,
    dmEnabled: Boolean(row.dm_enabled ?? 1),
    commentsEnabled: Boolean(row.comments_enabled ?? 1),
    commentTarget: target,
    hideSpam: Boolean(row.hide_spam),
    lastError: String(row.last_error || ''),
    connected: Boolean(row.access_token && row.ig_user_id),
  }
}

export async function updateInstagram(values: Record<string, unknown>) {
  await ensureInstagramTables()
  await db
    .from('whatsapp_instagram')
    .where('id', 1)
    .update({ ...values, updated_at: new Date() })
}
