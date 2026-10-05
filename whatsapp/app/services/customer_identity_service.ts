import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'

/** Only a phone-number JID is a phone. LIDs and bare numeric IDs are never decoded. */
export function phoneFromJid(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return /^([1-9][0-9]{6,14})(?::[0-9]+)?@s\.whatsapp\.net$/.exec(value)?.[1] || null
}

export async function resolveCustomerPhoneJid(
  jid: string,
  lookup: (lid: string) => Promise<string | null | undefined>,
  alternate?: string | null
): Promise<string | null> {
  const direct = phoneFromJid(jid)
  if (direct) return `${direct}@s.whatsapp.net`
  if (!/^[0-9]+(?::[0-9]+)?@lid$/.test(jid)) return null
  const supplied = phoneFromJid(alternate)
  let mapped: string | null = null
  try {
    mapped = phoneFromJid(await lookup(jid))
  } catch {
    // A temporary mapping lookup failure must not interrupt message ingestion.
  }
  if (supplied && mapped && supplied !== mapped) return null
  const phone = mapped || supplied
  return phone ? `${phone}@s.whatsapp.net` : null
}

export async function rememberCustomerPhone(
  jid: string,
  lookup: (lid: string) => Promise<string | null | undefined>,
  alternate?: string | null
) {
  const phoneJid = await resolveCustomerPhoneJid(jid, lookup, alternate)
  if (!phoneJid || phoneFromJid(phoneJid) === workspaceScope().phone) return
  await db.rawQuery(
    `INSERT INTO whatsapp_contacts (jid, phone_jid, phone_resolved_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE phone_jid = VALUES(phone_jid),
       phone_resolved_at = VALUES(phone_resolved_at)`,
    [jid, phoneJid, new Date(), new Date()]
  )
}

/**
 * Satu pelanggan bisa punya dua room: `…@lid` (ID internal WhatsApp) dan `…@s.whatsapp.net` (nomor).
 * Room kanonik = nomor HP. Begitu pasangannya diketahui, seluruh data room LID dipindah ke room nomor
 * supaya tidak ada dua room untuk orang yang sama (riwayat chat untuk AI pun jadi utuh).
 */
const RENAME_TABLES = [
  'whatsapp_messages',
  'whatsapp_reactions',
  'whatsapp_beta3_orders',
  'whatsapp_beta3_proofs',
  'whatsapp_beta3_refs',
  'whatsapp_beta3_shipments',
  'whatsapp_beta3_tests',
  'whatsapp_ai_traces',
  'whatsapp_conversation_evaluations',
  'whatsapp_evaluation_history',
  'whatsapp_customer_balance_entries',
  'whatsapp_payment_reviews',
  'whatsapp_payment_wait_notices',
  'whatsapp_shipping_notices',
  'whatsapp_production_signals',
  'whatsapp_cart_events',
  'whatsapp_order_operations',
  'whatsapp_order_routing',
  'whatsapp_orders',
  'whatsapp_approval_wait_episodes',
  'whatsapp_sync_retries',
  'whatsapp_chat_goals',
  'whatsapp_ai_reviews',
  'whatsapp_carts',
  'whatsapp_beta3_customers',
  'whatsapp_beta3_specs',
  'whatsapp_beta3_chats',
  'whatsapp_beta3_priority',
  'whatsapp_customer_memory',
  'whatsapp_chat_deletions',
]
/** Tabel berkunci jid: bila room nomor sudah punya baris, baris LID yang tersisa dibuang (room nomor menang). */
const KEYED_TABLES = new Set([
  'whatsapp_chat_goals',
  'whatsapp_ai_reviews',
  'whatsapp_carts',
  'whatsapp_beta3_customers',
  'whatsapp_beta3_specs',
  'whatsapp_beta3_chats',
  'whatsapp_beta3_priority',
  'whatsapp_customer_memory',
  'whatsapp_chat_deletions',
])
const LID_RE = /^[0-9]+(?::[0-9]+)?@lid$/

export function isLidJid(jid: string) {
  return LID_RE.test(jid)
}

/** Room kanonik untuk jid pesan: LID dengan pasangan nomor → room nomor; `62xxx:3@s.whatsapp.net` → tanpa akhiran perangkat. */
export async function canonicalRoomJid(jid: string): Promise<string> {
  const phone = phoneFromJid(jid)
  if (phone) return `${phone}@s.whatsapp.net`
  if (!isLidJid(jid)) return jid
  const row = await db.from('whatsapp_contacts').where('jid', jid).select('phone_jid').first()
  return row?.phone_jid && phoneFromJid(row.phone_jid) ? String(row.phone_jid) : jid
}

/** Pindahkan semua data room LID ke room nomor. Mengembalikan jumlah pesan yang dipindah. */
export async function mergeLidRoom(lid: string, phoneJid: string): Promise<number> {
  if (!isLidJid(lid) || !phoneFromJid(phoneJid) || lid === phoneJid) return 0
  let moved = 0
  for (const table of RENAME_TABLES) {
    try {
      const result = await db.rawQuery(`UPDATE IGNORE ${table} SET jid = ? WHERE jid = ?`, [phoneJid, lid])
      if (table === 'whatsapp_messages') moved = Number((result[0] as any)?.affectedRows || 0)
      if (KEYED_TABLES.has(table)) await db.rawQuery(`DELETE FROM ${table} WHERE jid = ?`, [lid])
    } catch {
      /* tabel belum ada di workspace ini */
    }
  }
  // Nama/foto dari kontak LID ikut ke kontak nomor bila di sana masih kosong; penanda baca dipindah.
  try {
    const src = await db.from('whatsapp_contacts').where('jid', lid).first()
    if (src)
      await db.rawQuery(
        `INSERT INTO whatsapp_contacts (jid, name, profile_picture_url, line_id, workspace_read_id, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           name = COALESCE(NULLIF(name, ''), VALUES(name)),
           profile_picture_url = COALESCE(profile_picture_url, VALUES(profile_picture_url)),
           line_id = COALESCE(line_id, VALUES(line_id)),
           workspace_read_id = GREATEST(COALESCE(workspace_read_id, 0), COALESCE(VALUES(workspace_read_id), 0))`,
        [phoneJid, src.name || null, src.profile_picture_url || null, src.line_id ?? null, src.workspace_read_id ?? null]
      )
  } catch {}
  return moved
}

/** Sapu room LID yang pasangannya sudah diketahui tapi masih punya pesan sendiri (data lama). */
export async function mergeKnownLidRooms(): Promise<number> {
  const rows = await db.rawQuery(
    `SELECT c.jid, c.phone_jid FROM whatsapp_contacts c
     WHERE c.jid LIKE '%@lid' AND c.phone_jid IS NOT NULL AND c.phone_jid <> c.jid
       AND EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.jid = c.jid) LIMIT 200`
  )
  let total = 0
  for (const row of rows[0] as any[]) total += await mergeLidRoom(String(row.jid), String(row.phone_jid)).catch(() => 0)
  return total
}
