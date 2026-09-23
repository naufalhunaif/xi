import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name}: visible model options, custom ID and independent reasoning/speed autosave`, async () => {
    const edge = new Edge({ cache: false })
    edge.mount(new URL('../resources/views', import.meta.url).pathname)
    const browser = await engine.launch({ headless: true })
    try {
      for (const colorScheme of ['light', 'dark']) {
        const settings = { aiEnabled: false, aiProvider: 'chatgpt', aiFailover: false, chatgptModel: 'saved-custom-model', claudeModel: 'opus', chatgptReasoning: 'high', claudeReasoning: 'medium', chatgptSpeed: 'standard', claudeSpeed: 'standard', codexBin: '', claudeBin: '' }
        const content = await edge.render('partials/settings/ai', { settings, oauth: { connected: true }, claudeOauth: { connected: true } })
        const context = await browser.newContext({ colorScheme, viewport: colorScheme === 'dark' ? { width: 390, height: 844 } : { width: 1280, height: 900 } })
        const page = await context.newPage()
        const requests = []
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await context.route('**/*', async route => {
          const path = new URL(route.request().url()).pathname
          if (path === '/settings') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8"><meta name="app-url" content="https://models.test"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/forms.css"></head><body class="workspace-ui"><main style="padding:16px;max-width:560px"><div class="wa-panel wa-settings-panel"><form id="settingsForm">${content}<span id="settingsSaveState"></span></form></div></main><script src="/assets/model_settings.js"></script><script src="/assets/app.js"></script></body></html>` })
          if (path === '/store.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('../../store/assets/css/app.css', import.meta.url), 'utf8') })
          if (path.startsWith('/assets/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8') })
          if (path === '/api/settings') {
            const input = route.request().postDataJSON()
            requests.push(input)
            if (input.chatgptModel === 'rejected-model') return route.fulfill({ status: 400, json: { error: 'Model rejected fixture' } })
            Object.assign(settings, input)
            return route.fulfill({ json: settings })
          }
          return route.fulfill({ json: { connected: true, available: true, connections: [] } })
        })
        await page.goto('https://models.test/settings')
        assert.equal(await page.locator('#chatgptModelPicker').inputValue(), '__custom__')
        assert.equal(await page.locator('[name=chatgptModel]').inputValue(), 'saved-custom-model')
        const save = async (selector, value, key) => {
          if (settings[key] === value) return
          const response = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().postDataJSON()?.[key] === value)
          await page.locator(selector).selectOption(value)
          await response
        }
        for (const provider of ['chatgpt', 'claude']) {
          if (provider === 'claude') await save('#aiProvider', 'claude', 'aiProvider')
          const picker = page.locator(`#${provider}ModelPicker`)
          assert.ok(await picker.isVisible())
          const options = await picker.locator('option').allTextContents()
          assert.ok(options.length >= 5)
          assert.ok(options.every(text => text.trim().length > 0))
          const colors = await picker.evaluate(el => { const s = getComputedStyle(el); return [s.color, s.backgroundColor, s.webkitTextFillColor, s.colorScheme] })
          assert.deepEqual(colors, ['rgb(38, 38, 38)', 'rgb(255, 255, 255)', 'rgb(38, 38, 38)', 'light'])
          await save(`#${provider}ModelPicker`, provider === 'chatgpt' ? 'gpt-6-astra' : 'sonnet', `${provider}Model`)
          if (provider === 'claude') await save('#claudeModelPicker', 'opus', 'claudeModel')
          await save(`[name=${provider}Reasoning]`, 'high', `${provider}Reasoning`)
          await save(`[name=${provider}Speed]`, 'fast', `${provider}Speed`)
          assert.equal(await page.locator(`[name=${provider}Reasoning]`).inputValue(), 'high')
          assert.equal(settings[`${provider}Reasoning`], 'high')
          await save(`[name=${provider}Speed]`, 'standard', `${provider}Speed`)
        }
        await save('#aiProvider', 'chatgpt', 'aiProvider')
        // The failover switch is an ordinary autosaved setting, not a second engine picker.
        assert.equal(await page.locator('[name=aiFailover]').getAttribute('aria-checked'), 'false')
        const failover = page.waitForResponse(
          (r) => r.url().endsWith('/api/settings') && r.request().postDataJSON()?.aiFailover === true
        )
        await page.locator('[name=aiFailover]').click()
        await failover
        assert.equal(await page.locator('[name=aiFailover]').getAttribute('aria-checked'), 'true')
        assert.equal(settings.aiFailover, true)
        const count = requests.length
        await page.locator('#chatgptModelPicker').selectOption('__custom__')
        assert.equal(requests.length, count)
        assert.ok(await page.locator('[name=chatgptModel]').isVisible())
        const response = page.waitForResponse(r => r.url().endsWith('/api/settings') && r.request().postDataJSON()?.chatgptModel === 'rejected-model')
        await page.locator('[name=chatgptModel]').fill('rejected-model')
        await response
        await page.locator('#chatgptModelPicker[aria-invalid=true]').waitFor()
        assert.ok(await page.locator('[name=chatgptModel]').isVisible())
        assert.ok(requests.every(payload => Object.keys(payload).length === 1 && !Object.values(payload).includes('__custom__')))
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
        assert.deepEqual(errors, [])
        if (name === 'webkit' && colorScheme === 'light') await page.screenshot({ path: '/private/tmp/wa-model-settings-webkit.png', fullPage: true })
        await context.close()
      }
    } finally { await browser.close() }
  })
}
