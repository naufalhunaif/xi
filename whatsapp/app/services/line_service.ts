// Nomor tambahan (line ≥ 2). Tabel global: satu daftar untuk semua workspace.
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
    // v3.6.18: satu proses per nomor (sewa) — mencegah dua proses memegang sesi yang sama.
    await db.rawQuery(`ALTER TABLE whatsapp_lines ADD COLUMN IF NOT EXISTS worker_id CHAR(36) NULL AFTER heartbeat_at`)
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
  worker_id: string | null
}

/** Sewa nomor tambahan: proses hidup ditandai heartbeat ≤ LEASE_MS; lewat itu proses lain boleh mengambil alih. */
export const LINE_LEASE_MS = 20_000

/** Ambil sewa nomor untuk proses ini. false = proses lain masih memegangnya (heartbeat segar). */
export async function claimLine(id: number, workerId: string) {
  await ensureLinesTable()
  const result = await db.rawQuery(
    `UPDATE whatsapp_lines SET worker_id = ?, heartbeat_at = NOW(), updated_at = NOW()
     WHERE id = ? AND (worker_id IS NULL OR worker_id = ? OR heartbeat_at IS NULL OR heartbeat_at < NOW() - INTERVAL ${Math.round(LINE_LEASE_MS / 1000)} SECOND)`,
    [workerId, id, workerId]
  )
  return Number((result[0] as any)?.affectedRows || 0) > 0
}

/** Perpanjang sewa; false = sewa sudah diambil proses lain (proses ini harus berhenti). */
export async function touchLine(id: number, workerId: string) {
  const result = await db.rawQuery(
    `UPDATE whatsapp_lines SET heartbeat_at = NOW() WHERE id = ? AND worker_id = ?`,
    [id, workerId]
  )
  return Number((result[0] as any)?.affectedRows || 0) > 0
}

export async function releaseLine(id: number, workerId: string) {
  await db.rawQuery(`UPDATE whatsapp_lines SET worker_id = NULL WHERE id = ? AND worker_id = ?`, [id, workerId])
}

/** Nomor yang sedang dipegang proses hidup (untuk supervisor: jangan nyalakan proses kedua). */
export function lineHeld(line: Pick<LineRow, 'worker_id' | 'heartbeat_at'>, ownWorkerIds: Set<string>) {
  if (!line.worker_id || ownWorkerIds.has(line.worker_id) || !line.heartbeat_at) return false
  return Date.now() - new Date(line.heartbeat_at).getTime() < LINE_LEASE_MS
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
/** Hapus nomor tambahan beserta sesinya sekarang juga (proses nomor itu berhenti sendiri). */
export async function removeLineNow(id: number) {
  await db.transaction(async (trx) => {
    await trx.from('baileys_auth').where('auth_key', 'like', `${lineAuthPrefix(id)}%`).delete()
    await trx.from('whatsapp_lines').where('id', id).delete()
  })
}

export async function requestLineDisconnect(id: number) {
  await updateLine(id, { desired_connected: 0, status: 'disconnecting' })
}

/** Kunci sesi Baileys per line disimpan di tabel baileys_auth dengan awalan ini. */
export const lineAuthPrefix = (id: number) => (id > 1 ? `ln${id}|` : '')
