import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { ensureLeanTables } from '#beta3/tables'
import { scanShipments } from '#beta3/shipments'

type InboxMessage = {
  id: number
  jid: string
  contact_name: string | null
  phone_jid: string | null
  body: string
  media_type: string | null
  direction: 'in' | 'out'
  created_at: Date
  unread_count: number
  unanswered_count: number
  needs_payment: boolean
  has_order: boolean
  done_order: boolean
}

/** Workspace read state is separate from WhatsApp delivery/read receipts. */
export async function markRoomRead(jid: string, throughId: number) {
  await initializeDatabase()
  if (
    !/^[^@\s]+@(?:s\.whatsapp\.net|lid|ig)$/.test(jid) ||
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

export async function latestInboxMessages() {
  await initializeDatabase()
  await ensureLeanTables()
  // Pembayaran = pelanggan sudah bayar dan menunggu konfirmasi CS: kirim gambar setelah
  // total dikirim, atau AI mencatat tahap bukti_dikirim (belum ada order lunas sesudahnya).
  const paymentSql = `EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'awaiting_payment'
          AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.jid = m.jid AND p.direction = 'in'
            AND p.media_type = 'image' AND p.created_at > b.updated_at))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'paid'
          AND b.paid_amount < b.total
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_shipments sx WHERE sx.jid = m.jid
            AND (sx.created_at >= b.created_at OR b.source = 'rekap'))
          AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.jid = m.jid AND p.direction = 'in'
            AND p.media_type = 'image' AND p.created_at > COALESCE(b.paid_checked_at, b.updated_at)
            AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_proofs k WHERE k.message_id = p.message_id
              AND k.kind IN ('model', 'ukuran', 'lain'))))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_chats n WHERE n.jid = m.jid
          AND n.note REGEXP 'tahap[[:space:]]*[:=][[:space:]]*bukti_dikirim'
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders d WHERE d.jid = m.jid
            AND d.status IN ('paid', 'cancelled') AND d.updated_at >= n.updated_at))`
  // Resi terkirim = pesan keluar (AI/CS/pemilik) yang memuat nomor resi, kata-katanya
  // bebas (dipindai kode → whatsapp_beta3_shipments). Selesai = chat sudah dikirimi resi dan
  // tidak ada pesanan baru sesudahnya (order dari rekap dibuat belakangan, jadi tidak dihitung
  // "baru"). Order = pesanan berjalan yang belum dikirimi resi. Lunas > 45 hari tanpa resi
  // di chat dianggap selesai.
  await scanShipments().catch(() => {})
  const resiSql = (alias: string, after = '') =>
    `EXISTS (SELECT 1 FROM whatsapp_beta3_shipments ${alias} WHERE ${alias}.jid = m.jid${after})`
  const lastResiSql = `(SELECT MAX(rl.created_at) FROM whatsapp_beta3_shipments rl WHERE rl.jid = m.jid)`
  const shippedSql = `(${resiSql('rs', ' AND rs.created_at >= b.created_at')} OR (b.source = 'rekap' AND ${resiSql('r2')}))`
  // Order = pesanan yang sudah dibayar (DP/lunas) dan belum dikirim. Belum bayar = belum order
  // (masih tanya-tanya / menunggu pembayaran), jadi tidak masuk tab ini.
  const orderSql = `EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid
          AND b.status = 'paid' AND b.updated_at >= NOW() - INTERVAL 45 DAY AND NOT ${shippedSql})`
  const doneSql = `(${resiSql('r5')}
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders n WHERE n.jid = m.jid AND n.source <> 'rekap'
            AND n.status <> 'cancelled' AND n.created_at > ${lastResiSql})
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_specs ns WHERE ns.jid = m.jid AND ns.spec <> ''
            AND ns.updated_at > ${lastResiSql}))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'paid'
          AND b.updated_at < NOW() - INTERVAL 45 DAY
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders n2 WHERE n2.jid = m.jid
            AND n2.status <> 'cancelled' AND n2.created_at > b.updated_at))`
  // Nama: kontak ini, pasangan LID ↔ nomor HP (dua arah), lalu nama WA terakhir dari
  // pesan masuk (pesan keluar tidak membawa nama pelanggan).
  const result = await db.rawQuery(`WITH successful_replies AS (
      SELECT jid, id, created_at,
        ROW_NUMBER() OVER (PARTITION BY jid ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages WHERE direction = 'out' AND status IN ('sent', 'delivered', 'read')
    )
    SELECT m.id, m.jid,
      COALESCE(NULLIF(c.name, ''), NULLIF(pc.name, ''),
        (SELECT NULLIF(x.name, '') FROM whatsapp_contacts x WHERE x.phone_jid = m.jid
          AND x.jid <> m.jid AND x.name IS NOT NULL AND x.name <> '' LIMIT 1),
        m.contact_name,
        (SELECT n.contact_name FROM whatsapp_messages n WHERE n.jid = m.jid AND n.direction = 'in'
          AND n.contact_name IS NOT NULL AND n.contact_name <> '' ORDER BY n.id DESC LIMIT 1)) AS contact_name,
      COALESCE(NULLIF(c.phone_jid, ''), CASE WHEN m.jid LIKE '%@s.whatsapp.net' THEN m.jid END) AS phone_jid,
      m.body, m.media_type,
      m.direction, m.created_at,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid
        AND u.direction = 'in' AND u.id > COALESCE(c.workspace_read_id, 0)) AS unread_count,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid AND u.direction = 'in'
        AND (r.id IS NULL OR u.created_at > r.created_at
          OR (u.created_at = r.created_at AND u.id > r.id))) AS unanswered_count,
      (${paymentSql}) AS needs_payment,
      (${orderSql}) AS has_order,
      (${doneSql}) AS done_order
    FROM whatsapp_messages m
    JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY jid ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages) ranked ON ranked.id = m.id AND ranked.position = 1
    LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
    LEFT JOIN whatsapp_contacts pc ON pc.jid = c.phone_jid AND pc.jid <> m.jid
    LEFT JOIN successful_replies r ON r.jid = m.jid AND r.position = 1
    ORDER BY m.created_at DESC, m.id DESC`)
  return (result[0] as InboxMessage[]).map((message) => ({
    ...message,
    unread_count: Number(message.unread_count),
    unanswered_count: Number(message.unanswered_count),
    needs_payment: Boolean(Number(message.needs_payment)),
    has_order: Boolean(Number(message.has_order)),
    done_order: Boolean(Number(message.done_order)),
  }))
}
