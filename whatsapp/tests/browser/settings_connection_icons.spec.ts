import { test } from '@japa/runner'

test('connection icons retain labels and MCP switches align after dynamic rendering', async ({
  client,
  browserContext,
  assert,
}) => {
  const response = await client.get('/settings').withSession({
    account: {
      sub: 'a'.repeat(64),
      sessionToken: 'b'.repeat(43),
      checkedAt: Date.now(),
      name: 'Test CS',
      username: 'test',
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
  const badAssets: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('response', (result) => {
    if (result.url().includes('.svg') && result.status() !== 200) badAssets.push(result.url())
  })
  const connections = [
    { slug: 'connected-test', name: 'Data produk', enabled: true, authenticated: true },
    {
      slug: 'disconnected-test',
      name: 'Pengiriman dan stok cabang',
      enabled: false,
      authenticated: false,
    },
  ]
  await page.route('**/settings', (route) =>
    route.fulfill({ contentType: 'text/html', body: response.text() })
  )
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/settings/mcp') || path.includes('/api/mcp/oauth/'))
      return route.fulfill({ json: { connections } })
    if (path.endsWith('/api/settings'))
      return route.fulfill({ json: { aiEnabled: false, mcpConnections: connections } })
    if (path.endsWith('/api/ai/oauth/status')) return route.fulfill({ json: { connected: true } })
    return route.fulfill({ json: { connected: false, found: true, version: 'Siap' } })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost/alogaritm--app/whatsapp/settings#business')
  await page.locator('#mcpName').fill('Data uji')
  await page.locator('#mcpUrl').fill('https://example.com/mcp')
  await page.locator('#mcpAddButton').click()
  await page.locator('[data-mcp-row="connected-test"]').waitFor()
  assert.isFalse(
    await page.getByRole('button', { name: 'Hubungkan Data produk', exact: true }).isVisible()
  )
  assert.isTrue(
    await page
      .getByRole('button', { name: 'Hubungkan Pengiriman dan stok cabang', exact: true })
      .isVisible()
  )
  const assertAligned = async () => {
    const first = await page
      .getByRole('switch', { name: 'Aktifkan Data produk', exact: true })
      .boundingBox()
    const second = await page
      .getByRole('switch', { name: 'Aktifkan Pengiriman dan stok cabang', exact: true })
      .boundingBox()
    assert.closeTo(first!.x, second!.x, 1)
    assert.equal(first!.width, 36)
  }
  await assertAligned()
  await page.screenshot({ path: '/private/tmp/whatsapp-connection-icons-desktop.png' })
  await page.setViewportSize({ width: 390, height: 740 })
  await page.locator('#sidebar').waitFor({ state: 'hidden' })
  await assertAligned()
  const width = await page.evaluate<{ full: number; viewport: number }>(
    '({ full: document.documentElement.scrollWidth, viewport: innerWidth })'
  )
  assert.isAtMost(width.full, width.viewport)
  await page.screenshot({
    path: '/private/tmp/whatsapp-connection-icons-mobile.png',
    animations: 'disabled',
  })
  await page.locator('[data-settings-menu="ai"]').click()
  await page.locator('#settings-ai').waitFor({ state: 'visible' })
  await page.locator('#aiProvider').selectOption('chatgpt')
  await page.locator('#oauthStatus.connected').waitFor()
  assert.equal(await page.locator('#oauthStatus').getAttribute('title'), 'Terhubung')
  assert.isFalse(await page.locator('#oauthButton').isVisible())
  assert.deepEqual(errors, [])
  assert.deepEqual(badAssets, [])
}).timeout(60_000)
