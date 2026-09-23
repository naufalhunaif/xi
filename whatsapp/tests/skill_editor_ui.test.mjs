// All HTTP and AI responses are fixtures. Never edits live settings or sends messages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

test('skill instruction form: explicit submit, polling, reload recovery, failures and EN/ID responsive layout', async () => {
  const edge = new Edge({ cache: false })
  edge.mount(new URL('../resources/views', import.meta.url).pathname)
  const skills = [{ id: 7, name: 'language', updatedAt: new Date().toISOString(), updatedAtLabel: 'Today' }]
  const content = await edge.render('partials/settings/skills', { settings: { skills }, appUrl: 'https://skill.test' })
  const browser = await (process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true })
  try {
    for (const locale of ['en', 'id']) for (const width of [1440, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 850 } })
      const page = await context.newPage()
      await page.clock.install()
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const posts = []
      let job = { status: 'running', changes: [] }
      await context.route('**/*', async (route) => {
        const path = new URL(route.request().url()).pathname
        if (path === '/settings') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://skill.test"><meta name="whatsapp-workspace" content="fixture"><meta name="csrf-token" content="test"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/forms.css"><link rel="stylesheet" href="/assets/skill_editor.css"><style>body{margin:0;padding:16px}.wa-settings-panel{max-width:700px;margin:auto}</style></head><body class="workspace-ui"><div class="wa-panel wa-settings-panel"><form id="settingsForm">${content}</form></div><script src="/lang/${locale}.js"></script><script src="/translate.js"></script><script src="/assets/app.js"></script><script src="/assets/skill_editor.js"></script></body></html>` })
        if (path === '/translate.js') return route.fulfill({ contentType: 'text/javascript', body: `window.waI18n={t:(key,...args)=>(window.waLocales['${locale}'][key]||key).replaceAll('{0}',args[0]??'')};document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=window.waI18n.t(el.dataset.i18n));document.querySelectorAll('[data-i18n-placeholder]').forEach(el=>el.placeholder=window.waI18n.t(el.dataset.i18nPlaceholder));` })
        if (path === '/store.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('../../store/assets/css/app.css', import.meta.url), 'utf8') })
        if (path.startsWith('/assets/') || path.startsWith('/lang/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8') })
        if (path === '/api/settings/skill-edits' && route.request().method() === 'POST') {
          assert.equal(route.request().headers()['x-csrf-token'], 'test')
          posts.push(route.request().postDataJSON())
          job = { ...job, id: posts.at(-1).requestKey }
          return route.fulfill({ status: 202, json: job })
        }
        if (path.startsWith('/api/settings/skill-edits/')) return route.fulfill({ json: job })
        if (route.request().method() !== 'GET') throw new Error(`Unexpected write: ${path}`)
        return route.fulfill({ json: {} })
      })
      await page.goto('https://skill.test/settings')
      const button = page.locator('#skillEditSubmit')
      await button.click()
      assert.equal(posts.length, 0)
      await page.locator('#skillEditInstruction').fill('Tampilkan total 100 + 100 = 200')
      assert.equal(posts.length, 0)
      await button.click()
      await page.waitForFunction(() => document.querySelector('#skillEditSubmit').disabled)
      await page.reload()
      await page.waitForFunction(() => document.querySelector('#skillEditSubmit').disabled)
      assert.equal(posts.length, 1)
      assert.equal(await page.locator('#skillEditInstruction').inputValue(), 'Tampilkan total 100 + 100 = 200')
      job = { ...job, status: 'completed', summary: 'Format updated.', changes: [{ name: 'language', action: 'updated' }], skills }
      await page.clock.fastForward(3100)
      await page.waitForFunction(() => !document.querySelector('#skillEditSubmit').disabled)
      assert.match(await page.locator('#skillEditStatus').textContent(), locale === 'en' ? /Skills updated/ : /Skill diperbarui/)
      assert.equal(await page.locator('[data-skill-row="7"]').count(), 1)
      assert.match(await page.locator('[data-skill-download="7"]').getAttribute('href'), /\/7\/download$/)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: `/private/tmp/skill-editor-${locale}-${width}.png` })
      job = { status: 'failed', errorCode: 'USAGE_LIMIT', summary: 'Limit reached' }
      await page.locator('#skillEditInstruction').fill('Buat lebih singkat')
      await button.click()
      await page.waitForFunction(() => document.querySelector('#skillEditStatus').textContent.includes('USAGE_LIMIT'))
      assert.equal(await button.isEnabled(), true)
      assert.equal(await page.locator('[data-skill-row="7"]').count(), 1)
      assert.equal(posts.length, 2)
      assert.notEqual(posts[0].requestKey, posts[1].requestKey)
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally { await browser.close() }
})
