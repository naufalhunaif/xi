import encryption from '@adonisjs/core/services/encryption'
import { auth, extractWWWAuthenticateParams } from '@modelcontextprotocol/sdk/client/auth.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import db from '#services/workspace_database'
import env from '#start/env'
import { workspaceScope } from '#services/workspace_context'
import {
  beginSharedLogin,
  validateSharedCallback,
  refreshSharedToken,
  SharedMcpProvider,
  type SharedMcpState,
} from '#services/shared_mcp_contract'
import { mcpOAuthFetch } from '#services/mcp_oauth_fetch'

const LOGIN_ERROR =
  'Login MCP belum berhasil. Periksa URL dan discovery MCP, lalu mulai ulang login.'
const EXPIRED_ERROR = 'Hubungkan ulang MCP dari pengaturan.'
const TRANSIENT_ERROR = 'Koneksi MCP sementara tidak tersedia. Coba lagi.'
function purpose(row: Record<string, any>) {
  return `mcp:${workspaceScope().id}:${row.slug}:${row.url}`
}
export function readSharedMcpState(row: Record<string, any>) {
  if (!row.shared_oauth) return undefined
  const data = encryption.decrypt<SharedMcpState>(String(row.shared_oauth), purpose(row))
  return data && data.url === row.url ? data : undefined
}
export function sharedPending(row: Record<string, any>) {
  const pending = readSharedMcpState(row)?.pending
  return pending && pending.expiresAt > Date.now() ? pending : undefined
}

// Row locks also serialize token rotation between WEB and WORKER, not just one process.
async function locked<T>(
  slug: string,
  action: (
    row: any,
    data: SharedMcpState | undefined
  ) => Promise<{
    value: T
    data?: SharedMcpState
    connected?: boolean
    enabled?: boolean
    error?: string
  }>
) {
  if (!workspaceScope().id || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))
    throw new Error('Sumber data tidak valid.')
  return db.transaction(async (trx) => {
    const row = await trx.from('whatsapp_mcp_connections').where('slug', slug).forUpdate().first()
    if (!row) throw new Error('Sumber data tidak valid.')
    const result = await action(row, readSharedMcpState(row))
    await trx
      .from('whatsapp_mcp_connections')
      .where('id', row.id)
      .update({
        ...(result.data
          ? { shared_oauth: encryption.encrypt(result.data, undefined, purpose(row)) }
          : {}),
        ...(result.connected === undefined ? {} : { shared_authenticated: result.connected }),
        ...(result.enabled === undefined ? {} : { enabled: result.enabled }),
        last_error: result.error || null,
        updated_at: new Date(),
      })
    return result.value
  })
}

export async function startSharedMcpLogin(slug: string, binding: string, restart: boolean) {
  const error = await locked(slug, async (row, previous) => {
    if (previous?.pending && previous.pending.expiresAt > Date.now() && !restart)
      return { value: '' }
    if (row.shared_authenticated && previous?.tokens && !restart) return { value: '' }
    const redirect = `${env.get('APP_URL').replace(/\/$/, '')}/oauth/mcp/callback/shared/${encodeURIComponent(slug)}`
    const data = beginSharedLogin(String(row.url), redirect, binding)
    // Stable callback permits reusing the registered client, without sharing CLI credentials.
    if (previous?.redirect === redirect) {
      data.client = previous.client
      data.discovery = previous.discovery
    }
    try {
      const fetchFn = mcpOAuthFetch(data.url)
      const probe = await fetchFn(data.url, {
        headers: { Accept: 'application/json, text/event-stream' },
      })
      const challenge = extractWWWAuthenticateParams(probe)
      await probe.body?.cancel()
      const result = await auth(new SharedMcpProvider(data, true), {
        serverUrl: data.url,
        fetchFn,
        ...challenge,
      })
      if (result !== 'REDIRECT' || !data.pending?.authorizationUrl)
        throw new Error('Missing authorization URL')
      return { value: '', data, connected: false, enabled: true }
    } catch {
      // OAuth SDK errors can contain response bodies/codes: never persist or return those.
      return { value: LOGIN_ERROR, error: LOGIN_ERROR }
    }
  })
  if (error) throw new Error(error)
}

export async function completeSharedMcpLogin(
  slug: string,
  binding: string,
  query: URLSearchParams
) {
  return locked(slug, async (_row, data) => {
    if (!data?.pending) throw new Error('Sesi login MCP berakhir.')
    const callback = validateSharedCallback(data, data.pending.id, binding, query)
    if (callback.denied) {
      delete data.pending
      return { value: 'denied', data, connected: false }
    }
    try {
      const fetchFn = mcpOAuthFetch(data.url)
      const result = await auth(new SharedMcpProvider(data, false), {
        serverUrl: data.url,
        authorizationCode: callback.code,
        fetchFn,
      })
      if (result !== 'AUTHORIZED' || !data.tokens) throw new Error('Missing token')
      // Confirm actual MCP access, not just a successful token exchange. No tools are executed.
      const client = new Client({ name: 'whatsapp-workspace', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(data.url), {
            requestInit: { headers: { Authorization: `Bearer ${data.tokens.access_token}` } },
            fetch: fetchFn,
          }),
          { timeout: 15_000 }
        )
        await client.listTools({}, { timeout: 15_000 })
      } finally {
        await client.close().catch(() => {})
      }
      delete data.pending
      return { value: 'complete', data, connected: true }
    } catch {
      // Consume even a failed exchange; replaying a one-time code is not safe.
      delete data.pending
      return { value: 'failed', data, connected: false, error: LOGIN_ERROR }
    }
  })
}

export async function sharedMcpToken(slug: string, url: string) {
  const result = await locked<{ token?: string; error?: string }>(slug, async (row, data) => {
    if (!row.enabled || row.url !== url) throw new Error('Sumber data tidak aktif.')
    if (!row.shared_oauth) return { value: { token: '' } } // existing CLI login only
    if (!row.shared_authenticated && data?.pending) return { value: { token: '' } }
    if (!row.shared_authenticated || !data?.tokens) return { value: { error: EXPIRED_ERROR } }
    try {
      return {
        value: { token: await refreshSharedToken(data, mcpOAuthFetch(data.url)) },
        data,
        connected: true,
      }
    } catch {
      // Keep refresh tokens for transient network failure, and never claim disconnected on a timeout.
      const stillAuthorized = Boolean(data.tokens?.refresh_token)
      const error = stillAuthorized ? TRANSIENT_ERROR : EXPIRED_ERROR
      return {
        value: { error },
        data,
        error,
        connected: stillAuthorized,
      }
    }
  })
  if (result.error) throw new Error(result.error)
  return result.token || ''
}
