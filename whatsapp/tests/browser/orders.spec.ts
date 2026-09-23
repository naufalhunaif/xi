import { test } from '@japa/runner'
import { initialOperations, groupOrderSnapshot } from '#services/order_operations_service'
import edge from 'edge.js'
import { readFile } from 'node:fs/promises'

test('orders has compact production actions and private group preview in both languages', async ({
  browserContext,
  assert,
}) => {
  // Render the real template without the controller's ensureDefaults/database writes.
  const html = await edge
    .createRenderer()
    .share({
      csrfToken: 'test-only',
      workspaceVersion: 'test-only',
      workspaceId: 0,
    })
    .render('pages/dashboard', {
      page: 'orders',
      appUrl: 'http://orders.test/whatsapp',
      bundle: 'http://orders.test',
      csrfToken: 'test-only',
      workspaceVersion: 'test-only',
      workspaceId: 0,
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Test Owner',
        username: 'owner',
      },
    })
  const page = await browserContext.newPage()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const image =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="120"><rect width="100" height="120" fill="#202b28"/></svg>'
    )
  const cart = {
    items: [
      {
        name: 'Custom peak — jas, celana, rompi',
        size: 'custom',
        requestedSize: '38',
        quantity: 1,
        measurements: { 'Lingkar pinggang': 96 },
        image,
        modelType: 'custom',
        note: 'Model disetujui',
      },
    ],
    recipient: { name: 'Pengaturan', address: 'Alamat sangat rahasia 99', phone: '081234567890' },
  }
  const order: any = {
    id: 47,
    number: 'WA-000047',
    jid: '10000000000047@lid',
    cart,
    status: 'active',
    total: 889000,
    paid: 816000,
    version: '',
    operations: initialOperations(cart),
    groupJid: null,
    paymentTrigger: 'first_payment',
    dispatch: 'not_queued',
    preview: groupOrderSnapshot({
      id: 47,
      snapshot_json: JSON.stringify(cart),
      paid: 816000,
      total: 889000,
    }),
  }
  const routing: any = {
    version: 'routing-v1',
    groupJid: null,
    paymentTrigger: 'first_payment',
    groups: [{ jid: '120363999888777@g.us', name: 'Tim Produksi' }],
    refreshRequested: false,
  }
  const errors: string[] = []
  const updates: any[] = []
  const routingUpdates: any[] = []
  const queries: string[] = []
  let acceptConfirm = true
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('dialog', (dialog) => (acceptConfirm ? dialog.accept() : dialog.dismiss()))
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    if (url.hostname !== 'orders.test') return route.abort()
    if (url.pathname === '/whatsapp/orders')
      return route.fulfill({ contentType: 'text/html', body: html })
    const asset =
      url.pathname.startsWith('/whatsapp/assets/') || url.pathname.startsWith('/whatsapp/lang/')
        ? new URL(`../../public/${url.pathname.slice('/whatsapp/'.length)}`, import.meta.url)
        : url.pathname.startsWith('/store/assets/')
          ? new URL(`../../../${url.pathname.slice(1)}`, import.meta.url)
          : null
    if (!asset) return route.abort()
    try {
      const contentType = asset.pathname.endsWith('.js')
        ? 'text/javascript'
        : asset.pathname.endsWith('.css')
          ? 'text/css'
          : 'image/svg+xml'
      return route.fulfill({ body: await readFile(asset), contentType })
    } catch {
      return route.fulfill({ status: 404 })
    }
  })
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.endsWith('/api/workspace'))
      return route.fulfill({ status: 204, headers: { 'X-WhatsApp-Workspace': 'test-only' } })
    if (path.endsWith('/api/orders/routing')) {
      if (route.request().method() === 'PUT') {
        const input = route.request().postDataJSON()
        routingUpdates.push(input)
        Object.assign(routing, input, { version: 'routing-v2' })
      }
      return route.fulfill({ json: routing })
    }
    if (path.endsWith('/api/orders')) {
      const query = url.searchParams.get('query') || ''
      queries.push(query)
      const orders = query === 'missing' ? [] : [order]
      return route.fulfill({ json: { page: 1, total: orders.length, orders } })
    }
    if (path.endsWith('/operations')) {
      const input = route.request().postDataJSON()
      updates.push(input)
      order.version = `v-${updates.length}`
      if (input.operations)
        order.operations = { ...order.operations, ...input.operations, source: 'operator' }
      if (input.advance)
        order.operations = { ...order.operations, stage: 'queued', source: 'operator' }
      if (input.groupJid) {
        order.groupJid = input.groupJid
        order.dispatch = 'queued'
      }
      return route.fulfill({ json: { ok: true } })
    }
    if (path.endsWith('/history')) return route.fulfill({ json: { events: [], parts: [] } })
    return route.fulfill({
      json: { connected: false, connections: [], found: true, status: 'disconnected' },
    })
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto('http://orders.test/whatsapp/orders')
  await page.locator('#orderList button').waitFor()
  assert.isFalse(await page.locator('#orderDrawer').isVisible())
  await page.goto('http://orders.test/whatsapp/orders?order=47')
  await page
    .locator('#orderAdvance')
    .waitFor({ timeout: 5000 })
    .catch(async () => {
      throw new Error(
        JSON.stringify({
          errors,
          queries,
          state: await page.evaluate(
            "({url: location.href, notice: document.getElementById('orderPageNotice')?.textContent, network: window.waNetwork?.snapshot(), workspace: document.querySelector('meta[name=whatsapp-workspace]')?.content})"
          ),
        })
      )
    })
  assert.equal(await page.locator('#orderOperationsForm').count(), 0)
  assert.isTrue(await page.locator('#orderAdvance').isVisible())
  assert.isTrue(await page.locator('#orderDrawer').isVisible())
  assert.equal(await page.locator('#orderList tr[data-order-id] td').count(), 5)
  const drawerBounds = await page.locator('#orderDrawer').boundingBox()
  assert.isAbove(drawerBounds!.x, 750)
  assert.isAtMost(drawerBounds!.width, 640)
  await page.locator('#orderDrawerClose').click()
  await page.locator('#orderDrawer').waitFor({ state: 'hidden' })
  await page.waitForFunction(
    "document.querySelector('#orderList button') === document.activeElement"
  )
  const info = page.locator('[data-info-target="orderRoutingInfo"]')
  assert.isFalse(await page.locator('#orderRoutingDialog').isVisible())
  await page.locator('#orderRoutingOpen').click()
  assert.isTrue(await page.locator('#orderRoutingDialog').isVisible())
  await info.click()
  assert.isTrue(await page.locator('#orderRoutingInfo').isVisible())
  await page.keyboard.press('Escape')
  assert.isFalse(await page.locator('#orderRoutingInfo').isVisible())
  assert.isTrue(await page.locator('#orderRoutingDialog').isVisible())
  await page.locator('#orderDefaultGroup').selectOption('120363999888777@g.us')
  await page.locator('#orderDefaultTrigger').selectOption('fully_paid')
  await page.locator('#orderRefreshGroups').click()
  assert.equal(await page.locator('#orderDefaultTrigger').inputValue(), 'fully_paid')
  acceptConfirm = false
  await page.locator('#orderRoutingClose').click()
  assert.isTrue(await page.locator('#orderRoutingDialog').isVisible())
  acceptConfirm = true
  await page.locator('#orderRoutingForm button[type="submit"]').click()
  await page.waitForFunction(
    "document.getElementById('orderRoutingNotice').textContent === 'Saved'"
  )
  assert.equal(routingUpdates[0].paymentTrigger, 'fully_paid')
  await page.screenshot({ path: '/private/tmp/whatsapp-order-routing-desktop.png' })
  await page.keyboard.press('Escape')
  await page.locator('#orderRoutingDialog').waitFor({ state: 'hidden' })
  await page.waitForFunction(
    "document.getElementById('orderRoutingOpen') === document.activeElement"
  )
  assert.isAbove(
    await page.locator('#orderSearch').evaluate((el) => el.getBoundingClientRect().width),
    300
  )
  await page.locator('#orderSearch').fill('missing')
  await page.locator('#orderList .wa-order-empty').waitFor()
  assert.include(queries, 'missing')
  await page.locator('#orderSearch').fill('Pengaturan')
  await page.locator('#orderList button').waitFor()
  assert.include(queries, 'Pengaturan')
  assert.isFalse(await page.locator('#orderDrawer').isVisible())
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-table-desktop.png' })
  await page.locator('#orderList button').focus()
  await page.keyboard.press('Enter')
  await page.locator('#orderDrawer').waitFor()
  await page.keyboard.press('Shift+Tab')
  assert.isTrue(
    await page.evaluate<boolean>(
      "document.getElementById('orderDrawer').contains(document.activeElement)"
    )
  )
  await page.locator('#orderDestinationGroup').selectOption('120363999888777@g.us')
  acceptConfirm = false
  await page.locator('#orderDrawerClose').click()
  assert.isTrue(await page.locator('#orderDrawer').isVisible())
  assert.equal(await page.locator('#orderDestinationGroup').inputValue(), '120363999888777@g.us')
  acceptConfirm = true
  await page.locator('#orderDrawerClose').click()
  await page.locator('#orderDrawer').waitFor({ state: 'hidden' })
  await page.locator('#orderList button').click()
  assert.equal(await page.locator('#orderDestinationGroup').inputValue(), '')
  const controlHeights = await page.evaluate<number[]>(
    "Array.from(document.querySelectorAll('#orderDestinationForm input, #orderDestinationForm select')).map(el => el.getBoundingClientRect().height).filter(Boolean)"
  )
  assert.isTrue(
    controlHeights.every((height) => height === 36),
    JSON.stringify(controlHeights)
  )
  assert.equal(
    await page.locator('.sidebar .nav-item[aria-current="page"] .nav-text').textContent(),
    'Orders'
  )
  assert.include((await page.locator('#orderDetail').textContent()) || '', 'Pengaturan')
  await page.locator('#orderAdvance').click()
  await page.waitForFunction("document.getElementById('orderPageNotice')?.textContent === 'Saved'")
  assert.isTrue(updates[0].advance)
  assert.notProperty(updates[0], 'operations')
  await page.locator('#orderDetail .wa-cart-item img').click()
  assert.isTrue(await page.locator('#mediaViewer').isVisible())
  await page.keyboard.press('Escape')
  assert.isTrue(await page.locator('#orderDrawer').isVisible())
  await page.getByText('Group message preview', { exact: true }).click()
  const preview = (await page.locator('#orderDetail pre').textContent()) || ''
  assert.include(preview, 'Pengaturan')
  assert.include(preview, 'Lingkar pinggang: 96 cm')
  assert.notInclude(preview, 'Alamat sangat rahasia')
  assert.notInclude(preview, '081234567890')
  await page.locator('#orderDestinationGroup').selectOption('120363999888777@g.us')
  await page.locator('#orderDestinationForm button[type="submit"]').click()
  await page.waitForFunction("document.getElementById('orderDestinationGroup')?.disabled === true")
  assert.equal(updates[1].groupJid, '120363999888777@g.us')
  await page.locator('#orderDetail').evaluate((el) => {
    el.scrollTop = 0
  })
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-page-desktop.png' })
  await page.evaluate("window.waI18n.setLanguage('id')")
  await page.waitForFunction(
    "document.querySelector('.sidebar .nav-item[aria-current=page] .nav-text')?.textContent === 'Order'"
  )
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#sidebar').waitFor({ state: 'hidden' })
  await page.locator('#orderDestinationForm').scrollIntoViewIfNeeded()
  const dimensions = await page.evaluate<{ width: number; viewport: number }>(
    '({width: document.documentElement.scrollWidth, viewport: innerWidth})'
  )
  assert.isAtMost(dimensions.width, dimensions.viewport)
  assert.equal(
    await page
      .locator('#orderDestinationGroup')
      .evaluate((el) => el.getBoundingClientRect().height),
    40
  )
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-page-mobile.png' })
  await page.keyboard.press('Escape')
  await page.locator('#orderDrawer').waitFor({ state: 'hidden' })
  await page.screenshot({ path: '/private/tmp/whatsapp-orders-table-mobile.png' })
  assert.isAtMost(await page.evaluate<number>('document.documentElement.scrollWidth'), 390)
  await page.locator('#orderRoutingOpen').click()
  const routingBounds = await page.locator('#orderRoutingDialog').boundingBox()
  assert.isAtLeast(routingBounds!.x, 0)
  assert.isAtMost(routingBounds!.x + routingBounds!.width, 390)
  assert.equal(await page.locator('#orderDefaultTrigger').inputValue(), 'fully_paid')
  await page.screenshot({ path: '/private/tmp/whatsapp-order-routing-mobile.png' })
  await page.mouse.click(2, 2)
  await page.locator('#orderRoutingDialog').waitFor({ state: 'hidden' })
  await page.locator('#orderList .wa-order-customer').click()
  await page.locator('#orderDrawer').waitFor()
  assert.isTrue(await page.locator('#orderDrawerClose').isVisible())
  assert.deepEqual(errors, [])
}).timeout(60_000)
