import type { HttpContext } from '@adonisjs/core/http'
import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { inWorkspace } from '#services/workspace_context'
import { activeWorkspace } from '#services/workspace_service'
import { publicAppUrl } from '#services/public_url'
import db from '#services/workspace_database'
import { readInstagram, updateInstagram } from '#instagram/store'
import {
  accountFromToken,
  authorizeUrl,
  exchangeCode,
  refreshToken,
  subscribeApp,
  validSignature,
} from '#instagram/api'
import { handleInstagramWebhook } from '#instagram/webhook'
import { shareFilePath, shareMime } from '#instagram/media'

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 290)

/** Diagnostik ringan: kapan webhook terakhir masuk (per proses web). */
const webhookSeen: { at: Date | null; rejectedAt: Date | null } = { at: null, rejectedAt: null }
const REJECTED = 'Webhook ditolak: App Secret tidak cocok.'

export default class InstagramController {
  /** Verifikasi webhook dari Meta (GET hub.challenge). */
  async verify({ request, response }: HttpContext) {
    const query = new URLSearchParams(request.url(true).split('?').slice(1).join('?'))
    const scope = await activeWorkspace()
    if (!scope.id) return response.forbidden('')
    const config = await inWorkspace(scope, () => readInstagram())
    if (
      query.get('hub.mode') === 'subscribe' &&
      config.verifyToken &&
      query.get('hub.verify_token') === config.verifyToken
    )
      return response.header('Content-Type', 'text/plain').send(query.get('hub.challenge') || '')
    return response.forbidden('')
  }

  /** Event DM/komentar. Tanda tangan wajib valid; diproses di latar belakang. */
  async receive({ request, response }: HttpContext) {
    const scope = await activeWorkspace()
    if (!scope.id) return response.ok('')
    const config = await inWorkspace(scope, () => readInstagram())
    const raw = request.raw() || ''
    if (!validSignature(config.appSecret, raw, request.header('x-hub-signature-256'))) {
      webhookSeen.rejectedAt = new Date()
      await inWorkspace(scope, () =>
        updateInstagram({
          last_error: `${REJECTED} Isi "Instagram app secret" dari menu Instagram → API setup with Instagram login (bukan App Secret Facebook).`,
        })
      ).catch(() => {})
      return response.unauthorized('')
    }
    webhookSeen.at = new Date()
    if (config.lastError.startsWith(REJECTED))
      await inWorkspace(scope, () => updateInstagram({ last_error: null })).catch(() => {})
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      return response.badRequest('')
    }
    void handleInstagramWebhook(payload).catch((error) =>
      console.error(`Instagram webhook: ${errorText(error)}`)
    )
    return response.ok('EVENT_RECEIVED')
  }

  /** Gambar keluar untuk DM (URL acak sementara; Instagram mengambilnya sendiri). */
  async media({ params, response }: HttpContext) {
    const path = shareFilePath(String(params.name || ''))
    if (!path || !(await stat(path).catch(() => null))) return response.notFound('')
    response.header('Content-Type', shareMime(String(params.name)))
    response.header('Cache-Control', 'public, max-age=86400')
    return response.stream(createReadStream(path))
  }

  private urls(request: HttpContext['request']) {
    const base = publicAppUrl(request)
    return { callbackUrl: `${base}/instagram/callback`, webhookUrl: `${base}/instagram/webhook` }
  }

  async show({ request, response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    const config = await readInstagram()
    const counts = await db
      .from('whatsapp_instagram_comments')
      .select('status')
      .count('* as total')
      .where('created_at', '>=', new Date(Date.now() - 7 * 24 * 3_600_000))
      .groupBy('status')
    return response.json({
      appId: config.appId,
      hasSecret: Boolean(config.appSecret),
      verifyToken: config.verifyToken,
      ...this.urls(request),
      connected: config.connected,
      username: config.username,
      tokenExpiresAt: config.tokenExpiresAt,
      dmEnabled: config.dmEnabled,
      commentsEnabled: config.commentsEnabled,
      commentTarget: config.commentTarget,
      hideSpam: config.hideSpam,
      lastError: config.lastError,
      lastWebhookAt: webhookSeen.at,
      lastRejectedAt: webhookSeen.rejectedAt,
      comments: Object.fromEntries(counts.map((row: any) => [row.status, Number(row.total)])),
    })
  }

  async save({ request, response }: HttpContext) {
    const values: Record<string, unknown> = {}
    const appId = request.input('appId')
    if (typeof appId === 'string') values.app_id = appId.replace(/\D/g, '').slice(0, 40)
    const secret = request.input('appSecret')
    if (typeof secret === 'string' && secret.trim())
      values.app_secret = secret.trim().replace(/[^a-zA-Z0-9]/g, '').slice(0, 120)
    for (const [field, column] of [
      ['dmEnabled', 'dm_enabled'],
      ['commentsEnabled', 'comments_enabled'],
      ['hideSpam', 'hide_spam'],
    ] as const) {
      const value = request.input(field)
      if (typeof value === 'boolean') values[column] = value ? 1 : 0
    }
    const target = request.input('commentTarget')
    if (['dm', 'wa', 'both'].includes(target)) values.comment_target = target
    await updateInstagram(values)
    return this.show({ request, response } as HttpContext)
  }

  async connect({ request, response, session }: HttpContext) {
    const config = await readInstagram()
    if (!config.appId || !config.appSecret)
      return response.redirect().toPath(`${publicAppUrl(request)}/settings?instagram=missing#instagram`)
    const state = randomBytes(16).toString('hex')
    session.put('instagram_oauth_state', state)
    return response.redirect().toPath(authorizeUrl(config.appId, this.urls(request).callbackUrl, state))
  }

  async callback({ request, response, session }: HttpContext) {
    response.header('Cache-Control', 'no-store, private')
    response.header('Referrer-Policy', 'no-referrer')
    let result = 'failed'
    try {
      const expected = session.pull('instagram_oauth_state')
      const code = String(request.input('code', '')).replace(/#_$/, '')
      if (!expected || request.input('state') !== expected || !code)
        throw new Error('Sesi login Instagram tidak valid, coba hubungkan lagi.')
      const config = await readInstagram()
      const token = await exchangeCode(config, code, this.urls(request).callbackUrl)
      await updateInstagram({
        access_token: token.accessToken,
        token_expires_at: token.expiresAt,
        ig_user_id: token.igUserId,
        username: token.username,
        connected_at: new Date(),
        last_error: null,
      })
      await subscribeApp(token.accessToken)
      result = 'connected'
    } catch (error) {
      await updateInstagram({ last_error: errorText(error) }).catch(() => {})
    }
    return response
      .redirect()
      .withQs(false)
      .status(303)
      .toPath(`${publicAppUrl(request)}/settings?instagram=${result}#instagram`)
  }

  /** Alternatif login: tempel access token dari dashboard Meta (Generate access token). */
  async saveToken({ request, response }: HttpContext) {
    const raw = String(request.input('accessToken', '')).trim().replace(/\s+/g, '')
    if (!/^[A-Za-z0-9_\-.|]{20,1000}$/.test(raw))
      return response.unprocessableEntity({ error: 'Access token tidak valid.' })
    try {
      const account = await accountFromToken(raw)
      // Token dari dashboard sudah jangka panjang (±60 hari); diperpanjang bila bisa.
      let token = { accessToken: raw, expiresAt: new Date(Date.now() + 55 * 24 * 3_600_000) }
      token = await refreshToken(raw).catch(() => token)
      await updateInstagram({
        access_token: token.accessToken,
        token_expires_at: token.expiresAt,
        ig_user_id: account.igUserId,
        username: account.username,
        connected_at: new Date(),
        last_error: null,
      })
      await subscribeApp(token.accessToken).catch(async (error) => {
        await updateInstagram({ last_error: errorText(error) })
      })
      return this.show({ request, response } as HttpContext)
    } catch (error) {
      return response.unprocessableEntity({ error: errorText(error) })
    }
  }

  async disconnect({ request, response }: HttpContext) {
    await updateInstagram({
      access_token: null,
      token_expires_at: null,
      ig_user_id: '',
      username: '',
      connected_at: null,
      last_error: null,
    })
    return this.show({ request, response } as HttpContext)
  }
}
