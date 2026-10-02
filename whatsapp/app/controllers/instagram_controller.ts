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
import { ensureCommentRoom } from '#services/instagram_worker'
import { ensureDefaults } from '#services/settings_service'
import { resumeAiAfterHumanReply } from '#services/message_service'
import db from '#services/workspace_database'
import * as ig from '#services/instagram_api'

// Tab halaman Komentar → status baris.
const COMMENT_TABS: Record<string, string[]> = {
  replied: ['replied'],
  open: ['pending', 'processing', 'failed', 'skipped', 'cs'],
  ignored: ['ignored'],
}
const PRIVATE_REPLY_MS = 7 * 86_400_000

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

  /** Halaman Komentar Instagram. */
  async page({ view, session }: HttpContext) {
    await ensureDefaults()
    return view.render('pages/dashboard', {
      page: 'comments',
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '').replace(/\/$/, '').replace(/\/account$/, ''),
    })
  }

  async comments({ request, response }: HttpContext) {
    await ensureIgTables()
    response.header('cache-control', 'no-store')
    const config = await readIgConfig()
    const tab = String(request.qs().status || 'all')
    const q = String(request.qs().q || '').trim()
    const query = db.from('whatsapp_ig_comments').orderBy('created_at', 'desc').limit(200)
    if (COMMENT_TABS[tab]) query.whereIn('status', COMMENT_TABS[tab])
    if (q) query.where((sub) => sub.where('body', 'like', `%${q}%`).orWhere('username', 'like', `%${q}%`))
    const [rows, totals] = await Promise.all([
      query,
      db.from('whatsapp_ig_comments').select('status').count('* as total').groupBy('status'),
    ])
    const counts: Record<string, number> = { all: 0, replied: 0, open: 0, ignored: 0 }
    for (const row of totals as any[]) {
      const total = Number(row.total || 0)
      counts.all += total
      for (const [key, statuses] of Object.entries(COMMENT_TABS)) if (statuses.includes(row.status)) counts[key] += total
    }
    const now = Date.now()
    return response.json({
      connected: Boolean(config.token && config.userId),
      username: config.username,
      counts,
      comments: (rows as any[]).map((row) => ({
        id: String(row.comment_id),
        username: row.username || '',
        body: row.body || '',
        status: row.status,
        reply: row.reply || '',
        publicReply: row.public_reply || '',
        error: row.error || '',
        caption: row.media_caption || '',
        permalink: row.permalink || '',
        image: row.media_image || '',
        mediaId: row.media_id || '',
        jid: `${row.from_id}@ig`,
        createdAt: row.created_at,
        canDm: row.status !== 'replied' && now - new Date(row.created_at).getTime() < PRIVATE_REPLY_MS,
      })),
    })
  }

  /** Jumlah komentar yang perlu dibalas (badge menu). */
  async commentsCount({ response }: HttpContext) {
    await ensureIgTables()
    response.header('cache-control', 'no-store')
    const config = await readIgConfig()
    const row = await db
      .from('whatsapp_ig_comments')
      .whereIn('status', ['failed', 'skipped', 'cs'])
      .count('* as total')
      .first()
    return response.json({ connected: Boolean(config.token && config.userId), open: Number(row?.total || 0) })
  }

  /** Balas manual: lewat DM (sekali per komentar, maks 7 hari) atau di bawah komentar. */
  async replyComment({ params, request, response }: HttpContext) {
    await ensureIgTables()
    const config = await readIgConfig()
    if (!config.token) return response.badRequest({ error: 'Instagram belum terhubung.' })
    const row = await db.from('whatsapp_ig_comments').where('comment_id', String(params.id)).first()
    if (!row) return response.notFound({ error: 'Komentar tidak ditemukan.' })
    const text = String(request.input('text') || '').trim()
    if (!text) return response.badRequest({ error: 'Tulis balasannya dulu.' })
    const via = request.input('via') === 'public' ? 'public' : 'dm'
    try {
      if (via === 'public') {
        await ig.replyComment(config.token, String(row.comment_id), text)
        await db
          .from('whatsapp_ig_comments')
          .where('comment_id', row.comment_id)
          .update({ public_reply: text, processed_at: new Date() })
        return response.json({ ok: true })
      }
      if (row.status === 'replied') return response.badRequest({ error: 'Komentar ini sudah dibalas lewat DM. Lanjutkan di chat.' })
      if (Date.now() - new Date(row.created_at).getTime() >= PRIVATE_REPLY_MS)
        return response.badRequest({ error: 'Lewat 7 hari, Instagram tidak mengizinkan balasan DM untuk komentar ini.' })
      const { jid } = await ensureCommentRoom(config, row)
      const mid = await ig.privateReply(config.token, String(row.comment_id), text)
      await db.table('whatsapp_messages').insert({
        message_id: mid || `ig-out-${Date.now()}`,
        jid,
        contact_name: null,
        direction: 'out',
        sender_type: 'cs',
        body: text,
        status: 'sent',
        created_at: new Date(),
      })
      await db
        .from('whatsapp_ig_comments')
        .where('comment_id', row.comment_id)
        .update({ status: 'replied', reply: text, error: null, processed_at: new Date() })
      await resumeAiAfterHumanReply(jid).catch(() => {})
      return response.json({ ok: true, jid })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Minta AI membalas komentar ini (walau bukan pertanyaan / sebelumnya gagal). */
  async aiComment({ params, response }: HttpContext) {
    await ensureIgTables()
    const row = await db.from('whatsapp_ig_comments').where('comment_id', String(params.id)).first()
    if (!row) return response.notFound({ error: 'Komentar tidak ditemukan.' })
    if (row.status === 'replied') return response.badRequest({ error: 'Sudah dibalas lewat DM.' })
    if (Date.now() - new Date(row.created_at).getTime() >= 6 * 86_400_000)
      return response.badRequest({ error: 'Komentar terlalu lama untuk dibalas AI.' })
    await db
      .from('whatsapp_ig_comments')
      .where('comment_id', row.comment_id)
      .update({ status: 'pending', force_ai: 1, error: null })
    return response.json({ ok: true })
  }
}
