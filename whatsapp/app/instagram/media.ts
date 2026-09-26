// Media Instagram: unduh lampiran masuk, dan publikasikan gambar keluar lewat URL
// acak sementara (Instagram hanya menerima gambar berupa URL publik).
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { randomBytes } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { workspaceFileName } from '#services/workspace_context'

const SHARE_DIR = () => app.makePath('storage', 'ig-share')
const SHARE_TTL_MS = 3 * 24 * 3_600_000
const LIMIT = 16 * 1024 * 1024
export const SHARE_NAME = /^[a-f0-9]{32}\.(jpg|png|webp|gif|mp4)$/

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
}

export function shareFilePath(name: string) {
  if (!SHARE_NAME.test(name)) return null
  return app.makePath('storage', 'ig-share', name)
}

export function shareMime(name: string) {
  const ext = name.split('.').pop()
  return Object.entries(EXT).find(([, value]) => value === ext)?.[0] || 'application/octet-stream'
}

/** Simpan bytes → URL publik acak (dihapus otomatis setelah 3 hari). */
export async function publishShare(bytes: Buffer, mime = 'image/jpeg') {
  const ext = EXT[mime.split(';')[0].trim().toLowerCase()] || 'jpg'
  const name = `${randomBytes(16).toString('hex')}.${ext}`
  await mkdir(SHARE_DIR(), { recursive: true })
  await writeFile(app.makePath('storage', 'ig-share', name), bytes, { mode: 0o644 })
  void cleanupShares().catch(() => {})
  return `${env.get('APP_URL').replace(/\/$/, '')}/ig-media/${name}`
}

let lastCleanup = 0
async function cleanupShares() {
  if (Date.now() - lastCleanup < 3_600_000) return
  lastCleanup = Date.now()
  for (const name of await readdir(SHARE_DIR()).catch(() => [] as string[])) {
    const path = shareFilePath(name)
    if (!path) continue
    const info = await stat(path).catch(() => null)
    if (info && Date.now() - info.mtimeMs > SHARE_TTL_MS) await unlink(path).catch(() => {})
  }
}

/** Lampiran pelanggan (URL CDN Instagram) → public/media milik workspace ini. */
export async function downloadIncoming(url: string, messageId: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const mime = (response.headers.get('content-type') || 'image/jpeg').split(';')[0].trim()
  const bytes = Buffer.from(await response.arrayBuffer())
  if (!bytes.length || bytes.length > LIMIT) throw new Error('Ukuran lampiran tidak valid.')
  const ext = EXT[mime] || 'jpg'
  await mkdir(app.makePath('public', 'media'), { recursive: true })
  const filename = workspaceFileName(
    `ig${messageId.replace(/[^a-z0-9_-]/gi, '').slice(-60)}.${ext}`
  )
  await writeFile(app.makePath('public', 'media', filename), bytes, { mode: 0o644 })
  return { url: `${env.get('APP_BASE_PATH') || ''}/media/${filename}`, mime, size: bytes.length }
}
