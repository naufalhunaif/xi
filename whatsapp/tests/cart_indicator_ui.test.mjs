// Isolated fixture: never calls the live database, payment service or WhatsApp.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

test('cart quantity and payment icons stay current, accessible and compact in EN/ID', async () => {
  const dashboard = await readFile(
    new URL('../resources/views/pages/dashboard.edge', import.meta.url),
    'utf8'
  )
  const opener = dashboard.match(/<button\s+id="cartOpen"[\s\S]*?<\/button>/)[0]
  const view = await readFile(
    new URL('../resources/views/partials/cart.edge', import.meta.url),
    'utf8'
  )
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium
  const browser = await engine.launch({ headless: true })
  try {
    for (const locale of ['en', 'id']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const page = await context.newPage()
      await page.addInitScript({ content: await readFile(new URL('../public/assets/order_shipping_status.js', import.meta.url), 'utf8') })
      await page.addInitScript({
        content: await readFile(
          new URL('../public/assets/order_item_details.js', import.meta.url),
          'utf8'
        ),
      })
      await page.clock.install()
      await page.addInitScript(
        (language) => localStorage.setItem('https://cart.test:ui-language', language),
        locale
      )
      const errors = []
      const writes = []
      page.on('pageerror', (error) => errors.push(error.message))
      let cart = {
        jid: 'fixture@lid',
        version: 'v1',
        items: [],
        recipient: { name: 'Customer', phone: '628000000001', address: 'Fixture' },
        shipping: { service: 'REG', cost: 8000 },
        subtotal: 0,
        discount: 0,
        total: 8000,
        paymentStatus: 'none',
        note: '',
      }
      const item = (quantity) => ({
        id: 'one',
        name: 'Suit',
        quantity,
        unitPrice: 100000,
        size: 'M',
        measurements: {},
        approval: 'approved',
        image: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
        productionDetails: {
          heightCm: 168,
          weightKg: 84,
          fit: 'regular',
          color: 'Black',
          material: '',
          lapel: 'peak',
          buttons: '2',
          notes: '<img src=x onerror=alert(1)>',
          pending: [],
          sourceMessageIds: ['fixture'],
          measurements: [
            { name: 'Waist', value: 96, basis: 'body' },
            { name: 'Waist', value: 100, basis: 'garment' },
          ],
        },
      })
      const stages = ['unverified', 'awaiting_details', 'queued', 'production', 'qc', 'ready', 'shipped', 'completed', 'unknown', null]
      const orders = [...stages, 'cancelled'].map((stage, index) => ({
        id: index + 1,
        number: `INV-TEST-${index + 1}`,
        status: stage === 'cancelled' ? 'cancelled' : 'active',
        total: 108000, paid: 108000, balance: 0,
        cart: { ...cart, items: [] },
        operations: stage === null ? null : {
          stage: stage === 'cancelled' ? 'ready' : stage,
          trackingNumber: 'FIXTURE-AWB',
        },
        shipment: stage === 'ready' ? { status: 'waiting_pickup', errorCode: null, attempts: 28, nextAttemptAt: new Date(Date.now() + 120000).toISOString() } : stage === 'qc' ? { errorCode: 'ORION_AUTH_REQUIRED' } : null,
      }))
      await context.route('**/*', async (route) => {
        const url = new URL(route.request().url())
        if (url.pathname === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="app-url" content="https://cart.test"><meta name="csrf-token" content="fixture"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/app.css"><link rel="stylesheet" href="/assets/cart.css"><link rel="stylesheet" href="/assets/forms.css"><style>body{margin:0;font-family:Arial}.fixture-header{display:flex;justify-content:flex-end;padding:20px}.actions{display:flex;gap:8px}</style></head><body class="workspace-ui"><div class="fixture-header">${opener}</div><div id="messages" data-jid="fixture@lid"></div>${view}<script src="/lang/en.js"></script><script src="/lang/id.js"></script><script src="/assets/i18n.js"></script><script src="/assets/cart.js"></script></body></html>`,
          })
        if (url.pathname === '/store.css')
          return route.fulfill({
            contentType: 'text/css',
            body: await readFile(
              new URL('../../store/assets/css/app.css', import.meta.url),
              'utf8'
            ),
          })
        if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/lang/'))
          return route.fulfill({
            contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
            body: await readFile(new URL(`../public${url.pathname}`, import.meta.url), 'utf8'),
          })
        if (route.request().method() !== 'GET') writes.push(url.pathname)
        if (url.pathname === '/api/cart/read-payment')
          return route.fulfill({ json: { review: { id: 'review-fixture', ready: true, issues: [],
            billAmount: 699000, amount: 599000, overpayment: 0, reference: '',
            paymentQuote: cart.paymentQuote, methodName: 'Bank fixture', destination: '999999',
            proofUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
          } } })
        if (url.pathname === '/api/cart/cancel')
          cart = { ...cart, items: [], paymentStatus: 'none' }
        if (url.pathname === '/api/cart' || url.pathname === '/api/cart/cancel')
          return route.fulfill({
            json: { cart, orders, customerBalance: { balance: 0, entries: [] } },
          })
        return route.abort()
      })
      await page.goto('https://cart.test')
      await page.waitForFunction(() =>
        document.querySelector('#cartOpen').getAttribute('aria-label').includes('0')
      )
      assert.equal(await page.locator('#cartCount').isVisible(), false)
      assert.equal(await page.locator('#cartMoney').isVisible(), false)

      cart.items = [item(2), { ...item(3), id: 'two' }]
      Object.assign(cart.items[0], {
        name: 'Peak Suit - Black', size: 'S', modelType: 'catalog', modelApproval: 'approved',
        modelConsentEvidence: { requestMessageId: 'design-request', approvalMessageId: 'cs-approval' },
      })
      cart.items[0].productionDetails.color = 'navy'
      cart.items[0].productionDetails.lapel = 'hitam'
      cart.paymentStatus = 'reported'
      cart.items.forEach((item) => {
        item.unitPrice = 141000
      })
      cart.subtotal = 705000
      cart.discount = 15000
      cart.shipping.cost = 9000
      cart.total = 699000
      cart.paymentQuote = { availableBalance: 100000, reservedForOrders: 0, balanceToUse: 100000, amountDue: 599000 }
      // Advance only the application's polling interval, with all network requests mocked.
      await page.clock.fastForward(5000)
      await page.waitForFunction(() => document.querySelector('#cartCount').textContent === '5')
      assert.equal(await page.locator('#cartMoney').isVisible(), true)
      assert.match(
        await page.locator('#cartOpen').getAttribute('aria-label'),
        locale === 'en'
          ? /5 items in cart.*Transfer awaiting review/
          : /5 item di cart.*Transfer perlu diperiksa/
      )
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 800 })
        const bounds = await page.locator('#cartCount').boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
        await page.screenshot({
          path: `/private/tmp/cart-indicator-${process.env.PLAYWRIGHT_BROWSER || 'chromium'}-${locale}-${width}.png`,
        })
        await page.locator('#cartOpen').click()
        await page.locator('#cartConfirmPayment').waitFor({ state: 'visible' })
        const expectedStages = locale === 'en'
          ? ['Not updated', 'Awaiting details', 'Production queue', 'Production', 'QC', 'Ready to ship', 'Shipped', 'Completed', 'Not updated', 'Not updated']
          : ['Belum diperbarui', 'Menunggu detail', 'Antre produksi', 'Produksi', 'QC', 'Siap kirim', 'Dikirim', 'Selesai', 'Belum diperbarui', 'Belum diperbarui']
        assert.deepEqual(await page.locator('#cartOrders .wa-cart-stage').allTextContents(), expectedStages)
        assert.equal(await page.locator('[data-order-id="11"] .wa-cart-order-progress').count(), 0)
        // Paid + AWB must not promote a ready order to shipped.
        assert.equal(await page.locator('[data-order-id="6"] .wa-cart-order-progress').getAttribute('data-stage'), 'ready')
        assert.match(await page.locator('[data-order-id="6"]').textContent(), locale === 'en' ? /Waiting for shipping update/ : /Menunggu pembaruan pengiriman/)
        assert.doesNotMatch(await page.locator('[data-order-id="6"]').textContent(), /Check 28|Pemeriksaan 28|Retry in|Coba lagi dalam/)
        assert.match(await page.locator('[data-order-id="5"]').textContent(), locale === 'en' ? /Reconnect Orion/ : /Hubungkan ulang Orion/)
        const ready = page.locator('[data-order-id="6"]')
        await ready.scrollIntoViewIfNeeded()
        const orderBounds = await ready.boundingBox()
        assert.ok(orderBounds.x >= 0 && orderBounds.x + orderBounds.width <= width)
        await page.screenshot({ path: `/private/tmp/cart-order-status-${process.env.PLAYWRIGHT_BROWSER || 'chromium'}-${locale}-${width}.png` })
        const production = page.locator('#cartItems .wa-item-production-details').first()
        assert.equal(await production.locator('h4').textContent(), locale === 'en' ? 'Catalog design adjustments' : 'Penyesuaian desain katalog')
        assert.match(await production.textContent(), locale === 'en' ? /Design · approved by CS/ : /Desain · disetujui CS/)
        assert.match(await production.textContent(), /navy/)
        assert.match(await production.textContent(), /hitam/)
        assert.equal(await page.locator('#cartItems .wa-item-production-details').nth(1).locator('h4').textContent(), locale === 'en' ? 'Production details' : 'Detail pengerjaan')
        assert.equal(await page.getByRole('button', { name: locale === 'en' ? 'Approve model' : 'Setujui model', exact: true }).count(), 0)
        assert.equal(await production.evaluate((element) => element.tagName), 'SECTION')
        assert.equal(await production.locator('summary').count(), 0)
        assert.equal(await production.locator('dd').first().isVisible(), true)
        assert.match(await production.textContent(), /168 cm/)
        assert.match(await production.textContent(), /84 kg/)
        assert.match(
          await production.textContent(),
          locale === 'en' ? /Finished garment measurements/ : /Ukuran pakaian jadi/
        )
        assert.equal(await production.locator('img').count(), 0)
        await production.scrollIntoViewIfNeeded()
        const detailBounds = await production.boundingBox()
        assert.ok(detailBounds.x >= 0 && detailBounds.x + detailBounds.width <= width)
        await production.screenshot({ path: `/private/tmp/cart-production-details-${locale}-${width}.png` })
        assert.match(await page.locator('#cartDiscount').textContent(), /15[.,]000/)
        assert.match(await page.locator('#cartTotal').textContent(), /699[.,]000/)
        assert.equal(await page.locator('#cartCreditRow').isVisible(), true)
        assert.match(await page.locator('#cartCredit').textContent(), /100[.,]000/)
        assert.match(await page.locator('#cartDue').textContent(), /599[.,]000/)
        assert.equal(await page.locator('#cartConfirmPayment .wa-cart-payment-icon').count(), 1)
        assert.equal(await page.locator('#cartPaymentApprove .wa-cart-payment-icon').count(), 1)
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        )
        await page.locator('#cartConfirmPayment').click()
        await page.locator('#cartPaymentReadingDetails').waitFor({ state: 'visible' })
        assert.equal(await page.locator('#cartPaymentReference').textContent(), '—')
        assert.equal(await page.locator('#cartPaymentApprove').isEnabled(), true)
        assert.match(await page.locator('#cartPaymentBalance').textContent(), /100[.,]000/)
        assert.match(await page.locator('#cartPaymentDue').textContent(), /599[.,]000/)
        await page.locator('#cartPaymentCancel').click()
        await page.locator('#cartClose').click()
      }
      // A server-side status change is picked up by the existing live refresh.
      const missingDesign = await page.evaluate(() => {
        const parent = document.createElement('div')
        window.waOrderItemDetails(parent, {
          modelType: 'catalog', modelApproval: 'approved', productionDetails: null,
          modelConsentEvidence: { requestMessageId: 'request', approvalMessageId: 'approval' },
        })
        return parent.textContent
      })
      assert.match(missingDesign, locale === 'en' ? /Adjustment details are not available yet/ : /Detail penyesuaian belum tersedia/)
      assert.doesNotMatch(missingDesign, /approved by CS|disetujui CS/)
      await page.locator('#cartOpen').click()
      orders[5].operations.stage = 'shipped'
      await page.clock.fastForward(5000)
      await page.waitForFunction(() => document.querySelector('[data-order-id="6"] .wa-cart-order-progress')?.dataset.stage === 'shipped')
      await page.locator('#cartClose').click()
      // Upper bound stays compact; exact count remains available to assistive technology.
      cart.items = [item(120)]
      await page.locator('#messages').evaluate((el) => {
        el.dataset.jid = 'third@lid'
      })
      await page.waitForFunction(() => document.querySelector('#cartCount').textContent === '99+')
      assert.match(await page.locator('#cartOpen').getAttribute('aria-label'), /120/)
      await page.locator('#cartOpen').click()
      page.once('dialog', (dialog) => dialog.accept())
      await page.locator('#cartCancel').click()
      await page.waitForFunction(
        () =>
          document.querySelector('#cartCount').hidden && document.querySelector('#cartMoney').hidden
      )
      assert.deepEqual(writes, ['/api/cart/read-payment', '/api/cart/read-payment', '/api/cart/cancel'])
      assert.deepEqual(errors, [])
      await context.close()
    }
  } finally {
    await browser.close()
  }
})
