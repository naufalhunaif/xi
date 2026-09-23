import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { webkit, chromium } from 'playwright'

test('chat cleanup confirmation, progress and layouts in EN/ID (mock API only)', async () => {
  const root = new URL('../', import.meta.url)
  const html = await readFile(new URL('resources/views/pages/dashboard.edge', root), 'utf8')
  const panel = html.match(/<div class="wa-chat-cleanup">[\s\S]*?<\/div>/)[0]
  const script = await readFile(new URL('public/assets/chat_cleanup.js', root), 'utf8')
  const css = (
    await Promise.all(
      [
        '../store/assets/css/app.css',
        '../store/assets/css/workspace.css',
        'public/assets/app.css',
        'public/assets/forms.css',
      ].map((path) => readFile(new URL(path, root), 'utf8'))
    )
  ).join('\n')
  const browser = await (process.env.PLAYWRIGHT_BROWSER === 'chromium' ? chromium : webkit).launch({
    headless: true,
  })
  try {
    for (const lang of ['en', 'id'])
      for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 800 } })
        await page.clock.install()
        let status = 'idle'
        const posts = []
        const errors = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.route('https://cleanup.test/**', async (route) => {
          if (route.request().url().includes('/api/chats/cleanup')) {
            if (route.request().method() === 'POST') {
              posts.push(route.request().postDataJSON())
              assert.equal(route.request().headers()['x-csrf-token'], 'fixture-csrf')
              status = 'pending'
            }
            return route.fulfill({ json: { status } })
          }
          return route.fulfill({
            contentType: 'text/html',
            body: `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://cleanup.test/whatsapp"><meta name="csrf-token" content="fixture-csrf"><style>${css}</style><body class="workspace-ui"><main class="wa-settings-panel" style="margin:20px;max-width:800px"><h2>Settings</h2>${panel}</main></body>`,
          })
        })
        await page.goto('https://cleanup.test/whatsapp/settings')
        await page.addScriptTag({
          content: await readFile(new URL(`public/lang/${lang}.js`, root), 'utf8'),
        })
        await page.evaluate((language) => {
          window.waI18n = { t: (text) => window.waLocales[language][text] || text }
          document.querySelector('[data-i18n]').textContent = window.waI18n.t('Hapus chat & media')
        }, lang)
        await page.addScriptTag({ content: script })
        page.once('dialog', (dialog) => dialog.dismiss())
        await page.locator('#chatCleanupButton').click()
        assert.equal(posts.length, 0)
        page.once('dialog', async (dialog) => {
          assert.match(
            dialog.message(),
            lang === 'en' ? /cannot be undone/ : /Tidak dapat dibatalkan/
          )
          await dialog.accept()
        })
        const posted = page.waitForResponse(
          (response) =>
            response.url().includes('/api/chats/cleanup') && response.request().method() === 'POST'
        )
        await page.locator('#chatCleanupButton').click()
        await page.waitForFunction(() => document.getElementById('chatCleanupButton').disabled)
        await posted
        assert.deepEqual(posts, [{ confirmation: 'DELETE' }])
        await page.screenshot({ path: `/private/tmp/chat-cleanup-${lang}-${width}.png` })
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        status = 'completed'
        await page.clock.fastForward(5000)
        await page.waitForFunction(() => !document.getElementById('chatCleanupButton').disabled)
        assert.match(
          await page.locator('#chatCleanupStatus').innerText(),
          lang === 'en' ? /deleted/ : /dihapus/
        )
        assert.equal(posts.length, 1)
        assert.deepEqual(errors, [])
        await page.close()
      }
  } finally {
    await browser.close()
  }
})

test('Danger reset requires typed confirmation; scopes number, reports progress, no duplicate POST (mock only)', async () => {
  const root = new URL('../', import.meta.url)
  const html = await readFile(new URL('resources/views/pages/dashboard.edge', root), 'utf8')
  const panel = html
    .match(/<section id="settings-danger"[\s\S]*?<\/section>/)[0]
    .replace(' hidden', '')
  const general = html.match(/<div class="wa-chat-cleanup">[\s\S]*?<\/div>/)[0]
  const script = await readFile(new URL('public/assets/chat_cleanup.js', root), 'utf8')
  const css = (
    await Promise.all(
      [
        '../store/assets/css/app.css',
        '../store/assets/css/workspace.css',
        'public/assets/app.css',
        'public/assets/forms.css',
        'public/assets/theme.css',
      ].map((path) => readFile(new URL(path, root), 'utf8'))
    )
  ).join('\n')
  const browser = await (process.env.PLAYWRIGHT_BROWSER === 'chromium' ? chromium : webkit).launch({
    headless: true,
  })
  try {
    for (const [lang, theme, width] of [
      ['en', 'light', 1440],
      ['id', 'dark', 390],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 850 } })
      await page.clock.install()
      let state = { status: 'idle', mode: 'chat', phone: '628000000002' }
      const posts = []
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('https://cleanup.test/**', async (route) => {
        if (route.request().url().includes('/api/chats/cleanup')) {
          if (route.request().method() === 'POST') {
            posts.push(route.request().postDataJSON())
            assert.equal(route.request().headers()['x-csrf-token'], 'fixture-csrf')
            state = { ...state, status: 'pending', mode: 'all' }
          }
          return route.fulfill({ json: state })
        }
        return route.fulfill({
          contentType: 'text/html',
          body: `<html data-theme="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://cleanup.test/whatsapp"><meta name="csrf-token" content="fixture-csrf"><style>${css}</style><body class="workspace-ui"><main class="wa-settings-panel" style="margin:20px;max-width:650px">${panel}<div hidden>${general}</div></main></body></html>`,
        })
      })
      await page.goto('https://cleanup.test/whatsapp/settings#danger')
      await page.addScriptTag({
        content: await readFile(new URL(`public/lang/${lang}.js`, root), 'utf8'),
      })
      await page.evaluate((language) => {
        window.waI18n = { t: (text) => window.waLocales[language][text] || text }
        document.querySelectorAll('[data-i18n]').forEach((el) => {
          el.textContent = window.waI18n.t(el.dataset.i18n)
        })
      }, lang)
      await page.addScriptTag({ content: script })
      await page.waitForFunction(() => !document.getElementById('dataResetButton').disabled)
      assert.equal(await page.locator('#dataResetPhone').innerText(), '+628000000002')
      page.once('dialog', (dialog) => dialog.dismiss())
      await page.locator('#dataResetButton').click()
      assert.equal(posts.length, 0)
      const attempt = async (value) => {
        const handle = async (dialog) => {
          if (dialog.type() === 'confirm') {
            assert.match(dialog.message(), /628000000002/)
            assert.match(dialog.message(), /Orion\/MCP/)
            await dialog.accept()
          } else await dialog.accept(value)
        }
        page.on('dialog', handle)
        await page.locator('#dataResetButton').click()
        page.off('dialog', handle)
      }
      await attempt('DELETE')
      assert.equal(posts.length, 0)
      const posted = page.waitForResponse((response) => response.request().method() === 'POST')
      await attempt('RESET ALL')
      await posted
      await page.waitForFunction(() => document.getElementById('dataResetButton').disabled)
      assert.deepEqual(posts, [{ mode: 'all', confirmation: 'RESET ALL' }])
      await page.screenshot({ path: `/private/tmp/data-reset-${lang}-${width}.png` })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      state.status = 'retrying'
      await page.clock.fastForward(5000)
      assert.equal(await page.locator('#dataResetButton').isDisabled(), true)
      state.status = 'completed'
      await page.clock.fastForward(5000)
      await page.waitForFunction(() => !document.getElementById('dataResetButton').disabled)
      assert.match(
        await page.locator('#dataResetStatus').innerText(),
        lang === 'en' ? /Reset complete/ : /Reset selesai/
      )
      assert.equal(posts.length, 1)
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
