// Nomor WhatsApp tambahan (line ≥ 2). Tabel global: satu daftar untuk semua workspace.
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'

let ready: Promise<void> | undefined
export function ensureLinesTable() {
  ready ??= (async () => {
    await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_lines (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NULL,
      desired_connected TINYINT(1) NOT NULL DEFAULT 1,
      status VARCHAR(20) NOT NULL DEFAULT 'connecting',
      qr_data_url MEDIUMTEXT NULL,
      last_error VARCHAR(300) NULL,
      auth_version CHAR(36) NOT NULL,
      heartbeat_at DATETIME NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
  })().catch((error) => {
    ready = undefined
    throw error
  })
  return ready
}

export type LineRow = {
  id: number
  phone: string | null
  desired_connected: number
  status: string
  qr_data_url: string | null
  last_error: string | null
  auth_version: string
  heartbeat_at: Date | null
}

export async function listLines(): Promise<LineRow[]> {
  await ensureLinesTable()
  return db.from('whatsapp_lines').orderBy('id', 'asc')
}

export async function readLine(id: number): Promise<LineRow | null> {
  await ensureLinesTable()
  return (await db.from('whatsapp_lines').where('id', id).first()) || null
}

export async function updateLine(id: number, values: Record<string, unknown>) {
  await ensureLinesTable()
  await db
    .from('whatsapp_lines')
    .where('id', id)
    .update({ ...values, updated_at: new Date() })
}

/** Tambah nomor: worker menyalakan proses baru yang menampilkan QR. */
export async function createLine() {
  await ensureLinesTable()
  const pending = await db
    .from('whatsapp_lines')
    .whereNull('phone')
    .where('desired_connected', 1)
    .first()
  if (pending) return Number(pending.id)
  const [id] = await db.table('whatsapp_lines').insert({
    desired_connected: 1,
    status: 'connecting',
    auth_version: randomUUID(),
    created_at: new Date(),
    updated_at: new Date(),
  })
  return Number(id)
}

/** Putuskan: proses line logout, menghapus sesi, lalu menghapus baris ini. */
export async function requestLineDisconnect(id: number) {
  await updateLine(id, { desired_connected: 0, status: 'disconnecting' })
}

/** Kunci sesi Baileys per line disimpan di tabel baileys_auth dengan awalan ini. */
export const lineAuthPrefix = (id: number) => (id > 1 ? `ln${id}|` : '')
