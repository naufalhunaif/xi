import { test } from '@japa/runner'
import {
  codexPublicCallback,
  codexPublicCallbackArguments,
  claimPublicMcpCallback,
  isPublicMcpAuthorization,
  type PublicCallbackSession,
} from '#services/mcp_callback_relay'

const id = 'b686d351-a9fa-4e69-ac4c-b03694521b23'
const state = 'synthetic-oauth-state-no-credentials'
const publicUrl = `https://shop.example/whatsapp/oauth/mcp/callback/${id}`
test('public mode never exposes a CLI link that still registers localhost or another callback', ({
  assert,
}) => {
  assert.isTrue(isPublicMcpAuthorization(authorization(), publicUrl))
  assert.isTrue(isPublicMcpAuthorization(authorization(publicUrl + '/provider_id'), publicUrl))
  for (const redirect of [
    'http://127.0.0.1:43603/callback',
    'https://other.example/callback',
    publicUrl + '-other',
    publicUrl + '/../../other',
    publicUrl + '?next=other',
  ]) {
    assert.isFalse(isPublicMcpAuthorization(authorization(redirect), publicUrl))
  }
})
function fixture(): PublicCallbackSession {
  return {
    id,
    expiresAt: Date.now() + 60_000,
    callbackSubmitted: false,
    child: { killed: false, exitCode: null },
    publicCallbackUrl: publicUrl,
    listenerPort: 3334,
    browserBinding: 'fixture-session-binding',
  }
}
function authorization(redirect = publicUrl, issuer = 'store') {
  const url = new URL(`https://shop.example/${issuer}/oauth/authorize`)
  url.searchParams.set('redirect_uri', redirect)
  url.searchParams.set('state', state)
  return url.href
}
function query(issuer = 'store') {
  return new URLSearchParams({
    code: 'synthetic-code-only',
    state,
    iss: `https://shop.example/${issuer}`,
  }).toString()
}

test('public callback configuration registers the domain before authorization, for Store and Fit', ({
  assert,
}) => {
  for (const name of ['business_store', 'business_fit']) {
    const config = codexPublicCallback('https://shop.example/whatsapp/', id, 3334, 3333)
    assert.deepEqual(config, { url: publicUrl, port: 3334 })
    const args = codexPublicCallbackArguments(name, config)
    assert.include(args, `mcp_oauth_callback_url="${publicUrl}"`)
    assert.include(args, 'mcp_oauth_callback_port=3334')
    assert.include(
      args,
      `mcp_servers.${name}.oauth={callback_url="${publicUrl}",callback_port=3334}`
    )
    assert.notInclude(args.join(' '), '127.0.0.1')
  }
})

test('public callback config rejects credentials, fragments, HTTP, invalid ports and the WEB port', ({
  assert,
}) => {
  for (const base of [
    'http://shop.example/whatsapp',
    'https://user:secret@shop.example/whatsapp',
    'https://shop.example/whatsapp?foo=bar',
    'https://shop.example/whatsapp#fragment',
  ])
    assert.throws(() => codexPublicCallback(base, id, 3334, 3333))
  for (const port of [80, 443, 3333, 65536, 3334.5, NaN])
    assert.throws(() => codexPublicCallback('https://shop.example/whatsapp', id, port, 3333))
})

test('public callback relays only to fixed internal listener, preserving path, state and issuer', ({
  assert,
}) => {
  for (const issuer of ['store', 'fit']) {
    const login = fixture()
    const result = claimPublicMcpCallback(
      login,
      id,
      login.browserBinding,
      authorization(publicUrl, issuer),
      undefined,
      query(issuer) + '&next=https://evil.example&port=8080'
    )
    assert.equal(result.target.origin, 'http://127.0.0.1:3334')
    assert.equal(result.target.pathname, `/whatsapp/oauth/mcp/callback/${id}`)
    assert.equal(result.target.searchParams.get('iss'), `https://shop.example/${issuer}`)
    assert.equal(result.target.searchParams.get('state'), state)
    assert.equal(result.target.searchParams.get('code'), 'synthetic-code-only')
    assert.isFalse(result.target.searchParams.has('next'))
    assert.isFalse(result.target.searchParams.has('port'))
    assert.isFalse(result.denied)
    assert.isTrue(login.callbackSubmitted)
    assert.notInclude(JSON.stringify(login), 'synthetic-code-only')
  }
})

test('public callback supports exact provider-specific callback IDs and bundle subfolders', ({
  assert,
}) => {
  const login = fixture()
  login.publicCallbackUrl = `https://shop.example/project/whatsapp/oauth/mcp/callback/${id}`
  const callbackId = 'synthetic_provider_id'
  const result = claimPublicMcpCallback(
    login,
    id,
    login.browserBinding,
    authorization(login.publicCallbackUrl + '/' + callbackId),
    callbackId,
    query()
  )
  assert.equal(result.target.pathname, `/project/whatsapp/oauth/mcp/callback/${id}/${callbackId}`)
})

test('public callback rejects another browser, workspace lookup, flow, stale or exited session', ({
  assert,
}) => {
  assert.throws(() =>
    claimPublicMcpCallback(
      undefined,
      id,
      'fixture-session-binding',
      authorization(),
      undefined,
      query()
    )
  )
  for (const login of [
    { ...fixture(), id: 'other-flow' },
    { ...fixture(), canceled: true },
    { ...fixture(), expiresAt: Date.now() - 1 },
    { ...fixture(), child: { killed: true, exitCode: null } },
    { ...fixture(), child: { killed: false, exitCode: 0 } },
    { ...fixture(), browserBinding: 'other-browser' },
  ]) {
    assert.throws(() =>
      claimPublicMcpCallback(
        login,
        id,
        'fixture-session-binding',
        authorization(),
        undefined,
        query()
      )
    )
    assert.isFalse(login.callbackSubmitted)
  }
})

test('public callback rejects redirect substitution, duplicate state/code/issuer and invalid input', ({
  assert,
}) => {
  for (const bad of [
    query().replace(state, 'another-state'),
    query() + '&state=' + state,
    query() + '&code=other',
    query() + '&iss=other',
    query() + '&error=access_denied',
    query().replace('synthetic-code-only', ''),
    query().replace('synthetic-code-only', '%0aBad'),
    'x'.repeat(8193),
  ]) {
    const login = fixture()
    assert.throws(() =>
      claimPublicMcpCallback(login, id, login.browserBinding, authorization(), undefined, bad)
    )
    assert.isFalse(login.callbackSubmitted)
  }
  for (const redirect of [
    'http://127.0.0.1:43603/callback',
    'https://evil.example/callback',
    publicUrl + '/wrong',
  ]) {
    const login = fixture()
    assert.throws(() =>
      claimPublicMcpCallback(
        login,
        id,
        login.browserBinding,
        authorization(redirect),
        undefined,
        query()
      )
    )
  }
})

test('public callback is one-use, including denial, and drops provider error descriptions', ({
  assert,
}) => {
  const login = fixture()
  const denied = new URLSearchParams({
    error: 'access_denied',
    error_description: 'private detail',
    state,
    iss: 'https://shop.example/store',
  }).toString()
  const result = claimPublicMcpCallback(
    login,
    id,
    login.browserBinding,
    authorization(),
    undefined,
    denied
  )
  assert.isTrue(result.denied)
  assert.equal(result.target.searchParams.get('error'), 'access_denied')
  assert.isFalse(result.target.searchParams.has('error_description'))
  assert.throws(() =>
    claimPublicMcpCallback(login, id, login.browserBinding, authorization(), undefined, denied)
  )
})
