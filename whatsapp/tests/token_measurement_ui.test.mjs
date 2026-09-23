// All HTTP is fulfilled from fixtures. No account, worker, database or AI calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

const root = new URL('../', import.meta.url)
const engines =
  process.env.PLAYWRIGHT_BROWSER === 'webkit'
    ? [['webkit', webkit]]
    : process.env.PLAYWRIGHT_BROWSER === 'chromium'
      ? [['chromium', chromium]]
      : [['chromium', chromium], ['webkit', webkit]]

const trace = {
  id: 'fixture',
  status: 'completed',
  createdAt: new Date().toISOString(),
  input: { provider: 'chatgpt', model: 'gpt-6-astra', text: 'Ada size S?', skills: [] },
  steps: [
    {
      key: 'prompt-size',
      label: 'Ukuran prompt giliran ini',
      status: 'completed',
      detail: {
        estimated: true,
        chars: 101544,
        tokens: 27444,
        note: 'Perkiraan lokal per bagian; angka token aktual ada pada tiap fase AI.',
        sections: [
          { key: 'skill: cs-cart-order', chars: 16082, tokens: 4347 },
          { key: 'aturan-cart-order', chars: 8550, tokens: 2311 },
          { key: 'riwayat-percakapan', chars: 7200, tokens: 1946 },
          { key: 'state-cart-order', chars: 4000, tokens: 1081 },
        ],
      },
    },
    {
      key: 'analysis:mcp-tools:store',
      label: 'Skema tool MCP dikirim ke AI',
      status: 'completed',
      detail: { server: 'business_store', tools: 9, chars: 21400, estimatedTokens: 5784 },
    },
    {
      key: 'analysis:mcp-cache:1',
      label: 'Hasil MCP langsung',
      status: 'completed',
      detail: {
        server: 'business_store',
        tool: 'list_records',
        chars: 148000,
        estimatedTokens: 40000,
        cache: { source: 'mcp', status: 'bypass' },
      },
    },
    {
      key: 'analysis:mcp-cache:2',
      label: 'Hasil MCP langsung',
      status: 'completed',
      detail: {
        server: 'business_store',
        tool: 'get_record',
        chars: 18500,
        estimatedTokens: 5000,
        cache: { source: 'mcp', status: 'bypass' },
      },
    },
    {
      key: 'analysis',
      label: 'Menganalisis input dan data bisnis',
      status: 'completed',
      durationMs: 24000,
      detail: { provider: 'chatgpt', usage: { input: 118000, output: 1400, cached: 92000, cacheWrite: 21000 } },
    },
    {
      key: 'business-recheck-run',
      label: 'Menganalisis input dan data bisnis',
      status: 'completed',
      durationMs: 19000,
      detail: { provider: 'chatgpt', usage: { input: 96000, output: 900, cached: 81000, cacheWrite: 0 } },
    },
  ],
  decision: { decision: 'reply', summary: 'Size S tersedia.' },
}
const usage = {
  days: 30,
  providers: [
    { provider: 'chatgpt', runs: 40, measured: 40, input: 4_000_000, output: 52_000, cached: 3_100_000, cacheWrite: 410_000, failed: 1, durationMs: 21000 },
    { provider: 'claude', runs: 0, measured: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, failed: 0, durationMs: 0 },
  ],
  phases: [
    { phase: 'analysis', runs: 22, input: 2_400_000, output: 31_000, cached: 1_900_000, cacheWrite: 240_000, durationMs: 24000 },
    { phase: 'business-recheck-run', runs: 12, input: 1_200_000, output: 14_000, cached: 950_000, cacheWrite: 0, durationMs: 19000 },
    { phase: 'comparison', runs: 6, input: 400_000, output: 7_000, cached: 250_000, cacheWrite: 30_000, durationMs: 31000 },
  ],
  recent: [
    { id: 2, provider: 'chatgpt', phase: 'business-recheck-run', model: 'gpt-6-astra', status: 'completed', tokens: 96_900, input: 96_000, output: 900, cached: 81_000, cacheWrite: 0, durationMs: 19000, createdAt: new Date().toISOString() },
    { id: 1, provider: 'chatgpt', phase: 'analysis', model: 'gpt-6-astra', status: 'completed', tokens: 119_400, input: 118_000, output: 1400, cached: 92_000, cacheWrite: 21_000, durationMs: 24000, createdAt: new Date().toISOString() },
  ],
}

for (const [name, engine] of engines) {
  test(`${name}: process detail attributes tokens per phase and prompt section`, async () => {
    const browser = await engine.launch({ headless: true })
    try {
      for (const locale of ['id', 'en']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
        const page = await context.newPage()
        const errors = []
        let interrupted = false
        page.on('pageerror', (error) => errors.push(error.message))
        await context.route('**/*', async (route) => {
          const path = new URL(route.request().url()).pathname
          if (path === '/api/ai/trace') {
            const fixture = structuredClone(trace)
            if (interrupted) {
              fixture.status = 'interrupted'
              fixture.steps = [
                { key: 'analysis', label: 'Menganalisis input dan data bisnis', status: 'running' },
                { ...fixture.steps[1] },
              ]
              return route.fulfill({ json: { trace: fixture } })
            }
            // Existing persisted traces must remain readable after the redaction fix.
            if (locale === 'en') {
              const detail = fixture.steps[0].detail
              detail.tokens = '[disembunyikan]'
              detail.sections.forEach(row => { row.tokens = '[disembunyikan]' })
              fixture.steps.forEach(step => {
                if ('estimatedTokens' in step.detail) step.detail.estimatedTokens = '[disembunyikan]'
              })
            }
            return route.fulfill({ json: { trace: fixture } })
          }
          if (['/process.js', '/app.css', '/lang.js'].includes(path))
            return route.fulfill({
              contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
              body: await readFile(new URL(path === '/lang.js' ? `public/lang/${locale}.js` : `public/assets${path}`, root), 'utf8'),
            })
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8">
              <meta name="app-url" content="https://tokens.test"><meta name="viewport" content="width=device-width">
              <link rel="stylesheet" href="/app.css"></head><body class="workspace-ui">
              <div id="messages" data-jid="audit@lid"><button data-trace-id="fixture">Detail</button></div><small id="roomGoalStatus"></small>
              <button id="aiProgress"><span id="aiProgressLabel"></span></button>
              <dialog id="aiTraceDialog"><button id="aiTraceClose">Close</button><span id="aiTraceStatus"></span><div id="aiTraceContent"></div></dialog>
              <script src="/lang.js"></script><script>window.waI18n={locale:'${locale}',t:(key,...args)=>(window.waLocales['${locale}'][key]||key).replace(/\\{(\\d+)\\}/g,(_,i)=>args[i]??'')}</script>
              <script src="/process.js"></script></body></html>`,
          })
        })
        await page.goto('https://tokens.test/')
        await page.locator('[data-trace-id]').click()
        await page.waitForSelector('[data-key="activity-timeline"]')

        // The turn total is the headline: several full AI calls, not one.
        const headline = await page.locator('.wa-trace-expanded-label').innerText()
        assert.match(headline, /216[.,]300/, headline)
        assert.match(
          await page.locator('.wa-trace-expanded-label').getAttribute('title'),
          /173[.,]000/
        )

        // The compounding cost is summed up front instead of left to manual addition.
        const tools = await page.locator('.wa-trace-tools').innerText()
        assert.match(tools, /2/)
        assert.match(tools, /45[.,]000/)
        assert.match(tools, /5[.,]784/)
        assert.ok(await page.locator('.wa-trace-tools').getAttribute('title'))

        // Each phase carries the provider's own numbers, marked as exact.
        const phase = page.locator('[data-key="analysis"] > .wa-trace-step-title .wa-trace-step-meta')
        assert.match(await phase.innerText(), /119[.,]400/)
        assert.equal(await phase.getAttribute('data-tokens'), 'exact')
        assert.match(await phase.getAttribute('title'), /92[.,]000/)
        // Writes are shown apart from reads: paying to write and never reading is its own problem.
        assert.match(await phase.getAttribute('title'), /21[.,]000/)

        // Our own character estimates are shown separately and never claimed as exact.
        const schema = page.locator('[data-key="analysis:mcp-tools:store"] > summary .wa-trace-step-meta')
        assert.match(await schema.innerText(), /≈\s?5[.,]784/)
        assert.equal(await schema.getAttribute('data-tokens'), 'estimated')

        // Prompt composition: which section is actually expensive.
        await page.locator('[data-key="prompt-size"] > summary').click()
        const sizes = page.locator('[data-key="prompt-size"] .wa-trace-sizes tr')
        assert.equal(await sizes.count(), 4)
        const first = await sizes.first().innerText()
        assert.match(first, /cs-cart-order/)
        assert.match(first, locale === 'en' ? /4[.,]346/ : /4[.,]347/)
        assert.match(first, /16%/) // Share of the whole prompt, not just the visible rows.
        assert.match(
          await page.locator('[data-key="prompt-size"] > summary').innerText(),
          /≈\s?27[.,]444/
        )
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        assert.ok(!(await page.locator('#aiTraceContent').innerText()).includes('NaN'))
        await page.screenshot({ path: `/private/tmp/token-detail-${name}-${locale}.png`, fullPage: true })
        assert.deepEqual(errors, [])
        interrupted = true
        await page.reload()
        await page.locator('[data-trace-id]').click()
        await page.waitForSelector('.wa-trace-diagnostic')
        assert.match(await page.locator('.wa-trace-diagnostic').innerText(), /TRACE_UPDATES_STALE/)
        assert.match(await page.locator('.wa-trace-current-label').innerText(), /Menganalisis input/)
        assert.ok(!(await page.locator('.wa-trace-current-label').innerText()).includes('MCP'))
        assert.match(await page.locator('.wa-trace-diagnostic').innerText(), locale === 'en' ? /has not been confirmed/ : /belum terkonfirmasi/)
        await context.close()
      }
    } finally {
      await browser.close()
    }
  })

  test(`${name}: usage history breaks tokens down by phase`, async () => {
    const edge = new Edge({ cache: false })
    edge.mount(new URL('resources/views', root).pathname)
    const browser = await engine.launch({ headless: true })
    try {
      const content = await edge.render('partials/settings/usage')
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await context.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/ai/usage') return route.fulfill({ json: usage })
        if (path === '/api/ai/quotas') return route.fulfill({ json: { providers: [] } })
        if (path.startsWith('/assets/') || path.startsWith('/lang/'))
          return route.fulfill({
            contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: await readFile(new URL(`public${path}`, root), 'utf8'),
          })
        return route.fulfill({
          contentType: 'text/html; charset=utf-8',
          body: `<!doctype html><html><head><meta charset="utf-8"><meta name="app-url" content="https://tokens.test">
            <meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/assets/app.css">
            <script src="/lang/en.js"></script><script src="/lang/id.js"></script><script src="/assets/i18n.js"></script></head>
            <body class="workspace-ui"><main><form id="settingsForm"><section id="settings-usage" data-settings-panel="usage">${content}</section><button id="evaluationRefresh" hidden></button></form></main>
            <script src="/assets/settings.js"></script></body></html>`,
        })
      })
      await page.goto('https://tokens.test/settings#usage')
      await page.waitForFunction(() => document.querySelectorAll('#usagePhases tr').length > 1)
      const rows = page.locator('#usagePhases tr')
      assert.equal(await rows.count(), 3)
      assert.match(await rows.first().innerText(), /240[.,]000/)
      const top = await rows.first().innerText()
      assert.match(top, /analysis/)
      assert.match(top, /100%/)
      // The recheck phase is visible as its own cost, not folded into the reply.
      const second = await rows.nth(1).innerText()
      assert.match(second, /business-recheck-run/)
      assert.match(second, /1[.,]200[.,]000/)
      assert.match(await page.locator('#usageRecent tr').first().innerText(), /business-recheck-run/)
      assert.match(
        await page.locator('#usageRecent tr').first().getAttribute('title'),
        /81[.,]000/
      )
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await page.screenshot({ path: `/private/tmp/token-usage-${name}.png`, fullPage: true })
      assert.deepEqual(errors, [])
      await context.close()
    } finally {
      await browser.close()
    }
  })
}
