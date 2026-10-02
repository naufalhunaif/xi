import { readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import baseDb from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { isMediaFile, mediaDir, mediaPath, type PostItem } from '#services/instagram_publish'
import { driveDownloadFile, driveMediaState, driveUploadFile } from '#services/backup_service'

/**
 * Penyimpanan media postingan Instagram agar server tidak penuh.
 *
 * Langkah 1 (selalu aktif): media dihapus dari server bila sudah tidak diperlukan —
 * 1 hari setelah terbit, postingan dihapus, atau unggahan tidak pernah dipakai (> 24 jam).
 *
 * Langkah 2 (opsional, Pengaturan → Backup): media untuk jadwal > 24 jam ke depan dipindah ke
 * Google Drive, lalu diambil kembali 2 jam sebelum terbit. Saat dimatikan, media yang sudah di Drive
 * tetap diambil kembali tepat waktu.
 */

export type StoredItem = PostItem & { drive?: string }

const HOUR = 3_600_000
const DAY = 24 * HOUR
const OFFLOAD_AFTER_MS = DAY
const RESTORE_BEFORE_MS = 2 * HOUR

const exists = async (path: string) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
export const mediaExists = (file: string) => exists(mediaPath(file))

/* ───── Indeks file → id Drive (global, agar /ig-media tetap bisa menampilkan pratinjau) ───── */
const indexPath = () => app.makePath('storage', 'ig-media', 'drive.json')
async function readIndex(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(indexPath(), 'utf8'))
  } catch {
    return {}
  }
}
async function writeIndex(index: Record<string, string>) {
  const temp = `${indexPath()}.tmp`
  await writeFile(temp, JSON.stringify(index))
  await rename(temp, indexPath())
}
export async function driveIdFor(file: string) {
  return (await readIndex())[file] || ''
}

/* ───── Langkah 1: bersih otomatis ───── */
let lastSweep = 0

/** Semua nomor memakai folder media yang sama, jadi daftar yang masih dipakai diambil dari semua tabel. */
async function filesInUse() {
  const keep = new Set<string>()
  const result = (await baseDb.rawQuery(
    `SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE ?`,
    ['%whatsapp_ig_posts']
  )) as any
  const tables = ((Array.isArray(result) ? result[0] : result?.rows) || []) as { name: string }[]
  const recent = Date.now() - DAY
  for (const { name } of tables) {
    if (!/^[\w]+$/.test(String(name))) continue
    const posts = (await baseDb.from(String(name)).select('items', 'status', 'published_at')) as any[]
    for (const post of posts) {
      const done = post.status === 'published' && post.published_at && new Date(post.published_at).getTime() < recent
      if (done) continue
      for (const item of JSON.parse(post.items || '[]') as StoredItem[]) keep.add(item.file)
    }
  }
  return keep
}

/** Hapus media yang tidak diperlukan lagi (maks sekali per jam). Mengembalikan jumlah file yang dihapus. */
export async function sweepMedia(force = false) {
  if (!force && Date.now() - lastSweep < HOUR) return 0
  lastSweep = Date.now()
  let removed = 0
  const keep = await filesInUse()
  const index = await readIndex()
  let indexChanged = false
  let names: string[] = []
  try {
    names = await readdir(mediaDir())
  } catch {
    return 0
  }
  for (const name of names) {
    if (!isMediaFile(name) || keep.has(name)) continue
    try {
      const info = await stat(mediaPath(name))
      // Unggahan baru (form mungkin masih terbuka) dibiarkan 24 jam.
      if (Date.now() - info.mtimeMs < DAY) continue
      await unlink(mediaPath(name))
      removed++
    } catch {}
  }
  for (const name of Object.keys(index))
    if (!keep.has(name)) {
      delete index[name]
      indexChanged = true
    }
  if (indexChanged) await writeIndex(index).catch(() => {})
  // Frame video untuk caption AI: bisa dibuat ulang, simpan 1 hari saja.
  const frames = app.makePath('storage', 'ig-media', 'frames')
  for (const name of await readdir(frames).catch(() => [] as string[])) {
    try {
      const info = await stat(`${frames}/${name}`)
      if (Date.now() - info.mtimeMs > DAY) await unlink(`${frames}/${name}`)
    } catch {}
  }
  return removed
}

/* ───── Langkah 2: Google Drive untuk jadwal yang masih lama ───── */
const mimeOf = (file: string) => (file.endsWith('.jpg') ? 'image/jpeg' : file.endsWith('.mov') ? 'video/quicktime' : 'video/mp4')

/** Pastikan file ada di server (ambil dari Drive bila perlu). False bila tidak ada di mana pun. */
export async function ensureLocal(item: StoredItem) {
  if (await mediaExists(item.file)) return true
  const id = item.drive || (await driveIdFor(item.file))
  if (!id) return false
  await driveDownloadFile(id, mediaPath(item.file))
  return true
}

let lastDrive = new Map<string, number>()

/** Dipanggil worker per nomor: pindahkan media jadwal lama ke Drive / ambil kembali menjelang terbit. */
export async function driveMediaTick(scopeKey: string) {
  if (Date.now() - (lastDrive.get(scopeKey) || 0) < 5 * 60_000) return
  lastDrive.set(scopeKey, Date.now())
  const drive = await driveMediaState()
  if (!drive.connected) return
  const posts = (await db
    .from('whatsapp_ig_posts')
    .whereIn('status', ['scheduled', 'publishing', 'failed', 'cancelled'])
    .select('id', 'items', 'status', 'scheduled_at')) as any[]
  const index = await readIndex()
  let indexChanged = false
  for (const post of posts) {
    const items = JSON.parse(post.items || '[]') as StoredItem[]
    const due = new Date(post.scheduled_at).getTime() - Date.now()
    const needLocal = post.status !== 'scheduled' || due <= RESTORE_BEFORE_MS
    let changed = false
    for (const item of items) {
      try {
        if (needLocal) {
          if (item.drive && !(await mediaExists(item.file))) await driveDownloadFile(item.drive, mediaPath(item.file))
        } else if (drive.offload && due > OFFLOAD_AFTER_MS && !item.drive && (await mediaExists(item.file))) {
          item.drive = await driveUploadFile(mediaPath(item.file), item.file, mimeOf(item.file))
          index[item.file] = item.drive
          indexChanged = changed = true
          await unlink(mediaPath(item.file)).catch(() => {})
        }
      } catch {
        // Coba lagi di putaran berikutnya; file lokal tidak dihapus bila unggah gagal.
      }
    }
    if (changed)
      await db.from('whatsapp_ig_posts').where('id', post.id).update({ items: JSON.stringify(items), updated_at: new Date() })
  }
  if (indexChanged) await writeIndex(index).catch(() => {})
}
