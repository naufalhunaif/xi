import type { HttpContext } from '@adonisjs/core/http'
import { activeWorkspace } from '#services/workspace_service'
import { readConnectionStatus } from '#services/connection_status_service'
import { createLine, listLines, readLine, removeLineNow, requestLineDisconnect } from '#services/line_service'

const ONLINE_MS = 30_000

/** Nomor: nomor utama + nomor tambahan yang dijawab AI yang sama. */
export default class LinesController {
  async index({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const [scope, connection, lines] = await Promise.all([
      activeWorkspace(),
      readConnectionStatus() as Promise<Record<string, any>>,
      listLines(),
    ])
    return response.json({
      primary: {
        phone: connection.phone || scope.phone || null,
        status: connection.status,
        active: Boolean(connection.desired_connected) || ['connected', 'qr', 'connecting'].includes(connection.status),
        qr: connection.status === 'qr' ? connection.qr_data_url : null,
      },
      lines: lines.map((line) => ({
        id: line.id,
        phone: line.phone,
        status:
          line.status === 'connected' &&
          (!line.heartbeat_at || Date.now() - new Date(line.heartbeat_at).getTime() > ONLINE_MS)
            ? 'offline'
            : line.status,
        qr: line.status === 'qr' ? line.qr_data_url : null,
        error: line.last_error,
      })),
    })
  }

  async store({ response }: HttpContext) {
    const id = await createLine()
    return response.json({ ok: true, id })
  }

  async disconnect({ params, response }: HttpContext) {
    const line = await readLine(Number(params.id))
    if (!line) return response.notFound({ error: 'Nomor tidak ditemukan.' })
    // Belum pernah tersambung (masih QR/gagal) → langsung dihapus. Yang tersambung
    // di-logout dulu oleh prosesnya; bila macet lebih dari 20 detik, dihapus paksa.
    if (line.status !== 'connected') {
      await removeLineNow(line.id)
      return response.json({ ok: true })
    }
    await requestLineDisconnect(line.id)
    return response.json({ ok: true })
  }
}
