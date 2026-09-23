import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import env from '#start/env'
import { isLocalAuth } from '#services/local_auth_service'

/**
 * Pengaturan alamat akses & domain dari halaman Pengaturan (mode standalone).
 * Pekerjaan root (Nginx, SSL, restart) dijalankan oleh /usr/local/bin/wa lewat sudo
 * tanpa password (aturan sudoers dibuat installer), terpisah dari proses web supaya
 * tetap berjalan saat WEB di-restart.
 */
const WA_BIN = '/usr/local/bin/wa'
const DOMAIN_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/

function root() {
  return fileURLToPath(new URL('../../', import.meta.url))
}
function stateFile() {
  return join(root(), 'tmp', 'domain-setup.json')
}
function logFile() {
  return join(root(), 'tmp', 'domain-setup.log')
}

export function accessAvailable() {
  return isLocalAuth() && existsSync(WA_BIN)
}

export function readAccess() {
  const appUrl = env.get('APP_URL').replace(/\/$/, '')
  let domain = ''
  try {
    const url = new URL(appUrl)
    if (url.protocol === 'https:' && DOMAIN_RE.test(url.hostname)) domain = url.hostname
  } catch {}
  return {
    available: accessAvailable(),
    appUrl,
    domain,
    aapanel: existsSync('/www/server/panel'),
    job: readJob(),
  }
}

type Job = {
  action: 'domain' | 'unset'
  domain: string
  startedAt: number
  done: boolean
  ok: boolean | null
  log: string
}

function readJob(): Job | null {
  try {
    const state = JSON.parse(readFileSync(stateFile(), 'utf8')) as Job
    let log = ''
    try {
      log = readFileSync(logFile(), 'utf8')
    } catch {}
    // Baris penanda ditulis pembungkus shell setelah `wa` selesai.
    const done = /\n__WA_DONE__ (\d+)\n?$/.exec(log)
    const clean = log
      .replace(/\n__WA_DONE__ \d+\n?$/, '')
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*m/g, '')
      .trim()
    return {
      ...state,
      done: Boolean(done),
      ok: done ? done[1] === '0' : null,
      log: clean.slice(-4000),
    }
  } catch {
    return null
  }
}

function run(action: 'domain' | 'unset', domain: string) {
  if (!accessAvailable())
    throw new Error('Pengaturan domain hanya tersedia pada pemasangan standalone (perintah wa).')
  const job = readJob()
  if (job && !job.done && Date.now() - job.startedAt < 15 * 60_000)
    throw new Error('Proses domain sebelumnya masih berjalan.')
  writeFileSync(stateFile(), JSON.stringify({ action, domain, startedAt: Date.now() }))
  writeFileSync(logFile(), '')
  const out = openSync(logFile(), 'a')
  const arg = action === 'unset' ? '--lepas' : domain
  // Proses terpisah (setsid) supaya tidak ikut mati saat Supervisor me-restart WEB.
  const child = spawn(
    'bash',
    ['-c', `sudo -n ${WA_BIN} domain ${arg}; code=$?; printf '\\n__WA_DONE__ %s\\n' "$code"`],
    { detached: true, stdio: ['ignore', out, out], env: { ...process.env, TERM: 'dumb' } }
  )
  child.unref()
}

export function setDomain(input: string) {
  const domain = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
  if (!DOMAIN_RE.test(domain)) throw new Error('Domain tidak valid. Contoh: wa.contoh.com')
  run('domain', domain)
  return domain
}

export function unsetDomain() {
  run('unset', '')
}
