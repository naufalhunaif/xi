// Backup ke Google Drive: database (semua tabel: chat, AI, akun AI, skill, kualitas, order),
// folder storage (login akun AI, sesi, media CS), media chat, dan kunci aplikasi.
// Pulihkan di VPS baru: hubungkan Google Drive yang sama → pilih backup → Pulihkan.
import { spawn } from 'node:child_process'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile, cp, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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
  lastBackup?: { at: number; name: string; size: number; ok: boolean; error?: string }
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
    lastBackup: state.lastBackup || null,
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
function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...options.env }, stdio: ['pipe', options.stdout ? 'pipe' : 'ignore', 'pipe'] })
    let error = ''
    child.stderr?.on('data', (chunk) => (error = (error + chunk).slice(-2000)))
    if (options.stdin) options.stdin.pipe(child.stdin!)
    else child.stdin?.end()
    if (options.stdout && child.stdout) child.stdout.pipe(options.stdout)
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command}: ${error.trim() || `kode ${code}`}`))))
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
    if (existsSync(dir)) await cp(dir, join(work, target), { recursive: true }).catch(() => {})
  }
  const archive = join(tmpdir(), name)
  const parts = ['-C', work, 'db.sql', 'meta.json']
  for (const extra of ['home-codex', 'home-claude']) if (existsSync(join(work, extra))) parts.push(extra)
  const storageArgs = ['-C', app.makePath(), '--exclude=storage/backup/*.tmp', '--exclude=storage/diagnostics', 'storage']
  const mediaArgs = includeMedia && existsSync(app.makePath('public', 'media')) ? ['-C', app.makePath(), 'public/media'] : []
  // -h: storage & media di rilis berupa symlink ke folder bersama; arsipkan isinya.
  await run('tar', ['-czhf', archive, ...parts, ...storageArgs, ...mediaArgs])
  await rm(work, { recursive: true, force: true })
  return { archive, name, size: (await stat(archive)).size }
}

async function upload(token: string, parent: string, file: string, name: string, size: number) {
  const start = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/gzip',
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
  }
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
    // Simpan 14 backup terbaru.
    const list = await listBackups()
    for (const old of list.slice(KEEP)) await drive(token, `files/${old.id}`, { method: 'DELETE' }).catch(() => {})
    await writeGoogle({ ...(await readGoogle()), lastBackup: { at: Date.now(), name: built.name, size: built.size, ok: true } })
    return { ok: true, name: built.name, size: built.size, reason }
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
  if (!state.refreshToken || state.auto === false || running) return
  const wibHour = (new Date().getUTCHours() + 7) % 24
  const last = state.lastBackup?.at || 0
  if (wibHour >= 3 && Date.now() - last > 20 * 3_600_000) await runBackup('auto').catch(() => {})
}
export async function listStorageRoot() {
  return readdir(app.makePath('storage')).catch(() => [])
}
