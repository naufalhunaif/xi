import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import AccountAuthMiddleware from '#middleware/account_auth_middleware'
import AccountController from '#controllers/account_controller'
import env from '#start/env'
import { validateWorkspaceUrls } from '#services/workspace_urls'

const accountUrl = String(env.get('ACCOUNT_URL') || '').replace(/\/$/, '')
const login = `${env.get('APP_URL').replace(/\/$/, '')}/login`
function context(path = '/api/workspace', account?: Record<string, unknown>) {
  const data = new Map<string, unknown>(account ? [['account', account]] : [])
  const result = {
    status: 200,
    body: undefined as unknown,
    location: '',
    next: false,
    withQs: true,
    headers: {} as Record<string, string>,
  }
  const redirect = {
    withQs(value: boolean) {
      result.withQs = value
      return redirect
    },
    toPath(value: string) {
      result.status = 302
      result.location = value
    },
  }
  const ctx = {
    request: { url: () => path, accepts: () => 'html' },
    session: {
      get: (key: string) => data.get(key),
      forget: (key: string) => data.delete(key),
      put: (key: string, value: unknown) => data.set(key, value),
    },
    response: {
      header: (key: string, value: string) => {
        result.headers[key] = value
      },
      unauthorized: (body: unknown) => {
        result.status = 401
        result.body = body
      },
      serviceUnavailable: (body: unknown) => {
        result.status = 503
        result.body = body
      },
      redirect: () => redirect,
    },
  } as unknown as HttpContext
  return {
    ctx,
    data,
    result,
    next: async () => {
      result.next = true
    },
  }
}
function session(checkedAt = 0) {
  return { sub: 'a'.repeat(64), sessionToken: 'b'.repeat(43), issuer: accountUrl, checkedAt }
}
const guard = new AccountAuthMiddleware()

test.group('Account API authentication without OAuth redirects', (group) => {
  group.each.setup(() => {
    const original = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('Unexpected network request')
    }
    return () => {
      globalThis.fetch = original
    }
  })

  test('all guest API reads return 401 JSON, never an OAuth redirect', async ({ assert }) => {
    for (const path of [
      '/api/workspace',
      '/api/status',
      '/api/contacts',
      '/api/ai/claude/oauth/verify',
    ]) {
      const mock = context(path)
      await guard.handle(mock.ctx, mock.next)
      assert.equal(mock.result.status, 401)
      assert.equal(mock.result.headers['X-WhatsApp-Auth'], 'required')
      assert.equal(mock.result.headers['Cache-Control'], 'no-store, private')
      assert.equal(mock.result.location, '')
      assert.isFalse(mock.result.next)
    }
  })

  test('guest pages and media still require login and do not forward query strings', async ({
    assert,
  }) => {
    for (const path of ['/', '/settings', '/orders', '/media/private.jpg']) {
      const mock = context(path)
      await guard.handle(mock.ctx, mock.next)
      assert.equal(mock.result.status, 302)
      assert.equal(mock.result.location, login)
      assert.isFalse(mock.result.withQs)
      assert.isFalse(mock.result.next)
    }
  })

  test('valid recent sessions pass while malformed sessions are rejected', async ({ assert }) => {
    const fresh = context('/api/status', session(Date.now()))
    await guard.handle(fresh.ctx, fresh.next)
    assert.isTrue(fresh.result.next)
    const invalid = context('/api/status', { ...session(Date.now()), sessionToken: 'bad' })
    await guard.handle(invalid.ctx, invalid.next)
    assert.equal(invalid.result.status, 401)
    assert.isFalse(invalid.data.has('account'))
  })

  test('revoked sessions are cleared, verified sessions are refreshed', async ({ assert }) => {
    for (const status of [401, 403]) {
      globalThis.fetch = async () => new Response('{}', { status })
      const mock = context('/api/status', session())
      await guard.handle(mock.ctx, mock.next)
      assert.equal(mock.result.status, 401)
      assert.isFalse(mock.data.has('account'))
    }
    globalThis.fetch = async (_url, options) => {
      assert.equal(options?.redirect, 'manual')
      return Response.json({ active: true, sub: 'a'.repeat(64), aud: 'whatsapp', iss: accountUrl })
    }
    const mock = context('/api/status', session())
    await guard.handle(mock.ctx, mock.next)
    assert.isTrue(mock.result.next)
    assert.isAbove((mock.data.get('account') as ReturnType<typeof session>).checkedAt, 0)
  })

  test('timeouts, HTML, rate limits and redirects fail closed without deleting the session', async ({
    assert,
  }) => {
    for (const failure of ['timeout', 'html', '429', '302', '500']) {
      globalThis.fetch = async () => {
        if (failure === 'timeout') throw new Error('timeout')
        if (failure === 'html') return new Response('<html>login</html>')
        return new Response('{}', { status: Number(failure) })
      }
      const mock = context('/api/status', session())
      await guard.handle(mock.ctx, mock.next)
      assert.equal(mock.result.status, 503)
      assert.equal(mock.result.headers['Retry-After'], '10')
      assert.isTrue(mock.data.has('account'))
      assert.isFalse(mock.result.next)
    }
  })

  test('wrong identity, audience or issuer cannot authorize API access', async ({ assert }) => {
    for (const bad of [
      { sub: 'wrong' },
      { aud: 'store' },
      { iss: 'https://other.test/account' },
      { active: false },
    ]) {
      globalThis.fetch = async () =>
        Response.json({
          active: true,
          sub: 'a'.repeat(64),
          aud: 'whatsapp',
          iss: accountUrl,
          ...bad,
        })
      const mock = context('/api/status', session())
      await guard.handle(mock.ctx, mock.next)
      assert.equal(mock.result.status, 401)
      assert.isFalse(mock.result.next)
    }
  })

  test('a stale cookie cannot trap the login route in a redirect loop', async ({ assert }) => {
    const mock = context('/login', session())
    await new AccountController().login(mock.ctx)
    const url = new URL(mock.result.location)
    assert.equal(url.pathname, `${new URL(accountUrl).pathname}/oauth/account/authorize`)
    assert.equal(url.searchParams.get('redirect_uri'), login.replace(/\/login$/, '/auth/callback'))
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
    assert.isFalse(mock.result.withQs)
    assert.isFalse(mock.data.has('account'))
    assert.isTrue(mock.data.has('account_oauth'))
  })
})

test('production URLs reject localhost/http, wrong www and mismatched callback folders', ({
  assert,
}) => {
  for (const prefix of ['', '/Project']) {
    assert.doesNotThrow(() =>
      validateWorkspaceUrls(
        `https://shop.test${prefix}/whatsapp`,
        `https://shop.test${prefix}/account`,
        `${prefix}/whatsapp`
      )
    )
  }
  for (const [app, account, base] of [
    ['http://shop.test/whatsapp', 'https://shop.test/account', '/whatsapp'],
    ['https://shop.test/whatsapp', 'https://www.shop.test/account', '/whatsapp'],
    ['https://shop.test/whatsapp', 'https://shop.test/account', '/Project/whatsapp'],
    ['https://shop.test/whatsapp', 'https://shop.test/Project/account', '/whatsapp'],
    ['https://shop.test/whatsapp?x=1', 'https://shop.test/account', '/whatsapp'],
  ])
    assert.throws(() => validateWorkspaceUrls(app, account, base))
})

test('standalone URLs accept the domain root and reject http or a mismatched base path', ({
  assert,
}) => {
  assert.doesNotThrow(() => validateWorkspaceUrls('https://wa.shop.test', '', ''))
  assert.doesNotThrow(() => validateWorkspaceUrls('https://wa.shop.test/', '', '/'))
  assert.doesNotThrow(() => validateWorkspaceUrls('https://shop.test/wa', '', '/wa'))
  assert.throws(() => validateWorkspaceUrls('http://wa.shop.test', '', ''))
  assert.throws(() => validateWorkspaceUrls('https://wa.shop.test', '', '/whatsapp'))
  assert.throws(() => validateWorkspaceUrls('https://wa.shop.test?x=1', '', ''))
})
