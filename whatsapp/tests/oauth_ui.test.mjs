// Isolated UI regression: all HTTP requests are fulfilled locally, no account/DB/AI calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

test('OAuth verification UI: Claude submit/retry and ChatGPT device code, desktop/mobile EN/ID', async () => {
  const edge = new Edge({ cache: false })
  edge.mount(new URL('../resources/views', import.meta.url).pathname)
  const content = await edge.render('partials/settings/ai', {
    settings: { aiEnabled: false, aiProvider: 'claude', claudeModel: '', claudeBin: '', chatgptModel: '', codexBin: '' },
    oauth: { connected: false }, claudeOauth: { connected: false },
  })
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium
  const browser = await engine.launch({ headless: true })
  try {
    for (const locale of ['en', 'id']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      const errors = []
      const requests = []
      page.on('pageerror', (error) => errors.push(error.message))
      let submitted = false
      let connected = false
      let chatgptStatusUnavailable = false
      let chatgptStartError = ''
      let chatgptCodeReady = true
      let flow = 'test-login'
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        const path = url.pathname
        if (url.origin === 'https://auth.openai.com') return route.fulfill({
          contentType: 'text/html', body: '<h1>OpenAI test fixture</h1>',
        })
        if (path === '/settings') {
          return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
            <meta name="app-url" content="https://oauth.test"><meta name="csrf-token" content="test">
            <link rel="stylesheet" href="/store/app.css"><link rel="stylesheet" href="/assets/app.css">
            <link rel="stylesheet" href="/assets/forms.css"></head><body class="workspace-ui">
            <div id="notice" hidden></div><div class="wa-panel wa-settings-panel"><form id="settingsForm">${content}</form></div>
            <script src="/lang/${locale}.js"></script><script src="/translate.js"></script>
            <script src="/assets/chatgpt_login.js"></script><script src="/assets/app.js"></script></body></html>` })
        }
        if (path === '/translate.js') return route.fulfill({ contentType: 'text/javascript', body: `
          window.waI18n = { t: (key, ...args) => (window.waLocales['${locale}'][key] || key).replaceAll('{0}', args[0] ?? '') };
          document.querySelectorAll('[data-i18n]').forEach(el => el.textContent = window.waI18n.t(el.dataset.i18n));
        ` })
        if (path === '/store/app.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('../../store/assets/css/app.css', import.meta.url), 'utf8') })
        if (path.startsWith('/assets/') || path.startsWith('/lang/')) return route.fulfill({
          contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8'),
        })
        requests.push({ path, method: route.request().method(), body: route.request().postData() })
        if (path === '/api/settings') return route.fulfill({ json: { aiEnabled: false, ...route.request().postDataJSON() } })
        if (path.endsWith('/claude/oauth/verify')) {
          assert.equal(route.request().headers()['x-csrf-token'], 'test')
          assert.deepEqual(route.request().postDataJSON(), { loginId: flow, code: 'synthetic_code#fixture_state' })
          submitted = true
          return route.fulfill({ json: { submitted: true } })
        }
        if (path.endsWith('/claude/oauth/start')) {
          flow = 'new-test-login'
          submitted = false
          return route.fulfill({ json: {} })
        }
        if (path.endsWith('/claude/oauth/status')) return route.fulfill({ json: {
          connected, pending: !connected, loginId: connected ? '' : flow,
          verificationUrl: 'https://claude.ai/oauth/authorize?state=fixture_state', codeSubmitted: submitted,
        } })
        if (path.endsWith('/ai/oauth/status') && chatgptStatusUnavailable) return route.fulfill({
          status: 503, json: { error: 'Fixture temporarily unavailable' },
        })
        // Keep the pending panel visible while the server obtains a device code.
        if (path.endsWith('/ai/oauth/start')) {
          chatgptCodeReady = false
          await new Promise((resolve) => setTimeout(resolve, 1200))
          if (chatgptStartError) return route.fulfill({ status: 422, json: { error: chatgptStartError } })
          return route.fulfill({ json: { connected: false, pending: true, userCode: '', verificationUrl: '' } })
        }
        if (path.endsWith('/ai/oauth/status') && chatgptStartError) return route.fulfill({ json: {
          connected: false, pending: false, error: chatgptStartError,
        } })
        if (path.endsWith('/ai/oauth/status') && !chatgptCodeReady) return route.fulfill({ json: {
          connected: false, pending: true, userCode: '', verificationUrl: '',
        } })
        if (path.endsWith('/ai/oauth/status') || path.endsWith('/ai/oauth/start')) return route.fulfill({ json: {
          connected: false, pending: true, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'Ab12-cD345',
        } })
        return route.fulfill({ json: { connections: [], found: true, version: 'test' } })
      })
      await page.goto('https://oauth.test/settings')
      const input = page.locator('#claudeOauthCode')
      await input.waitFor({ state: 'visible' })
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        await page.screenshot({ path: `/private/tmp/oauth-claude-${locale}-${width}.png`, fullPage: true })
      }
      await input.fill('synthetic_code#fixture_state')
      // Credentials have no name, and must not enter autosave or FormData.
      assert.equal(await input.getAttribute('name'), null)
      assert.equal(await page.locator('#claudeOauthVerify').textContent(), locale === 'en' ? 'Verify' : 'Verifikasi')
      await input.press('Enter')
      await page.waitForFunction(() => document.querySelector('#claudeOauthHelp').textContent.includes('erif'))
      assert.equal(await input.inputValue(), '')
      assert.equal(await input.isDisabled(), true)
      assert.equal(requests.filter(r => r.path.endsWith('/verify')).length, 1)
      assert.equal(requests.some(r => r.path === '/api/settings'), false)
      await page.locator('#claudeOauthRestart').click()
      await input.fill('synthetic_code#fixture_state')
      await page.locator('#claudeOauthVerify').click()
      connected = true
      await page.waitForFunction(() => document.querySelector('#claudeOauthDevice').hidden)
      assert.equal(await input.inputValue(), '')
      await page.locator('#aiProvider').selectOption('chatgpt')
      await page.locator('#oauthCode').waitFor({ state: 'visible' })
      assert.equal(await page.locator('#oauthCode').inputValue(), 'Ab12-cD345')
      assert.equal(await page.locator('#oauthCode').getAttribute('readonly'), '')
      assert.equal(await page.locator('#oauthLink').getAttribute('href'), 'https://auth.openai.com/codex/device')
      const pageCount = context.pages().length
      await page.locator('#oauthRestart').click()
      assert.equal(await page.locator('#oauthCode').isVisible(), true)
      assert.equal(await page.locator('#oauthCopy').isVisible(), true)
      assert.equal(await page.locator('#oauthCopy').isDisabled(), true)
      assert.equal(await page.locator('#oauthLink').isVisible(), false)
      assert.equal(context.pages().length, pageCount)
      await page.waitForFunction(() => !document.querySelector('#oauthRestart').disabled)
      assert.equal(await page.locator('#oauthMessage').innerText(), locale === 'en' ? 'Requesting device code…' : 'Meminta kode perangkat…')
      assert.equal(await page.locator('#oauthCode').inputValue(), '')
      assert.equal(await page.locator('#oauthLink').isVisible(), false)
      chatgptCodeReady = true
      await page.waitForFunction(() => document.querySelector('#oauthCode').value === 'Ab12-cD345')
      assert.equal(await page.locator('#oauthStatus').textContent(), locale === 'en' ? 'Waiting for ChatGPT sign-in' : 'Menunggu login ChatGPT')
      assert.equal(context.pages().length, pageCount, 'no about:blank while waiting for the code')
      const popupPromise = context.waitForEvent('page')
      await page.locator('#oauthLink').click()
      const popup = await popupPromise
      await popup.waitForURL('https://auth.openai.com/codex/device')
      assert.equal(await popup.evaluate(() => window.opener), null)
      assert.deepEqual(requests.find(r => r.path === '/api/ai/oauth/start' && r.method === 'POST')?.body, '{"restart":true}')
      await popup.close()
      chatgptStatusUnavailable = true
      await page.evaluate(() => document.dispatchEvent(new Event('ui-language:change')))
      await page.waitForFunction(() => /Status login gagal|Unable to load login/.test(document.querySelector('#oauthStatus').textContent))
      assert.equal(await page.locator('#oauthCode').inputValue(), 'Ab12-cD345')
      assert.equal(await page.locator('#oauthLink').isVisible(), true)
      chatgptStatusUnavailable = false
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async (text) => { window.testCopiedCode = text },
        } })
      })
      await page.locator('#oauthCopy').click()
      assert.equal(await page.evaluate(() => window.testCopiedCode), 'Ab12-cD345')
      chatgptStartError = 'Fixture login unavailable'
      await page.locator('#oauthRestart').click()
      await page.waitForFunction(() => document.querySelector('#oauthStatus').textContent.includes('Fixture login unavailable'))
      assert.equal(await page.locator('#oauthMessage').isVisible(), true)
      assert.equal(await page.locator('#oauthMessage').innerText(), 'Fixture login unavailable')
      assert.ok(await page.locator('#oauthMessage').evaluate(el => parseFloat(getComputedStyle(el).fontSize) >= 12))
      assert.equal(await page.locator('#oauthDevice').isVisible(), true)
      assert.equal(await page.locator('#oauthCopy').isVisible(), true)
      assert.equal(await page.locator('#oauthCopy').isDisabled(), true)
      assert.equal(await page.locator('#oauthRestart').isEnabled(), true)
      assert.equal(context.pages().length, pageCount)
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 900 })
        const sizes = await page.evaluate(() => ({ full: document.documentElement.scrollWidth, viewport: innerWidth }))
        assert.ok(sizes.full <= sizes.viewport, `${locale} ${width}: horizontal overflow`)
        await page.screenshot({ path: `/private/tmp/oauth-${locale}-${width}.png`, fullPage: true })
      }
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally {
    await browser.close()
  }
})
