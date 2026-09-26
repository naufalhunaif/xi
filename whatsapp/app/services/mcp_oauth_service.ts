import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import db from '#services/workspace_database'
import env from '#start/env'
import { claudeBinary, claudeOAuthEnv } from '#services/claude_oauth_service'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { workspaceScope } from '#services/workspace_context'
import { codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { randomUUID } from 'node:crypto'
import { sharedMcpConnected } from '#services/shared_mcp_contract'
import { sharedPending } from '#services/shared_mcp_oauth_service'
import {
  mcpAuthorizationUrl,
  supportsMcpCallbackRelay,
  claimMcpCallback,
  sendMcpCallback,
  codexPublicCallback,
  codexPublicCallbackArguments,
  claimPublicMcpCallback,
  isPublicMcpAuthorization,
} from '#services/mcp_callback_relay'
const execFileAsync = promisify(execFile)
type AiProvider = 'chatgpt' | 'claude'
type LoginProcess = {
  output: string
  error: string
  child?: ReturnType<typeof spawn>
  canceled?: boolean
  id: string
  expiresAt: number
  callbackSubmitted: boolean
  publicCallback?: { url: string; port: number }
  browserBinding?: string
  finished?: Promise<boolean>
}
const logins = new Map<string, LoginProcess>()
async function codexBinary() {
  const settings = await readSettings()
  return settings.codexBin || env.get('CODEX_BIN') || 'codex'
}
function serverName(slug: string) {
  return `business_${slug}`
}
function configArguments(slug: string, url: string) {
  const name = serverName(slug)
  return [
    '-c',
    `mcp_servers.${name}.url=${JSON.stringify(url)}`,
    '-c',
    `mcp_servers.${name}.enabled=true`,
  ]
}
function cleanOutput(value: string) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  return value.replace(ansiColor, '').trim()
}
function loginUrl(login?: LoginProcess) {
  const output = cleanOutput(`${login?.output || ''}\n${login?.error || ''}`)
  return mcpAuthorizationUrl(output)
}
async function connection(slug: string) {
  await ensureDefaults()
  return db.from('whatsapp_mcp_connections').where('slug', slug).first()
}
function loginKey(provider: AiProvider, slug: string) {
  return `${workspaceScope().prefix}:${provider}:${slug}`
}
export async function mcpOAuthState(provider: AiProvider = 'chatgpt') {
  await ensureDefaults()
  const rows = await db.from('whatsapp_mcp_connections').orderBy('id', 'asc')
  return {
    provider,
    connections: rows.map((row) => {
      const login = row.shared_oauth ? undefined : logins.get(loginKey(provider, String(row.slug)))
      const authorizationUrl = loginUrl(login)
      const wrongCallback = Boolean(
        login?.publicCallback &&
        authorizationUrl &&
        !isPublicMcpAuthorization(authorizationUrl, login.publicCallback.url)
      )
      const authenticated = sharedMcpConnected(row, provider)
      const pending = sharedPending(row)
      return {
        slug: String(row.slug),
        name: String(row.name),
        url: String(row.url),
        enabled: Boolean(row.enabled),
        authenticated: pending ? false : authenticated,
        sharedAuthenticated: Boolean(row.shared_authenticated),
        chatgptAuthenticated: Boolean(row.chatgpt_authenticated ?? row.oauth_authenticated),
        claudeAuthenticated: Boolean(row.claude_authenticated),
        pending: Boolean(pending || login),
        verificationUrl: pending?.authorizationUrl || (wrongCallback ? '' : authorizationUrl),
        loginId: pending?.id || login?.id || '',
        manualCallback: !login?.publicCallback && supportsMcpCallbackRelay(loginUrl(login)),
        publicCallback: Boolean(pending || login?.publicCallback),
        callbackSubmitted: Boolean(login?.callbackSubmitted),
        error: wrongCallback
          ? 'CLI belum menggunakan callback publik. Perbarui CLI dan mulai ulang login.'
          : login
            ? ''
            : String(row.last_error || ''),
      }
    }),
  }
}
export async function startMcpOAuthLogin(
  slug: string,
  provider: AiProvider = 'chatgpt',
  restart = false,
  browserBinding = ''
) {
  if (!workspaceScope().id) throw new Error('Hubungkan nomor terlebih dahulu.')
  const row = await connection(slug)
  if (!row) throw new Error('Sumber data tidak valid.')
  const key = loginKey(provider, slug)
  if (restart) {
    const previous = logins.get(key)
    cancelMcpOAuthLogin(slug, provider)
    if (previous?.finished) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          previous.finished,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('Selesaikan login MCP yang sedang berjalan terlebih dahulu.')),
              3000
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }
  }
  if (logins.has(key)) return mcpOAuthState(provider)
  const authColumn = provider === 'claude' ? 'claude_authenticated' : 'chatgpt_authenticated'
  const login: LoginProcess = {
    output: '',
    error: '',
    id: randomUUID(),
    expiresAt: Date.now() + 600_000,
    callbackSubmitted: false,
    browserBinding,
  }
  if (provider === 'chatgpt' && new URL(env.get('APP_URL')).protocol === 'https:') {
    if (!browserBinding) throw new Error('Sesi login MCP tidak valid. Mulai ulang login.')
    if ([...logins.values()].some((entry) => entry.publicCallback))
      throw new Error('Selesaikan login MCP yang sedang berjalan terlebih dahulu.')
    login.publicCallback = codexPublicCallback(
      env.get('APP_URL'),
      login.id,
      env.get('MCP_OAUTH_CALLBACK_PORT') ?? 3334,
      env.get('PORT')
    )
  }
  // Reserve before asynchronous configuration/spawn so two requests cannot claim the same listener.
  logins.set(key, login)
  try {
    await db
      .from('whatsapp_mcp_connections')
      .where('slug', slug)
      .update({
        enabled: true,
        [authColumn]: false,
        ...(provider === 'chatgpt' ? { oauth_authenticated: false } : {}),
        last_error: null,
        updated_at: new Date(),
      })
    let executable: string
    let args: string[]
    let childEnv: NodeJS.ProcessEnv
    if (provider === 'claude') {
      executable = await claudeBinary()
      childEnv = claudeOAuthEnv()
      try {
        await execFileAsync(
          executable,
          [
            'mcp',
            'add',
            '--transport',
            'http',
            '--scope',
            'local',
            serverName(slug),
            String(row.url),
          ],
          { cwd: process.cwd(), env: childEnv, timeout: 15_000, maxBuffer: 20_000 }
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (!/already exists/i.test(message)) throw error
      }
      args = ['mcp', 'login', serverName(slug)]
    } else {
      executable = await codexBinary()
      childEnv = codexOAuthEnv()
      args = [
        ...codexOAuthArguments(),
        'mcp',
        'login',
        serverName(slug),
        ...configArguments(slug, String(row.url)),
        ...(login.publicCallback
          ? codexPublicCallbackArguments(serverName(slug), login.publicCallback)
          : []),
        '--oauth-client-registration',
        'dcr',
      ]
    }
    if (login.canceled || logins.get(key) !== login)
      throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
    const child = spawn(executable, args, {
      cwd: process.cwd(),
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 600_000,
    })
    login.child = child
    logins.set(key, login)
    child.stdout.on('data', (chunk) => {
      login.output = `${login.output}${String(chunk)}`.slice(-20_000)
    })
    child.stderr.on('data', (chunk) => {
      login.error = `${login.error}${String(chunk)}`.slice(-20_000)
    })
    let resolveFinished: (success: boolean) => void = () => {}
    login.finished = new Promise<boolean>((resolve) => {
      resolveFinished = resolve
    })
    let finishing = false
    const finish = async (success: boolean) => {
      if (finishing) return
      finishing = true
      try {
        if (login.canceled || logins.get(key) !== login) {
          success = false
          return
        }
        await db
          .from('whatsapp_mcp_connections')
          .where('slug', slug)
          .update({
            [authColumn]: success,
            ...(provider === 'chatgpt' ? { oauth_authenticated: success } : {}),
            last_error: success ? null : 'Login MCP belum berhasil. Mulai ulang login.',
            updated_at: new Date(),
          })
      } catch {
        success = false
      } finally {
        if (logins.get(key) === login) logins.delete(key)
        login.output = ''
        login.error = ''
        resolveFinished(success)
      }
    }
    child.on('error', () => {
      void finish(false)
    })
    child.on('close', (code) => {
      void finish(code === 0)
    })
    await new Promise((resolve) => setTimeout(resolve, 350))
    return mcpOAuthState(provider)
  } catch (error) {
    login.canceled = true
    login.child?.kill('SIGTERM')
    if ((!login.child || login.child.exitCode !== null) && logins.get(key) === login)
      logins.delete(key)
    throw error
  }
}
export function cancelMcpOAuthLogin(slug: string, selectedProvider?: AiProvider) {
  for (const provider of selectedProvider ? [selectedProvider] : (['chatgpt', 'claude'] as const)) {
    const key = loginKey(provider, slug)
    const login = logins.get(key)
    if (!login) continue
    login.canceled = true
    login.child?.kill('SIGTERM')
    // Retain the listener reservation until the process actually exits.
    if (!login.child || login.child.exitCode !== null) logins.delete(key)
  }
}

export async function verifyMcpOAuthCallback(
  slug: string,
  provider: AiProvider,
  loginId: unknown,
  callbackUrl: unknown
) {
  if (!workspaceScope().id) throw new Error('Hubungkan nomor terlebih dahulu.')
  const login = logins.get(loginKey(provider, slug))
  const target = claimMcpCallback(login, loginId, loginUrl(login), callbackUrl)
  try {
    await sendMcpCallback(target)
    return { submitted: true }
  } catch {
    // Do not replay automatically: the CLI might already have consumed the code.
    throw new Error('Callback MCP belum diterima. Periksa status atau mulai ulang login.')
  }
}

export async function completePublicMcpOAuth(
  loginId: string,
  browserBinding: unknown,
  callbackId: string | undefined,
  query: string
) {
  const prefix = `${workspaceScope().prefix}:chatgpt:`
  const login = [...logins.entries()].find(
    ([key, value]) => key.startsWith(prefix) && value.id === loginId
  )?.[1]
  if (!workspaceScope().id || !login?.publicCallback)
    throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
  const { target, denied } = claimPublicMcpCallback(
    {
      ...login,
      publicCallbackUrl: login.publicCallback.url,
      listenerPort: login.publicCallback.port,
      browserBinding: login.browserBinding || '',
    },
    loginId,
    browserBinding,
    loginUrl(login),
    callbackId,
    query
  )
  // claimPublicMcpCallback receives a projection; claim the original before the first await too.
  login.callbackSubmitted = true
  await sendMcpCallback(target)
  if (denied) return 'denied'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const success = await Promise.race([
      login.finished,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 6000)
      }),
    ])
    return success === true ? 'complete' : success === false ? 'failed' : 'pending'
  } finally {
    clearTimeout(timer)
  }
}
