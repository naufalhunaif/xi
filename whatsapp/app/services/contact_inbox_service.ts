import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { ensureLeanTables } from '#beta3/tables'
import { rescanSelfDeliveries, scanShipments } from '#beta3/shipments'
import { reconcileCsTotals } from '#beta3/order_service'
import { repairAutoRoles } from '#beta3/contact_role'

let reconciled = false
/**
 * Perbaikan data sekali per proses (kotak masuk atau halaman Order, mana yang dibuka dulu):
 * total CS tertinggal (v3.6.32) → peran vendor keliru (v3.6.33) → antar-sendiri lama (v3.6.34).
 */
export function oneTimeMaintenance() {
  if (reconciled) return
  reconciled = true
  void (async () => {
    await reconcileCsTotals().catch(() => 0)
    await repairAutoRoles().catch(() => 0)
    await rescanSelfDeliveries().catch(() => 0)
  })()
}

type InboxMessage = {
  id: number
  jid: string
  message_line_id: number | null
  line: number
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
  /** Prioritas dari Jev (1–5) dalam 24 jam terakhir; 0 = tidak ada. */
  priority: number
}

/**
 * Room = pelanggan (jid) + nomor penerima (line; 1 = nomor utama). Satu pelanggan yang chat ke
 * dua nomor toko tampil sebagai dua room (v3.6.24). Pesan tanpa line_id = nomor utama.
 */
export const roomLine = (value: unknown) => {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 1 ? id : 1
}
export const lineSql = (alias: string) => `COALESCE(${alias}.line_id, 1)`

/** Workspace read state is separate from WhatsApp delivery/read receipts. Penanda baca per room (jid + nomor). */
/**
 * Sebelum penanda lama per kontak (workspace_read_id) dinaikkan, bekukan posisi baca room
 * nomor lain milik pelanggan yang sama — agar menandai room nomor 2 tidak ikut "membaca" room nomor 1.
 */
async function freezeOtherLines(jid: string) {
  await db.rawQuery(
    `INSERT IGNORE INTO whatsapp_room_reads (jid, line_id, read_id, updated_at)
     SELECT m.jid, ${lineSql('m')}, COALESCE(c.workspace_read_id, 0), ?
     FROM whatsapp_messages m LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
     WHERE m.jid = ? GROUP BY m.jid, ${lineSql('m')}`,
    [new Date(), jid]
  )
}

export async function markRoomRead(jid: string, throughId: number, line = 1) {
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
  const lineId = roomLine(line)
  await freezeOtherLines(jid)
  await db.rawQuery(
    `INSERT INTO whatsapp_room_reads (jid, line_id, read_id, updated_at)
     VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE read_id = GREATEST(read_id, VALUES(read_id)), updated_at = VALUES(updated_at)`,
    [jid, lineId, throughId, new Date()]
  )
  // Penanda lama (per kontak) ikut naik: dipakai pengiriman tanda baca ke WhatsApp & data lama.
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, workspace_read_id, updated_at)
    VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE workspace_read_id = GREATEST(workspace_read_id, VALUES(workspace_read_id))`,
    [jid, throughId, new Date()]
  )
}

/**
 * Tandai beberapa room dibaca / belum dibaca (pilihan di kotak masuk).
 * Dibaca = penanda ke pesan terakhir. Belum dibaca = penanda ke sebelum pesan masuk terakhir,
 * sehingga satu pesan terhitung belum dibaca (seperti "Tandai belum dibaca" di WhatsApp).
 */
export async function setRoomsReadState(rooms: Array<string | { jid: string; line?: unknown }>, state: 'read' | 'unread') {
  await initializeDatabase()
  const wanted = new Map<string, { jid: string; line: number }>()
  for (const item of rooms) {
    const jid = String(typeof item === 'string' ? item : item?.jid || '')
    if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid|ig)$/.test(jid)) continue
    const line = roomLine(typeof item === 'string' ? 1 : item.line)
    wanted.set(`${jid}|${line}`, { jid, line })
    if (wanted.size >= 2000) break
  }
  if (!wanted.size) throw new Error('Room tidak valid.')
  const jids = [...new Set([...wanted.values()].map((room) => room.jid))]
  const result = await db.rawQuery(
    `SELECT jid, ${lineSql('whatsapp_messages')} AS line, MAX(id) AS last_id,
       MAX(CASE WHEN direction = 'in' THEN id ELSE 0 END) AS last_in_id
     FROM whatsapp_messages WHERE jid IN (${jids.map(() => '?').join(',')}) GROUP BY jid, ${lineSql('whatsapp_messages')}`,
    jids
  )
  let changed = 0
  for (const row of result[0] as any[]) {
    const room = wanted.get(`${row.jid}|${roomLine(row.line)}`)
    if (!room) continue
    const lastId = Number(row.last_id) || 0
    const lastIn = Number(row.last_in_id) || 0
    if (state === 'unread' && !lastIn) continue
    const readId = state === 'read' ? lastId : Math.max(0, lastIn - 1)
    await freezeOtherLines(room.jid)
    await db.rawQuery(
      `INSERT INTO whatsapp_room_reads (jid, line_id, read_id, updated_at)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE read_id = VALUES(read_id), updated_at = VALUES(updated_at)`,
      [room.jid, room.line, readId, new Date()]
    )
    if (state === 'read')
      await db.rawQuery(
        `INSERT INTO whatsapp_contacts (jid, workspace_read_id, updated_at)
         VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE workspace_read_id = GREATEST(workspace_read_id, VALUES(workspace_read_id)), updated_at = VALUES(updated_at)`,
        [room.jid, readId, new Date()]
      )
    changed++
  }
  return changed
}

/**
 * v3.6.44 (kotak masuk ringan): `jids` = hanya room milik kontak itu (pembaruan per kejadian);
 * `limit`/`offset` = halaman room terbaru (muat bertahap). Tanpa opsi = semua room (seperti dulu).
 */
export type InboxQuery = { jids?: string[]; limit?: number; offset?: number }

export async function latestInboxMessages(query: InboxQuery = {}) {
  await initializeDatabase()
  await ensureLeanTables()
  if (query.jids && !query.jids.length) return []
  let jids = query.jids
  let ids: number[] | null = null
  if (query.limit) {
    // Halaman room terbaru dulu (murah: hanya id pesan terakhir per room), lalu baris lengkap
    // dihitung untuk room di halaman itu saja.
    const page = await db.rawQuery(
      `SELECT ranked.id, ranked.jid FROM (
         SELECT id, jid, created_at,
           ROW_NUMBER() OVER (PARTITION BY jid, ${lineSql('whatsapp_messages')} ORDER BY created_at DESC, id DESC) AS position
         FROM whatsapp_messages${jids ? ` WHERE jid IN (${jids.map(() => '?').join(',')})` : ''}
       ) ranked WHERE ranked.position = 1 ORDER BY ranked.created_at DESC, ranked.id DESC LIMIT ? OFFSET ?`,
      [...(jids || []), Math.max(1, Math.min(500, query.limit)), Math.max(0, query.offset || 0)]
    )
    const rows = page[0] as Array<{ id: number; jid: string }>
    if (!rows.length) return []
    ids = rows.map((row) => Number(row.id))
    jids = [...new Set(rows.map((row) => String(row.jid)))]
  }
  const jidFilter = (column: string) => (jids ? ` AND ${column} IN (${jids.map(() => '?').join(',')})` : '')
  const jidBindings = jids || []
  // Pembayaran = pelanggan sudah bayar dan menunggu konfirmasi CS: kirim gambar setelah
  // total dikirim, atau AI mencatat tahap bukti_dikirim (belum ada order lunas sesudahnya).
  // v3.6.30: gambar dihitung bukti hanya bila hasil pilah isinya "bukti" atau belum dipilah (note '?' = gagal dilihat);
  // foto jas/model/ukuran sesudah rekening bukan pembayaran.
  const notProofSql = (alias: string) =>
    `NOT EXISTS (SELECT 1 FROM whatsapp_beta3_proofs k WHERE k.message_id = ${alias}.message_id
              AND k.kind <> 'bukti' AND k.note <> '\\?')`  // \\? = tanda tanya biasa (bukan parameter knex)
  const paymentSql = `NOT EXISTS (SELECT 1 FROM whatsapp_contacts cv WHERE cv.jid = m.jid AND cv.role IN ('vendor', 'lainnya'))
        AND (EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'awaiting_payment'
          AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.jid = m.jid AND p.direction = 'in'
            AND p.media_type = 'image' AND p.created_at > b.updated_at AND ${notProofSql('p')}))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid AND b.status = 'paid'
          AND b.paid_amount < b.total
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_shipments sx WHERE sx.jid = m.jid
            AND (sx.created_at >= b.created_at OR b.source = 'rekap'))
          AND EXISTS (SELECT 1 FROM whatsapp_messages p WHERE p.jid = m.jid AND p.direction = 'in'
            AND p.media_type = 'image' AND p.created_at > COALESCE(b.paid_checked_at, b.updated_at)
            AND ${notProofSql('p')}))
        OR EXISTS (SELECT 1 FROM whatsapp_beta3_chats n WHERE n.jid = m.jid
          AND n.note REGEXP 'tahap[[:space:]]*[:=][[:space:]]*bukti_dikirim'
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders d WHERE d.jid = m.jid
            AND d.status IN ('paid', 'cancelled') AND d.updated_at >= n.updated_at)))`
  // Resi terkirim = pesan keluar (AI/CS/pemilik) yang memuat nomor resi, kata-katanya
  // bebas (dipindai kode → whatsapp_beta3_shipments). Selesai = chat sudah dikirimi resi dan
  // tidak ada pesanan baru sesudahnya (order dari rekap dibuat belakangan, jadi tidak dihitung
  // "baru"). Order = pesanan berjalan yang belum dikirimi resi. Lunas > 45 hari tanpa resi
  // di chat dianggap selesai.
  await scanShipments().catch(() => {})
  oneTimeMaintenance()
  const resiSql = (alias: string, after = '') =>
    `EXISTS (SELECT 1 FROM whatsapp_beta3_shipments ${alias} WHERE ${alias}.jid = m.jid${after})`
  const lastResiSql = `(SELECT MAX(rl.created_at) FROM whatsapp_beta3_shipments rl WHERE rl.jid = m.jid)`
  const shippedSql = `(${resiSql('rs', ' AND rs.created_at >= b.created_at')} OR (b.source = 'rekap' AND b.status NOT IN ('pending', 'awaiting_payment') AND ${resiSql('r2')}))`
  // Order = pesanan yang sudah dibayar (DP/lunas) dan belum dikirim. Belum bayar = belum order
  // (masih tanya-tanya / menunggu pembayaran), jadi tidak masuk tab ini.
  const orderSql = `NOT EXISTS (SELECT 1 FROM whatsapp_contacts cvo WHERE cvo.jid = m.jid AND cvo.role IN ('vendor', 'lainnya'))
        AND EXISTS (SELECT 1 FROM whatsapp_beta3_orders b WHERE b.jid = m.jid
          AND b.status = 'paid' AND b.updated_at >= NOW() - INTERVAL 45 DAY AND NOT ${shippedSql})`
  const doneSql = `(${resiSql('r5')}
          AND NOT EXISTS (SELECT 1 FROM whatsapp_beta3_orders n WHERE n.jid = m.jid
            AND (n.source <> 'rekap' OR n.status IN ('pending', 'awaiting_payment'))
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
      SELECT jid, ${lineSql('whatsapp_messages')} AS line, id, created_at,
        ROW_NUMBER() OVER (PARTITION BY jid, ${lineSql('whatsapp_messages')} ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages WHERE direction = 'out' AND status IN ('sent', 'delivered', 'read')${jidFilter('jid')}
    )
    SELECT m.id, m.jid, m.line_id AS message_line_id, ${lineSql('m')} AS line,
      COALESCE(NULLIF(c.name, ''), NULLIF(pc.name, ''),
        (SELECT NULLIF(x.name, '') FROM whatsapp_contacts x WHERE x.phone_jid = m.jid
          AND x.jid <> m.jid AND x.name IS NOT NULL AND x.name <> '' LIMIT 1),
        m.contact_name,
        (SELECT n.contact_name FROM whatsapp_messages n WHERE n.jid = m.jid AND n.direction = 'in'
          AND n.contact_name IS NOT NULL AND n.contact_name <> '' ORDER BY n.id DESC LIMIT 1)) AS contact_name,
      COALESCE(NULLIF(c.phone_jid, ''), CASE WHEN m.jid LIKE '%@s.whatsapp.net' THEN m.jid END) AS phone_jid,
      m.body, m.media_type,
      m.direction, m.created_at,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid AND ${lineSql('u')} = ${lineSql('m')}
        AND u.direction = 'in' AND u.id > COALESCE(rr.read_id, c.workspace_read_id, 0)) AS unread_count,
      (SELECT COUNT(*) FROM whatsapp_messages u WHERE u.jid = m.jid AND ${lineSql('u')} = ${lineSql('m')} AND u.direction = 'in'
        AND (r.id IS NULL OR u.created_at > r.created_at
          OR (u.created_at = r.created_at AND u.id > r.id))) AS unanswered_count,
      (${paymentSql}) AS needs_payment,
      (${orderSql}) AS has_order,
      (${doneSql}) AS done_order,
      (SELECT pr.score FROM whatsapp_beta3_priority pr WHERE pr.jid = m.jid
        AND pr.created_at >= NOW() - INTERVAL 1 DAY) AS priority
    FROM whatsapp_messages m
    JOIN (SELECT id, ROW_NUMBER() OVER (PARTITION BY jid, ${lineSql('whatsapp_messages')} ORDER BY created_at DESC, id DESC) AS position
      FROM whatsapp_messages WHERE 1 = 1${jidFilter('jid')}) ranked ON ranked.id = m.id AND ranked.position = 1
    LEFT JOIN whatsapp_contacts c ON c.jid = m.jid
    LEFT JOIN whatsapp_contacts pc ON pc.jid = c.phone_jid AND pc.jid <> m.jid
    LEFT JOIN whatsapp_room_reads rr ON rr.jid = m.jid AND rr.line_id = ${lineSql('m')}
    LEFT JOIN successful_replies r ON r.jid = m.jid AND r.line = ${lineSql('m')} AND r.position = 1
    ${ids ? `WHERE m.id IN (${ids.map(() => '?').join(',')})` : ''}
    ORDER BY m.created_at DESC, m.id DESC`, [...jidBindings, ...jidBindings, ...(ids || [])])
  return (result[0] as InboxMessage[]).map((message) => ({
    ...message,
    line: roomLine(message.line),
    unread_count: Number(message.unread_count),
    unanswered_count: Number(message.unanswered_count),
    needs_payment: Boolean(Number(message.needs_payment)),
    has_order: Boolean(Number(message.has_order)),
    done_order: Boolean(Number(message.done_order)),
    priority: Number(message.priority) || 0,
  }))
}
