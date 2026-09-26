import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import env from '#start/env'
import { readSettings } from '#services/settings_service'
import {
  codexOAuthEnv,
  codexOAuthArguments,
  codexRuntimeEnv,
  codexCommand,
} from '#services/workspace_oauth'
import { workspaceScope } from '#services/workspace_context'
import { aiAccountKey, currentAiAccount } from '#services/ai_account_context'
import { watchDeviceLogin } from '#services/codex_device_login'
import { resetQuota } from '#services/ai_quota_store'

const execFileAsync = promisify(execFile)

type LoginState = {
  connected: boolean
  pending: boolean
  verificationUrl: string
  userCode: string
  error: string
}

const logins = new Map<
  string,
  {
    session?: ReturnType<typeof watchDeviceLogin>
  }
>()
function loginState() {
  const key = aiAccountKey(workspaceScope().prefix)
  if (!logins.has(key)) logins.set(key, {})
  return logins.get(key)!
}

async function codexBinary() {
  // Pengaturan di halaman Setting menang atas variabel lingkungan, supaya
  // lokasi codex bisa diperbaiki tanpa menyentuh berkas .env.
  try {
    const settings = await readSettings()
    if (settings.codexBin) return codexCommand(settings.codexBin)
  } catch {
    // Abaikan; jatuh ke env atau PATH.
  }
  return codexCommand(env.get('CODEX_BIN'))
}

/** Memeriksa apakah biner codex benar-benar bisa dijalankan. */
export async function codexBinaryStatus(override?: string) {
  const bin = String(override || '').trim() ? codexCommand(override) : await codexBinary()
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 5000,
      maxBuffer: 20_000,
      env: codexRuntimeEnv(),
    })
    return {
      found: true,
      bin,
      version: cleanOutput(`${stdout}\n${stderr}`).slice(0, 120),
      error: '',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      found: false,
      bin,
      version: '',
      error: message.includes('ENOENT')
        ? `Tidak ditemukan: ${bin}. Isi lokasi lengkapnya, misal /usr/local/bin/codex`
        : message.slice(0, 300),
    }
  }
}

function cleanOutput(value: string) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  return value.replace(ansiColor, '').trim()
}

function details(connected: boolean): LoginState {
  const state = loginState().session?.snapshot()
  return {
    connected,
    pending: !connected && Boolean(state?.pending),
    verificationUrl: !connected ? state?.verificationUrl || '' : '',
    userCode: !connected ? state?.userCode || '' : '',
    error:
      !connected && state && !state.pending
        ? state.error || 'Login ChatGPT belum berhasil. Mulai ulang login.'
        : '',
  }
}

export async function isChatgptConnected() {
  if (!workspaceScope().id && !currentAiAccount()) return false
  try {
    const { stdout, stderr } = await execFileAsync(
      await codexBinary(),
      [...codexOAuthArguments(), 'login', 'status'],
      {
        timeout: 5000,
        maxBuffer: 20_000,
        env: codexOAuthEnv(),
      }
    )
    return /logged in using chatgpt/i.test(`${stdout}\n${stderr}`)
  } catch {
    return false
  }
}

export async function oauthState() {
  return details(await isChatgptConnected())
}

const starts = new Map<string, Promise<LoginState>>()
export async function startOAuthLogin(restart = false) {
  const key = aiAccountKey(workspaceScope().prefix)
  const existing = starts.get(key)
  if (existing) return existing
  const operation = beginOAuthLogin(restart)
  starts.set(key, operation)
  try {
    return await operation
  } finally {
    if (starts.get(key) === operation) starts.delete(key)
  }
}

async function beginOAuthLogin(restart: boolean) {
  const state = loginState()
  if (!workspaceScope().id && !currentAiAccount()) throw new Error('Hubungkan nomor WhatsApp terlebih dahulu.')
  if (await isChatgptConnected()) return details(true)
  if (state.session?.snapshot().pending && !restart) {
    await state.session.ready
    return details(false)
  }
  state.session?.cancel()
  await resetQuota('chatgpt')
  const child = spawn(await codexBinary(), [...codexOAuthArguments(), 'login', '--device-auth'], {
    env: codexOAuthEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 600_000,
  })
  state.session = watchDeviceLogin(child)
  // Fast replies contain the code; slower replies keep polling without a long HTTP request.
  await state.session.ready
  return details(state.session.snapshot().pending ? false : await isChatgptConnected())
}
