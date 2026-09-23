import type { HttpContext } from '@adonisjs/core/http'
import env from '#start/env'
import { isLocalAuth } from '#services/local_auth_service'

/**
 * URL publik aplikasi untuk tautan/aset halaman.
 * Bundle: APP_URL. Standalone: mengikuti host yang dipakai pengunjung
 * (http://IP:PORT maupun https://domain sama-sama berfungsi tanpa ubah .env).
 */
export function publicAppUrl(request?: HttpContext['request']) {
  if (!isLocalAuth() || !request) return env.get('APP_URL').replace(/\/$/, '')
  const base = (env.get('APP_BASE_PATH') || '').replace(/\/$/, '')
  return `${request.protocol()}://${request.host()}${base}`
}
