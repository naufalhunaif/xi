import { generateMessageIDV2 } from '@whiskeysockets/baileys'
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'

const pending = new Set<string>()
const key = (jid: string, id: string) => `${workspaceScope().prefix}:${jid}:${id}`

/** Own-device echoes can arrive before sendMessage resolves and before SQL persistence. */
export function isTrackedOutgoingMessage(jid: string, id: string) {
  return pending.has(key(jid, id))
}

export async function trackOutgoingMessage<T>(jid: string, operation: (id: string) => Promise<T>) {
  const id = generateMessageIDV2()
  const identity = key(jid, id)
  pending.add(identity)
  try {
    return await operation(id)
  } finally {
    pending.delete(identity)
  }
}

type Row = Record<string, any> & {
  message_id: string
  jid: string
  direction: 'out'
  sender_type: 'ai'
}
type Repository = {
  insert: (row: Row) => Promise<unknown>
  find: (id: string) => Promise<Record<string, any> | undefined>
  promote: (row: Row) => Promise<unknown>
}
const repository: Repository = {
  insert: async (row) => db.table('whatsapp_messages').insert(row),
  find: async (id) => db.from('whatsapp_messages').where('message_id', id).first(),
  promote: async (row) => {
    const content = Object.fromEntries(
      Object.entries(row).filter(
        ([field]) =>
          !['message_id', 'jid', 'direction', 'created_at', 'status', 'contact_name'].includes(
            field
          )
      )
    )
    await db
      .from('whatsapp_messages')
      .where('message_id', row.message_id)
      .where('jid', row.jid)
      .where('direction', 'out')
      .update({
        ...content,
        // Delivery/read receipts may arrive between the duplicate check and update.
        status: db.raw("CASE WHEN status IN ('read', 'delivered') THEN status ELSE 'sent' END"),
      })
  },
}

/** A confirmed send must not become a send failure just because its echo won the insert. */
export async function saveSentAiMessage(row: Row, store: Repository = repository) {
  try {
    await store.insert(row)
  } catch (error) {
    if ((error as any)?.code !== 'ER_DUP_ENTRY' && (error as any)?.errno !== 1062) throw error
    const existing = await store.find(row.message_id)
    if (!existing || existing.jid !== row.jid || existing.direction !== 'out')
      throw new Error('Konflik identitas pesan; penyimpanan perlu diperiksa.')
    await store.promote(row)
  }
}
