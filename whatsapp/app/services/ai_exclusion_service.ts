import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { invalidateConversationGoal } from '#services/conversation_goal_service'

export async function setAiExcluded(jid: string, excluded: boolean) {
  await initializeDatabase()
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid|ig)$/.test(jid) || typeof excluded !== 'boolean')
    throw new Error('Kontak atau status tidak valid.')
  const message = await db.from('whatsapp_messages').where('jid', jid).first()
  const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
  if (!message && !contact) throw new Error('Pilih kontak dari daftar chat.')
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, ai_excluded, handling_mode, updated_at)
    VALUES (?, ?, 'cs', ?) ON DUPLICATE KEY UPDATE ai_excluded = VALUES(ai_excluded),
    handling_mode = 'cs', activity = NULL, activity_updated_at = NULL, updated_at = VALUES(updated_at)`,
    [jid, excluded, new Date()]
  )
  // Both adding/removing require a fresh, deliberate activation before another AI reply.
  await invalidateConversationGoal(jid, true)
  await db.from('whatsapp_ai_reviews').where('jid', jid).delete()
}
