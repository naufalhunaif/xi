import type { HttpContext } from '@adonisjs/core/http'
import { createReadStream } from 'node:fs'
import { Readable } from 'node:stream'
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
import { driveIdFor, mediaExists, type StoredItem } from '#services/instagram_media_store'
import { driveFetchFile } from '#services/backup_service'
import { generateCaption, postSignals, readAnalysis, startAnalysis } from '#services/instagram_ai'

const NEEDED = ['instagram_business_content_publish', 'instagram_business_manage_insights']

/** Halaman Konten Instagram: jadwal posting + performa + ringkasan akun. */
export default class InstagramContentController {
  /** Satu halaman Instagram: tab Konten · Komentar · Ringkasan. */
  async page({ view, session, request }: HttpContext) {
    await ensureDefaults()
    const tab = String(request.qs().tab || '')
    return view.render('pages/dashboard', {
      page: 'instagram',
      igTab: ['comments', 'summary'].includes(tab) ? tab : 'content',
      account: session.get('account'),
      bundle: (env.get('ACCOUNT_URL') || '').replace(/\/$/, '').replace(/\/account$/, ''),
    })
  }

  /** Media untuk diambil Instagram saat terbit (publik, nama acak). */
  async media({ params, request, response }: HttpContext) {
    const name = String(params.name || '')
    if (!isMediaFile(name)) return response.notFound()
    const type = name.endsWith('.jpg') ? 'image/jpeg' : name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4'
    let size = -1
    try {
      size = (await stat(mediaPath(name))).size
    } catch {}
    if (size >= 0) {
      response.header('content-type', type)
      response.header('accept-ranges', 'bytes')
      response.header('cache-control', 'public, max-age=86400')
      // Safari hanya memutar video bila server melayani potongan (Range).
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.header('range') || ''))
      if (range && size > 0) {
        let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2] || 0))
        let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
        if (start >= size || start > end) {
          response.header('content-range', `bytes */${size}`)
          return response.status(416).send('')
        }
        start = Math.max(0, start)
        end = Math.max(start, end)
        response.status(206)
        response.header('content-range', `bytes ${start}-${end}/${size}`)
        response.header('content-length', String(end - start + 1))
        return response.stream(createReadStream(mediaPath(name), { start, end }))
      }
      response.header('content-length', String(size))
      return response.stream(createReadStream(mediaPath(name)))
    }
    // Media jadwal yang sedang disimpan di Google Drive: dialirkan langsung untuk pratinjau.
    const driveId = await driveIdFor(name)
    if (!driveId) return response.notFound()
    try {
      const file = await driveFetchFile(driveId)
      response.header('content-type', type)
      const length = file.headers.get('content-length')
      if (length) response.header('content-length', length)
      response.header('cache-control', 'private, max-age=3600')
      return response.stream(Readable.fromWeb(file.body as any))
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
    // Saat diubah: pertahankan penanda Google Drive per file, lalu pastikan semua file masih ada.
    if (id) {
      const current = await db.from('whatsapp_ig_posts').where('id', id).first()
      const known = new Map(
        (JSON.parse(current?.items || '[]') as StoredItem[]).map((item) => [item.file, item.drive || ''])
      )
      for (const item of items as StoredItem[]) if (known.get(item.file)) item.drive = known.get(item.file)
    }
    for (const item of items as StoredItem[])
      if (!item.drive && !(await mediaExists(item.file)) && !(await driveIdFor(item.file)))
        return response.badRequest({ error: 'File sudah kedaluwarsa, unggah ulang fotonya.' })
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
      .whereIn('status', ['scheduled', 'failed', 'cancelled'])
      .delete()
    if (!changed) return response.badRequest({ error: 'Hanya jadwal yang belum terbit yang bisa dihapus.' })
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
      const data = await mediaPerformance(config, after, !after && request.input('fresh') === '1')
      // Minat beli per postingan: komentar yang bertanya & penanya yang order.
      const signals = await postSignals(data.posts.map((post: any) => String(post.id))).catch(() => new Map())
      const posts = data.posts.map((post: any) => ({
        ...post,
        signals: signals.get(String(post.id)) || { comments: 0, questions: 0, orders: 0 },
      }))
      return response.json({ connected: true, ...data, posts })
    } catch (error) {
      return response.json({ connected: true, posts: [], stories: [], next: '', error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Caption dari AI untuk form Buat postingan (draf di kolom caption dipakai sebagai catatan). */
  async caption({ request, response }: HttpContext) {
    await ensureIgTables()
    const kind = String(request.input('kind') || 'feed') as PostKind
    if (!['feed', 'carousel', 'reels', 'story'].includes(kind)) return response.badRequest({ error: 'Jenis postingan tidak valid.' })
    const items = (Array.isArray(request.input('items')) ? request.input('items') : []).slice(0, 10).map((item: any) => ({
      file: String(item?.file || ''),
      type: item?.type === 'video' ? 'video' : 'image',
    })) as PostItem[]
    try {
      const caption = await generateCaption({ kind, items, note: String(request.input('note') || '').slice(0, 2200) })
      return response.json({ caption })
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : String(error) })
    }
  }

  async analysis({ response }: HttpContext) {
    await ensureIgTables()
    response.header('cache-control', 'no-store')
    return response.json(await readAnalysis())
  }

  async analyze({ response }: HttpContext) {
    await ensureIgTables()
    try {
      return response.json(await startAnalysis())
    } catch (error) {
      return response.badRequest({ error: error instanceof Error ? error.message : String(error) })
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
