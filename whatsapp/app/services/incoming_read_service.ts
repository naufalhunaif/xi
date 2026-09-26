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
export async function flushWorkspaceReads(socket: ReadSocket, line = 1) {
  const rows = await db
    .from('whatsapp_messages as m')
    .join('whatsapp_contacts as c', 'c.jid', 'm.jid')
    .select('m.id', 'm.jid', 'm.message_id')
    .where('m.direction', 'in')
    // Tanda baca dikirim oleh nomor yang menerima pesan itu.
    .where((query) => {
      if (line > 1) query.where('m.line_id', line)
      else query.whereNull('m.line_id').orWhere('m.line_id', '<=', 1)
    })
    .whereNot('m.status', 'read')
    .whereColumn('m.id', '<=', 'c.workspace_read_id')
    .orderBy('m.id', 'asc')
    .limit(BATCH_SIZE)
  await acknowledge(socket, rows)
}
