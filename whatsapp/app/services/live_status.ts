// v3.6.116 — status sambungan untuk bilah atas (WhatsApp, nomor, order menunggu). Dulu setiap tab menanyakannya
// tiap 2 detik; sekarang dibaca sekali per workspace oleh pemeriksa kejadian (SSE) dan didorong ke semua tab
// hanya bila berubah. /api/status tetap ada untuk muat awal & cadangan.
import { readConnectionStatus } from '#services/connection_status_service'
import { pendingOrderCount } from '#services/pending_orders'
import { listLines } from '#services/line_service'

export async function statusPayload() {
  const [state, pendingOrders, lines] = await Promise.all([
    readConnectionStatus(),
    pendingOrderCount(),
    listLines().catch(() => []),
  ])
  const linesConnected = lines.filter((line) => line.status === 'connected').length
  return { ...state, pendingOrders, linesConnected }
}

/** Bagian yang terlihat di layar saja (detak worker & waktu ubah tidak dihitung → tidak memicu kiriman). */
export function statusSignature(payload: Record<string, any>) {
  return JSON.stringify([
    payload.status,
    payload.status_label,
    Boolean(payload.desired_connected),
    Boolean(payload.worker_online),
    payload.phone || '',
    payload.qr_data_url || '',
    Number(payload.pendingOrders || 0),
    Number(payload.linesConnected || 0),
  ])
}
