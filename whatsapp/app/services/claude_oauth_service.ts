import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import env from '#start/env'
import { readSettings } from '#services/settings_service'
import { workspaceOAuthDirectory } from '#services/workspace_oauth'
import { workspaceScope } from '#services/workspace_context'
import { aiAccountKey, currentAiAccount } from '#services/ai_account_context'
import { randomUUID } from 'node:crypto'
import { writeClaudeVerification } from '#services/oauth_verification'
import { resetQuota } from '#services/ai_quota_store'

const execFileAsync = promisify(execFile)

type LoginState = {
  connected: boolean
  pending: boolean
  verificationUrl: string
  error: string
  loginId: string
  codeSubmitted: boolean
}

const logins = new Map<
  string,
  {
    loginProcess?: ChildProcessWithoutNullStreams
    loginOutput: string
    loginError: string
    loginId: string
    codeSubmitted: boolean
    expiresAt: number
  }
>()
function loginState() {
  const key = aiAccountKey(workspaceScope().prefix)
  if (!logins.has(key))
    logins.set(key, {
      loginOutput: '',
      loginError: '',
      loginId: '',
      codeSubmitted: false,
      expiresAt: 0,
    })
  return logins.get(key)!
}

/** Claude harus memakai sesi OAuth milik Claude Code, bukan API key dari environment. */
export function claudeOAuthEnv() {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  delete childEnv.ANTHROPIC_API_KEY
  delete childEnv.ANTHROPIC_AUTH_TOKEN
  delete childEnv.ANTHROPIC_BASE_URL
  delete childEnv.CLAUDE_CODE_USE_BEDROCK
  delete childEnv.CLAUDE_CODE_USE_VERTEX
  delete childEnv.CLAUDE_CODE_USE_FOUNDRY
  const directory = workspaceOAuthDirectory('claude')
  if (directory) {
    childEnv.CLAUDE_CONFIG_DIR = directory
    childEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = directory
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN
    delete childEnv.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    delete childEnv.ANTHROPIC_PROFILE
  }
  return childEnv
}

export async function claudeBinary(override?: string) {
  const explicit = String(override || '').trim()
  if (explicit) return explicit
  try {
    const settings = await readSettings()
    if (settings.claudeBin) return settings.claudeBin
  } catch {
    // Jatuh ke environment/PATH ketika database belum tersedia.
  }
  if (env.get('CLAUDE_BIN')) return env.get('CLAUDE_BIN')!
  const local = join(process.cwd(), 'node_modules', '.bin', 'claude')
  try {
    await access(local)
    return local
  } catch {
    return 'claude'
  }
}

function cleanOutput(value: string) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  return value.replace(ansiColor, '').trim()
}

export async function claudeBinaryStatus(override?: string) {
  const bin = await claudeBinary(override)
  try {
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], {
      timeout: 5000,
      maxBuffer: 20_000,
      env: claudeOAuthEnv(),
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
        ? `Tidak ditemukan: ${bin}. Isi lokasi lengkap perintah claude.`
        : message.slice(0, 300),
    }
  }
}

export async function isClaudeConnected() {
  if (!workspaceScope().id && !currentAiAccount()) return false
  try {
    const { stdout } = await execFileAsync(await claudeBinary(), ['auth', 'status'], {
      timeout: 8000,
      maxBuffer: 20_000,
      env: claudeOAuthEnv(),
    })
    try {
      const status = JSON.parse(stdout) as Record<string, unknown>
      return status.loggedIn === true || status.logged_in === true
    } catch {
      return /logged\s*in|authenticated/i.test(stdout)
    }
  } catch {
    return false
  }
}

function details(connected: boolean): LoginState {
  const { loginProcess, loginOutput, loginError, loginId, codeSubmitted } = loginState()
  const output = cleanOutput(`${loginOutput}\n${loginError}`)
  const verificationUrl = output.match(/https?:\/\/[^\s]+/)?.[0]?.replace(/[),.;]+$/, '') || ''
  return {
    connected,
    pending: Boolean(loginProcess),
    verificationUrl: loginProcess && !connected ? verificationUrl : '',
    loginId: loginProcess && !connected ? loginId : '',
    codeSubmitted: Boolean(loginProcess && codeSubmitted),
    error:
      !loginProcess && !connected && loginId
        ? 'Login Claude belum berhasil. Mulai ulang login.'
        : '',
  }
}

export async function claudeOAuthState() {
  return details(await isClaudeConnected())
}

export async function startClaudeOAuthLogin(restart = false) {
  const state = loginState()
  if (!workspaceScope().id && !currentAiAccount()) throw new Error('Hubungkan nomor WhatsApp terlebih dahulu.')
  if (await isClaudeConnected()) return details(true)
  if (state.loginProcess && !restart) return details(false)
  if (state.loginProcess) {
    state.loginProcess.kill('SIGTERM')
    state.loginProcess = undefined
  }

  state.loginOutput = ''
  state.loginError = ''
  state.loginId = randomUUID()
  state.codeSubmitted = false
  state.expiresAt = Date.now() + 600_000
  await resetQuota('claude')
  const child = spawn(await claudeBinary(), ['auth', 'login'], {
    env: claudeOAuthEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 600_000,
  })
  state.loginProcess = child
  // A closed stdin can emit an error in addition to the write callback.
  child.stdin.on('error', () => {})
  child.stdout.on('data', (chunk) => {
    if (state.loginProcess !== child) return
    state.loginOutput = `${state.loginOutput}${String(chunk)}`.slice(-20_000)
  })
  child.stderr.on('data', (chunk) => {
    if (state.loginProcess !== child) return
    state.loginError = `${state.loginError}${String(chunk)}`.slice(-20_000)
  })
  child.on('error', (error) => {
    if (state.loginProcess !== child) return
    state.loginError = error.message
    state.loginProcess = undefined
  })
  child.on('close', () => {
    if (state.loginProcess !== child) return
    state.loginProcess = undefined
  })

  await new Promise((resolve) => setTimeout(resolve, 500))
  return details(false)
}

export async function verifyClaudeOAuthLogin(loginId: unknown, code: unknown) {
  if (!workspaceScope().id && !currentAiAccount()) throw new Error('Hubungkan nomor WhatsApp terlebih dahulu.')
  await writeClaudeVerification(loginState(), loginId, code)
  return { submitted: true }
}
