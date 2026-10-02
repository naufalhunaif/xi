import type { HttpContext } from '@adonisjs/core/http'
import { randomBytes } from 'node:crypto'
import env from '#start/env'
import { activeWorkspace } from '#services/workspace_service'
import { inWorkspace } from '#services/workspace_context'
import {
  clearIgAccount,
  ensureIgTables,
  noteIgError,
  noteIgWebhook,
  readIgConfig,
  saveIgAccount,
  saveIgConfig,
} from '#services/instagram_store'
import { ingestInstagramWebhook } from '#services/instagram_inbox'
import * as ig from '#services/instagram_api'

const appUrl = () => env.get('APP_URL').replace(/\/$/, '')
const redirectUri = () => `${appUrl()}/instagram/callback`
const webhookUrl = () => `${appUrl()}/webhooks/instagram`

export default class InstagramController {
  /** Verifikasi webhook dari Meta (GET dengan hub.challenge). */
  async verify({ request, response }: HttpContext) {
    const scope = await activeWorkspace()
    return inWorkspace(scope, async () => {
      const config = await readIgConfig()
      const qs = request.qs()
      if (qs['hub.mode'] === 'subscribe' && qs['hub.verify_token'] === config.verifyToken)
        return response.type('text/plain').send(String(qs['hub.challenge'] || ''))
      return response.forbidden('invalid verify token')
    })
  }

  /** Notifikasi DM & komentar. Ditandatangani dengan Instagram app secret. */
  async receive({ request, response }: HttpContext) {
    const scope = await activeWorkspace()
    return inWorkspace(scope, async () => {
      const config = await readIgConfig()
      const raw = String(request.raw() || '')
      if (!ig.validSignature(config.appSecret, raw, String(request.header('x-hub-signature-256') || ''))) {
        await noteIgError('Webhook ditolak: tanda tangan tidak cocok (cek Instagram app secret).').catch(() => {})
        return response.unauthorized('invalid signature')
      }
      await noteIgWebhook().catch(() => {})
      let body: unknown
      try {
        body = JSON.parse(raw)
      } catch {
        return response.badRequest('invalid json')
      }
      // Balas cepat; pemrosesan berjalan di latar dalam workspace yang sama.
      void inWorkspace(scope, () => ingestInstagramWebhook(body)).catch(() => {})
      return response.send('EVENT_RECEIVED')
    })
  }

  async status({ response }: HttpContext) {
    await ensureIgTables()
    const config = await readIgConfig()
    response.header('cache-control', 'no-store')
    return response.json({
      appId: config.appId,
      hasSecret: Boolean(config.appSecret),
      verifyToken: config.verifyToken,
      webhookUrl: webhookUrl(),
      redirectUri: redirectUri(),
      connected: Boolean(config.token && config.userId),
      username: config.username,
      tokenExpires: config.tokenExpires || null,
      lastWebhookAt: config.lastWebhookAt || null,
      lastError: config.lastError,
      comments: config.comments,
    })
  }

  async save({ request, response }: HttpContext) {
    await saveIgConfig({
      appId: request.input('appId') !== undefined ? String(request.input('appId') || '') : undefined,
      appSecret: request.input('appSecret') ? String(request.input('appSecret')) : undefined,
      comments:
        request.input('comments') !== undefined ? (request.input('comments') ? '1' : '0') : undefined,
    })
    return this.status({ response } as HttpContext)
  }

  /** Tombol "Hubungkan Instagram": ke halaman login Instagram. */
  async connect({ session, response }: HttpContext) {
    const config = await readIgConfig()
    if (!config.appId || !config.appSecret)
      return response.redirect().toPath(`${appUrl()}/settings?instagram=missing#instagram`)
    const state = randomBytes(16).toString('base64url')
    session.put('instagram_oauth_state', state)
    return response.redirect().toPath(ig.authorizeUrl(config.appId, redirectUri(), state))
  }

  async callback({ request, session, response }: HttpContext) {
    const done = (result: string) => response.redirect().toPath(`${appUrl()}/settings?instagram=${result}#instagram`)
    const expected = session.pull('instagram_oauth_state')
    const qs = request.qs()
    if (qs.error || !qs.code) return done('cancelled')
    if (!expected || qs.state !== expected) return done('state')
    try {
      const config = await readIgConfig()
      const token = await ig.exchangeCode({
        appId: config.appId,
        appSecret: config.appSecret,
        redirectUri: redirectUri(),
        code: String(qs.code),
      })
      const account = await ig.me(token.token)
      await saveIgAccount({ token: token.token, expiresIn: token.expiresIn, userId: account.userId, username: account.username })
      await noteIgError('').catch(() => {})
      try {
        await ig.subscribe(token.token)
      } catch (error) {
        await noteIgError(`Langganan webhook gagal: ${error instanceof Error ? error.message : String(error)}`)
      }
      return done('connected')
    } catch (error) {
      await noteIgError(error instanceof Error ? error.message : String(error)).catch(() => {})
      return done('failed')
    }
  }

  async disconnect({ response }: HttpContext) {
    await clearIgAccount()
    return this.status({ response } as HttpContext)
  }
}
