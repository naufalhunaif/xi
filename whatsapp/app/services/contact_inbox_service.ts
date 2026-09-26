import { isBeta3Mode } from '#services/settings_service'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { ensureLeanTables } from '#beta3/tables'

type InboxMessage = {
  id: number
  jid: string
  contact_name: string | null
  body: string
  media_type: string | null
  direction: 'in' | 'out'
  created_at: Date
  unread_count: number
  unanswered_count: number
  needs_payment: boolean
  has_order: boolean
}

/** Workspace read state is separate from WhatsApp delivery/read receipts. */
export async function markRoomRead(jid: string, throughId: number) {
  await initializeDatabase()
  if (
    !/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid) ||
    !Number.isSafeInteger(throughId) ||
    throughId < 1
  )
    throw new Error('Room atau pesan tidak valid.')
  const message = await db
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('id', throughId)
    .first()
  if (!message) throw new Error('Pesan tidak ditemukan di room ini.')
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, workspace_read_id, updated_at)
    VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE workspace_read_id = GREATEST(workspace_read_id, VALUES(workspace_read_id))`,
    [jid, throughId, new Date()]
  )
}

const PAYMENT_SQL = `COALESCE(cart.payment_status = 'reported', 0) OR EXISTS (
        SELECT 1 FROM whatsapp_payment_reviews review
        JOIN whatsapp_orders o ON o.id = review.order_id AND o.jid = m.jid
        WHERE review.jid = m.jid AND o.status = 'active'
          AND review.cart_version = cart.version AND review.order_paid = o.paid
          AND NOT EXISTS (SELECT 1 FROM whatsapp_order_payments p
            WHERE p.proof_message_id = review.proof_message_id)
      )`
const ORDER_SQL = `COALESCE(JSON_LENGTH(CASE WHEN JSON_VALID(cart.items_json) THEN cart.items_json ELSE '[]' END), 0) > 0
        OR EXISTS (SELECT 1 FROM whatsapp_orders o WHERE o.jid = m.jid AND o.status = 'active')`

export async function latestInboxMessages() {
  await initializeDatabase()
  // Beta 3: filter Pembayaran/Order memakai order Beta 3 (bukan keranjang Beta 1).
  const beta3 = await isBeta3Mode().catch(() => false)
  if (beta3) await ensureLeanTables()
  // Pembayaran = pelanggan sudah bayar dan menunggu konfirmasi CS: kirim gambar setelah
  // total dikirim, atau AI mencatat tahap bukti_dikirim (belum ada order lunas sesudahnya).
  const paymentSql = beta3
    ? `EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'awaiting_payment'
          AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.jid = m.jid AND p.direction = 'in'
            AND p.media_type = 'image' AND p.created_at > b.updated_at))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_chats n WHERE n.jid = m.jid
          AND n.note REGEXP 'tahap[[:space:]]*[:=][[:space:]]*bukti_dikirim'
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders d WHERE d.jid = m.jid
            AND d.status IN ('paid', 'cancelled') AND d.updated_at >= n.updated_at))`
    : PAYMENT_SQL
  // Order = pesanan berjalan: form masuk, menunggu bayar, atau lunas tapi belum sampai grup.
  const orderSql = beta3
    ? `EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid
          AND (b.status IN ('pending', 'awaiting_payment')
            OR (b.status = 'paid' AND b.group_status IN ('pending', 'failed'))))`
    : ORDER_SQL
  const result = await db.rawQuery(`WITH successful_replies AS (
      SELECT jid, id, created_at,
        ROW_NUMBER() OVER (PARTITION BY jid ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages WHERE direction = 'out' AND status IN ('sent', 'delivered', 'read')
    )
    SELECT m.id, m.jid,
      -- Nama: kontak ini, kontak nomor HP pasangannya (LID ↔ nomor), atau nama WA
      -- terakhir dari pesan masuk. Pesan keluar tidak membawa nama pelanggan.
      COALESCE(NULLIF(c.name, ''), NULLIF(pc.name, ''), m.contact_name,
        (SELECT n.contact_name FROM whatsapp_messages n WHERE n.jid = m.jid AND n.direction = 'in'
          AND n.contact_name IS NOT NULL AND n.contact_name <> '' ORDER BY n.id DESC LIMIT 1)) AS contact_name,
      m.body, m.media_type,
      m.direction, m.created_at,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid
        AND u.direction = 'in' AND u.id > COALESCE(c.workspace_read_id, 0)) AS unread_count,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid AND u.direction = 'in'
        AND (r.id IS NULL OR u.created_at > r.created_at
          OR (u.created_at = r.created_at AND u.id > r.id))) AS unanswered_count,
      (${paymentSql}) AS needs_payment,
      (${orderSql}) AS has_order
    FROM whatsapp_messages m
    JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY jid ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages) ranked ON ranked.id = m.id AND ranked.position = 1
    LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
    LEFT JOIN whatsapp_contacts pc ON pc.jid = c.phone_jid AND pc.jid <> m.jid
    LEFT JOIN successful_replies r ON r.jid = m.jid AND r.position = 1
    LEFT JOIN whatsapp_carts cart ON cart.jid = m.jid
    ORDER BY m.created_at DESC, m.id DESC`)
  return (result[0] as InboxMessage[]).map((message) => ({
    ...message,
    unread_count: Number(message.unread_count),
    unanswered_count: Number(message.unanswered_count),
    needs_payment: Boolean(Number(message.needs_payment)),
    has_order: Boolean(Number(message.has_order)),
  }))
}
