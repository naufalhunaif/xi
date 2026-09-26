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

/** Ringkasan isi webhook untuk diagnostik di Pengaturan. */
function webhookSummary(payload: any) {
  const entries = Array.isArray(payload?.entry) ? payload.entry : []
  if (entries.some((entry: any) => String(entry?.id) === '0')) return 'tes dari Meta'
  const kinds = new Set<string>()
  for (const entry of entries) {
    if (Array.isArray(entry?.messaging)) kinds.add('DM')
    for (const change of entry?.changes || [])
      kinds.add(change?.field === 'comments' ? 'komentar' : String(change?.field || 'lain'))
  }
  return [...kinds].join(', ') || 'kosong'
}
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
      await inWorkspace(scope, () =>
        updateInstagram({
          last_webhook_at: new Date(),
          last_webhook_note: 'ditolak: tanda tangan tidak cocok',
          last_error: `${REJECTED} Isi "Instagram app secret" dari menu Instagram → API setup with Instagram login (bukan App Secret Facebook).`,
        })
      ).catch(() => {})
      return response.unauthorized('')
    }
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      return response.badRequest('')
    }
    await inWorkspace(scope, () =>
      updateInstagram({
        last_webhook_at: new Date(),
        last_webhook_note: webhookSummary(payload),
        ...(config.lastError.startsWith(REJECTED) ? { last_error: null } : {}),
      })
    ).catch(() => {})
    void handleInstagramWebhook(payload).catch((error) =>
      console.error(`Instagram webhook: ${errorText(error)}`)
    )
    return response.ok('EVENT_RECEIVED')
  }

  /** Halaman publik yang diminta Meta saat app dipublikasikan (Live). */
  async policy({ request, response }: HttpContext) {
    const deletion = request.url().includes('data-deletion')
    const title = deletion ? 'Penghapusan Data' : 'Kebijakan Privasi'
    const body = deletion
      ? `<p>Untuk meminta penghapusan data, kirim pesan <strong>"hapus data saya"</strong> lewat DM Instagram atau WhatsApp toko kami.</p>
         <p>Riwayat percakapan, catatan pesanan, dan data kontak Anda akan dihapus dari sistem kami paling lambat 30 hari setelah permintaan diterima, kecuali data transaksi yang wajib disimpan menurut hukum.</p>`
      : `<p>Aplikasi ini dipakai toko untuk membalas pesan pelanggan di WhatsApp dan Instagram (DM dan komentar), termasuk dengan bantuan AI.</p>
         <h2>Data yang kami proses</h2>
         <p>Nama/username, isi pesan dan komentar, gambar yang Anda kirim, serta data pesanan (nama penerima, nomor HP, alamat) yang Anda berikan sendiri.</p>
         <h2>Penggunaan</h2>
         <p>Data hanya dipakai untuk menjawab pertanyaan, memproses pesanan, dan pengiriman. Data tidak dijual dan tidak dibagikan ke pihak lain selain layanan yang diperlukan untuk menjalankan fungsi tersebut (penyedia AI, ekspedisi, Meta).</p>
         <h2>Penyimpanan & penghapusan</h2>
         <p>Data disimpan selama diperlukan untuk layanan. Anda dapat meminta penghapusan kapan saja; lihat <a href="data-deletion">Penghapusan Data</a>.</p>`
    response.header('Content-Type', 'text/html; charset=utf-8')
    return response.send(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font:13px/1.6 Inter,-apple-system,"Segoe UI",sans-serif;color:#242424;background:#fff}main{max-width:680px;margin:0 auto;padding:32px 16px}h1{font-size:22px;margin:0 0 16px}h2{font-size:14px;margin:20px 0 6px}p{margin:0 0 10px;color:#3d3d3a}a{color:#18865b}@media(prefers-color-scheme:dark){body{background:#000;color:#e6ebe7}p{color:#abb8ae}a{color:#88d9ad}}</style>
</head><body><main><h1>${title}</h1>${body}</main></body></html>`)
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
    return {
      callbackUrl: `${base}/instagram/callback`,
      webhookUrl: `${base}/instagram/webhook`,
      privacyUrl: `${base}/privacy`,
      deletionUrl: `${base}/data-deletion`,
    }
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
      lastWebhookAt: config.lastWebhookAt,
      lastWebhookNote: config.lastWebhookNote,
      comments: Object.fromEntries(counts.map((row: any) => [row.status, Number(row.total)])),
    })
  }

  /** Komentar terbaru untuk tab Komentar di inbox. */
  async comments({ response }: HttpContext) {
    response.header('Cache-Control', 'no-store')
    await readInstagram()
    const rows = await db
      .from('whatsapp_instagram_comments')
      .select('id', 'comment_id', 'username', 'text', 'status', 'kind', 'public_reply', 'private_reply', 'error', 'created_at', 'dm_igsid')
      .orderBy('id', 'desc')
      .limit(100)
    // Tautan "Buka DM" hanya bila pelanggan sudah membalas DM (room-nya ada).
    const jids = [...new Set(rows.filter((row: any) => row.dm_igsid).map((row: any) => `${row.dm_igsid}@ig`))]
    const rooms = jids.length
      ? new Set(
          (await db.from('whatsapp_messages').distinct('jid').whereIn('jid', jids)).map((row: any) =>
            String(row.jid)
          )
        )
      : new Set<string>()
    for (const row of rows as any[]) {
      const jid = row.dm_igsid ? `${row.dm_igsid}@ig` : ''
      row.dm_jid = rooms.has(jid) ? jid : null
      delete row.dm_igsid
    }
    return response.json({ comments: rows })
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
