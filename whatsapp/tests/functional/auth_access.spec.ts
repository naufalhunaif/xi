import { test } from '@japa/runner'

// Only unauthenticated routes: no database initialization, OAuth login or WhatsApp calls.
test('guest API routes return JSON 401 without redirecting to Account', async ({ client }) => {
  for (const path of ['/api/workspace', '/api/status', '/api/contacts', '/api/contact-directory', '/api/contact-directory/export', '/api/ai/quotas', '/api/ai/oauth/status', '/api/ai/claude/oauth/status']) {
    const response = await client.get(path).redirects(0)
    response.assertStatus(401)
    response.assertHeader('X-WhatsApp-Auth', 'required')
    response.assertBodyContains({ code: 'AUTH_REQUIRED' })
  }
})

test('guest HTML routes require login, including settings and orders', async ({ client }) => {
  for (const path of ['/', '/settings', '/orders', '/contacts', '/media/private.jpg']) {
    const response = await client.get(path).redirects(0)
    response.assertStatus(302)
    response.assertHeader('Cache-Control', 'no-store, private')
  }
})

test('guest cannot submit an OAuth verification code even with a CSRF token', async ({ client }) => {
  for (const path of ['/api/ai/claude/oauth/verify', '/api/mcp/oauth/verify']) {
    const response = await client.post(path).withCsrfToken().json({
      loginId: 'test-only', code: 'synthetic_code#fixture_state',
    }).redirects(0)
    response.assertStatus(401)
    response.assertBodyContains({ code: 'AUTH_REQUIRED' })
  }
})

test('public MCP callback still requires Account login and does not forward OAuth secrets to login', async ({ client }) => {
  const response = await client.get('/oauth/mcp/callback/test-only?code=synthetic-code&state=test-state')
    .redirects(0)
  response.assertStatus(302)
  response.assertHeader('Referrer-Policy', 'no-referrer')
  response.assertHeader('Cache-Control', 'no-store, private')
  if (String(response.header('location') || '').includes('synthetic-code')) throw new Error('Callback leaked to login')
})
