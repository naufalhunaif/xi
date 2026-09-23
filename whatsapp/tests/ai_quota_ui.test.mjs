import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

const root = new URL('../', import.meta.url)
const edge = new Edge({ cache: false })
edge.mount(new URL('resources/views', root).pathname)
const now = Date.now()
const windowData = (remainingPercent, minutes = 300) => ({
  key: minutes === 300 ? 'five_hour' : 'seven_day', bucket: 'codex', minutes,
  remainingPercent, resetsAt: Math.floor(now / 1000) + 7200, observedAt: now,
  status: remainingPercent === 0 ? 'rejected' : 'allowed', expired: false, stale: false,
})
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${engine}: quota bars, unknown/stale/reset states and dark/mobile`, async () => {
    const browser = await browserType.launch({ headless: true })
    try {
      for (const [width, lang, theme] of [[1440, 'en', 'light'], [390, 'id', 'dark']]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 } })
        await context.addInitScript(language => localStorage.setItem('https://quota.test:ui-language', language), lang)
        let response = { providers: [
          { provider: 'chatgpt', windows: [windowData(75), windowData(20, 10080)] },
          { provider: 'claude', windows: [windowData(0)] },
        ] }
        const errors = []
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        await context.route('**/*', async route => {
          const url = new URL(route.request().url())
          assert.equal(route.request().method(), 'GET')
          if (url.pathname === '/api/ai/quotas') return route.fulfill({ json: response })
          if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/lang/'))
            return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8', body: await readFile(new URL(`public${url.pathname}`, root), 'utf8') })
          return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://quota.test"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/theme.css"><link rel="stylesheet" href="/assets/quotas.css"><script src="/lang/en.js"></script><script src="/lang/id.js"></script><script src="/assets/i18n.js"></script></head><body class="workspace-ui" style="margin:0;padding:16px;box-sizing:border-box;background:${theme === 'dark' ? '#000' : '#fff'};color:${theme === 'dark' ? '#eee' : '#222'};font-family:system-ui"><section id="settings-usage" style="max-width:900px;margin:auto;display:grid;gap:16px">${await edge.render('partials/settings/usage')}</section><script src="/assets/quotas.js"></script></body></html>` })
        })
        await page.goto('https://quota.test/#usage')
        await page.waitForFunction(() => document.querySelector('#quotaCards').getAttribute('aria-busy') === 'false')
        assert.equal(await page.locator('progress').count(), 3)
        assert.deepEqual(await page.locator('progress').evaluateAll(nodes => nodes.map(n => n.value)), [75, 20, 0])
        assert.deepEqual(await page.locator('progress').evaluateAll(nodes => nodes.map(n => n.dataset.level)), ['good', 'warning', 'low'])
        assert.match(await page.locator('#quotaCards').innerText(), lang === 'en' ? /75% remaining/ : /Sisa 75%/)
        assert.ok(await page.locator('progress').first().getAttribute('aria-label'))
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        await page.screenshot({ path: `/private/tmp/ai-quota-${engine}-${width}.png`, fullPage: true })
        response = { providers: [
          { provider: 'chatgpt', refreshFailed: true, windows: [{ ...windowData(75), stale: true }] },
          { provider: 'claude', windows: [] },
        ] }
        await page.locator('#usageRefresh').click()
        await page.waitForFunction(() => document.querySelector('progress')?.dataset.level === 'stale')
        assert.equal(await page.locator('progress').count(), 1)
        assert.match(await page.locator('#quotaCards').innerText(), lang === 'en' ? /Quota unavailable/ : /Kuota belum tersedia/)
        response = { providers: [{ provider: 'chatgpt', windows: [{ ...windowData(75), resetsAt: now / 1000 - 1 }] }] }
        await page.locator('#usageRefresh').click()
        await page.waitForFunction(() => document.querySelectorAll('progress').length === 0)
        assert.match(await page.locator('#quotaCards').innerText(), lang === 'en' ? /Awaiting data after reset/ : /Menunggu data setelah reset/)
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally { await browser.close() }
  })
}
