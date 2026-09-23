import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'

test('AI cart is read-only, previews images and keeps approval/payment controls within the viewport', async ({
  browserContext,
  assert,
}) => {
  const page = await browserContext.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Existing regression scenarios use the Indonesian UI explicitly.
  await page.addInitScript(() => {
    ;(globalThis as any).localStorage.setItem(
      'http://localhost/alogaritm--app/whatsapp:ui-language',
      'id'
    )
  })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  const view = await readFile('resources/views/partials/cart.edge', 'utf8')
  const css = await readFile('public/assets/cart.css', 'utf8')
  const baseCss = await readFile('../store/assets/css/app.css', 'utf8')
  const workspaceCss = await readFile('../store/assets/css/workspace.css', 'utf8')
  const js = await readFile('public/assets/cart.js', 'utf8')
  const viewerJs = await readFile('public/assets/media_viewer.js', 'utf8')
  const viewerCss = await readFile('public/assets/media_viewer.css', 'utf8')
  const image =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#203044"/></svg>'
    )
  const cart = {
    jid: 'fixture@lid',
    version: 'v1',
    items: [
      {
        id: 'item1',
        name: 'Basic Suit - Black',
        image,
        size: 'custom',
        requestedSize: '38',
        quantity: 1,
        unitPrice: 705000 as number | null,
        measurements: { 'Panjang jas': 67, 'Panjang tangan': 59 } as Record<string, number>,
        note: '',
        approval: 'pending',
      },
    ],
    recipient: { name: 'Pelanggan Uji', phone: '0812000000', address: 'Alamat uji lengkap' },
    shipping: { service: 'REG', cost: 8000 as number | null },
    note: '',
    total: 713000,
    paymentStatus: 'reported',
  }
  const requests: string[] = []
  const confirmed: Record<string, unknown>[] = []
  let receiptClear = true
  let receiptExcess = 0
  const customerBalance = { balance: 0, entries: [] as Record<string, unknown>[] }
  const order = {
    id: 1,
    number: 'WA-000001',
    cart: structuredClone(cart),
    total: 713000,
    paid: 300000,
    balance: 413000,
    overpayment: 0,
    balanceApplied: 0,
    status: 'active',
  }
  const orders: (typeof order)[] = []
  await page.route('**/cart-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="app-url" content="http://localhost/alogaritm--app/whatsapp"><meta name="csrf-token" content="fixture"><style>body{font-family:Arial}.actions{display:flex;gap:8px}${baseCss}${workspaceCss}${css}${viewerCss}</style></head><body class="workspace-ui"><button id="cartOpen">Cart</button><div id="messages" data-jid="fixture@lid"></div>${view}<script>${js}</script><script>${viewerJs}</script></body></html>`,
    })
  )
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/read-payment')) {
      const input = route.request().postDataJSON()
      return route.fulfill({
        json: {
          review: {
            id: 'fixture-review',
            amount: receiptExcess
              ? (input.orderId ? 413000 : cart.total) + receiptExcess
              : input.orderId
                ? 413000
                : 300000,
            overpayment: receiptExcess,
            methodName: 'Bank Uji',
            destination: '999988887777',
            reference: receiptClear ? 'UJI-REF-1' : '',
            proofUrl: image,
            ready: receiptClear,
            issues: receiptClear ? [] : ['Referensi transaksi belum terbaca lengkap.'],
          },
        },
      })
    }
    if (path.endsWith('/payments'))
      return route.fulfill({
        json: { paymentMethods: [{ id: 1, name: 'Bank Uji', enabled: true }] },
      })
    if (route.request().method() === 'POST') {
      requests.push(path)
      if (path.endsWith('/confirm-payment')) confirmed.push(route.request().postDataJSON())
      if (path.endsWith('/custom')) {
        cart.items[0].approval = 'approved'
        cart.version = 'v2'
      }
    }
    return route.fulfill({ json: { cart, orders, customerBalance } })
  })
  await page.setViewportSize({ width: 390, height: 740 })
  await page.goto('http://localhost/alogaritm--app/whatsapp/cart-fixture')
  await page.locator('#cartOpen').click()
  await page.locator('#cartItems').getByText('Basic Suit - Black').waitFor()
  assert.deepEqual(await page.locator('.wa-cart-summary').first().locator('dt').allTextContents(), [
    'Subtotal',
    'Diskon',
    'Ongkir',
    'Total',
  ])
  const digits = async (id: string) => {
    const value = await page.locator(id).innerText()
    return value.replace(/\D/g, '')
  }
  assert.equal(await digits('#cartSubtotal'), '705000')
  assert.equal(await digits('#cartDiscount'), '0')
  assert.equal(await digits('#cartShipping'), '8000')
  assert.equal(await digits('#cartTotal'), '713000')
  assert.notInclude(await page.locator('#cartDetails').innerText(), 'Ongkir')
  assert.equal(
    await page
      .locator('#cartItems input, #cartDetails input, #cartItems textarea, #cartDetails textarea')
      .count(),
    0
  )
  assert.equal(await page.locator('input[name="image"], #cartAdd, #cartItemForm').count(), 0)
  assert.include(await page.locator('#cartItems').innerText(), 'Panjang jas: 67 cm')
  assert.include(await page.locator('#cartItems').innerText(), 'custom 38')
  assert.isTrue(
    await page
      .locator('#cartItems img')
      .evaluate((img: any) => img.complete && img.naturalWidth > 0)
  )
  page.on('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Setujui ukuran' }).click()
  await page.locator('#cartItems').getByText('Ukuran · disetujui CS', { exact: true }).waitFor()
  await page.locator('#cartConfirmPayment').click()
  await page.locator('#cartPaymentReadingDetails').waitFor({ state: 'visible' })
  assert.equal(await digits('#cartPaymentAmount'), '300000')
  assert.equal(await page.locator('#cartPaymentForm input, #cartPaymentForm select').count(), 0)
  assert.isTrue(await page.locator('#cartPaymentProof').isVisible())
  await page.locator('#cartPaymentProof').click()
  assert.isTrue(await page.locator('#mediaViewer').isVisible())
  await page.keyboard.press('Escape')
  assert.isTrue(await page.locator('#cartPaymentForm').isVisible())
  assert.isFalse(await page.locator('#cartPaymentApprove').isDisabled())
  assert.lengthOf(confirmed, 0)
  const bounds = await page.locator('#cartDialog').boundingBox()
  assert.isNotNull(bounds)
  assert.isAtMost(bounds!.x + bounds!.width, 390)
  assert.isAtMost(bounds!.y + bounds!.height, 740)
  await page.screenshot({ path: '/private/tmp/whatsapp-cart-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.locator('#cartPaymentCancel').click()
  await page.screenshot({ path: '/private/tmp/whatsapp-cart-desktop.png' })
  assert.lengthOf(requests, 1)
  cart.items[0].measurements = {}
  cart.items[0].approval = 'pending'
  cart.version = 'v3'
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartItems').getByText('Ukuran · menunggu detail', { exact: true }).waitFor()
  assert.isTrue(await page.getByRole('button', { name: 'Setujui ukuran' }).isDisabled())
  cart.items[0].name = 'Custom peak — jas, celana, rompi'
  cart.items[0].unitPrice = null
  cart.shipping.cost = null
  cart.version = 'v4'
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartItems').getByText(cart.items[0].name, { exact: true }).waitFor()
  assert.equal(await page.locator('#cartSubtotal').innerText(), 'Menunggu harga')
  assert.equal(await page.locator('#cartTotal').innerText(), 'Menunggu harga')
  assert.equal(await page.locator('#cartShipping').innerText(), 'Belum ditentukan')
  cart.items[0].unitPrice = 705000
  cart.items[0].quantity = 2
  cart.version = 'v5'
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartTotal').getByText('Menunggu ongkir', { exact: true }).waitFor()
  assert.equal(await digits('#cartSubtotal'), '1410000')
  cart.shipping.cost = 0
  cart.total = 1410000
  cart.version = 'v6'
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page
    .locator('#cartShipping')
    .getByText(/^Rp\s*0$/)
    .waitFor()
  assert.equal(await digits('#cartTotal'), '1410000')
  orders.push(order)
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  const paymentSummary = page.locator('#cartOrders .wa-cart-summary')
  await paymentSummary.getByText('DP diterima', { exact: true }).waitFor()
  await page.evaluate(() => {
    Object.defineProperty((globalThis as any).navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          ;(globalThis as any).__copiedOrder = text
        },
      },
    })
  })
  const copyNumber = page.getByRole('button', { name: 'Salin nomor order WA-000001', exact: true })
  assert.equal(await copyNumber.textContent(), '')
  assert.equal(await page.locator('#cartOrders .actions .wa-order-copy').count(), 0)
  assert.equal(await page.locator('#cartOrders .wa-order-number .wa-order-copy').count(), 1)
  await copyNumber.focus()
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Nomor order disalin', exact: true }).waitFor()
  assert.equal(await page.evaluate('(globalThis).__copiedOrder'), 'WA-000001')
  assert.equal(await page.locator('#cartOrders .wa-cart-order-item').count(), 0)
  await page.getByRole('button', { name: 'Detail WA-000001', exact: true }).click()
  const orderImage = page.locator('#orderDetailContent .wa-cart-order-item img')
  await orderImage.scrollIntoViewIfNeeded()
  await orderImage.evaluate(async (img: any) => img.decode())
  assert.equal(await orderImage.getAttribute('src'), image)
  assert.equal(await orderImage.getAttribute('alt'), 'Basic Suit - Black')
  await orderImage.click()
  assert.isTrue(await page.locator('#mediaViewer').isVisible())
  await page.keyboard.press('Escape')
  assert.isTrue(await page.locator('#orderDetailPanel').isVisible())
  assert.include(await page.locator('#orderDetailContent').innerText(), 'Panjang jas: 67 cm')
  const detailBounds = await page.locator('#orderDetailPanel').boundingBox()
  const mainBounds = await page.locator('#cartMainPanel').boundingBox()
  assert.isAtMost(detailBounds!.x + detailBounds!.width, mainBounds!.x)
  await page.screenshot({ path: '/private/tmp/whatsapp-order-expanded-desktop.png' })
  assert.equal(await page.locator('#cartOrders input, #cartOrders select').count(), 0)
  assert.deepEqual(await paymentSummary.locator('dt').allTextContents(), [
    'Total',
    'DP diterima',
    'Sisa pembayaran',
  ])
  const amounts = await paymentSummary.locator('dd').allTextContents()
  assert.deepEqual(
    amounts.map((value) => value.replace(/\D/g, '')),
    ['713000', '300000', '413000']
  )
  await page.getByRole('button', { name: 'Konfirmasi pelunasan' }).click()
  await page.locator('#cartPaymentReadingDetails').waitFor({ state: 'visible' })
  assert.equal(await digits('#cartPaymentAmount'), '413000')
  assert.lengthOf(confirmed, 0)
  await page.locator('#cartPaymentCancel').click()
  await paymentSummary.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-cart-dp-desktop.png' })
  await page.setViewportSize({ width: 390, height: 740 })
  await paymentSummary.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-cart-dp-mobile.png' })
  await page.getByRole('button', { name: 'Detail WA-000001', exact: true }).click()
  assert.isFalse(await page.locator('#cartMainPanel').isVisible())
  assert.isTrue(await page.locator('#orderDetailPanel').isVisible())
  await page.screenshot({ path: '/private/tmp/whatsapp-order-expanded-mobile.png' })
  await page.setViewportSize({ width: 320, height: 740 })
  const mobileDetail = await page.locator('#orderDetailPanel').boundingBox()
  assert.isAtMost(mobileDetail!.x + mobileDetail!.width, 320)
  await page.keyboard.press('Escape')
  assert.isTrue(await page.locator('#cartMainPanel').isVisible())
  assert.isTrue(await page.locator('#cartDialog').isVisible())
  assert.equal(await page.locator('[data-order-detail]').getAttribute('aria-expanded'), 'false')
  await page.setViewportSize({ width: 390, height: 740 })
  order.paid = order.total
  order.balance = 0
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartOrders').getByText('Lunas', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Detail WA-000001', exact: true }).click()
  assert.equal(await orderImage.getAttribute('src'), image)
  await page.locator('#orderDetailClose').click()
  assert.equal(await paymentSummary.getByText('DP diterima', { exact: true }).count(), 0)
  assert.equal(await digits('#cartOrders .wa-cart-summary > div:last-child dd'), '0')
  assert.equal(await page.getByRole('button', { name: 'Konfirmasi pelunasan' }).count(), 0)
  order.paid = 770000
  order.overpayment = 57000
  customerBalance.balance = 57000
  customerBalance.entries.push({
    amount: 57000,
    orderNumber: order.number,
    reference: 'EXCESS-1',
    createdAt: '2026-09-13T10:00:00Z',
  })
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartOrders').getByText('Kelebihan → saldo', { exact: true }).waitFor()
  assert.equal(await digits('#cartCustomerBalance'), '57000')
  assert.equal(await page.getByRole('button', { name: 'Konfirmasi pelunasan' }).count(), 0)
  assert.equal(
    await paymentSummary
      .locator('dd')
      .nth(2)
      .innerText()
      .then((value) => value.replace(/\D/g, '')),
    '0'
  )
  await page.locator('#cartBalanceHistory summary').click()
  assert.include(await page.locator('#cartBalanceEntries').innerText(), 'EXCESS-1')
  await page.locator('#cartCustomerBalance').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-customer-balance-mobile.png' })
  customerBalance.balance = 7000
  customerBalance.entries.unshift({
    amount: -50000,
    orderNumber: order.number,
    reason: 'order_payment',
    reference: null,
    createdAt: '2026-09-13T11:00:00Z',
  })
  order.balanceApplied = 50000
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartOrders').getByText('Termasuk saldo', { exact: true }).waitFor()
  assert.equal(await digits('#cartCustomerBalance'), '7000')
  assert.include(await page.locator('#cartBalanceEntries').innerText(), 'Pembayaran dari saldo')
  assert.notInclude(await page.locator('#cartBalanceEntries').innerText(), 'Ref: null')
  assert.include(await page.locator('#cartBalanceEntries strong').first().innerText(), '−Rp')
  await paymentSummary.scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-balance-applied-mobile.png' })
  order.balanceApplied = 0
  order.overpayment = 0
  order.paid = 300000
  order.balance = 413000
  order.status = 'cancelled'
  await page.keyboard.press('Escape')
  await page.locator('#cartOpen').click()
  await page.locator('#cartOrders').getByText('Dibatalkan', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Detail WA-000001', exact: true }).click()
  assert.equal(await orderImage.getAttribute('src'), image)
  await page.locator('#orderDetailClose').click()
  assert.equal(await paymentSummary.getByText('DP diterima', { exact: true }).count(), 0)
  assert.equal(
    await paymentSummary.getByText('Sisa sebelum pembatalan', { exact: true }).count(),
    1
  )
  assert.equal(await page.getByRole('button', { name: 'Konfirmasi pelunasan' }).count(), 0)
  assert.lengthOf(requests, 1)
  receiptClear = false
  receiptExcess = 57000
  await page.locator('#cartConfirmPayment').click()
  await page.locator('#cartPaymentReadingDetails').waitFor({ state: 'visible' })
  assert.isTrue(await page.locator('#cartPaymentApprove').isDisabled())
  assert.equal(await digits('#cartPaymentExcess'), '57000')
  assert.lengthOf(confirmed, 0)
  await page.locator('#cartPaymentCancel').click()
  receiptClear = true
  await page.locator('#cartConfirmPayment').click()
  await page.locator('#cartPaymentReadingDetails').waitFor({ state: 'visible' })
  assert.isTrue(await page.locator('#cartPaymentApprove').isEnabled())
  assert.include(
    await page.locator('#cartPaymentReading').innerText(),
    'otomatis mengurangi sisa tagihan'
  )
  await page.locator('#cartPaymentExcessRow').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-overpayment-preview-mobile.png' })
  await page.locator('#cartPaymentApprove').click()
  await page.locator('#cartPaymentForm').waitFor({ state: 'hidden' })
  assert.lengthOf(confirmed, 1)
  assert.equal(confirmed[0].reviewId, 'fixture-review')
  assert.equal(confirmed[0].verified, true)
  assert.notProperty(confirmed[0], 'amount')
  assert.notProperty(confirmed[0], 'methodId')
  assert.notProperty(confirmed[0], 'reference')
  // Selection stays in the left panel during polling and can switch between orders.
  orders.push({ ...structuredClone(order), id: 2, number: 'WA-000002' })
  await page.locator('#cartClose').click()
  await page.locator('#cartOpen').click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Detail WA-000001', exact: true }).click()
  await page.getByRole('button', { name: 'Detail WA-000002', exact: true }).click()
  assert.equal(await page.locator('#orderDetailTitle').innerText(), 'WA-000002')
  assert.equal(await page.locator('[data-order-detail="1"]').getAttribute('aria-expanded'), 'false')
  assert.equal(await page.locator('[data-order-detail="2"]').getAttribute('aria-expanded'), 'true')
  orders[1].cart.recipient.name = 'Penerima diperbarui'
  await page
    .locator('#orderDetailContent')
    .getByText('Penerima diperbarui', { exact: true })
    .waitFor()
  assert.isTrue(await page.locator('#orderDetailPanel').isVisible())
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-expanded-desktop.png' })
  await page.locator('#orderDetailClose').click()
  await page.setViewportSize({ width: 390, height: 740 })
  await page.locator('#cartOrders').scrollIntoViewIfNeeded()
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-compact-mobile.png' })
  await page.locator('#cartClose').click()
  await page.locator('#cartOpen').click()
  assert.isFalse(await page.locator('#orderDetailPanel').isVisible())
  assert.deepEqual(errors, [])
})
