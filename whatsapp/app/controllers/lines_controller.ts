import type { HttpContext } from '@adonisjs/core/http'
import { activeWorkspace } from '#services/workspace_service'
import { readConnectionStatus } from '#services/connection_status_service'
import { createLine, listLines, readLine, requestLineDisconnect } from '#services/line_service'

const ONLINE_MS = 30_000

/** Nomor: nomor utama + nomor tambahan yang dijawab AI yang sama. */
export default class LinesController {
  async index({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const [scope, connection, lines] = await Promise.all([
      activeWorkspace(),
      readConnectionStatus(),
      listLines(),
    ])
    return response.json({
      primary: { phone: scope.phone || null, status: connection.status },
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
    await requestLineDisconnect(line.id)
    return response.json({ ok: true })
  }
}
