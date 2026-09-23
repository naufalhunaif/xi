import { lookup } from 'node:dns/promises'
import { BlockList } from 'node:net'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'

const blocked = new BlockList()
for (const [ip, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv4')
// BlockList also applies IPv4 rules to IPv4-mapped IPv6; blocking ::ffff/96 would block every IPv4 host.
for (const [ip, prefix] of [
  ['::', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  blocked.addSubnet(ip, prefix, 'ipv6')

// Pin the checked DNS address to the actual request (not check-then-fetch).
async function oauthRequest(
  url: URL,
  init: RequestInit,
  configured: URL,
  maxBytes = 1_048_576,
  timeoutMs = 12_000
): Promise<Response> {
  const local =
    ['localhost', '127.0.0.1', '[::1]'].includes(configured.hostname) &&
    configured.origin === url.origin
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  )
    throw new Error('URL OAuth MCP tidak aman.')
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true })
  if (
    !addresses.length ||
    (!local &&
      addresses.some(({ address, family }) =>
        blocked.check(address, family === 6 ? 'ipv6' : 'ipv4')
      ))
  )
    throw new Error('Alamat OAuth MCP tidak diizinkan.')
  const address = addresses[0]
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: init.method || 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        family: address.family,
        signal: AbortSignal.any([
          AbortSignal.timeout(timeoutMs),
          ...(init.signal ? [init.signal] : []),
        ]),
        lookup: (_host, _options, callback) => callback(null, address.address, address.family),
      },
      (res) => {
        const headers = new Headers()
        for (const [key, value] of Object.entries(res.headers))
          if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        const status = res.statusCode || 502
        if ([204, 205, 304].includes(status)) {
          res.resume()
          resolve(new Response(null, { status, headers }))
          return
        }
        let closed = false
        let size = 0
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              if (closed) return
              size += chunk.length
              if (size > maxBytes) {
                closed = true
                controller.error(new Error('Respons OAuth MCP terlalu besar.'))
                res.destroy()
                return
              }
              controller.enqueue(chunk)
            })
            res.on('end', () => {
              if (!closed) {
                closed = true
                controller.close()
              }
            })
            res.on('error', (error) => {
              if (!closed) {
                closed = true
                controller.error(error)
              }
            })
          },
          cancel() {
            closed = true
            res.destroy()
          },
        })
        resolve(new Response(body, { status, headers }))
      }
    )
    req.on('error', reject)
    if (init.body) req.write(String(init.body))
    req.end()
  })
}

/** Media uses the same DNS-pinned public-address checks, no redirects or OAuth credentials. */
export function mcpMediaFetch(configured: string): typeof fetch {
  return (input) =>
    oauthRequest(
      new URL(input instanceof Request ? input.url : String(input)),
      { method: 'GET', headers: { Accept: 'image/*, video/mp4, application/pdf' } },
      new URL(configured),
      16 * 1024 * 1024
    )
}

/** Business tool results can exceed OAuth metadata size; keep the same DNS/redirect protections. */
export function mcpBusinessFetch(server: string): typeof fetch {
  return mcpOAuthFetch(server, (url, init, configured) =>
    oauthRequest(url, init, configured, 16 * 1024 * 1024, 30_000)
  )
}

/** Only Fit's metadata gets the CI3 front-controller fallback; never rewrite issuer, tokens, or MCP audience. */
export function fitMetadataFallback(requested: URL, configured: URL) {
  const base = configured.pathname.match(/^(.*\/fit)\/mcp\/?$/)?.[1]
  if (!base || requested.origin !== configured.origin || requested.search) return null
  let path = requested.pathname
  if (path === `/.well-known/oauth-authorization-server${base}`)
    path = `${base}/.well-known/oauth-authorization-server`
  if (path === `/.well-known/openid-configuration${base}`)
    path = `${base}/.well-known/openid-configuration`
  if (path === `/.well-known/oauth-protected-resource${base}/mcp`)
    path = `${base}/.well-known/oauth-protected-resource/mcp`
  if (
    ![
      `${base}/.well-known/oauth-protected-resource`,
      `${base}/.well-known/oauth-protected-resource/mcp`,
      `${base}/.well-known/oauth-authorization-server`,
      `${base}/.well-known/openid-configuration`,
    ].includes(path)
  )
    return null
  return new URL(path.replace(`${base}/`, `${base}/index.php/`), configured.origin)
}

export function mcpOAuthFetch(server: string, request = oauthRequest): typeof fetch {
  const configured = new URL(server)
  const deadline = AbortSignal.timeout(30_000)
  return async (input, init = {}) => {
    init = { ...init, signal: AbortSignal.any([deadline, ...(init.signal ? [init.signal] : [])]) }
    let url = new URL(input instanceof Request ? input.url : String(input))
    for (let count = 0; count < 4; count++) {
      let response = await request(url, init, configured)
      const fallback =
        (init.method || 'GET') === 'GET' && response.status === 404
          ? fitMetadataFallback(url, configured)
          : null
      if (fallback) {
        await response.body?.cancel()
        response = await request(fallback, init, configured)
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      // Never redirect credential-bearing POST requests or authorization headers.
      if ((init.method || 'GET') !== 'GET' || new Headers(init.headers).has('Authorization')) {
        await response.body?.cancel()
        throw new Error('Redirect OAuth MCP ditolak.')
      }
      const location = response.headers.get('location')
      if (!location) return response
      await response.body?.cancel()
      url = new URL(location, url)
    }
    throw new Error('Redirect OAuth MCP berulang.')
  }
}
