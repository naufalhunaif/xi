import app from '@adonisjs/core/services/app'
import env from '#start/env'
import sharp from 'sharp'
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import db from '#services/workspace_database'
import { type IgConfig } from '#services/instagram_store'
import * as ig from '#services/instagram_api'

/** Postingan Instagram: unggah media, jadwal, lalu terbit otomatis oleh worker. */
export type PostKind = 'feed' | 'carousel' | 'reels' | 'story'
export type PostItem = { file: string; type: 'image' | 'video' }

export const POST_KINDS: PostKind[] = ['feed', 'carousel', 'reels', 'story']
const FILE_RE = /^[a-f0-9]{32}\.(jpg|mp4|mov)$/
export const isMediaFile = (name: string) => FILE_RE.test(name)
export const mediaDir = () => app.makePath('storage', 'ig-media')
export const mediaPath = (name: string) => app.makePath('storage', 'ig-media', name)
/** URL publik (nama acak, tak bisa ditebak) — Instagram mengambil media dari sini saat terbit. */
export const publicMediaUrl = (name: string) => `${env.get('APP_URL').replace(/\/$/, '')}/ig-media/${name}`

/**
 * Simpan unggahan. Foto selalu dijadikan JPG (syarat Instagram), lebar maks 1440.
 * Feed/carousel: rasio dipotong ke rentang yang diterima Instagram (4:5 s.d. 1.91:1).
 */
export async function saveUpload(input: { tmpPath: string; mime: string; kind: PostKind }) {
  await mkdir(mediaDir(), { recursive: true })
  const name = randomBytes(16).toString('hex')
  if (input.mime.startsWith('video/')) {
    const ext = input.mime.includes('quicktime') ? 'mov' : 'mp4'
    await writeFile(mediaPath(`${name}.${ext}`), await readFile(input.tmpPath))
    return { file: `${name}.${ext}`, type: 'video' as const }
  }
  if (!input.mime.startsWith('image/')) throw new Error('Format tidak didukung. Pakai foto (JPG/PNG/WEBP) atau video (MP4/MOV).')
  let image = sharp(input.tmpPath, { limitInputPixels: 60_000_000 }).rotate()
  const meta = await image.metadata()
  // EXIF orientasi 5–8 = foto diputar 90°, jadi lebar/tinggi tertukar setelah rotate().
  const turned = Number(meta.orientation || 1) >= 5
  const width = (turned ? meta.height : meta.width) || 0
  const height = (turned ? meta.width : meta.height) || 0
  // Satu kali resize saja (sharp hanya memakai resize terakhir): potong rasio + batasi lebar 1440.
  let targetWidth = width
  let targetHeight = height
  if ((input.kind === 'feed' || input.kind === 'carousel') && width && height) {
    const ratio = width / height
    if (ratio < 0.8) targetHeight = Math.round(width / 0.8)
    else if (ratio > 1.91) targetWidth = Math.round(height * 1.91)
  }
  const scale = targetWidth ? Math.min(1, 1440 / targetWidth) : 1
  if (targetWidth && targetHeight)
    image = image.resize({
      width: Math.round(targetWidth * scale),
      height: Math.round(targetHeight * scale),
      fit: 'cover',
      position: 'centre',
    })
  const bytes = await image.flatten({ background: '#ffffff' }).jpeg({ quality: 90, mozjpeg: true }).toBuffer()
  await writeFile(mediaPath(`${name}.jpg`), bytes)
  return { file: `${name}.jpg`, type: 'image' as const }
}

/** Validasi isi postingan sesuai jenisnya. */
export function checkPost(kind: PostKind, items: PostItem[]) {
  if (!POST_KINDS.includes(kind)) return 'Jenis postingan tidak dikenal.'
  if (!items.length) return 'Tambahkan foto atau video dulu.'
  if (items.some((item) => !isMediaFile(item.file))) return 'File tidak valid, unggah ulang.'
  if (kind === 'carousel' && (items.length < 2 || items.length > 10)) return 'Carousel butuh 2–10 foto/video.'
  if (kind !== 'carousel' && items.length > 1) return 'Jenis ini hanya untuk 1 foto/video. Pakai Carousel untuk banyak.'
  if (kind === 'reels' && items[0].type !== 'video') return 'Reels harus berupa video.'
  return ''
}

const WAIT_MS = 8_000
const TIMEOUT_MS = 30 * 60_000

/** Dipanggil worker tiap beberapa detik: mulai postingan yang jatuh tempo & lanjutkan yang sedang diproses. */
export async function publishTick(config: IgConfig) {
  const now = new Date()
  const due = await db
    .from('whatsapp_ig_posts')
    .where('status', 'scheduled')
    .where('scheduled_at', '<=', now)
    .orderBy('scheduled_at', 'asc')
    .first()
  if (due)
    await db
      .from('whatsapp_ig_posts')
      .where('id', due.id)
      .where('status', 'scheduled')
      .update({ status: 'publishing', step: 'create', started_at: now, checked_at: null, error: null, updated_at: now })
  const active = await db
    .from('whatsapp_ig_posts')
    .where('status', 'publishing')
    .where((q) => q.whereNull('checked_at').orWhere('checked_at', '<=', new Date(Date.now() - WAIT_MS)))
    .orderBy('id', 'asc')
    .limit(2)
  for (const post of active as any[]) {
    try {
      await advance(config, post)
    } catch (error) {
      await fail(post.id, error instanceof Error ? error.message : String(error))
    }
  }
}

const fail = (id: number, message: string) =>
  db
    .from('whatsapp_ig_posts')
    .where('id', id)
    .update({ status: 'failed', error: message.slice(0, 480), updated_at: new Date() })

async function advance(config: IgConfig, post: any) {
  const token = config.token
  const kind = post.kind as PostKind
  const items = JSON.parse(post.items || '[]') as PostItem[]
  const containers = JSON.parse(post.containers || '{}') as { children?: string[]; parent?: string }
  const save = (patch: Record<string, unknown>) =>
    db
      .from('whatsapp_ig_posts')
      .where('id', post.id)
      .update({ ...patch, checked_at: new Date(), updated_at: new Date() })
  if (post.started_at && Date.now() - new Date(post.started_at).getTime() > TIMEOUT_MS)
    return fail(post.id, 'Instagram terlalu lama memproses media (lebih dari 30 menit).')
  const caption = String(post.caption || '') || undefined
  const source = (item: PostItem) =>
    item.type === 'video' ? { video_url: publicMediaUrl(item.file) } : { image_url: publicMediaUrl(item.file) }

  if (post.step === 'create') {
    if (kind === 'carousel') {
      const children: string[] = []
      for (const item of items)
        children.push(
          await ig.createContainer(token, {
            is_carousel_item: 'true',
            ...(item.type === 'video' ? { media_type: 'VIDEO' } : {}),
            ...source(item),
          })
        )
      return save({ step: 'children', containers: JSON.stringify({ children }) })
    }
    const item = items[0]
    const params: Record<string, string | undefined> =
      kind === 'story'
        ? { media_type: 'STORIES', ...source(item) }
        : item.type === 'video' || kind === 'reels'
          ? { media_type: 'REELS', video_url: publicMediaUrl(item.file), caption, share_to_feed: post.share_to_feed ? 'true' : 'false' }
          : { image_url: publicMediaUrl(item.file), caption }
    const parent = await ig.createContainer(token, params)
    return save({ step: 'wait', containers: JSON.stringify({ parent }) })
  }

  if (post.step === 'children') {
    for (const id of containers.children || []) {
      const status = await ig.containerStatus(token, id)
      if (status.code === 'ERROR' || status.code === 'EXPIRED')
        return fail(post.id, `Media carousel gagal diproses Instagram. ${status.detail}`.trim())
      if (status.code !== 'FINISHED') return save({})
    }
    const parent = await ig.createContainer(token, {
      media_type: 'CAROUSEL',
      children: (containers.children || []).join(','),
      caption,
    })
    return save({ step: 'wait', containers: JSON.stringify({ ...containers, parent }) })
  }

  if (post.step === 'wait' && containers.parent) {
    const status = await ig.containerStatus(token, containers.parent)
    if (status.code === 'ERROR' || status.code === 'EXPIRED')
      return fail(post.id, `Instagram gagal memproses media. ${status.detail}`.trim())
    if (status.code !== 'FINISHED') return save({})
    const mediaId = await ig.publishContainer(token, containers.parent)
    const permalink = await ig.mediaPermalink(token, mediaId)
    return save({
      status: 'published',
      step: null,
      media_id: mediaId,
      permalink: permalink || null,
      published_at: new Date(),
    })
  }
  return fail(post.id, 'Langkah terbit tidak dikenal.')
}
