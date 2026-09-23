import { test } from '@japa/runner'

test('offline worker replaces connecting label and disables misleading connect action', async ({
  client,
  browserContext,
  assert,
}) => {
  const response = await client.get('/').withSession({
    account: {
      sub: 'a'.repeat(64),
      sessionToken: 'b'.repeat(43),
      checkedAt: Date.now(),
      name: 'Pemilik',
      username: 'owner',
    },
  })
  response.assertStatus(200)
  const page = await browserContext.newPage()
  // Existing regression scenarios use the Indonesian UI explicitly.
  await page.addInitScript(() => {
    ;(globalThis as any).localStorage.setItem(
      'http://localhost/alogaritm--app/whatsapp:ui-language',
      'id'
    )
  })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.route('**/whatsapp/', (route) =>
    route.fulfill({ contentType: 'text/html', body: response.text() })
  )
  let online = false
  let disconnected = false
  const actions: string[] = []
  await page.route('**/api/**', (route) => {
    if (route.request().method() === 'POST') actions.push(new URL(route.request().url()).pathname)
    if (new URL(route.request().url()).pathname.endsWith('/status'))
      return route.fulfill({
        json: disconnected
          ? { status: 'disconnected', desired_connected: false, worker_online: true }
          : online
            ? { status: 'connected', phone: '6281234567890', last_error: null, worker_online: true }
            : {
                status: 'worker_offline',
                last_error: 'Worker WhatsApp belum berjalan. Koneksi belum dapat diproses.',
                desired_connected: true,
                qr_data_url: null,
              },
      })
    return route.fulfill({ json: { contacts: [], connections: [] } })
  })
  await page.goto('http://localhost/alogaritm--app/whatsapp/')
  await page.locator('.wa-connection-status[aria-label="WhatsApp · Belum terhubung"]').waitFor()
  assert.isTrue(await page.locator('#connectButton').isDisabled())
  assert.isFalse(await page.locator('#qrPanel').isVisible())
  assert.isFalse(await page.locator('#notice').isVisible())
  assert.notInclude(await page.locator('body').innerText(), 'Worker WhatsApp')
  online = true
  await page.locator('#statusDot.connected').waitFor()
  assert.equal(await page.locator('#phoneText').textContent(), '+62 812 3456 7890')
  assert.include(
    (await page.locator('.wa-connection-status').getAttribute('title')) || '',
    'Terhubung'
  )
  const hiddenLabel = await page.locator('#statusText').boundingBox()
  assert.isAtMost(hiddenLabel!.width, 1)
  assert.isAtMost(hiddenLabel!.height, 1)
  assert.isFalse(await page.locator('#notice').isVisible())
  assert.isFalse(await page.locator('#connectButton').isVisible())
  assert.isTrue(
    await page.getByRole('button', { name: 'Putuskan WhatsApp', exact: true }).isVisible()
  )
  const disconnectText = await page.locator('#disconnectButton').innerText()
  const cartText = await page.locator('#cartOpen').innerText()
  assert.equal(disconnectText.trim(), '', 'Disconnect is icon-only')
  assert.equal(cartText.trim(), '', 'Cart is icon-only')
  assert.equal(await page.locator('#cartOpen svg').count(), 1)
  assert.equal(await page.locator('#cartOpen').getAttribute('aria-label'), 'Cart dan order')
  await page.setViewportSize({ width: 1440, height: 900 })
  let bounds = await page.locator('.wa-connection').boundingBox()
  assert.isAtMost(bounds!.height, 36)
  await page
    .locator('.wa-connection')
    .screenshot({ path: '/private/tmp/whatsapp-connection-compact.png' })
  await page.setViewportSize({ width: 390, height: 740 })
  bounds = await page.locator('.wa-connection').boundingBox()
  assert.isAtMost(bounds!.height, 36)
  assert.isAtMost(bounds!.x + bounds!.width, 390)
  assert.isAtLeast(bounds!.x, 0)
  await page.screenshot({ path: '/private/tmp/whatsapp-connection-mobile-full.png' })
  await page
    .locator('.wa-connection')
    .screenshot({ path: '/private/tmp/whatsapp-connection-compact-mobile.png' })
  disconnected = true
  await page.locator('#connectButton').waitFor({ state: 'visible' })
  assert.isFalse(await page.locator('#connectButton').isDisabled())
  assert.isFalse(await page.locator('#disconnectButton').isVisible())
  assert.isFalse(await page.locator('#phoneText').isVisible())
  await page.getByRole('button', { name: 'Hubungkan WhatsApp', exact: true }).click()
  assert.isTrue(actions.some((path) => path.endsWith('/api/connect')))
})
