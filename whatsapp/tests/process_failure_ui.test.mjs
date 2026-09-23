// All HTTP is fulfilled from fixtures. No account, worker, database or AI calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

test('failure UI names MCP/provider, explains next action, and hides duplicate wrappers', async () => {
  const browser = await (process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
  try {
    for (const locale of ['en', 'id']) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      let failure = { stage: 'mcp_auth', provider: 'claude', source: 'fit', code: 'MCP_AUTH_REQUIRED', message: 'Autentikasi perlu dihubungkan ulang.', action: 'Hubungkan ulang sumber yang tercantum melalui pengaturan.', retryable: false }
      let trace = {
        id: 'fixture', status: 'failed', createdAt: new Date().toISOString(),
        input: { provider: 'claude', text: 'Yang casual', skills: [] },
        steps: [
          { key: 'input', label: 'Input dan konteks siap', status: 'completed' },
          { key: 'business-check', label: 'Memeriksa data bisnis sebelum menjawab', status: 'failed', detail: { failure } },
          { key: 'analysis', label: 'Menganalisis input dan data bisnis', status: 'failed', detail: failure },
          { key: 'analysis:mcp-auth:fit', label: 'Memeriksa akses MCP · fit', status: 'failed', detail: failure },
        ],
        decision: { error: failure.message, failure },
      }
      await context.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/ai/trace') return route.fulfill({ json: { trace } })
        if (path === '/process.js' || path === '/app.css' || path === '/lang.js') return route.fulfill({
          contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: await readFile(new URL(path === '/lang.js' ? `../public/lang/${locale}.js` : `../public/assets${path}`, import.meta.url), 'utf8'),
        })
        if (path !== '/') throw new Error('Unexpected fixture request')
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="${locale}"><head>
          <meta charset="utf-8">
          <meta name="app-url" content="https://trace.test"><meta name="viewport" content="width=device-width">
          <link rel="stylesheet" href="/app.css"></head><body class="workspace-ui">
          <div id="messages" data-jid="audit@lid"></div><small id="roomGoalStatus"></small>
          <button id="aiProgress"><span id="aiProgressLabel"></span></button>
          <dialog id="aiTraceDialog"><button id="aiTraceClose">Close</button><span id="aiTraceStatus"></span><div id="aiTraceContent"></div></dialog>
          <script src="/lang.js"></script><script>window.waI18n={locale:'${locale}',t:(key,...args)=>(window.waLocales['${locale}'][key]||key).replace(/\\{(\\d+)\\}/g,(_,i)=>args[i]??'')}</script>
          <script src="/process.js"></script></body></html>` })
      })
      await page.goto('https://trace.test/')
      await page.waitForFunction(() => document.querySelector('#aiProgressLabel').textContent.includes('fit'))
      await page.locator('#aiProgress').click()
      await page.waitForFunction(() => document.querySelector('#aiTraceContent').textContent.includes('MCP_AUTH_REQUIRED'))
      assert.equal(await page.locator('.wa-trace-step.is-failed').count(), 1)
      assert.equal(await page.locator('.wa-trace-step').count(), 2)
      assert.match(await page.locator('#aiTraceContent').innerText(), locale === 'en' ? /Reconnect the listed source/ : /Hubungkan ulang sumber/)
      await page.locator('#aiTraceClose').click()
      failure = { stage: 'provider', provider: 'claude', code: 'USAGE_LIMIT', message: 'Batas pemakaian layanan tercapai.', action: 'Tunggu batas pemakaian pulih sebelum mencoba lagi.', retryable: true }
      trace = { ...trace, decision: { error: failure.message, failure }, steps: [
        { key: 'business-check', label: 'Memeriksa data bisnis sebelum menjawab', status: 'failed' },
        { key: 'analysis', label: 'Menganalisis input dan data bisnis', status: 'failed', detail: failure },
      ] }
      await page.locator('#aiProgress').click()
      await page.waitForFunction(() => document.querySelector('#aiTraceContent').textContent.includes('USAGE_LIMIT'))
      assert.equal(await page.locator('.wa-trace-step.is-failed').count(), 1)
      assert.doesNotMatch(await page.locator('#aiTraceContent').innerText(), /MCP_AUTH_REQUIRED/)
      assert.match(await page.locator('.wa-trace-current-label').innerText(), locale === 'en' ? /Claude usage limit reached/ : /Limit penggunaan Claude tercapai/)
      await page.locator('#aiTraceClose').click()
      failure = { ...failure, provider: 'chatgpt' }
      trace = { ...trace, input: { ...trace.input, provider: 'chatgpt' }, decision: { error: failure.message, failure }, steps: [
        { key: 'analysis', label: 'Menganalisis input dan data bisnis', status: 'failed', detail: failure },
      ] }
      await page.locator('#aiProgress').click()
      await page.waitForFunction(() => document.querySelector('.wa-trace-current-label')?.textContent.includes('ChatGPT'))
      assert.match(await page.locator('.wa-trace-current-label').innerText(), locale === 'en' ? /ChatGPT usage limit reached/ : /Limit penggunaan ChatGPT tercapai/)
      await page.locator('#aiTraceClose').click()
      trace = { ...trace, steps: [
        { key: 'cache-hit', label: 'Hasil MCP dari cache', status: 'completed', detail: { server: 'business_orion', tool: 'check_shipping_rates', cache: { source: 'cache', status: 'hit', expiresAt: '2026-09-16T12:15:00.000Z' } } },
        { key: 'cache-live', label: 'Hasil MCP langsung', status: 'completed', detail: { server: 'business_orion', tool: 'track_awb', cache: { source: 'mcp', status: 'bypass' } } },
        { key: 'visual-cache', label: 'Perbandingan visual dari cache', status: 'completed', detail: { source: 'cache', scope: 'observations_only' } },
        { key: 'visual-followup', label: 'Observasi gambar lama digunakan', status: 'completed', detail: { source: 'cache', candidatePixelsVerified: true } },
        { key: 'reply-timing', label: 'Waktu pemrosesan balasan', status: 'completed', durationMs: 0, detail: { elapsedMs: 12300 } },
        { key: 'queue-timing', label: 'Waktu tunggu antrean', status: 'completed', durationMs: 0, detail: { elapsedMs: 6000 } },
        ...trace.steps,
      ] }
      await page.locator('#aiProgress').click()
      await page.waitForFunction(() => document.querySelector('[data-key="cache-hit"]'))
      // The row names what was called; an icon marks whether it came live, from cache, or from the app.
      const origin = (key) => page.locator(`[data-key="${key}"] > summary .wa-trace-origin`)
      assert.match(await page.locator('[data-key="cache-hit"] > summary').innerText(), /^orion · check_shipping_rates/)
      assert.equal(await origin('cache-hit').getAttribute('data-origin'), 'cache')
      assert.match(await page.locator('[data-key="cache-live"] > summary').innerText(), /^orion · track_awb/)
      assert.equal(await origin('cache-live').getAttribute('data-origin'), 'live')
      assert.equal(await origin('visual-cache').getAttribute('data-origin'), 'cache')
      assert.equal(await origin('visual-followup').getAttribute('data-origin'), 'cache')
      // The icon replaces the origin words the label used to repeat.
      for (const key of ['visual-cache', 'visual-followup']) {
        const text = await page.locator(`[data-key="${key}"] > summary .wa-trace-step-label`).innerText()
        assert.doesNotMatch(text, /cache/i)
        assert.ok(text.trim().length > 3, text)
      }
      assert.equal(await origin('reply-timing').getAttribute('data-origin'), 'system')
      assert.equal(await origin('queue-timing').getAttribute('data-origin'), 'system')
      assert.equal(
        await origin('cache-hit').getAttribute('aria-label'),
        locale === 'en' ? 'From cache' : 'Dari cache'
      )
      assert.equal(
        await origin('cache-live').getAttribute('aria-label'),
        locale === 'en' ? 'Live data' : 'Data langsung'
      )
      // The legend keeps the wording the icons replaced in each row.
      assert.equal(await page.locator('.wa-trace-legend .wa-trace-legend-item').count(), 3)
      assert.match(
        await page.locator('.wa-trace-legend').innerText(),
        locale === 'en' ? /Live data.*From cache.*From the app/s : /Data langsung.*Dari cache.*Dari sistem/s
      )
      assert.match(await page.locator('[data-key="reply-timing"] > summary').innerText(), /12[,.]3/)
      assert.match(await page.locator('[data-key="queue-timing"] > summary').innerText(), /6/)
      await page.locator('[data-key="cache-hit"] > summary').click()
      assert.match(await page.locator('[data-key="cache-hit"]').innerText(), /expiresAt/)
      await page.screenshot({ path: `/private/tmp/process-activity-${locale}.png`, fullPage: true })
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally { await browser.close() }
})
