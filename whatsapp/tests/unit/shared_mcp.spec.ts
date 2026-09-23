import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import {
  beginSharedLogin,
  SharedMcpProvider,
  validateSharedCallback,
  refreshSharedToken,
  sharedMcpConnected,
} from '#services/shared_mcp_contract'
import { mcpOAuthFetch, fitMetadataFallback } from '#services/mcp_oauth_fetch'
import {
  claudeMcpConnection,
  mcpTokenEnvironment,
  mcpTokenVariable,
} from '#services/mcp_runtime_auth'

const resource = 'https://business.example/fit/mcp'
const issuer = 'https://business.example/fit'
const redirect = 'https://workspace.example/whatsapp/oauth/mcp/callback/shared/fit'
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth/authorize`,
  token_endpoint: `${issuer}/oauth/token`,
  registration_endpoint: `${issuer}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['none'],
  code_challenge_methods_supported: ['S256'],
  authorization_response_iss_parameter_supported: true,
}

test('shared OAuth: Fit 404 fallback, PKCE consent, restart-safe callback, tokens refresh for either AI', async ({
  assert,
}) => {
  const requests: Array<{ url: string; body: URLSearchParams }> = []
  let tokenCount = 0
  const fetchFn = mcpOAuthFetch(resource, async (url, options) => {
    const body = new URLSearchParams(String(options.body || ''))
    requests.push({ url: url.href, body })
    if (url.pathname.includes('.well-known/') && !url.pathname.includes('/index.php/'))
      return new Response('', { status: 404 })
    if (url.pathname.includes('oauth-protected-resource'))
      return Response.json({
        resource,
        authorization_servers: [issuer],
        scopes_supported: ['mcp:tools'],
      })
    if (url.pathname.includes('oauth-authorization-server')) return Response.json(metadata)
    if (url.pathname.endsWith('/register')) {
      assert.deepEqual(JSON.parse(String(options.body)).redirect_uris, [redirect])
      return Response.json(
        { client_id: 'test-shared-client', ...JSON.parse(String(options.body)) },
        { status: 201 }
      )
    }
    if (url.pathname.endsWith('/token')) {
      assert.equal(body.get('resource'), resource)
      tokenCount++
      return Response.json({
        access_token: `fixture-access-${tokenCount}`,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `fixture-refresh-${tokenCount}`,
      })
    }
    throw new Error(`Unexpected fixture path: ${url.pathname}`)
  })
  const data = beginSharedLogin(resource, redirect, 'browser-a')
  assert.equal(
    await auth(new SharedMcpProvider(data, true), { serverUrl: resource, fetchFn }),
    'REDIRECT'
  )
  const authorization = new URL(data.pending!.authorizationUrl!)
  assert.equal(authorization.searchParams.get('redirect_uri'), redirect)
  assert.equal(authorization.searchParams.get('state'), data.pending!.state)
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(
    authorization.searchParams.get('code_challenge'),
    createHash('sha256').update(data.pending!.verifier!).digest('base64url')
  )
  // Database serialization/restart must not lose the shared client or PKCE state.
  const restored = JSON.parse(JSON.stringify(data))
  const query = new URLSearchParams({
    state: restored.pending.state,
    code: 'fixture-code',
    iss: issuer,
  })
  const callback = validateSharedCallback(restored, restored.pending.id, 'browser-a', query)
  assert.equal(
    await auth(new SharedMcpProvider(restored, false), {
      serverUrl: resource,
      authorizationCode: callback.code,
      fetchFn,
    }),
    'AUTHORIZED'
  )
  delete restored.pending
  assert.throws(() => validateSharedCallback(restored, data.pending!.id, 'browser-a', query))
  const first = await refreshSharedToken(restored, fetchFn)
  assert.equal(first, 'fixture-access-1')
  assert.equal(tokenCount, 1)
  restored.expiresAt = Date.now() - 1
  assert.equal(await refreshSharedToken(restored, fetchFn), 'fixture-access-2')
  assert.equal(requests.at(-1)?.body.get('refresh_token'), 'fixture-refresh-1')
  assert.equal(restored.tokens.refresh_token, 'fixture-refresh-2')
  for (const provider of ['chatgpt', 'claude'])
    assert.isTrue(sharedMcpConnected({ shared_authenticated: 1 }, provider))
})

test('callback rejects wrong browser, stale state, duplicate fields, issuer mixup and replay', ({
  assert,
}) => {
  const data = beginSharedLogin(resource, redirect, 'browser-a')
  data.pending!.verifier = 'fixture-verifier'
  data.discovery = { authorizationServerUrl: issuer, authorizationServerMetadata: metadata }
  const query = new URLSearchParams({
    state: data.pending!.state,
    code: 'fixture-code',
    iss: issuer,
  })
  assert.throws(() => validateSharedCallback(data, data.pending!.id, 'browser-b', query))
  assert.throws(() => validateSharedCallback(data, 'old-id', 'browser-a', query))
  for (const key of ['state', 'code', 'iss']) {
    const duplicate = new URLSearchParams(query)
    duplicate.append(key, 'other')
    assert.throws(() => validateSharedCallback(data, data.pending!.id, 'browser-a', duplicate))
  }
  const missingIssuer = new URLSearchParams(query)
  missingIssuer.delete('iss')
  assert.throws(() => validateSharedCallback(data, data.pending!.id, 'browser-a', missingIssuer))
  const wrongIssuer = new URLSearchParams(query)
  wrongIssuer.set('iss', 'https://evil.example')
  assert.throws(() => validateSharedCallback(data, data.pending!.id, 'browser-a', wrongIssuer))
  data.pending!.expiresAt = Date.now() - 1
  assert.throws(() => validateSharedCallback(data, data.pending!.id, 'browser-a', query))
})

test('Fit fallback is confined to known metadata paths on the configured origin', async ({
  assert,
}) => {
  const configured = new URL(resource)
  assert.equal(
    fitMetadataFallback(new URL(`${issuer}/.well-known/oauth-authorization-server`), configured)
      ?.href,
    `${issuer}/index.php/.well-known/oauth-authorization-server`
  )
  for (const url of [
    'https://evil.example/fit/.well-known/oauth-authorization-server',
    `${issuer}/oauth/token`,
    resource,
    `${issuer}/.env`,
    `${issuer}/.well-known/oauth-authorization-server?token=secret`,
  ])
    assert.isNull(fitMetadataFallback(new URL(url), configured))
  const fetchFn = mcpOAuthFetch(
    resource,
    async () => new Response('', { status: 302, headers: { location: 'https://evil.example' } })
  )
  await assert.rejects(
    () => fetchFn(`${issuer}/oauth/token`, { method: 'POST', body: 'code=fixture' }),
    /Redirect OAuth MCP ditolak/
  )
})

test('runtime gives both providers the same token via environment, never inline config', ({
  assert,
}) => {
  const token = 'fixture-sensitive-access'
  const environment = mcpTokenEnvironment({ fit: token })
  const key = mcpTokenVariable('fit')
  assert.equal(environment[key], token)
  const claude = claudeMcpConnection(resource, 'fit', true)
  assert.equal(claude.headers!.Authorization, `Bearer \${${key}}`)
  assert.notInclude(JSON.stringify(claude), token)
  assert.notEqual(mcpTokenVariable('foo-bar'), mcpTokenVariable('foo_bar'))
  assert.isUndefined(claudeMcpConnection(resource, 'fit', false).headers)
  assert.isFalse(
    sharedMcpConnected({ chatgpt_authenticated: 1, claude_authenticated: 0 }, 'claude')
  )
})

test('background refresh never starts a new consent flow when authorization is required', async ({
  assert,
}) => {
  const data = beginSharedLogin(resource, redirect, 'browser-a')
  await assert.rejects(
    () =>
      refreshSharedToken(data, async () => {
        throw new Error('must not fetch')
      }),
    /Hubungkan ulang/
  )
  assert.throws(
    () =>
      new SharedMcpProvider(data, false).redirectToAuthorization(
        new URL(`${issuer}/oauth/authorize`)
      ),
    /Hubungkan ulang/
  )
  assert.isUndefined(data.pending?.authorizationUrl)
})
