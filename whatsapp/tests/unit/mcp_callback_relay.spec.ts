import { test } from '@japa/runner'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import {
  mcpAuthorizationUrl,
  supportsMcpCallbackRelay,
  validatedMcpCallback,
  claimMcpCallback,
  sendMcpCallback,
} from '#services/mcp_callback_relay'

const state = 'synthetic-state-for-tests-only'

// Mock the built-in transport; these tests never open a socket.
function mockTransport(statusCode: number | 'error', inspect: (url: URL, options: object) => void) {
  const original = http.get
  http.get = ((url: URL, options: object, receive: (response: EventEmitter) => void) => {
    inspect(url, options)
    const request = new EventEmitter() as EventEmitter & {
      setTimeout: () => void
      destroy: () => void
    }
    request.setTimeout = () => {}
    request.destroy = () => {
      request.emit('close')
    }
    queueMicrotask(() => {
      if (statusCode === 'error') {
        request.emit('error', new Error('transport detail including synthetic secret'))
        request.emit('close')
        return
      }
      const response = Object.assign(new EventEmitter(), { statusCode, resume() {}, destroy() {} })
      receive(response)
      response.emit('end')
      request.emit('close')
    })
    return request
  }) as unknown as typeof http.get
  syncBuiltinESMExports()
  return () => {
    http.get = original
    syncBuiltinESMExports()
  }
}

test('MCP relay sends only to the validated target without proxy, cookies or connection pooling', async ({
  assert,
}) => {
  let calls = 0
  const restore = mockTransport(200, (url, options) => {
    calls++
    const expected = new URL(callback())
    assert.equal(url.origin + url.pathname, expected.origin + expected.pathname)
    assert.deepEqual(
      Object.fromEntries(url.searchParams),
      Object.fromEntries(expected.searchParams)
    )
    assert.deepEqual(options, {
      agent: false,
      maxHeaderSize: 8192,
      headers: { connection: 'close' },
    })
  })
  try {
    await sendMcpCallback(validatedMcpCallback(authorization(), callback()))
  } finally {
    restore()
  }
  assert.equal(calls, 1)
})

test('MCP relay rejects redirects and errors without exposing secrets', async ({ assert }) => {
  for (const status of [302, 400, 500, 'error'] as const) {
    let calls = 0
    const restore = mockTransport(status, () => {
      calls++
    })
    try {
      await assert.rejects(
        () => sendMcpCallback(validatedMcpCallback(authorization(), callback())),
        /^Callback MCP belum diterima\. Periksa status atau mulai ulang login\.$/
      )
      assert.equal(calls, 1)
    } finally {
      restore()
    }
  }
})

function authorization(callback = 'http://127.0.0.1:42803/callback') {
  const url = new URL('https://business.example/oauth/authorize')
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', callback)
  return url.href
}
function callback(base = 'http://127.0.0.1:42803/callback') {
  const url = new URL(base)
  url.searchParams.set('state', state)
  url.searchParams.set('code', 'synthetic-code-not-a-credential')
  url.searchParams.set('iss', 'https://business.example/store')
  return url.href
}
function session() {
  return {
    id: 'fixture-login',
    expiresAt: Date.now() + 60_000,
    callbackSubmitted: false,
    canceled: false,
    child: { killed: false, exitCode: null as number | null },
  }
}

test('MCP extracts the authorization URL from ANSI CLI output, not a documentation link', ({
  assert,
}) => {
  assert.equal(
    mcpAuthorizationUrl(`See https://example.com/help\n\u001b[32m${authorization()}\u001b[0m\n`),
    authorization()
  )
  assert.equal(mcpAuthorizationUrl('Waiting for login https://example.com/'), '')
  assert.equal(mcpAuthorizationUrl('https://['), '')
  assert.isTrue(supportsMcpCallbackRelay(authorization()))
})

test('MCP only forwards the expected callback parameters, preserving issuer and code', ({
  assert,
}) => {
  const result = validatedMcpCallback(authorization(), callback() + '&next=https://evil.example')
  assert.equal(result.origin, 'http://127.0.0.1:42803')
  assert.equal(result.pathname, '/callback')
  assert.equal(result.searchParams.get('code'), 'synthetic-code-not-a-credential')
  assert.equal(result.searchParams.get('iss'), 'https://business.example/store')
  assert.isFalse(result.searchParams.has('next'))
})

test('MCP supports CLI callback IDs, IPv6 and literal loopback normalization', ({ assert }) => {
  for (const base of ['http://localhost:42803/callback', 'http://[::1]:42803/callback/test-id']) {
    const result = validatedMcpCallback(authorization(base), callback(base))
    assert.equal(result.hostname, base.includes('localhost') ? '127.0.0.1' : '[::1]')
  }
})

test('MCP refuses arbitrary network destinations, privileged ports and callback paths', ({
  assert,
}) => {
  for (const base of [
    'https://127.0.0.1:42803/callback',
    'http://169.254.169.254:42803/callback',
    'http://example.com:42803/callback',
    'http://127.0.0.1:80/callback',
    'http://127.0.0.1/callback',
    'http://127.0.0.1:42803/admin',
    'http://user:pass@127.0.0.1:42803/callback',
    'http://127.0.0.1:42803/callback?next=x',
    'http://127.0.0.1:42803/callback#fragment',
  ]) {
    assert.isFalse(supportsMcpCallbackRelay(authorization(base)), base)
  }
})

test('MCP rejects another port, path, state, duplicated parameters or malformed code', ({
  assert,
}) => {
  for (const value of [
    callback('http://127.0.0.1:42804/callback'),
    callback('http://127.0.0.1:42803/callback/other'),
    callback().replace(state, 'wrong-state'),
    callback() + '&state=' + state,
    callback() + '&code=another',
    callback() + '&iss=https://another.example',
    callback() + '&error=access_denied',
    callback() + '#fragment',
    callback().replace('synthetic-code-not-a-credential', ''),
    callback().replace('synthetic-code-not-a-credential', '%0D%0AInjected'),
    'x'.repeat(8193),
    '\n' + callback(),
    null,
  ]) {
    assert.throws(() => validatedMcpCallback(authorization(), value))
  }
  assert.isFalse(supportsMcpCallbackRelay(authorization() + '&state=duplicate'))
  assert.isFalse(supportsMcpCallbackRelay(authorization() + '&redirect_uri=duplicate'))
})

test('MCP claim is single-use and invalid input does not consume the session', ({ assert }) => {
  const login = session()
  assert.throws(() => claimMcpCallback(login, login.id, authorization(), 'invalid'))
  assert.isFalse(login.callbackSubmitted)
  const target = claimMcpCallback(login, login.id, authorization(), callback())
  assert.equal(target.searchParams.get('state'), state)
  assert.isTrue(login.callbackSubmitted)
  assert.throws(
    () => claimMcpCallback(login, login.id, authorization(), callback()),
    /sedang diverifikasi/
  )
  assert.notInclude(JSON.stringify(login), 'synthetic-code-not-a-credential')
})

test('MCP refuses missing, expired, canceled, exited and mismatched login sessions', ({
  assert,
}) => {
  for (const login of [
    undefined,
    { ...session(), expiresAt: Date.now() - 1 },
    { ...session(), canceled: true },
    { ...session(), id: 'another-workspace-provider-or-flow' },
    { ...session(), child: undefined },
    { ...session(), child: { killed: true, exitCode: null } },
    { ...session(), child: { killed: false, exitCode: 0 } },
  ]) {
    assert.throws(
      () => claimMcpCallback(login, 'fixture-login', authorization(), callback()),
      /Sesi login MCP berakhir/
    )
  }
})
