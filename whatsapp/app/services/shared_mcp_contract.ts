import { timingSafeEqual, randomBytes } from 'node:crypto'
import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthTokens,
  OAuthClientInformationMixed,
} from '@modelcontextprotocol/sdk/shared/auth.js'

export type SharedMcpState = {
  url: string
  redirect: string
  client?: OAuthClientInformationMixed
  tokens?: OAuthTokens
  expiresAt?: number
  discovery?: OAuthDiscoveryState
  pending?: {
    id: string
    state: string
    binding: string
    expiresAt: number
    verifier?: string
    authorizationUrl?: string
  }
}

export function beginSharedLogin(url: string, redirect: string, binding: string): SharedMcpState {
  if (!binding) throw new Error('Sesi login MCP tidak valid.')
  return {
    url,
    redirect,
    pending: {
      id: randomBytes(24).toString('hex'),
      state: randomBytes(32).toString('base64url'),
      binding,
      expiresAt: Date.now() + 600_000,
    },
  }
}

function equal(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

export function validateSharedCallback(
  data: SharedMcpState,
  id: string,
  binding: string,
  query: URLSearchParams
) {
  const pending = data.pending
  if (
    !pending ||
    pending.expiresAt <= Date.now() ||
    !equal(pending.id, id) ||
    !equal(pending.binding, binding) ||
    query.getAll('state').length !== 1 ||
    !equal(pending.state, query.get('state') || '')
  )
    throw new Error('Sesi login MCP berakhir. Mulai ulang login.')
  const metadata = data.discovery?.authorizationServerMetadata
  const issuer = query.get('iss')
  if (
    query.getAll('iss').length > 1 ||
    (issuer && issuer !== metadata?.issuer) ||
    (metadata &&
      'authorization_response_iss_parameter_supported' in metadata &&
      metadata.authorization_response_iss_parameter_supported &&
      !issuer)
  )
    throw new Error('Issuer MCP tidak cocok.')
  if (query.has('error')) return { denied: true, code: '' }
  const code = query.get('code') || ''
  if (query.getAll('code').length !== 1 || !code || code.length > 4096 || !pending.verifier)
    throw new Error('Callback MCP tidak valid.')
  return { denied: false, code }
}

export class SharedMcpProvider implements OAuthClientProvider {
  constructor(
    public data: SharedMcpState,
    private interactive: boolean
  ) {}
  get redirectUrl() {
    return this.data.redirect
  }
  get clientMetadata() {
    return {
      client_name: 'WhatsApp Workspace',
      redirect_uris: [this.data.redirect],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }
  state() {
    return this.data.pending?.state || ''
  }
  clientInformation() {
    return this.data.client
  }
  saveClientInformation(client: OAuthClientInformationMixed) {
    this.data.client = client
  }
  tokens() {
    return this.data.tokens
  }
  saveTokens(tokens: OAuthTokens) {
    if (
      !/^Bearer$/i.test(tokens.token_type) ||
      !tokens.access_token ||
      /[\r\n]/.test(tokens.access_token)
    )
      throw new Error('Token MCP tidak valid.')
    this.data.tokens = {
      ...tokens,
      refresh_token: tokens.refresh_token || this.data.tokens?.refresh_token,
    }
    this.data.expiresAt = Date.now() + Math.max(0, tokens.expires_in ?? 300) * 1000
  }
  redirectToAuthorization(url: URL) {
    if (!this.interactive || !this.data.pending)
      throw new Error('Hubungkan ulang MCP dari pengaturan.')
    if (
      url.protocol !== 'https:' &&
      !(
        url.origin === new URL(this.data.url).origin &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    )
      throw new Error('URL authorize MCP tidak aman.')
    this.data.pending.authorizationUrl = url.href
  }
  saveCodeVerifier(verifier: string) {
    if (this.data.pending) this.data.pending.verifier = verifier
  }
  codeVerifier() {
    if (!this.data.pending?.verifier) throw new Error('PKCE tidak tersedia.')
    return this.data.pending.verifier
  }
  discoveryState() {
    return this.data.discovery
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.data.discovery = state
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') {
      delete this.data.tokens
      delete this.data.expiresAt
    }
    if (scope === 'all' || scope === 'client') delete this.data.client
    if (scope === 'all' || scope === 'discovery') delete this.data.discovery
    if (scope === 'verifier' && this.data.pending) delete this.data.pending.verifier
  }
}

export async function refreshSharedToken(data: SharedMcpState, fetchFn: typeof fetch) {
  if (data.tokens && (data.expiresAt || 0) > Date.now() + 120_000) return data.tokens.access_token
  if (!data.tokens?.refresh_token) throw new Error('Hubungkan ulang MCP dari pengaturan.')
  const result = await auth(new SharedMcpProvider(data, false), { serverUrl: data.url, fetchFn })
  if (result !== 'AUTHORIZED' || !data.tokens?.access_token)
    throw new Error('Hubungkan ulang MCP dari pengaturan.')
  return data.tokens.access_token
}

export function sharedMcpConnected(row: Record<string, any>, provider: string) {
  return Boolean(
    row.shared_authenticated ||
    (provider === 'claude'
      ? row.claude_authenticated
      : (row.chatgpt_authenticated ?? row.oauth_authenticated))
  )
}
