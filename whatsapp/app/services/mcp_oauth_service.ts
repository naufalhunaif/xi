import { spawn } from 'node:child_process'
import db from '#services/workspace_database'
import { ensureDefaults } from '#services/settings_service'
import { workspaceScope } from '#services/workspace_context'
import { sharedMcpConnected } from '#services/shared_mcp_contract'
import { sharedPending } from '#services/shared_mcp_oauth_service'
import {
  mcpAuthorizationUrl,
  supportsMcpCallbackRelay,
  claimMcpCallback,
  sendMcpCallback,
  claimPublicMcpCallback,
  isPublicMcpAuthorization,
} from '#services/mcp_callback_relay'
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
function cleanOutput(value: string) {
  const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
  return value.replace(ansiColor, '').trim()
}
function loginUrl(login?: LoginProcess) {
  const output = cleanOutput(`${login?.output || ''}\n${login?.error || ''}`)
  return mcpAuthorizationUrl(output)
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
