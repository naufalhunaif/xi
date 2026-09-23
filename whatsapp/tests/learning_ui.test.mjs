// Real partial and scripts; all APIs mocked. No AI, DB, or messages.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'
const edge = new Edge({ cache: false })
edge.mount(new URL('../resources/views', import.meta.url).pathname)
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name}: learning autosave, stale revision, rollback, EN/ID and responsive themes`, async () => {
    const content = await edge.render('partials/settings/evaluation')
    const browser = await engine.launch({ headless: true })
    try {
      for (const locale of ['en', 'id']) for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 850 } })
        const page = await context.newPage()
        const errors = [], writes = []
        page.on('pageerror', error => errors.push(error.message))
        let reject = false
        let data = { enabled: false, ready: true, blocked: false, revision: 'r1', activeVersion: 1,
          patterns: [{ kind: 'photo_initiative', customers: 3, eligible: true }],
          versions: [{ id: 1, kind: 'photo_initiative', status: 'applied', canRollback: true, proposal: '# Conversation learning\nKeep owner rules.\n<img src=x onerror=alert(1)>', updatedAt: new Date().toISOString(), tests: { before: [{ id: 'photo-next', passed: false }], after: [{ id: 'photo-next', passed: true }] } }],
        }
        await context.route('**/*', async route => {
          const path = new URL(route.request().url()).pathname
          if (path === '/settings') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html lang="${locale}" data-theme="${width === 390 ? 'dark' : 'light'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://learning.test"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/forms.css"><link rel="stylesheet" href="/assets/learning.css"><link rel="stylesheet" href="/assets/theme.css"><style>body{margin:0;padding:16px}.wa-settings-panel{max-width:720px;margin:auto}</style></head><body class="workspace-ui"><div class="wa-panel wa-settings-panel"><form id="settingsForm">${content}</form></div><script src="/lang/${locale}.js"></script><script src="/translate.js"></script><script src="/assets/app.js"></script><script src="/assets/info.js"></script><script src="/assets/learning.js"></script></body></html>` })
          if (path === '/translate.js') return route.fulfill({ contentType: 'text/javascript', body: `window.waI18n={locale:'${locale}',t:(key,...args)=>(window.waLocales['${locale}'][key]||key).replace(/\\{(\\d+)\\}/g,(m,i)=>args[i]??m)};document.querySelectorAll('[data-i18n]').forEach(el=>el.textContent=window.waI18n.t(el.dataset.i18n));` })
          if (path === '/store.css') return route.fulfill({ contentType: 'text/css', body: await readFile(new URL('../../store/assets/css/app.css', import.meta.url), 'utf8') })
          if (path.startsWith('/assets/') || path.startsWith('/lang/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8') })
          if (path.startsWith('/api/ai/learning')) {
            if (route.request().method() !== 'GET') {
              assert.equal(route.request().headers()['x-csrf-token'], 'fixture')
              const body = route.request().postDataJSON(); writes.push({ path, body })
              if (reject) return route.fulfill({ status: 409, json: { error: 'Pengaturan berubah. Muat ulang halaman.' } })
              assert.equal(body.revision, data.revision)
              if (path.endsWith('/rollback')) data = { ...data, enabled: false, revision: 'r3', activeVersion: null, versions: [{ ...data.versions[0], canRollback: false, status: 'rolled_back' }] }
              else data = { ...data, enabled: body.enabled, revision: 'r2' }
            }
            return route.fulfill({ json: data })
          }
          assert.equal(route.request().method(), 'GET', `Unexpected write ${path}`)
          return route.fulfill({ json: {} })
        })
        await page.goto('https://learning.test/settings#evaluation')
        await page.waitForFunction(() => !document.getElementById('learningToggle').disabled)
        await page.locator('#learningToggle').click()
        await page.waitForFunction(() => document.getElementById('learningToggle').getAttribute('aria-checked') === 'true')
        assert.equal(writes.length, 1) // Generic settings autosave must not also fire.
        await page.locator('#conversationLearning > details > summary').click()
        await page.locator('#learningVersions details summary').click()
        assert.equal(await page.locator('#learningVersions img').count(), 0)
        await page.locator('[data-info-target="learningInfo"]').click()
        assert.equal(await page.locator('#learningInfo').isVisible(), true)
        await page.keyboard.press('Escape')
        assert.equal(await page.locator('#learningInfo').isVisible(), false)
        await page.locator('#evaluationRefresh').click()
        await page.waitForFunction(() => document.getElementById('conversationLearning').getAttribute('aria-busy') === 'false')
        assert.equal(await page.locator('#learningVersions details').getAttribute('open'), '')
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await page.screenshot({ path: `/private/tmp/learning-${name}-${locale}-${width}.png` })
        page.once('dialog', dialog => dialog.dismiss())
        await page.locator('[data-rollback]').click()
        assert.equal(writes.length, 1)
        page.once('dialog', dialog => dialog.accept())
        await page.locator('[data-rollback]').click()
        await page.waitForFunction(() => !document.querySelector('[data-rollback]'))
        assert.equal(writes.length, 2)
        assert.equal(await page.locator('#learningToggle').getAttribute('aria-checked'), 'false')
        reject = true
        await page.locator('#learningToggle').click()
        await page.waitForFunction(() => document.getElementById('learningStatus').dataset.error === 'true')
        assert.equal(await page.locator('#learningToggle').isDisabled(), true)
        reject = false
        await page.locator('#evaluationRefresh').click()
        await page.waitForFunction(() => !document.getElementById('learningToggle').disabled)
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally { await browser.close() }
  })
}
