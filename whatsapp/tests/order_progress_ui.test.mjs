// Fully intercepted fixture: no database, Orion shipment, AI or WhatsApp call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

test('one-click production stays compact in both languages and viewport sizes', async () => {
  const view = await readFile(
    new URL('../resources/views/partials/orders.edge', import.meta.url),
    'utf8'
  )
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium
  const browser = await engine.launch({ headless: true })
  try {
    for (const language of ['en', 'id']) {
      const context = await browser.newContext()
      const page = await context.newPage()
      await page.clock.install()
      await page.addInitScript({ content: await readFile(new URL('../public/assets/order_shipping_status.js', import.meta.url), 'utf8') })
      await page.addInitScript({
        content: await readFile(
          new URL('../public/assets/order_item_details.js', import.meta.url),
          'utf8'
        ),
      })
      await page.addInitScript(
        (lang) => localStorage.setItem('https://orders.test:ui-language', lang),
        language
      )
      const errors = []
      const writes = []
      page.on('pageerror', (error) => errors.push(error.message))
      const order = {
        id: 1,
        number: 'INV-TEST',
        status: 'active',
        version: 'v1',
        total: 100,
        paid: 100,
        cart: {
          items: [
            {
              name: 'Custom peak — jas',
              size: 'custom',
              quantity: 1,
              measurements: {},
              productionDetails: {
                heightCm: 168,
                weightKg: 84,
                color: 'Navy',
                fit: 'regular',
                lapel: 'Notch lapel dengan list/piping glossy',
                buttons: '2 kancing depan',
                material: '',
                notes: 'Jas mengikuti foto referensi, warna navy dan dua kancing depan.',
                pending: ['Panjang lengan'],
                measurements: [
                  { name: 'Waist', value: 96, basis: 'body' },
                  { name: 'Waist', value: 100, basis: 'garment' },
                ],
              },
            },
          ],
          recipient: { name: 'Fixture' },
        },
        operations: { stage: 'queued', kind: 'custom', estimate: { estimateDays: 5, dayType: 'calendar' }, expectedReadyOn: '2026-09-20', source: 'operator' },
        nextProductionStage: 'production',
        dispatch: 'not_queued',
        paymentTrigger: 'first_payment',
        preview: { number: 'INV-TEST', customerName: 'Fixture', payment: 'Paid', items: [] },
      }
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html; charset=utf-8',
            body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://orders.test"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/orders.css"><link rel="stylesheet" href="/assets/forms.css"><style>body{margin:0;padding:12px;font-family:Arial}</style></head><body>${view}<script src="/lang/en.js"></script><script src="/lang/id.js"></script><script src="/assets/i18n.js"></script><script src="/assets/orders.js"></script></body></html>`,
          })
        if (url.pathname === '/store.css')
          return route.fulfill({
            contentType: 'text/css',
            body: await readFile(
              new URL('../../store/assets/css/app.css', import.meta.url),
              'utf8'
            ),
          })
        if (/^\/(assets|lang)\//.test(url.pathname))
          return route.fulfill({
            contentType: url.pathname.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8',
            body: await readFile(new URL(`../public${url.pathname}`, import.meta.url), 'utf8'),
          })
        if (url.pathname === '/api/orders/routing')
          return route.fulfill({
            json: { version: 'r1', groups: [], paymentTrigger: 'first_payment' },
          })
        if (url.pathname === '/api/orders') {
          if (url.searchParams.has('orderId')) assert.equal(url.searchParams.get('orderId'), '1')
          const tab = url.searchParams.get('tab')
          const visible = tab === 'completed' ? order.operations.stage === 'completed' : tab === 'active' ? order.operations.stage !== 'completed' : true
          const orders = visible ? [order] : []
          return route.fulfill({ json: { page: 1, total: orders.length, orders, sources: [] } })
        }
        if (url.pathname === '/api/orders/1/operations') {
          const payload = route.request().postDataJSON()
          writes.push(payload)
          assert.deepEqual(payload, { version: order.version, advance: true })
          order.operations.stage = order.nextProductionStage
          order.nextProductionStage = order.operations.stage === 'production' ? 'ready' : null
          order.version = `v${writes.length + 1}`
          return route.fulfill({ json: { ok: true } })
        }
        return route.abort()
      })
      for (const width of [1440, 390]) {
        order.shipment = null
        order.operations.stage = 'queued'
        order.nextProductionStage = 'production'
        await page.setViewportSize({ width, height: 900 })
        await page.goto('https://orders.test/?order=1')
        await page.addStyleTag({ content: await readFile(new URL('../public/assets/order_shipping.css', import.meta.url), 'utf8') })
        await page.locator('#orderAdvance').waitFor()
        assert.equal(await page.locator('#orderOperationsForm').count(), 0)
        assert.equal(await page.locator('.wa-order-production-box input, .wa-order-production-box select, .wa-order-production-box textarea').count(), 0)
        assert.match(await page.locator('.wa-order-production-box').textContent(), language === 'en' ? /5 Calendar days/ : /5 Hari kalender/)
        assert.match(await page.locator('.wa-order-production-box').textContent(), /2026-09-20/)
        assert.equal(
          await page.locator('#orderAdvance').textContent(),
          language === 'en' ? 'Start production' : 'Mulai produksi'
        )
        await page.locator('#orderAdvance').click()
        await page.waitForFunction(
          () =>
            document.querySelector('#orderAdvance')?.textContent === window.waI18n.t('Siap kirim')
        )
        await page.locator('#orderAdvance').click()
        await page.locator('.wa-order-shipping-wait').waitFor()
        assert.equal(await page.locator('#orderAdvance').count(), 0)
        const production = page.locator('#orderDetail .wa-item-production-details')
        assert.equal(await production.evaluate((element) => element.tagName), 'SECTION')
        assert.equal(await production.locator('summary').count(), 0)
        assert.equal(await production.locator('dd').first().isVisible(), true)
        assert.match(await production.textContent(), /168 cm/)
        assert.match(await production.textContent(), /84 kg/)
        assert.match(
          await production.textContent(),
          language === 'en' ? /Finished garment measurements/ : /Ukuran pakaian jadi/
        )
        assert.equal(
          await page.locator('.wa-order-shipping-wait').textContent(),
          language === 'en' ? 'Awaiting Orion AWB' : 'Menunggu AWB Orion'
        )
        // No refresh click: the selected order's actual phase is fetched and rendered.
        order.shipment = { status: 'processing', phase: 'creating', attempts: 1, leaseUntil: new Date(Date.now() + 600000).toISOString() }
        await page.clock.fastForward(5000)
        await page.waitForFunction(() => document.querySelector('.wa-shipping-progress-label')?.textContent === window.waI18n.t('Membuat AWB Orion'))
        assert.equal(await production.locator('dd').first().isVisible(), true)
        assert.equal(await production.locator('.wa-item-production-field--pending').isVisible(), true)
        const backgrounds = await production.locator('.wa-item-production-field').evaluateAll((fields) => [...new Set(fields.map((field) => getComputedStyle(field).backgroundColor))])
        assert.equal(backgrounds.length, 4)
        await production.scrollIntoViewIfNeeded()
        const detailBounds = await production.boundingBox()
        assert.ok(detailBounds.x >= 0 && detailBounds.x + detailBounds.width <= width)
        await production.screenshot({ path: `/private/tmp/order-production-details-${language}-${width}.png` })
        assert.equal(await page.locator('.wa-shipping-spinner').count(), 1)
        assert.equal(await production.locator('dd').first().isVisible(), true)
        await page.emulateMedia({ reducedMotion: 'reduce' })
        assert.equal(await page.locator('.wa-shipping-spinner').evaluate((el) => getComputedStyle(el).animationName), 'none')
        await page.emulateMedia({ reducedMotion: 'no-preference' })
        // Expired leases never keep showing a live spinner.
        order.shipment.leaseUntil = new Date(0).toISOString()
        await page.clock.fastForward(5000)
        await page.waitForFunction(() => document.querySelector('.wa-shipping-progress-label')?.textContent === window.waI18n.t('Menunggu pemulihan proses'))
        assert.equal(await page.locator('.wa-shipping-spinner').count(), 0)
        order.shipment = { status: 'retry', errorCode: 'ORION_UNAVAILABLE', attempts: 2, nextAttemptAt: new Date(Date.now() + 120000).toISOString() }
        await page.clock.fastForward(5000)
        await page.waitForFunction(() => document.querySelector('.wa-shipping-progress-label')?.textContent === window.waI18n.t('Orion belum tersedia · mencoba lagi'))
        assert.match(await page.locator('.wa-shipping-progress-meta').textContent(), language === 'en' ? /Check 2.*Retry in/ : /Pemeriksaan 2.*Coba lagi dalam/)
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        )
        assert.equal(await page.locator('.wa-order-advanced').count(), 0)
        await page.screenshot({
          path: `/private/tmp/order-progress-${process.env.PLAYWRIGHT_BROWSER || 'chromium'}-${language}-${width}.png`,
          fullPage: true,
        })
        await page.locator('#orderDestinationForm [name="paymentTrigger"]').selectOption('fully_paid')
        order.shipment = { status: 'processing', phase: 'tracking', attempts: 3, leaseUntil: new Date(Date.now() + 600000).toISOString() }
        await page.clock.fastForward(5000)
        assert.equal(await page.locator('#orderDestinationForm [name="paymentTrigger"]').inputValue(), 'fully_paid')
        assert.equal(await page.locator('.wa-shipping-spinner').count(), 0)
        // Explicitly close/discard before using controls behind the modal sheet.
        page.once('dialog', (dialog) => dialog.accept())
        await page.locator('#orderDrawerClose').click()
        await page.locator('#orderRefresh').click()
        await page.locator('#orderList .wa-order-open').click()
        await page.waitForFunction(() => document.querySelector('.wa-shipping-progress-label')?.textContent === window.waI18n.t('Memeriksa perjalanan paket'))
        await page.locator('#orderDrawerClose').click()
        await page.locator('[data-order-tab="active"]').click()
        await page.locator('#orderList [data-order-id="1"]').waitFor()
        await page.waitForFunction(() => document.querySelector('#orderList').getAttribute('aria-busy') === 'false')
        order.operations.stage = 'completed'
        order.nextProductionStage = null
        order.shipment = { status: 'completed' }
        await page.clock.fastForward(30000)
        await page.waitForFunction(() => !document.querySelector('#orderList [data-order-id="1"]'))
        await page.locator('[data-order-tab="completed"]').click()
        await page.locator('#orderList [data-order-id="1"]').waitFor()
        assert.equal(await page.locator('[data-order-tab="completed"]').getAttribute('aria-pressed'), 'true')
        assert.match(await page.locator('#orderList').textContent(), language === 'en' ? /Completed/ : /Selesai/)
        await page.locator('#orderList .wa-order-open').click()
        assert.equal(await page.locator('.wa-shipping-progress').count(), 0)
        assert.equal(await page.locator('#orderAdvance').count(), 0)
      }
      assert.equal(writes.length, 4)
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally {
    await browser.close()
  }
})
