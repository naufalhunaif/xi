import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

test('browser polling redirects once to login, never follows OAuth through fetch, under strict CSP', async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    for (const mode of ['401', 'legacy-302']) {
      const page = await browser.newPage()
      const requests = []
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      page.on('console', message => {
        if (/Content Security Policy|access control checks|CORS/i.test(message.text())) errors.push(message.text())
      })
      await page.route('**/*', async route => {
        const url = new URL(route.request().url())
        requests.push(url.href)
        if (url.hostname !== 'app.test') return route.abort()
        if (url.pathname.endsWith('/login')) return route.fulfill({ contentType: 'text/html', body: '<h1>Sign in</h1>' })
        if (url.pathname.includes('/api/')) return mode === '401'
          ? route.fulfill({ status: 401, headers: { 'X-WhatsApp-Auth': 'required' }, json: { code: 'AUTH_REQUIRED' } })
          : route.fulfill({ status: 302, headers: { location: 'https://oauth.test/authorize' }, body: '' })
        if (url.pathname.endsWith('/client.js')) return route.fulfill({ contentType: 'text/javascript', body: `
          Promise.allSettled(['workspace', 'status', 'contacts'].map(path => fetch('/whatsapp/api/' + path)));
        ` })
        if (url.pathname.endsWith('.js')) {
          const name = url.pathname.split('/').at(-1)
          return route.fulfill({ contentType: 'text/javascript', body: await readFile(new URL(`../public/assets/${name}`, import.meta.url), 'utf8') })
        }
        return route.fulfill({ contentType: 'text/html', headers: {
          'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'",
          'Cache-Control': 'no-store',
        }, body: `<!doctype html><html><head><meta charset="utf-8">
          <meta name="app-url" content="https://app.test/whatsapp">
          <meta name="whatsapp-workspace" content="1:v1"><meta name="whatsapp-workspace-id" content="1">
          <script src="/whatsapp/assets/workspace.js"></script><script src="/whatsapp/assets/sidebar_boot.js"></script>
          </head><body><h1>Protected fixture</h1><script src="/client.js"></script></body></html>` })
      })
      await page.goto('https://app.test/whatsapp/').catch(error => {
        if (!String(error).includes('interrupted')) throw error
      })
      await page.waitForURL('https://app.test/whatsapp/login')
      assert.equal(requests.filter(url => url.endsWith('/login')).length, 1)
      assert.equal(requests.some(url => url.startsWith('https://oauth.test')), false)
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally { await browser.close() }
})
