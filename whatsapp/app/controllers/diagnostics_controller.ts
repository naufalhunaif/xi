import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { readFile } from 'node:fs/promises'
import { diagnosticAuthorized } from '#services/diagnostic_contract'
import { serverDiagnostics } from '#services/server_diagnostics'

export default class DiagnosticsController {
  async show({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    response.header('X-Content-Type-Options', 'nosniff')
    let access
    try {
      access = JSON.parse(
        await readFile(app.makePath('storage', 'diagnostics', 'access.json'), 'utf8')
      )
    } catch {
      return response.notFound({ code: 'DIAGNOSTICS_DISABLED' })
    }
    if (!diagnosticAuthorized(access, request.header('authorization')))
      return response.unauthorized({ code: 'DIAGNOSTICS_UNAUTHORIZED' })
    const traceId = request.input('traceId')
    if (traceId !== undefined && (typeof traceId !== 'string' || !/^[a-f0-9-]{36}$/.test(traceId)))
      return response.badRequest({ code: 'INVALID_TRACE_ID' })
    try {
      const value = await serverDiagnostics(access.workspaceId, traceId)
      if (value.busy) {
        response.header('Retry-After', '2')
        return response.status(429).send(value)
      }
      return response.ok(value)
    } catch {
      return response.serviceUnavailable({ code: 'DIAGNOSTICS_UNAVAILABLE' })
    }
  }
}
