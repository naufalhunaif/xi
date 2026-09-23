import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)
const jid = '181111111111@lid'
const confirmation = 'HAPUS 628111111111'
const fixture = {
  jid,
  phone: '628111111111',
  name: '<img src=x onerror=alert(1)>',
  confirmation,
  counts: { messages: 8, memory: 2, orders: 1, carts: 1, media: 3 },
}

test('customer deletion: exact confirmation, isolated target, progress, mobile and uncertain network (mock API only)', async () => {
  const panel = await readFile(
    new URL('resources/views/partials/contact_delete.edge', root),
    'utf8'
  )
  const script = await readFile(new URL('public/assets/contact_delete.js', root), 'utf8')
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
  const browser = await chromium.launch({ headless: true })
  try {
    for (const [lang, theme, width, failure] of [
      ['en', 'light', 1440, false],
      ['id', 'dark', 390, false],
      ['id', 'light', 390, true],
    ]) {
      const page = await browser.newPage({ viewport: { width, height: 850 } })
      await page.clock.install()
      const posts = [],
        errors = []
      let state = { status: 'idle' }
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route('https://contact.test/**', async (route) => {
        const request = route.request(),
          url = new URL(request.url())
        if (url.pathname.endsWith('/api/chats/cleanup/contact')) {
          assert.equal(url.searchParams.get('jid'), jid)
          return route.fulfill({ json: fixture })
        }
        if (url.pathname.endsWith('/api/chats/cleanup')) {
          if (request.method() === 'POST') {
            posts.push(request.postDataJSON())
            assert.equal(request.headers()['x-csrf-token'], 'fixture-csrf')
            if (failure) return route.abort('failed')
            state = { status: 'pending', requestId: 'fixture-job' }
          }
          return route.fulfill({ json: state })
        }
        return route.fulfill({
          contentType: 'text/html',
          body: `<html data-theme="${theme}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://contact.test/whatsapp"><meta name="csrf-token" content="fixture-csrf"><style>${css}</style><body class="workspace-ui"><button id="contactDeleteButton">Delete customer</button><div id="messages" data-jid="${jid}"></div>${panel}</body></html>`,
        })
      })
      await page.goto('https://contact.test/whatsapp?jid=fixture')
      await page.addScriptTag({
        content: await readFile(new URL(`public/lang/${lang}.js`, root), 'utf8'),
      })
      await page.evaluate((lang) => {
        window.waI18n = { t: (text) => window.waLocales[lang][text] || text }
        document
          .querySelectorAll('[data-i18n]')
          .forEach((el) => (el.textContent = window.waI18n.t(el.dataset.i18n)))
      }, lang)
      await page.addScriptTag({ content: script })
      await page.locator('#contactDeleteButton').click()
      await page.waitForFunction(
        () => !document.getElementById('contactDeleteConfirmation').disabled
      )
      assert.equal(await page.locator('#contactDeleteIdentity img').count(), 0)
      assert.match(await page.locator('#contactDeleteIdentity').innerText(), /628111111111/)
      assert.equal(
        await page
          .locator('#contactDeleteCounts dd')
          .allTextContents()
          .then((values) => values.join(',')),
        '8,2,1,1,3'
      )
      await page.locator('#contactDeleteConfirmation').fill('DELETE')
      assert.equal(await page.locator('#contactDeleteConfirm').isDisabled(), true)
      await page.locator('#contactDeleteClose').click()
      assert.equal(posts.length, 0)
      await page.locator('#contactDeleteButton').click()
      await page.waitForFunction(
        () => !document.getElementById('contactDeleteConfirmation').disabled
      )
      await page.locator('#contactDeleteConfirmation').fill(confirmation)
      await page.screenshot({ path: `/private/tmp/contact-delete-${lang}-${theme}.png` })
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      )
      const dialog = await page.locator('#contactDeleteDialog').boundingBox()
      assert.ok(dialog.x >= 0 && dialog.x + dialog.width <= width)
      await page.locator('#contactDeleteConfirm').click()
      await page.waitForFunction(() => document.getElementById('contactDeleteConfirm').disabled)
      await page.clock.fastForward(5000)
      assert.deepEqual(posts, [{ mode: 'contact', jid, confirmation }])
      if (failure) {
        assert.match(await page.locator('#contactDeleteStatus').innerText(), /jangan kirim ulang/)
      } else {
        state = { status: 'completed', requestId: 'different-job' }
        await page.clock.fastForward(5000)
        assert.match(page.url(), /jid=fixture/)
        state = { status: 'retrying', requestId: 'fixture-job' }
        await page.clock.fastForward(5000)
        await page.waitForFunction(() =>
          /Mencoba kembali|Retrying/.test(
            document.getElementById('contactDeleteStatus').textContent
          )
        )
        state = { status: 'completed', requestId: 'fixture-job' }
        await page.clock.fastForward(5000)
        await page.waitForURL('https://contact.test/whatsapp/')
      }
      assert.equal(posts.length, 1)
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser.close()
  }
})
