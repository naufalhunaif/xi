import type { HttpContext } from '@adonisjs/core/http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import env from '#start/env'
import db from '#services/workspace_database'
import { ensureDefaults } from '#services/settings_service'
import { ensureIgTables, readIgConfig, readKey } from '#services/instagram_store'
import {
  checkPost,
  isMediaFile,
  mediaPath,
  publicMediaUrl,
  saveUpload,
  type PostItem,
  type PostKind,
} from '#services/instagram_publish'
import { accountOverview, audience, mediaPerformance } from '#services/instagram_insights'
import { mediaChildren as igChildren } from '#services/instagram_api'

const NEEDED = ['instagram_business_content_publish', 'instagram_business_manage_insights']

/** Halaman Konten Instagram: jadwal posting + performa + ringkasan akun. */
export default class InstagramContentController {
  async page({ view, session }: HttpContext) {
    await ensureDefaults()
    return view.render('pages/dashboard', {
      page: 'content',
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '').replace(/\/$/, '').replace(/\/account$/, ''),
    })
  }

  /** Media untuk diambil Instagram saat terbit (publik, nama acak). */
  async media({ params, response }: HttpContext) {
    const name = String(params.name || '')
    if (!isMediaFile(name)) return response.notFound()
    try {
      const info = await stat(mediaPath(name))
      response.header('content-type', name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4')
      response.header('content-length', String(info.size))
      response.header('cache-control', 'public, max-age=86400')
      return response.stream(createReadStream(mediaPath(name)))
    } catch {
      return response.notFound()
    }
  }

  async state({ response }: HttpContext) {
    await ensureIgTables()
    const config = await readIgConfig()
    const scopes = (await readKey('ig_scopes')).split(',').filter(Boolean)
    response.header('cache-control', 'no-store')
    return response.json({
      connected: Boolean(config.token && config.userId),
      username: config.username,
      ready: NEEDED.every((scope) => scopes.includes(scope)),
    })
  }

  async upload({ request, response }: HttpContext) {
    const file = request.file('file', { size: '60mb' })
    if (!file || !file.tmpPath) return response.badRequest({ error: 'Pilih foto atau video.' })
    if (file.hasErrors) return response.badRequest({ error: file.errors[0]?.message || 'File tidak bisa diunggah.' })
    const kind = String(request.input('kind') || 'feed') as PostKind
    try {
      const saved = await saveUpload({ tmpPath: file.tmpPath, mime: `${file.type}/${file.subtype}`, kind })
      return response.json({ ...saved, url: publicMediaUrl(saved.file) })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  async posts({ response }: HttpContext) {
    await ensureIgTables()
    response.header('cache-control', 'no-store')
    const rows = await db.from('whatsapp_ig_posts').orderBy('scheduled_at', 'desc').limit(100)
    return response.json({
      posts: (rows as any[]).map((row) => ({
        id: row.id,
        kind: row.kind,
        caption: row.caption || '',
        items: (JSON.parse(row.items || '[]') as PostItem[]).map((item) => ({ ...item, url: publicMediaUrl(item.file) })),
        shareToFeed: Boolean(row.share_to_feed),
        scheduledAt: row.scheduled_at,
        status: row.status,
        permalink: row.permalink || '',
        error: row.error || '',
        publishedAt: row.published_at,
        mediaId: row.media_id || '',
      })),
    })
  }

  async create({ request, response }: HttpContext) {
    await ensureIgTables()
    const kind = String(request.input('kind') || '') as PostKind
    const items = (Array.isArray(request.input('items')) ? request.input('items') : []).map((item: any) => ({
      file: String(item?.file || ''),
      type: item?.type === 'video' ? 'video' : 'image',
    })) as PostItem[]
    const problem = checkPost(kind, items)
    if (problem) return response.badRequest({ error: problem })
    const raw = String(request.input('scheduledAt') || '')
    // Jam dari form = WIB (Asia/Jakarta).
    const when = raw && raw !== 'now' ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}+07:00`) : new Date()
    if (Number.isNaN(when.getTime())) return response.badRequest({ error: 'Tanggal/jam tidak valid.' })
    const id = request.input('id') ? Number(request.input('id')) : 0
    const values = {
      kind,
      caption: kind === 'story' ? null : String(request.input('caption') || '').slice(0, 2200),
      items: JSON.stringify(items),
      share_to_feed: request.input('shareToFeed') === false ? 0 : 1,
      scheduled_at: when,
      status: 'scheduled',
      step: null,
      containers: null,
      error: null,
      updated_at: new Date(),
    }
    if (id) {
      const current = await db.from('whatsapp_ig_posts').where('id', id).first()
      if (!current || !['scheduled', 'failed', 'cancelled'].includes(current.status))
        return response.badRequest({ error: 'Postingan ini sudah diproses, tidak bisa diubah.' })
      await db.from('whatsapp_ig_posts').where('id', id).update(values)
      return response.json({ ok: true, id })
    }
    const [newId] = await db.table('whatsapp_ig_posts').insert({ ...values, created_at: new Date() })
    return response.json({ ok: true, id: Number(newId) })
  }

  async cancel({ params, response }: HttpContext) {
    const changed = await db
      .from('whatsapp_ig_posts')
      .where('id', Number(params.id))
      .where('status', 'scheduled')
      .update({ status: 'cancelled', updated_at: new Date() })
    if (!changed) return response.badRequest({ error: 'Hanya postingan terjadwal yang bisa dibatalkan.' })
    return response.json({ ok: true })
  }

  async retry({ params, response }: HttpContext) {
    const changed = await db
      .from('whatsapp_ig_posts')
      .where('id', Number(params.id))
      .whereIn('status', ['failed', 'cancelled'])
      .update({ status: 'scheduled', scheduled_at: new Date(), step: null, containers: null, error: null, updated_at: new Date() })
    if (!changed) return response.badRequest({ error: 'Postingan ini tidak bisa dicoba ulang.' })
    return response.json({ ok: true })
  }

  async remove({ params, response }: HttpContext) {
    const changed = await db
      .from('whatsapp_ig_posts')
      .where('id', Number(params.id))
      .whereNot('status', 'publishing')
      .delete()
    if (!changed) return response.badRequest({ error: 'Postingan sedang diterbitkan, tunggu sebentar.' })
    return response.json({ ok: true })
  }

  async insights({ request, response }: HttpContext) {
    await ensureIgTables()
    const config = await readIgConfig()
    response.header('cache-control', 'no-store')
    if (!config.token) return response.json({ connected: false })
    const fresh = request.input('fresh') === '1'
    const [overview, people] = await Promise.all([
      accountOverview(config, Number(request.input('days') || 7), fresh),
      audience(config, fresh).catch(() => ({})),
    ])
    return response.json({ connected: true, overview, audience: people })
  }

  async performance({ request, response }: HttpContext) {
    await ensureIgTables()
    const config = await readIgConfig()
    response.header('cache-control', 'no-store')
    if (!config.token) return response.json({ connected: false, posts: [], stories: [], next: '' })
    const after = String(request.input('after') || '').slice(0, 500)
    try {
      return response.json({ connected: true, ...(await mediaPerformance(config, after)) })
    } catch (error) {
      return response.json({ connected: true, posts: [], stories: [], next: '', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Isi carousel dari Instagram: foto & video satu per satu. */
  async children({ params, response }: HttpContext) {
    const id = String(params.id || '')
    if (!/^\d{1,40}$/.test(id)) return response.badRequest({ error: 'Postingan tidak valid.' })
    const config = await readIgConfig()
    if (!config.token) return response.badRequest({ error: 'Instagram belum terhubung' })
    response.header('cache-control', 'no-store')
    try {
      const items = await igChildren(config.token, id)
      return response.json({
        items: items.map((item: any) => ({
          type: item.media_type === 'VIDEO' ? 'video' : 'image',
          url: String(item.media_url || ''),
          thumb: String(item.thumbnail_url || item.media_url || ''),
        })),
      })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : String(error) })
    }
  }
}
