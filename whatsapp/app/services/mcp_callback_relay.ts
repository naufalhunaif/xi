import { get } from 'node:http'
import { stripVTControlCharacters } from 'node:util'

export function mcpAuthorizationUrl(output: string) {
  for (const value of stripVTControlCharacters(output).match(/https?:\/\/[^\s]+/g) || []) {
    try {
      const url = new URL(value.replace(/[),.;]+$/, ''))
      if (url.searchParams.has('state') && url.searchParams.has('redirect_uri')) return url.href
    } catch {
      /* Ignore incomplete output while the CLI is still writing. */
    }
  }
  return ''
}

function loopbackCallback(authorizationUrl: string) {
  const auth = new URL(authorizationUrl)
  if (
    auth.searchParams.getAll('redirect_uri').length !== 1 ||
    auth.searchParams.getAll('state').length !== 1
  )
    throw new Error('Sesi login MCP tidak valid. Mulai ulang login.')
  const state = auth.searchParams.get('state') || ''
  const callback = new URL(auth.searchParams.get('redirect_uri') || '')
  if (
    state.length < 16 ||
    state.length > 512 ||
    callback.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(callback.hostname) ||
    Number(callback.port) < 1024 ||
    Number(callback.port) > 65535 ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    !/^\/callback(?:\/[A-Za-z0-9_-]+)?$/.test(callback.pathname)
  ) {
    throw new Error('Callback MCP ini tidak mendukung verifikasi web.')
  }
  return { callback, state }
}

export function supportsMcpCallbackRelay(authorizationUrl: string) {
  try {
    loopbackCallback(authorizationUrl)
    return true
  } catch {
    return false
  }
}

export function validatedMcpCallback(authorizationUrl: string, value: unknown) {
  if (
    typeof value !== 'string' ||
    value.length > 8192 ||
    /[\r\n]/.test(value) ||
    value.includes('\0')
  )
    throw new Error('Tempel URL callback lengkap dari bilah alamat browser.')
  let submitted: URL
  try {
    submitted = new URL(value.trim())
  } catch {
    throw new Error('Tempel URL callback lengkap dari bilah alamat browser.')
  }
  const { callback, state } = loopbackCallback(authorizationUrl)
  if (
    submitted.origin !== callback.origin ||
    submitted.pathname !== callback.pathname ||
    submitted.username ||
    submitted.password ||
    submitted.hash ||
    submitted.searchParams.getAll('state').length !== 1 ||
    submitted.searchParams.get('state') !== state ||
    submitted.searchParams.getAll('code').length !== 1 ||
    submitted.searchParams.getAll('iss').length > 1 ||
    submitted.searchParams.has('error')
  ) {
    throw new Error('URL callback bukan dari sesi login MCP ini. Gunakan tautan login terbaru.')
  }
  const code = submitted.searchParams.get('code') || ''
  if (!code || code.length > 4096 || /[\r\n]/.test(code) || code.includes('\0'))
    throw new Error('Kode pada URL callback tidak valid.')
  // The destination always comes from the running CLI, never from submitted input.
  const target = new URL(callback)
  if (target.hostname === 'localhost') target.hostname = '127.0.0.1'
  for (const name of ['code', 'state', 'iss']) {
    const item = submitted.searchParams.get(name)
    if (item !== null) target.searchParams.set(name, item)
  }
  return target
}

export type CallbackSession = {
  id: string
  expiresAt: number
  canceled?: boolean
  callbackSubmitted: boolean
  child?: { killed: boolean; exitCode: number | null }
}

export function codexPublicCallback(
  appUrl: string,
  loginId: string,
  port: number,
  webPort: number
) {
  const base = new URL(appUrl)
  if (
    base.protocol !== 'https:' ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !/^[a-f0-9-]{36}$/.test(loginId) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    port === webPort
  ) {
    throw new Error('Konfigurasi callback MCP tidak valid.')
  }
  return { url: `${base.href.replace(/\/$/, '')}/oauth/mcp/callback/${loginId}`, port }
}

export function codexPublicCallbackArguments(
  name: string,
  callback: { url: string; port: number }
) {
  // Override the whole OAuth table so a saved local callback/client ID cannot take precedence.
  return [
    '-c',
    `mcp_oauth_callback_url=${JSON.stringify(callback.url)}`,
    '-c',
    `mcp_oauth_callback_port=${callback.port}`,
    '-c',
    `mcp_servers.${name}.oauth={callback_url=${JSON.stringify(callback.url)},callback_port=${callback.port}}`,
  ]
}

export function isPublicMcpAuthorization(authorizationUrl: string, publicCallbackUrl: string) {
  try {
    const auth = new URL(authorizationUrl)
    if (auth.searchParams.getAll('redirect_uri').length !== 1) return false
    const redirect = auth.searchParams.get('redirect_uri') || ''
    if (redirect === publicCallbackUrl) return true
    return (
      redirect.startsWith(publicCallbackUrl + '/') &&
      /^[A-Za-z0-9_-]{1,128}$/.test(redirect.slice(publicCallbackUrl.length + 1))
    )
  } catch {
    return false
  }
}

export type PublicCallbackSession = CallbackSession & {
  publicCallbackUrl: string
  listenerPort: number
  browserBinding: string
}

/** Preserve the CLI-registered redirect URI; only the network destination is local. */
export function claimPublicMcpCallback(
  session: PublicCallbackSession | undefined,
  loginId: string,
  browserBinding: unknown,
  authorizationUrl: string,
  callbackId: string | undefined,
  query: string
) {
  assertLiveSession(session, loginId)
  if (
    !session ||
    typeof browserBinding !== 'string' ||
    !browserBinding ||
    session.browserBinding !== browserBinding
  )
    throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
  if (session.callbackSubmitted) throw new Error('Callback MCP sedang diverifikasi.')
  const auth = new URL(authorizationUrl)
  const callback = new URL(auth.searchParams.get('redirect_uri') || '')
  const expected = session.publicCallbackUrl + (callbackId ? `/${callbackId}` : '')
  if (
    query.length > 8192 ||
    (callbackId && !/^[A-Za-z0-9_-]{1,128}$/.test(callbackId)) ||
    callback.href !== expected ||
    auth.searchParams.getAll('redirect_uri').length !== 1 ||
    auth.searchParams.getAll('state').length !== 1 ||
    !auth.searchParams.get('state')
  ) {
    throw new Error('Sesi login MCP tidak valid. Mulai ulang login.')
  }
  const params = new URLSearchParams(query)
  const code = params.get('code')
  const denied = params.get('error') === 'access_denied'
  if (
    params.getAll('state').length !== 1 ||
    params.get('state') !== auth.searchParams.get('state') ||
    params.getAll('iss').length > 1 ||
    (denied
      ? params.has('code') || params.getAll('error').length !== 1
      : params.has('error') ||
        params.getAll('code').length !== 1 ||
        !code ||
        code.length > 4096 ||
        /[\r\n]/.test(code) ||
        code.includes('\0'))
  ) {
    throw new Error('URL callback bukan dari sesi login MCP ini. Gunakan tautan login terbaru.')
  }
  if (
    !Number.isInteger(session.listenerPort) ||
    session.listenerPort < 1024 ||
    session.listenerPort > 65535
  )
    throw new Error('Konfigurasi callback MCP tidak valid.')
  const target = new URL(`http://127.0.0.1:${session.listenerPort}${callback.pathname}`)
  for (const name of ['code', 'state', 'iss', 'error']) {
    const value = params.get(name)
    if (value !== null) target.searchParams.set(name, value)
  }
  session.callbackSubmitted = true
  return { target, denied }
}

function assertLiveSession(session: CallbackSession | undefined, loginId: unknown) {
  if (
    !session ||
    session.canceled ||
    session.id !== loginId ||
    session.expiresAt <= Date.now() ||
    !session.child ||
    session.child.killed ||
    session.child.exitCode !== null
  ) {
    throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
  }
}

/** Claim once, before any asynchronous I/O. The caller selects the workspace/provider session. */
export function claimMcpCallback(
  session: CallbackSession | undefined,
  loginId: unknown,
  authorizationUrl: string,
  value: unknown
) {
  assertLiveSession(session, loginId)
  if (!session) throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
  if (session.callbackSubmitted) throw new Error('Callback MCP sedang diverifikasi.')
  const target = validatedMcpCallback(authorizationUrl, value)
  session.callbackSubmitted = true
  return target
}

/** No proxy, DNS to arbitrary hosts, redirects, cookies, or returned provider HTML. */
export async function sendMcpCallback(target: URL) {
  await new Promise<void>((resolve, reject) => {
    const request = get(
      target,
      { agent: false, maxHeaderSize: 8192, headers: { connection: 'close' } },
      (response) => {
        response.resume()
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy()
          reject(new Error('Callback MCP belum diterima. Periksa status atau mulai ulang login.'))
          return
        }
        response.on('end', resolve)
        response.on('error', () =>
          reject(new Error('Callback MCP belum diterima. Periksa status atau mulai ulang login.'))
        )
      }
    )
    const deadline = setTimeout(() => request.destroy(new Error('timeout')), 5000)
    request.on('close', () => clearTimeout(deadline))
    request.setTimeout(5000, () => request.destroy(new Error('timeout')))
    request.on('error', () =>
      reject(new Error('Callback MCP belum diterima. Periksa status atau mulai ulang login.'))
    )
  })
}
