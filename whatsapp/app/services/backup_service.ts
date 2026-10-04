// Backup ke Google Drive: database (semua tabel: chat, AI, akun AI, skill, kualitas, order),
// folder storage (login akun AI, sesi, media CS), media chat, dan kunci aplikasi.
// Pulihkan di VPS baru: hubungkan Google Drive yang sama → pilih backup → Pulihkan.
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile, cp, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import app from '@adonisjs/core/services/app'
import env from '#start/env'

const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER_NAME = 'WA Backup'
const KEEP = 14

type GoogleState = {
  clientId: string
  clientSecret: string
  refreshToken?: string
  email?: string
  folderId?: string
  auto?: boolean
  includeMedia?: boolean
  /** Media postingan Instagram terjadwal disimpan di Drive (hemat server). Bawaan: mati. */
  igOffload?: boolean
  igFolderId?: string
  lastBackup?: { at: number; name: string; size: number; ok: boolean; error?: string; media?: { uploaded: number; pending: number; total: number } }
  mediaFolderId?: string
  oauthState?: string
}

const stateFile = () => app.makePath('storage', 'backup', 'google.json')
export async function readGoogle(): Promise<GoogleState> {
  try {
    return { auto: true, includeMedia: true, ...JSON.parse(await readFile(stateFile(), 'utf8')) }
  } catch {
    return { clientId: '', clientSecret: '', auto: true, includeMedia: true }
  }
}
async function writeGoogle(state: GoogleState) {
  await mkdir(app.makePath('storage', 'backup'), { recursive: true, mode: 0o700 })
  await writeFile(stateFile(), JSON.stringify(state, null, 2), { mode: 0o600 })
}
export async function backupStatus() {
  const state = await readGoogle()
  return {
    clientId: state.clientId,
    hasSecret: Boolean(state.clientSecret),
    connected: Boolean(state.refreshToken),
    email: state.email || '',
    auto: state.auto !== false,
    includeMedia: state.includeMedia !== false,
    igOffload: state.igOffload === true,
    lastBackup: state.lastBackup || null,
    mediaRestoring: existsSync(app.makePath('storage', 'backup', 'media-restore-pending')),
    running,
    redirectUri: redirectUri(),
  }
}
export async function saveBackupSettings(input: Record<string, unknown>) {
  const state = await readGoogle()
  if (typeof input.clientId === 'string') state.clientId = input.clientId.trim().slice(0, 300)
  if (typeof input.clientSecret === 'string' && input.clientSecret.trim())
    state.clientSecret = input.clientSecret.trim().slice(0, 300)
  if (typeof input.auto === 'boolean') state.auto = input.auto
  if (typeof input.includeMedia === 'boolean') state.includeMedia = input.includeMedia
  if (typeof input.igOffload === 'boolean') state.igOffload = input.igOffload
  await writeGoogle(state)
  return backupStatus()
}

/* ---------------- OAuth Google ---------------- */
function redirectUri() {
  const base = String(env.get('APP_URL') || '').replace(/\/$/, '')
  return `${base}${env.get('APP_BASE_PATH') || ''}/backup/google/callback`
}
export async function googleAuthUrl() {
  const state = await readGoogle()
  if (!state.clientId || !state.clientSecret) throw new Error('Isi Client ID dan Client Secret dulu.')
  state.oauthState = Math.random().toString(36).slice(2) + Date.now().toString(36)
  await writeGoogle(state)
  const params = new URLSearchParams({
    client_id: state.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: `${SCOPE} openid email`,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: state.oauthState,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`
}
export async function finishGoogleAuth(code: string, returnedState: string) {
  const state = await readGoogle()
  if (!state.oauthState || state.oauthState !== returnedState) throw new Error('Sesi login Google tidak cocok. Ulangi.')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: state.clientId,
      client_secret: state.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  })
  const token = (await response.json().catch(() => ({}))) as Record<string, any>
  if (!response.ok || !token.refresh_token) throw new Error(token.error_description || 'Google tidak memberi izin.')
  // Layar izin Google punya kotak centang per izin; tanpa izin Drive backup tidak bisa jalan.
  if (!String(token.scope || '').includes('drive.file'))
    throw new Error('Izin Google Drive belum dicentang. Hubungkan lagi dan centang izin "file Google Drive yang Anda gunakan dengan aplikasi ini".')
  let email = ''
  try {
    const payload = JSON.parse(Buffer.from(String(token.id_token || '').split('.')[1] || '', 'base64url').toString())
    email = String(payload.email || '')
  } catch {}
  await writeGoogle({ ...state, refreshToken: token.refresh_token, email, oauthState: undefined, folderId: undefined })
}
export async function disconnectGoogle() {
  const state = await readGoogle()
  await writeGoogle({ ...state, refreshToken: undefined, email: undefined, folderId: undefined })
}
async function accessToken(state: GoogleState) {
  if (!state.refreshToken) throw new Error('Google Drive belum terhubung.')
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: state.clientId,
      client_secret: state.clientSecret,
      refresh_token: state.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const token = (await response.json().catch(() => ({}))) as Record<string, any>
  if (!response.ok || !token.access_token) throw new Error(token.error_description || 'Izin Google Drive kedaluwarsa. Hubungkan ulang.')
  return String(token.access_token)
}
async function drive(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) },
  })
  if (!response.ok) {
    const text = await response.text()
    if (response.status === 403 && /insufficient/i.test(text))
      throw new Error('Izin Google Drive belum diberikan. Tekan Putuskan, lalu Hubungkan lagi dan centang izin Google Drive.')
    throw new Error(`Google Drive: ${response.status} ${text.slice(0, 200)}`)
  }
  return response
}
async function folderId(state: GoogleState, token: string) {
  if (state.folderId) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${state.folderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await check.json().catch(() => ({}))) as Record<string, any>
    if (check.ok && !data.trashed) return state.folderId
  }
  const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)
  const found = (await (await drive(token, `files?q=${q}&fields=files(id)`)).json()) as any
  let id = found.files?.[0]?.id
  if (!id) {
    const created = (await (
      await drive(token, 'files?fields=id', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      })
    ).json()) as any
    id = created.id
  }
  await writeGoogle({ ...(await readGoogle()), folderId: id })
  return String(id)
}

/* ---------------- Arsip ---------------- */
function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream; okCodes?: number[] } = {}
) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ['pipe', options.stdout ? 'pipe' : 'ignore', 'pipe'] })
    let error = ''
    child.stderr?.on('data', (chunk) => (error = (error + chunk).slice(-2000)))
    if (options.stdin) options.stdin.pipe(child.stdin!)
    else child.stdin?.end()
    if (options.stdout && child.stdout) child.stdout.pipe(options.stdout)
    child.on('error', reject)
    child.on('close', (code) =>
      (options.okCodes || [0]).includes(Number(code)) ? resolve() : reject(new Error(`${command}: ${error.trim() || `kode ${code}`}`))
    )
  })
}
const binary = (name: string) =>
  ['/usr/bin', '/usr/local/bin', '/www/server/mysql/bin', '/usr/local/mysql/bin']
    .map((dir) => join(dir, name))
    .find((path) => existsSync(path)) || name
const dbEnv = () => ({ MYSQL_PWD: String(env.get('DB_PASSWORD') || '') })
const dbArgs = () => [
  `-h${env.get('DB_HOST')}`,
  `-P${env.get('DB_PORT')}`,
  `-u${env.get('DB_USER')}`,
]

/** Folder sementara/log login AI: tidak perlu dicadangkan dan sering berubah/hilang saat backup berjalan. */
const VOLATILE_DIRS = ['tmp', 'log', 'logs', 'cache', 'shell-snapshots', 'arg0']
const volatile = (path: string) => VOLATILE_DIRS.includes(basename(path))

async function buildArchive(includeMedia: boolean) {
  const work = await mkdtemp(join(tmpdir(), 'wa-backup-'))
  const stamp = new Date(Date.now() + 7 * 3_600_000).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const name = `wa-backup-${stamp}.tar.gz`
  const dump = createWriteStream(join(work, 'db.sql'))
  await run(binary('mysqldump'), [...dbArgs(), '--single-transaction', '--routines', '--no-tablespaces', String(env.get('DB_DATABASE'))], {
    env: dbEnv(),
    stdout: dump,
  })
  await new Promise((resolve) => dump.end(resolve))
  await writeFile(
    join(work, 'meta.json'),
    JSON.stringify({ createdAt: Date.now(), appKey: env.get('APP_KEY'), version: await readFile(app.makePath('VERSION'), 'utf8').catch(() => '') })
  )
  // Login lama di folder home (tanpa workspace) ikut disalin.
  for (const [dir, target] of [
    [join(homedir(), '.codex'), 'home-codex'],
    [join(homedir(), '.claude'), 'home-claude'],
  ]) {
    if (existsSync(dir))
      await cp(dir, join(work, target), { recursive: true, filter: (source) => !volatile(source) }).catch(() => {})
  }
  const archive = join(tmpdir(), name)
  const parts = ['-C', work, 'db.sql', 'meta.json']
  for (const extra of ['home-codex', 'home-claude']) if (existsSync(join(work, extra))) parts.push(extra)
  const storageArgs = [
    '-C',
    app.makePath(),
    '--exclude=storage/backup/*.tmp',
    '--exclude=storage/diagnostics',
    ...VOLATILE_DIRS.map((dir) => `--exclude=*/${dir}`),
    // Media dicadangkan terpisah & bertahap (hanya file baru), bukan disalin utuh tiap hari.
    '--exclude=storage/cs-media',
    '--exclude=storage/ig-media',
    'storage',
  ]
  void includeMedia
  const mediaArgs: string[] = []
  // -h: storage & media di rilis berupa symlink ke folder bersama; arsipkan isinya.
  // File sementara AI (codex/claude) bisa hilang saat dibaca → abaikan; kode 1 tar = ada file berubah, arsip tetap utuh.
  await run(
    'tar',
    ['--ignore-failed-read', '--warning=no-file-removed', '--warning=no-file-changed', '--warning=no-file-shrank', '-czhf', archive, ...parts, ...storageArgs, ...mediaArgs],
    { okCodes: [0, 1] }
  )
  await rm(work, { recursive: true, force: true })
  return { archive, name, size: (await stat(archive)).size }
}

async function upload(token: string, parent: string, file: string, name: string, size: number, mime = 'application/gzip') {
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mime,
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, parents: [parent] }),
  })
  const location = start.headers.get('location')
  if (!start.ok || !location) throw new Error(`Google Drive: upload tidak bisa dimulai (${start.status}).`)
  const chunk = 16 * 1024 * 1024
  for (let offset = 0; offset < size; offset += chunk) {
    const end = Math.min(size, offset + chunk) - 1
    const body = await new Promise<Buffer>((resolve, reject) => {
      const parts: Buffer[] = []
      createReadStream(file, { start: offset, end })
        .on('data', (data) => parts.push(data as Buffer))
        .on('end', () => resolve(Buffer.concat(parts)))
        .on('error', reject)
    })
    const response = await fetch(location, {
      method: 'PUT',
      headers: { 'Content-Length': String(body.length), 'Content-Range': `bytes ${offset}-${end}/${size}` },
      body,
    })
    if (![200, 201, 308].includes(response.status)) throw new Error(`Google Drive: upload gagal (${response.status}).`)
    if (response.status !== 308) {
      const done = (await response.json().catch(() => ({}))) as Record<string, any>
      if (done.id) return String(done.id)
    }
  }
  return ''
}

/* ---------------- File satuan (media Instagram terjadwal) ---------------- */
const IG_FOLDER = 'Instagram terjadwal'
/** Drive terhubung + pilihan "simpan media jadwal di Drive". */
export async function driveMediaState() {
  const state = await readGoogle()
  return { connected: Boolean(state.refreshToken), offload: state.igOffload === true }
}
async function igFolder(state: GoogleState, token: string) {
  if (state.igFolderId) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${state.igFolderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await check.json().catch(() => ({}))) as Record<string, any>
    if (check.ok && !data.trashed) return state.igFolderId
  }
  const parent = await folderId(state, token)
  const created = (await (
    await drive(token, 'files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: IG_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
    })
  ).json()) as any
  await writeGoogle({ ...(await readGoogle()), igFolderId: String(created.id) })
  return String(created.id)
}
/** Unggah satu file ke folder "WA Backup/Instagram terjadwal"; hasilnya id file di Drive. */
export async function driveUploadFile(file: string, name: string, mime: string) {
  const state = await readGoogle()
  const token = await accessToken(state)
  const parent = await igFolder(state, token)
  const id = await upload(token, parent, file, name, (await stat(file)).size, mime)
  if (!id) throw new Error('Google Drive: id file tidak diterima.')
  return id
}
/** Ambil isi satu file dari Drive (untuk dialirkan atau disimpan). */
export async function driveFetchFile(id: string) {
  const state = await readGoogle()
  const token = await accessToken(state)
  return drive(token, `files/${encodeURIComponent(id)}?alt=media`)
}
export async function driveDownloadFile(id: string, dest: string) {
  const response = await driveFetchFile(id)
  const temp = `${dest}.part`
  await pipeline(Readable.fromWeb(response.body as any), createWriteStream(temp))
  const { rename } = await import('node:fs/promises')
  await rename(temp, dest)
}

let running = ''
export async function runBackup(reason: 'manual' | 'auto' = 'manual') {
  if (running) throw new Error('Backup/pemulihan sedang berjalan.')
  running = 'backup'
  const state = await readGoogle()
  let archive = ''
  try {
    const token = await accessToken(state)
    const parent = await folderId(state, token)
    const built = await buildArchive(state.includeMedia !== false)
    archive = built.archive
    await upload(token, parent, built.archive, built.name, built.size)
    await rm(built.archive, { force: true }).catch(() => {})
    // Simpan 14 backup terbaru.
    const list = await listBackups()
    for (const old of list.slice(KEEP)) await drive(token, `files/${old.id}`, { method: 'DELETE' }).catch(() => {})
    // Media: hanya file baru yang diunggah (sisanya dilanjutkan backup berikutnya bila waktunya habis).
    const media = state.includeMedia !== false ? await syncMedia(state).catch(() => undefined) : undefined
    await writeGoogle({ ...(await readGoogle()), lastBackup: { at: Date.now(), name: built.name, size: built.size, ok: true, media } })
    return { ok: true, name: built.name, size: built.size, reason, media }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await writeGoogle({ ...(await readGoogle()), lastBackup: { at: Date.now(), name: '', size: 0, ok: false, error: message.slice(0, 300) } })
    throw error
  } finally {
    running = ''
    if (archive) await rm(archive, { force: true }).catch(() => {})
  }
}

export async function listBackups() {
  const state = await readGoogle()
  const token = await accessToken(state)
  const parent = await folderId(state, token)
  const q = encodeURIComponent(`'${parent}' in parents and trashed=false and name contains 'wa-backup-'`)
  const data = (await (await drive(token, `files?q=${q}&orderBy=createdTime desc&pageSize=100&fields=files(id,name,size,createdTime)`)).json()) as any
  return (data.files || []).map((file: any) => ({
    id: String(file.id),
    name: String(file.name),
    size: Number(file.size || 0),
    createdAt: String(file.createdTime),
  }))
}

/** Tanda agar worker memulai ulang setelah pemulihan (dibaca oleh whatsapp:listen). */
export const restartFlag = () => app.makePath('storage', 'restart-request')
export async function restartRequestedSince(startedAt: number) {
  try {
    return (await stat(restartFlag())).mtimeMs > startedAt
  } catch {
    return false
  }
}

export async function restoreBackup(fileId: string) {
  if (running) throw new Error('Backup/pemulihan sedang berjalan.')
  running = 'restore'
  const work = await mkdtemp(join(tmpdir(), 'wa-restore-'))
  try {
    const state = await readGoogle()
    const token = await accessToken(state)
    const response = await drive(token, `files/${encodeURIComponent(fileId)}?alt=media`)
    const archive = join(work, 'backup.tar.gz')
    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(archive))
    const out = join(work, 'x')
    await mkdir(out)
    await run('tar', ['-xzf', archive, '-C', out])
    if (!existsSync(join(out, 'db.sql'))) throw new Error('File backup tidak valid.')
    // 1) Database
    await run(binary('mysql'), [...dbArgs(), String(env.get('DB_DATABASE'))], {
      env: dbEnv(),
      stdin: createReadStream(join(out, 'db.sql')),
    })
    // 2) storage + media (koneksi Google saat ini dipertahankan)
    const googleNow = await readFile(stateFile(), 'utf8').catch(() => '')
    if (existsSync(join(out, 'storage')))
      await cp(join(out, 'storage'), await realpath(app.makePath('storage')), { recursive: true, force: true })
    if (googleNow) await writeFile(stateFile(), googleNow, { mode: 0o600 })
    if (existsSync(join(out, 'public', 'media')))
      await cp(join(out, 'public', 'media'), await realpath(app.makePath('public', 'media')).catch(() => app.makePath('public', 'media')), { recursive: true, force: true })
    for (const [source, target] of [
      ['home-codex', join(homedir(), '.codex')],
      ['home-claude', join(homedir(), '.claude')],
    ]) {
      if (existsSync(join(out, source))) await cp(join(out, source), target, { recursive: true, force: true }).catch(() => {})
    }
    // 3) Kunci aplikasi lama agar data terenkripsi tetap terbaca.
    const meta = JSON.parse(await readFile(join(out, 'meta.json'), 'utf8').catch(() => '{}'))
    const envFiles = [app.makePath('.env')].filter((path) => existsSync(path))
    if (meta.appKey && meta.appKey !== env.get('APP_KEY'))
      for (const file of envFiles) {
        const text = await readFile(file, 'utf8')
        if (/^APP_KEY=/m.test(text)) await writeFile(file, text.replace(/^APP_KEY=.*$/m, `APP_KEY=${meta.appKey}`))
      }
    // Media chat diunduh bertahap dari Drive setelah aplikasi menyala (lihat restoreMediaTick).
    await writeFile(app.makePath('storage', 'backup', 'media-restore-pending'), String(Date.now())).catch(() => {})
    // 4) Minta worker & web mulai ulang.
    await writeFile(restartFlag(), String(Date.now()))
    const now = new Date()
    await utimes(restartFlag(), now, now).catch(() => {})
    return { ok: true, restarting: true }
  } finally {
    running = ''
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** Backup otomatis harian sekitar 03.00 WIB (dipanggil berkala dari proses web). */
export async function autoBackupTick() {
  const state = await readGoogle()
  if (!state.refreshToken || running) return
  await restoreMediaTick(state).catch(() => {})
  if (state.auto === false || running) return
  const wibHour = (new Date().getUTCHours() + 7) % 24
  const last = state.lastBackup?.at || 0
  if (wibHour >= 3 && Date.now() - last > 20 * 3_600_000) await runBackup('auto').catch(() => {})
}

/* ---------------- Media bertahap (hanya file baru) ----------------
 * Foto & media chat tidak lagi masuk arsip harian (14 salinan penuh = boros Drive & disk server).
 * Setiap file diunggah sekali ke "WA Backup/Media"; indeks (path → id Drive) disimpan di server
 * dan di Drive, dipakai saat pemulihan. File yang dihapus di server dihapus dari Drive setelah 14 hari.
 */
type MediaEntry = { id: string; size: number; mtime: number; gone?: number }
const MEDIA_FOLDER = 'Media'
const MEDIA_BUDGET_MS = 25 * 60_000
const mediaIndexFile = () => app.makePath('storage', 'backup', 'media-index.json')
async function readMediaIndex(): Promise<Record<string, MediaEntry>> {
  try {
    return JSON.parse(await readFile(mediaIndexFile(), 'utf8'))
  } catch {
    return {}
  }
}
async function writeMediaIndex(index: Record<string, MediaEntry>) {
  await mkdir(app.makePath('storage', 'backup'), { recursive: true, mode: 0o700 })
  await writeFile(`${mediaIndexFile()}.tmp`, JSON.stringify(index))
  const { rename } = await import('node:fs/promises')
  await rename(`${mediaIndexFile()}.tmp`, mediaIndexFile())
}
/** Folder media yang dicadangkan bertahap: key = path relatif aplikasi. */
async function mediaRoots() {
  const roots: Array<{ key: string; dir: string }> = []
  for (const key of ['public/media', 'storage/cs-media']) {
    const dir = await realpath(app.makePath(...key.split('/'))).catch(() => '')
    if (dir && existsSync(dir)) roots.push({ key, dir })
  }
  return roots
}
async function walk(dir: string, prefix: string, out: Array<{ key: string; path: string }>) {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || entry.name.endsWith('.part') || entry.name.endsWith('.tmp')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await walk(path, `${prefix}/${entry.name}`, out)
    else if (entry.isFile()) out.push({ key: `${prefix}/${entry.name}`, path })
  }
}
async function mediaFolder(state: GoogleState, token: string) {
  if (state.mediaFolderId) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${state.mediaFolderId}?fields=id,trashed`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = (await check.json().catch(() => ({}))) as Record<string, any>
    if (check.ok && !data.trashed) return state.mediaFolderId
  }
  const parent = await folderId(state, token)
  const created = (await (
    await drive(token, 'files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: MEDIA_FOLDER, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
    })
  ).json()) as any
  await writeGoogle({ ...(await readGoogle()), mediaFolderId: String(created.id) })
  return String(created.id)
}
/** Unggah file kecil dalam satu permintaan (multipart); besar → resumable. */
async function uploadAny(token: string, parent: string, file: string, name: string, size: number) {
  if (size > 5 * 1024 * 1024) return upload(token, parent, file, name, size, 'application/octet-stream')
  const boundary = `wa${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parent] })}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`
  )
  const body = Buffer.concat([head, await readFile(file), Buffer.from(`\r\n--${boundary}--`)])
  const response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, any>
  if (!response.ok || !data.id) throw new Error(`Google Drive: upload media gagal (${response.status}).`)
  return String(data.id)
}
/** Token akses diperbarui tiap 40 menit selama proses panjang. */
function tokenSource(state: GoogleState) {
  let token = ''
  let at = 0
  return async () => {
    if (!token || Date.now() - at > 40 * 60_000) {
      token = await accessToken(state)
      at = Date.now()
    }
    return token
  }
}
async function saveIndexToDrive(token: string, folder: string, index: Record<string, MediaEntry>, state: GoogleState) {
  const q = encodeURIComponent(`'${folder}' in parents and trashed=false and name='media-index.json'`)
  const found = (await (await drive(token, `files?q=${q}&fields=files(id)`)).json()) as any
  const id = found.files?.[0]?.id
  const body = JSON.stringify(index)
  if (id)
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
    })
  else {
    const temp = join(tmpdir(), `media-index-${Date.now()}.json`)
    await writeFile(temp, body)
    await uploadAny(token, folder, temp, 'media-index.json', Buffer.byteLength(body)).finally(() => rm(temp, { force: true }))
  }
  void state
}

export async function syncMedia(state: GoogleState, budgetMs = MEDIA_BUDGET_MS) {
  const started = Date.now()
  const getToken = tokenSource(state)
  const folder = await mediaFolder(state, await getToken())
  const index = await readMediaIndex()
  const files: Array<{ key: string; path: string }> = []
  for (const root of await mediaRoots()) await walk(root.dir, root.key, files)
  const present = new Set(files.map((file) => file.key))
  const todo: Array<{ key: string; path: string; size: number; mtime: number }> = []
  for (const file of files) {
    const info = await stat(file.path).catch(() => null)
    if (!info) continue
    const known = index[file.key]
    if (known && known.size === info.size && !known.gone) continue
    if (known?.gone && known.size === info.size) {
      delete known.gone
      continue
    }
    todo.push({ ...file, size: info.size, mtime: Math.round(info.mtimeMs) })
  }
  let uploaded = 0
  let changed = false
  // 4 unggahan bersamaan; berhenti saat jatah waktu habis (dilanjutkan backup berikutnya).
  const queue = [...todo]
  const worker = async () => {
    while (queue.length && Date.now() - started < budgetMs) {
      const item = queue.shift()!
      try {
        const token = await getToken()
        const id = await uploadAny(token, folder, item.path, item.key, item.size)
        const old = index[item.key]
        if (old?.id && old.id !== id) await drive(token, `files/${old.id}`, { method: 'DELETE' }).catch(() => {})
        index[item.key] = { id, size: item.size, mtime: item.mtime }
        uploaded++
        changed = true
        if (uploaded % 50 === 0) await writeMediaIndex(index)
      } catch {
        // Dicoba lagi pada backup berikutnya.
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  // File yang sudah dihapus di server: hapus dari Drive setelah 14 hari.
  for (const [key, entry] of Object.entries(index)) {
    if (present.has(key)) continue
    if (!entry.gone) {
      entry.gone = Date.now()
      changed = true
    } else if (Date.now() - entry.gone > 14 * 86_400_000) {
      await drive(await getToken(), `files/${entry.id}`, { method: 'DELETE' }).catch(() => {})
      delete index[key]
      changed = true
    }
  }
  if (changed) {
    await writeMediaIndex(index)
    await saveIndexToDrive(await getToken(), folder, index, state).catch(() => {})
  }
  return { uploaded, pending: queue.length, total: Object.keys(index).length }
}

/** Setelah pemulihan: unduh media yang belum ada di server, bertahap (maks ±2 menit per putaran). */
async function restoreMediaTick(state: GoogleState) {
  const flag = app.makePath('storage', 'backup', 'media-restore-pending')
  if (!existsSync(flag) || running) return
  running = 'media'
  try {
    const getToken = tokenSource(state)
    const token = await getToken()
    let index = await readMediaIndex()
    // Indeks terbaru di Drive (lebih baru dari yang ada di arsip).
    try {
      const folder = await mediaFolder(state, token)
      const q = encodeURIComponent(`'${folder}' in parents and trashed=false and name='media-index.json'`)
      const found = (await (await drive(token, `files?q=${q}&fields=files(id)`)).json()) as any
      if (found.files?.[0]?.id) {
        const remote = (await (await drive(token, `files/${found.files[0].id}?alt=media`)).json()) as Record<string, MediaEntry>
        index = { ...index, ...remote }
        await writeMediaIndex(index)
      }
    } catch {}
    const roots = await mediaRoots()
    const started = Date.now()
    let missing = 0
    for (const [key, entry] of Object.entries(index)) {
      if (entry.gone) continue
      const root = roots.find((item) => key.startsWith(`${item.key}/`)) || { key: key.split('/').slice(0, 2).join('/'), dir: app.makePath(...key.split('/').slice(0, 2)) }
      const dest = join(root.dir, key.slice(root.key.length + 1))
      if (existsSync(dest)) continue
      if (Date.now() - started > 2 * 60_000) {
        missing++
        continue
      }
      try {
        await mkdir(join(dest, '..'), { recursive: true })
        const response = await drive(await getToken(), `files/${encodeURIComponent(entry.id)}?alt=media`)
        await pipeline(Readable.fromWeb(response.body as any), createWriteStream(`${dest}.part`))
        const { rename } = await import('node:fs/promises')
        await rename(`${dest}.part`, dest)
      } catch {
        missing++
      }
    }
    if (!missing) await rm(flag, { force: true })
  } finally {
    running = ''
  }
}
