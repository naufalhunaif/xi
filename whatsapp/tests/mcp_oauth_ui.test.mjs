// Mocked browser regression: no real login, MCP, database, or WhatsApp requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium } from 'playwright'

test('MCP callback UI: isolated providers, errors, restart, one-time verification, EN/ID desktop/mobile', async () => {
  const edge = new Edge({ cache: false })
  edge.mount(new URL('../resources/views', import.meta.url).pathname)
  const connection = { slug: 'fixture-business', name: 'Business data', enabled: true, authenticated: false,
    pending: true, loginId: 'fixture-login', manualCallback: true, callbackSubmitted: false,
    verificationUrl: 'https://business.example/authorize?state=synthetic-state&redirect_uri=http%3A%2F%2F127.0.0.1%3A42803%2Fcallback' }
  const content = await edge.render('partials/settings/business', { settings: { mcpConnections: [connection] } })
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    for (const locale of ['en', 'id']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const requests = []
      const errors = []
      let statusUnavailable = false
      const flows = { chatgpt: { ...connection }, claude: { ...connection, loginId: 'claude-fixture-login' } }
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/settings') return route.fulfill({ contentType: 'text/html', body: `<!doctype html>
          <html lang="${locale}"><head><meta charset="utf-8"><meta name="app-url" content="https://mcp.test">
          <meta name="csrf-token" content="fixture-csrf"><meta name="viewport" content="width=device-width,initial-scale=1">
          <link rel="stylesheet" href="/store/app.css"><link rel="stylesheet" href="/assets/app.css">
          <link rel="stylesheet" href="/assets/forms.css"></head><body class="workspace-ui">
          <div id="notice" hidden></div><div class="wa-panel wa-settings-panel"><form id="settingsForm">
          <label for="aiProvider">Provider</label><select id="aiProvider"><option value="chatgpt">ChatGPT</option><option value="claude">Claude</option></select>
          ${content}</form></div><script src="/lang/${locale}.js"></script><script src="/translate.js"></script>
          <script src="/assets/app.js"></script></body></html>` })
        if (path === '/translate.js') return route.fulfill({ contentType: 'text/javascript', body: `
          window.waI18n = { t: (key, ...args) => (window.waLocales['${locale}'][key] || key).replaceAll('{0}', args[0] ?? '') };
        ` })
        if (path === '/store/app.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('../../store/assets/css/app.css', import.meta.url), 'utf8') })
        if (path.startsWith('/assets/') || path.startsWith('/lang/')) return route.fulfill({
          contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8'),
        })
        requests.push({ path, method: route.request().method(), body: route.request().postData() })
        if (path === '/api/mcp/oauth/status') {
          if (statusUnavailable) return route.fulfill({ status: 503, json: { error: 'Fixture unavailable' } })
          const provider = new URL(route.request().url()).searchParams.get('provider')
          return route.fulfill({ json: { connections: [flows[provider]] } })
        }
        if (path === '/api/mcp/oauth/verify') {
          assert.equal(route.request().headers()['x-csrf-token'], 'fixture-csrf')
          const data = route.request().postDataJSON()
          assert.equal(data.slug, connection.slug)
          assert.equal(data.loginId, flows[data.provider].loginId)
          if (data.callbackUrl === 'wrong-session') return route.fulfill({ status: 422, json: {
            error: 'URL callback bukan dari sesi login MCP ini. Gunakan tautan login terbaru.',
          } })
          assert.equal(data.callbackUrl, 'http://127.0.0.1:42803/callback?code=synthetic&state=synthetic-state')
          flows[data.provider].callbackSubmitted = true
          return route.fulfill({ json: { submitted: true } })
        }
        if (path === '/api/mcp/oauth/start') {
          const data = route.request().postDataJSON()
          assert.equal(data.restart, true)
          flows[data.provider] = { ...connection, loginId: `${data.provider}-restarted` }
          return route.fulfill({ json: { connections: [flows[data.provider]] } })
        }
        return route.fulfill({ json: { connections: [], found: true, version: 'fixture' } })
      })
      await page.goto('https://mcp.test/settings')
      const input = page.locator('[data-mcp-callback]')
      await input.waitFor({ state: 'visible' })
      assert.equal(await input.getAttribute('name'), null)
      assert.equal(await input.getAttribute('type'), 'password')
      assert.equal(await page.locator('[data-mcp-verify]').textContent(), locale === 'en' ? 'Verify' : 'Verifikasi')
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${locale} ${width}: overflow`)
        await page.screenshot({ path: `/private/tmp/mcp-oauth-${locale}-${width}.png`, fullPage: true })
      }
      await input.fill('wrong-session')
      await input.press('Enter')
      await page.waitForFunction(() => !document.querySelector('[data-mcp-verification-result]').hidden)
      assert.equal(await input.inputValue(), '')
      assert.ok((await page.locator('[data-mcp-verification-result]').textContent()).includes(locale === 'en' ? 'does not match' : 'bukan dari'))
      // Polling must preserve an in-progress paste, but changing provider must clear it.
      await input.fill('unsubmitted-value')
      await page.waitForTimeout(3300)
      assert.equal(await input.inputValue(), 'unsubmitted-value')
      await page.locator('#aiProvider').selectOption('claude')
      await page.waitForFunction(() => document.querySelector('[data-mcp-verification]').dataset.provider === 'claude')
      assert.equal(await input.inputValue(), '')
      await page.locator('[data-mcp-restart]').click()
      await page.waitForFunction(() => document.querySelector('[data-mcp-verification]')?.dataset.loginId === 'claude-restarted')
      await input.fill('http://127.0.0.1:42803/callback?code=synthetic&state=synthetic-state')
      await input.press('Enter')
      await page.waitForFunction(() => document.querySelector('[data-mcp-verify]').disabled && document.querySelector('[data-mcp-callback]').disabled)
      assert.equal(await input.inputValue(), '')
      assert.equal(requests.filter(r => r.path.endsWith('/verify')).length, 2)
      assert.equal(await page.locator('[data-mcp-status]').textContent(), locale === 'en' ? 'Waiting for sign-in' : 'Menunggu login')
      flows.claude.authenticated = true
      flows.claude.pending = false
      await page.locator('[data-mcp-verification]').waitFor({ state: 'detached' })
      statusUnavailable = true
      await page.evaluate(() => window.dispatchEvent(new Event('wa:network-restored')))
      await page.waitForFunction(() => /Status unavailable|Status belum dapat diperiksa/.test(document.querySelector('[data-mcp-status]').textContent))
      assert.equal(flows.claude.authenticated, true, 'status failure must not revoke a stored connection')
      statusUnavailable = false
      await page.evaluate(() => window.dispatchEvent(new Event('wa:network-restored')))
      await page.waitForFunction(() => document.querySelector('[data-mcp-status]').classList.contains('connected'))
      assert.match(await page.locator('[data-mcp-status]').getAttribute('title'), /Claude/)
      // After one shared OAuth consent, switching either brain must retain the connection.
      for (const flow of Object.values(flows)) Object.assign(flow, { authenticated: true, sharedAuthenticated: true, pending: false })
      for (const provider of ['chatgpt', 'claude', 'chatgpt']) {
        await page.locator('#aiProvider').selectOption(provider)
        await page.evaluate(() => window.dispatchEvent(new Event('wa:network-restored')))
        await page.waitForFunction(() => document.querySelector('[data-mcp-connect]').hidden)
        assert.match(await page.locator('[data-mcp-status]').getAttribute('title'), /ChatGPT.*Claude/)
        assert.equal(await page.locator('[data-mcp-login]').isVisible(), false)
      }
      assert.equal(requests.some(r => r.path === '/api/settings'), false)
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally { await browser.close() }
})
