import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import {
  backupStatus,
  disconnectGoogle,
  finishGoogleAuth,
  googleAuthUrl,
  listBackups,
  restoreBackup,
  runBackup,
  saveBackupSettings,
} from '#services/backup_service'

const settingsUrl = () => `${env.get('APP_BASE_PATH') || ''}/settings#backup`
let restoreState: { at: number; ok: boolean; error?: string } | null = null

export default class BackupController {
  async status({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    return response.json({ ...(await backupStatus()), restore: restoreState })
  }

  async save({ request, response }: HttpContext) {
    return response.json(await saveBackupSettings(request.all()))
  }

  async connect({ response }: HttpContext) {
    try {
      return response.redirect(await googleAuthUrl())
    } catch (error) {
      return response.redirect(`${settingsUrl()}?backup_error=${encodeURIComponent(error instanceof Error ? error.message : 'Gagal')}`)
    }
  }

  async callback({ request, response }: HttpContext) {
    try {
      if (request.input('error')) throw new Error(String(request.input('error')))
      await finishGoogleAuth(String(request.input('code', '')), String(request.input('state', '')))
      return response.redirect(settingsUrl())
    } catch (error) {
      return response.redirect(
        `${env.get('APP_BASE_PATH') || ''}/settings?backup_error=${encodeURIComponent(error instanceof Error ? error.message : 'Gagal')}#backup`
      )
    }
  }

  async disconnect({ response }: HttpContext) {
    await disconnectGoogle()
    return response.json(await backupStatus())
  }

  async run({ response }: HttpContext) {
    const status = await backupStatus()
    if (!status.connected) return response.badRequest({ error: 'Hubungkan Google Drive dulu.' })
    if (status.running) return response.conflict({ error: 'Backup sedang berjalan.' })
    void runBackup('manual').catch(() => {})
    return response.accepted({ started: true })
  }

  async list({ response }: HttpContext) {
    response.header('cache-control', 'no-store')
    try {
      return response.json({ backups: await listBackups() })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : 'Gagal.' })
    }
  }

  async restore({ request, response }: HttpContext) {
    if (String(request.input('confirm', '')) !== 'PULIHKAN')
      return response.badRequest({ error: 'Ketik PULIHKAN untuk konfirmasi.' })
    const id = String(request.input('id', ''))
    if (!id) return response.badRequest({ error: 'Pilih backup.' })
    restoreState = { at: Date.now(), ok: false }
    void restoreBackup(id)
      .then(() => {
        restoreState = { at: Date.now(), ok: true }
        // Proses web dimulai ulang oleh Supervisor agar memakai data & kunci hasil pemulihan.
        setTimeout(() => process.exit(0), 3000)
      })
      .catch((error) => {
        restoreState = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) }
      })
    return response.accepted({ started: true })
  }
}
