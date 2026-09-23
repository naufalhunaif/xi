import { test } from '@japa/runner'

test('payment editor adds, edits and removes methods without saving unrelated settings', async ({
  client,
  browserContext,
  assert,
}) => {
  const response = await client.get('/settings').withSession({
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
  const requests: Array<{ method: string; body: any }> = []
  let methods: any[] = []
  await page.route('**/settings', (route) =>
    route.fulfill({ contentType: 'text/html', body: response.text() })
  )
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.includes('/api/settings/payments')) {
      const verb = route.request().method()
      const body = route.request().postDataJSON() || {}
      requests.push({ method: verb, body })
      if (verb === 'POST' || verb === 'PUT') methods = [{ id: 9999, ...body }]
      if (verb === 'DELETE') methods = []
      return route.fulfill({ json: { paymentMethods: methods } })
    }
    if (url.pathname.endsWith('/api/settings')) requests.push({ method: 'UNRELATED', body: {} })
    return route.fulfill({ json: { connections: [] } })
  })
  await page.setViewportSize({ width: 390, height: 740 })
  await page.goto('http://localhost/alogaritm--app/whatsapp/settings#payments')
  await page.locator('#settings-payments').waitFor({ state: 'visible' })
  assert.equal(await page.locator('#settingsForm button[type="submit"]').count(), 0)
  await page.locator('#paymentName').fill('Bank Uji')
  await page.locator('#paymentDestination').fill('001234500')
  await page.locator('#paymentAccountName').fill('Pemilik Uji')
  await page.locator('[data-settings-menu="skills"]').click()
  await page.locator('[data-settings-menu="payments"]').click()
  assert.equal(await page.locator('#paymentDestination').inputValue(), '001234500')
  await page.locator('#paymentSave').click()
  await page.locator('[data-payment-id="9999"]').waitFor()
  assert.equal(requests[0].body.destination, '001234500')
  await page.locator('[data-payment-edit]').click()
  await page.locator('#paymentDestination').fill('00999888')
  await page.locator('#paymentEnabled').click()
  await page.locator('#paymentList').getByText('Nonaktif', { exact: true }).waitFor()
  assert.equal(requests[1].method, 'PUT')
  assert.isFalse(requests[1].body.enabled)
  const width = await page.evaluate<{ full: number; viewport: number }>(
    '({ full: document.documentElement.scrollWidth, viewport: innerWidth })'
  )
  assert.isAtMost(width.full, width.viewport)
  await page.screenshot({ path: '/private/tmp/whatsapp-payments-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '/private/tmp/whatsapp-payments-desktop.png' })
  page.on('dialog', (dialog) => dialog.accept())
  await page.locator('[data-payment-delete]').click()
  await page.locator('#paymentList').getByText('Belum ada metode pembayaran').waitFor()
  assert.deepEqual(
    requests.map((request) => request.method),
    ['POST', 'PUT', 'DELETE']
  )
  assert.deepEqual(errors, [])
})
