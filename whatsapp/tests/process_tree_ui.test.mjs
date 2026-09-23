// Browser-only fixtures: no database, customer messages, MCP or AI requests.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

const step = (key, label, detail, status = 'completed') => ({ key, label, detail, status })
const fixture = () => ({
  id: 'tree-fixture', status: 'running', createdAt: new Date().toISOString(),
  input: { provider: 'chatgpt', text: 'Ada warna navy?', skills: ['catalog'] },
  steps: [
    step('input', 'Input dan konteks siap'),
    step('queue-timing', 'Waktu tunggu antrean', { elapsedMs: 6100 }),
    step('skill-routing', 'Pemetaan kebutuhan dan skill', { level: 2 }),
    step('analysis', 'Menganalisis input dan data bisnis', { usage: { input: 5100, output: 300, cached: 2000 } }),
    step('analysis:mcp-auth:store', 'Memeriksa akses MCP · store', { source: 'store', stage: 'mcp_auth' }),
    step('analysis:mcp-tools:store', 'Skema tool MCP dikirim ke AI', { server: 'business_store', tools: 3, estimatedTokens: 400 }),
    step('analysis:mcp-tools:fit', 'Skema tool MCP dikirim ke AI', { server: 'fit', tools: 1, estimatedTokens: 150 }),
    step('analysis:model-selection', 'Profil standard · gpt-5.6-terra', { modelSelection: { model: 'gpt-5.6-terra', tier: 'standard', reasoning: 'medium' } }),
    step('analysis:item-1', 'business_store · list_products', { parameters: { color: 'navy' }, result: { ok: true } }),
    step('analysis:mcp-cache:1', 'Hasil MCP langsung', { server: 'business_store', tool: 'list_products', arguments: { color: 'navy' }, cache: { source: 'mcp' }, estimatedTokens: 200 }),
    step('analysis:item-2', 'business_store · list_products', { parameters: { color: 'black' }, result: { ok: true } }),
    step('analysis:mcp-cache:2', 'Hasil MCP dari cache', { server: 'business_store', tool: 'list_products', arguments: { color: 'black' }, cache: { source: 'cache' }, estimatedTokens: 250 }),
    step('analysis:upstream:mcp-cache:1', 'Hasil MCP langsung', { server: 'business_store', tool: 'list_products', arguments: { color: 'navy' }, modelVisible: false, estimatedTokens: 0 }),
    step('compact-expand:prompt-size', 'Ukuran prompt giliran ini', { chars: 24000 }),
    step('analysis:primary:analysis', 'Menganalisis input dan data bisnis', undefined, 'running'),
    step('analysis:primary:analysis:model-selection', 'Profil complex · model utama', { modelSelection: { model: 'primary', tier: 'complex' } }),
    step('analysis:primary:analysis:mcp-cache:1', 'Hasil MCP langsung', { server: 'business_store', tool: 'get_product', arguments: { id: 7 } }, 'running'),
  ],
})
const engines = process.env.PLAYWRIGHT_BROWSER === 'chromium' ? [['chromium', chromium]]
  : process.env.PLAYWRIGHT_BROWSER === 'webkit' ? [['webkit', webkit]]
  : [['chromium', chromium], ['webkit', webkit]]
for (const [name, engine] of engines) {
  test(`${name}: branching phases keep evidence, focus and active glow through polling`, async () => {
    const browser = await engine.launch({ headless: true })
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      let trace = fixture()
      await context.route('**/*', async route => {
        const path = new URL(route.request().url()).pathname
        if (path === '/api/ai/trace') return route.fulfill({ json: { trace } })
        if (['/process.js', '/app.css', '/theme.css'].includes(path)) return route.fulfill({
          contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
          body: await readFile(new URL(`../public/assets${path}`, import.meta.url), 'utf8'),
        })
        assert.equal(path, '/')
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="app-url" content="https://tree.test"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/theme.css"></head><body class="workspace-ui">
          <div id="messages" data-jid="fixture@lid"><button data-trace-id="tree-fixture">Process details</button></div><button id="aiProgress"><span id="aiProgressLabel"></span></button>
          <dialog id="aiTraceDialog" class="wa-trace-dialog"><header class="wa-trace-header"><div><h2>Detail proses</h2><span id="aiTraceStatus"></span></div><button id="aiTraceClose">×</button></header><div id="aiTraceContent" class="wa-trace-content"></div></dialog><script src="/process.js"></script></body></html>` })
      })
      await page.goto('https://tree.test/')
      await page.locator('[data-trace-id]').click()
      const row = key => page.locator(`[data-step-key="${key}"]`)
      const branch = key => page.locator(`[data-key="${key}"]`)
      // Retry is a sibling phase, never attributed to the first model run.
      assert.equal(await page.locator('.wa-trace-activity > ul > .wa-trace-branch[data-step-key]').count(), 2)
      assert.equal(await row('analysis').locator('[data-step-key="analysis:primary:analysis"]').count(), 0)
      assert.match(await branch('analysis').locator(':scope > .wa-trace-step-title').innerText(), /Analisis · 1.*5.400/s)
      assert.match(await branch('analysis:primary:analysis').locator(':scope > .wa-trace-step-title').innerText(), /Analisis lanjutan · 2/)
      // Two calls with different arguments remain distinct. Provider wrappers folded away.
      const family = branch('tree:analysis:tool:store · list_products')
      assert.equal(await page.locator('.wa-trace-step-label', { hasText: /^store · list_products$/ }).count(), 1)
      assert.match(await family.locator(':scope > .wa-trace-step-title').innerText(), /2 panggilan/)
      assert.match(await page.locator('.wa-trace-tools').innerText(), /^3 panggilan tool/) // plus running get_product; excludes upstream copy
      await family.locator(':scope > .wa-trace-step-title').click()
      assert.equal(await family.evaluate(el => el.tagName), 'SECTION') // clicking cannot collapse the graph
      assert.equal(await family.locator('[data-step-key]').count(), 5)
      assert.equal(await row('analysis:item-1').isVisible(), true)
      await branch('analysis:mcp-cache:2').locator(':scope > summary').click()
      assert.match(await branch('analysis:mcp-cache:2').innerText(), /black/)
      assert.equal(await row('analysis:mcp-cache:2').locator('.wa-trace-origin').getAttribute('data-origin'), 'cache')
      assert.equal(await row('analysis:primary:analysis:mcp-cache:1').evaluate(el => el.classList.contains('is-active')), true)
      assert.equal(await row('analysis').evaluate(el => el.classList.contains('is-active')), false)
      assert.equal(await row('analysis:mcp-auth:store').isVisible(), true)
      assert.equal(await page.locator('.wa-trace-branch-content').evaluateAll(nodes => nodes.every(el => el.tagName === 'SECTION')), true)
      assert.equal(await row('analysis').evaluate(el => getComputedStyle(el, '::before').animationName), 'wa-trace-flow')
      const activeRail = branch('analysis:primary:analysis').locator(':scope > .wa-trace-children')
      assert.equal(await activeRail.evaluate(el => getComputedStyle(el, '::after').animationName), 'wa-trace-branch-flow')
      const positions = await activeRail.evaluate(async el => {
        const first = getComputedStyle(el, '::after').offsetDistance
        await new Promise(resolve => setTimeout(resolve, 200))
        return [first, getComputedStyle(el, '::after').offsetDistance]
      })
      assert.notEqual(positions[0], positions[1]) // The data dot actually travels, not just a static glow.

      assert.equal(await branch('analysis').locator(':scope > .wa-trace-children').evaluate(el => el.classList.contains('has-active-route')), false)
      // Polling must not erase the user's disclosure choice, keyboard focus or scroll.
      const focus = branch('analysis:mcp-cache:2').locator(':scope > summary')
      await focus.focus()
      trace.steps.push(step('progress-note', 'Draf sedang diperiksa', { note: 'checking' }, 'running'))
      await page.waitForSelector('[data-step-key="progress-note"]')
      assert.equal(await branch('analysis:mcp-cache:2').evaluate(el => el.open), true)
      assert.equal(await focus.evaluate(el => el === document.activeElement), true)
      await focus.click()
      await page.locator('.wa-trace-content').evaluate(el => el.scrollTop = 0)
      await page.screenshot({ path: `/private/tmp/process-tree-${name}-desktop.png` })
      await page.setViewportSize({ width: 390, height: 844 })
      await page.evaluate(() => document.documentElement.dataset.theme = 'dark')
      await row('analysis:primary:analysis').scrollIntoViewIfNeeded()
      await page.screenshot({ path: `/private/tmp/process-tree-${name}-mobile-dark.png` })
      assert.equal(await page.locator('.wa-trace-content').evaluate(el => el.scrollWidth <= el.clientWidth), true)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await row('analysis:primary:analysis:mcp-cache:1').evaluate(el => getComputedStyle(el, '::after').animationName), 'none')
      assert.equal(await activeRail.evaluate(el => getComputedStyle(el, '::after').animationName), 'none')
      assert.equal(await row('analysis').evaluate(el => getComputedStyle(el, '::before').animationName), 'none')
      // No glow if the trace goes stale, even if old records still say running.
      trace.status = 'interrupted'
      await page.waitForSelector('.wa-trace-diagnostic')
      assert.equal(await page.locator('#aiTraceDialog .is-active, #aiTraceDialog .wa-text-glow, #aiTraceDialog .has-active-route').count(), 0)
      assert.equal(await row('analysis:primary:analysis:mcp-cache:1').evaluate(el => el.classList.contains('is-interrupted')), true)
      // A failed nested call stays visible under an otherwise completed parent.
      trace.status = 'completed'
      trace.steps.find(s => s.key === 'analysis:mcp-cache:1').status = 'failed'
      trace.steps = trace.steps.map(s => s.status === 'running' ? { ...s, status: 'completed' } : s)
      await page.waitForFunction(() => document.querySelector('[data-step-key="analysis:mcp-cache:1"]').classList.contains('is-failed'))
      assert.equal(await row('analysis:mcp-cache:1').isVisible(), true)
      assert.equal(await page.locator('#aiTraceDialog .is-active').count(), 0)
      await page.keyboard.press('Escape')
      assert.equal(await page.locator('[data-trace-id]').evaluate(el => el === document.activeElement), true)
      assert.deepEqual(errors, [])
      await context.close()
    } finally { await browser.close() }
  })
}
