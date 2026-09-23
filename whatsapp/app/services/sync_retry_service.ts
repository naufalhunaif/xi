import db from '#services/workspace_database'
import { BufferJSON, type WAMessage } from '@whiskeysockets/baileys'

export async function saveSyncRetry(message: WAMessage, attempts: number) {
  const id = message.key.id
  const jid = message.key.remoteJid
  if (!id || !jid) return
  const delay = Math.min(60, 2 ** Math.max(0, attempts - 1)) * 1000
  await db.rawQuery(
    `INSERT INTO whatsapp_sync_retries
    (message_id,jid,payload_json,attempts,status,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?, ?,?,?,?,?) ON DUPLICATE KEY UPDATE
    attempts=VALUES(attempts),status=VALUES(status),next_attempt_at=VALUES(next_attempt_at),updated_at=VALUES(updated_at)`,
    [
      id,
      jid,
      JSON.stringify(message, BufferJSON.replacer),
      attempts,
      attempts >= 5 ? 'failed' : 'pending',
      new Date(Date.now() + delay),
      new Date(),
      new Date(),
    ]
  )
}

export async function dueSyncRetries() {
  const rows = await db
    .from('whatsapp_sync_retries')
    .where('status', 'pending')
    .where('next_attempt_at', '<=', new Date())
    .orderBy('created_at')
    .limit(25)
  return rows.map((row) => ({
    message: JSON.parse(row.payload_json, BufferJSON.reviver) as WAMessage,
    attempts: Number(row.attempts),
  }))
}

export async function finishSyncRetry(messageId: string) {
  // Drop only the retry payload after it is safely persisted in the chat table.
  await db.from('whatsapp_sync_retries').where('message_id', messageId).delete()
}
