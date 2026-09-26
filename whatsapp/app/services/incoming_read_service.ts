import type { WASocket } from '@whiskeysockets/baileys'
import db from '#services/workspace_database'

type ReadSocket = Pick<WASocket, 'readMessages'>
type IncomingReadRow = { id: number; jid: string; message_id: string }
const BATCH_SIZE = 100

async function acknowledge(socket: ReadSocket, rows: IncomingReadRow[]) {
  if (!rows.length) return
  await socket.readMessages(
    rows.map((row) => ({
      remoteJid: row.jid,
      id: row.message_id,
      fromMe: false,
    }))
  )
  // Persist only receipts actually sent. A failed batch remains eligible for retry.
  await db
    .from('whatsapp_messages')
    .where('direction', 'in')
    .whereIn(
      'id',
      rows.map((row) => row.id)
    )
    .update({ status: 'read' })
}

/** Same ingestion boundary as the inbox badge; never consume a later arrival. */
export async function readIncomingThrough(
  socket: ReadSocket,
  jid: string,
  throughId: number,
  canRead: () => Promise<boolean> = async () => true
) {
  if (!Number.isSafeInteger(throughId) || throughId < 1) return
  const anchor = await db.from('whatsapp_messages').where('jid', jid).where('id', throughId).first()
  if (!anchor || !/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid)) return
  while (await canRead()) {
    const rows = await db
      .from('whatsapp_messages')
      .select('id', 'jid', 'message_id')
      .where('jid', jid)
      .where('direction', 'in')
      .where('id', '<=', throughId)
      .whereNot('status', 'read')
      .orderBy('id', 'asc')
      .limit(BATCH_SIZE)
    if (!rows.length) return
    await acknowledge(socket, rows)
  }
}

/** Manual room reads persist in workspace_read_id, so receipt delivery survives restart. */
export async function flushWorkspaceReads(socket: ReadSocket) {
  const rows = await db
    .from('whatsapp_messages as m')
    .join('whatsapp_contacts as c', 'c.jid', 'm.jid')
    .select('m.id', 'm.jid', 'm.message_id')
    .where('m.direction', 'in')
    .whereNot('m.status', 'read')
    .whereColumn('m.id', '<=', 'c.workspace_read_id')
    // Tanda baca hanya untuk WhatsApp; room Instagram tidak lewat soket WA.
    .whereNot('m.jid', 'like', '%@ig')
    .orderBy('m.id', 'asc')
    .limit(BATCH_SIZE)
  await acknowledge(socket, rows)
}
