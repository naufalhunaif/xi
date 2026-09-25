// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'

/**
 * Tabel jalur ramping (beta 2). Dibuat lazy oleh init model dan oleh service
 * ini sendiri, tanpa migration, mengikuti pola tabel lain di workspace.
 */
export const LEAN_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_catalog (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    product VARCHAR(120) NOT NULL,
    color VARCHAR(80) NOT NULL DEFAULT '',
    category VARCHAR(60) NOT NULL DEFAULT '',
    price INT UNSIGNED NULL,
    sizes_ready VARCHAR(120) NOT NULL DEFAULT '',
    sizes_all VARCHAR(120) NOT NULL DEFAULT '',
    photo_url VARCHAR(1000) NULL,
    material_available TINYINT(1) NOT NULL DEFAULT 0,
    fit VARCHAR(40) NOT NULL DEFAULT '',
    note VARCHAR(255) NOT NULL DEFAULT '',
    active TINYINT(1) NOT NULL DEFAULT 1,
    updated_at DATETIME NOT NULL,
    UNIQUE KEY whatsapp_beta3_catalog_variant (product, color)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_examples (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    situation VARCHAR(255) NOT NULL DEFAULT '',
    customer_text TEXT NOT NULL,
    cs_text TEXT NOT NULL,
    tags VARCHAR(255) NOT NULL DEFAULT '',
    source VARCHAR(20) NOT NULL DEFAULT 'seed',
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_customers (
    jid VARCHAR(190) NOT NULL PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_orders (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    jid VARCHAR(190) NOT NULL,
    source_message_id VARCHAR(190) NULL,
    customer_name VARCHAR(190) NOT NULL DEFAULT '',
    address TEXT NULL,
    district VARCHAR(120) NOT NULL DEFAULT '',
    regency VARCHAR(120) NOT NULL DEFAULT '',
    postal_code VARCHAR(20) NOT NULL DEFAULT '',
    phone VARCHAR(40) NOT NULL DEFAULT '',
    items TEXT NOT NULL,
    note TEXT NULL,
    chat_note TEXT NULL,
    shipping_service VARCHAR(40) NOT NULL DEFAULT '',
    shipping_cost INT UNSIGNED NULL,
    subtotal INT UNSIGNED NULL,
    total INT UNSIGNED NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    cs_note TEXT NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    KEY whatsapp_beta3_orders_status (status, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_specs (
    jid VARCHAR(190) NOT NULL PRIMARY KEY,
    spec TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `ALTER TABLE whatsapp_beta3_catalog
    ADD COLUMN IF NOT EXISTS features VARCHAR(160) NOT NULL DEFAULT '' AFTER fit,
    ADD COLUMN IF NOT EXISTS features_ai VARCHAR(160) NOT NULL DEFAULT '' AFTER features,
    ADD COLUMN IF NOT EXISTS features_ai_photo VARCHAR(1000) NULL AFTER features_ai,
    ADD COLUMN IF NOT EXISTS material VARCHAR(80) NOT NULL DEFAULT '' AFTER features_ai_photo,
    ADD COLUMN IF NOT EXISTS size_group VARCHAR(60) NOT NULL DEFAULT '' AFTER material`,
  `ALTER TABLE whatsapp_beta3_orders
    ADD COLUMN IF NOT EXISTS order_number VARCHAR(32) NULL AFTER id,
    ADD COLUMN IF NOT EXISTS spec TEXT NULL AFTER items,
    ADD COLUMN IF NOT EXISTS group_jid VARCHAR(190) NULL AFTER cs_note,
    ADD COLUMN IF NOT EXISTS group_status VARCHAR(20) NOT NULL DEFAULT 'none' AFTER group_jid,
    ADD COLUMN IF NOT EXISTS group_sent_at DATETIME NULL AFTER group_status,
    ADD COLUMN IF NOT EXISTS group_error TEXT NULL AFTER group_sent_at,
    ADD COLUMN IF NOT EXISTS shipping_options TEXT NULL AFTER shipping_cost,
    ADD COLUMN IF NOT EXISTS auto_total_reason VARCHAR(190) NULL AFTER shipping_options`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_chats (
    jid VARCHAR(190) NOT NULL PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_refs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    jid VARCHAR(190) NOT NULL,
    order_id INT UNSIGNED NULL,
    message_id VARCHAR(190) NULL,
    image_url VARCHAR(1000) NOT NULL,
    part VARCHAR(80) NOT NULL DEFAULT '',
    note VARCHAR(300) NOT NULL DEFAULT '',
    box VARCHAR(60) NULL,
    created_at DATETIME NOT NULL,
    updated_at DATETIME NOT NULL,
    KEY whatsapp_beta3_refs_jid (jid, order_id),
    KEY whatsapp_beta3_refs_order (order_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS whatsapp_beta3_state (
    name VARCHAR(64) NOT NULL PRIMARY KEY,
    value TEXT NULL,
    updated_at DATETIME NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
]

const ready = new Set<string>()

export async function readLeanState(name: string) {
  await ensureLeanTables()
  const row = await db.from('whatsapp_beta3_state').where('name', name).first()
  return row?.value === null || row?.value === undefined ? '' : String(row.value)
}

export async function writeLeanState(name: string, value: string) {
  await ensureLeanTables()
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_state (name, value, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [name, value, new Date()]
  )
}

export async function ensureLeanTables() {
  const scopeKey = workspaceScope().prefix
  if (ready.has(scopeKey)) return
  for (const statement of LEAN_TABLE_STATEMENTS) await db.rawQuery(statement)
  ready.add(scopeKey)
}

/**
 * Memori Beta 2 per chat: catatan pelanggan, spesifikasi, order lean, dan state
 * per jid (ongkir:last, fit:last, fit:<jid>:…). Dipanggil oleh "Hapus chat &
 * media" (semua) dan hapus per kontak (jids) supaya AI mulai dari nol lagi.
 * Katalog, contoh CS, sumber MCP, dan skill tidak disentuh.
 */
export async function deleteLeanChatData(trx: any, jids?: string[]) {
  await ensureLeanTables()
  for (const table of [
    'whatsapp_beta3_customers',
    'whatsapp_beta3_specs',
    'whatsapp_beta3_orders',
    'whatsapp_beta3_chats',
    'whatsapp_beta3_refs',
  ]) {
    const query = trx.from(table)
    if (jids) query.whereIn('jid', jids)
    await query.delete()
  }
  const state = trx.from('whatsapp_beta3_state')
  if (jids) {
    state.where((q: any) => {
      for (const jid of jids)
        q.orWhere('name', `ongkir:last:${jid}`)
          .orWhere('name', `fit:last:${jid}`)
          .orWhere('name', 'like', `fit:${jid}:%`)
          .orWhere('name', `alamat:${jid}`)
    })
  } else {
    state.where((q: any) =>
      q.where('name', 'like', 'ongkir:last:%').orWhere('name', 'like', 'fit:%')
    )
  }
  await state.delete()
}

/** Catatan chat Beta 3 per nomor (pengganti whatsapp_contacts.chat_note milik Beta 1/2). */
export async function readBeta3ChatNote(jid: string) {
  await ensureLeanTables()
  const row = await db.from('whatsapp_beta3_chats').where('jid', jid).first()
  return row?.note ? String(row.note) : ''
}

export async function writeBeta3ChatNote(jid: string, note: string) {
  const value = note.trim().slice(0, 4000)
  if (!value) return
  await ensureLeanTables()
  await db.rawQuery(
    `INSERT INTO whatsapp_beta3_chats (jid, note, updated_at) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE note = VALUES(note), updated_at = VALUES(updated_at)`,
    [jid, value, new Date()]
  )
}
