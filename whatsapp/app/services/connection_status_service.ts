import db from '#services/workspace_database'
import { ensureDefaults } from '#services/settings_service'

const labels: Record<string, string> = {
  disconnected: 'Terputus',
  connecting: 'Menghubungkan',
  qr: 'Scan QR',
  connected: 'Terhubung',
  error: 'Belum terhubung',
}

export function presentConnection(row: Record<string, any>, now = new Date()) {
  const heartbeat = row.worker_heartbeat_at
    ? new Date(row.worker_heartbeat_at).getTime()
    : Number.NaN
  const alive =
    Number.isFinite(heartbeat) &&
    now.getTime() - heartbeat >= -5000 &&
    now.getTime() - heartbeat < 20_000
  return {
    ...row,
    worker_online: alive,
    status: alive ? row.status : 'worker_offline',
    status_label: alive ? labels[row.status] || 'Belum terhubung' : 'Belum terhubung',
    qr_data_url: alive ? row.qr_data_url : null,
    // Keep technical diagnostics in storage, not in the customer-facing status response.
    last_error: null,
  }
}

export async function readConnectionStatus() {
  await ensureDefaults()
  return presentConnection(await db.from('whatsapp_connection').where('id', 1).firstOrFail())
}

export async function startWorkerHeartbeat(workerId: string) {
  await db
    .from('whatsapp_connection')
    .where('id', 1)
    .update({ worker_id: workerId, worker_heartbeat_at: new Date() })
}

export async function touchWorkerHeartbeat(workerId: string) {
  await db
    .from('whatsapp_connection')
    .where('id', 1)
    .where('worker_id', workerId)
    .update({ worker_heartbeat_at: new Date() })
}

export async function stopWorkerHeartbeat(workerId: string) {
  await db
    .from('whatsapp_connection')
    .where('id', 1)
    .where('worker_id', workerId)
    .update({ worker_heartbeat_at: null, worker_id: null })
}
