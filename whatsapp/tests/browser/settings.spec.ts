import { test } from '@japa/runner'

test('settings menus preserve edits and remain usable on desktop and mobile', async ({
  client,
  browserContext,
  assert,
}) => {
  const session = {
    account: {
      sub: 'a'.repeat(64),
      sessionToken: 'b'.repeat(43),
      checkedAt: Date.now(),
      name: 'Pemilik',
      username: 'owner',
    },
  }
  const response = await client.get('/settings').withSession(session)
  response.assertStatus(200)
  const usage = await client.get('/api/ai/usage').withSession(session)
  usage.assertStatus(200)
  usage.assertHeader('cache-control', 'no-store')
  assert.lengthOf(usage.body().providers, 2)
  const evaluations = await client.get('/api/ai/evaluations').withSession(session)
  evaluations.assertStatus(200)
  evaluations.assertHeader('cache-control', 'no-store')

  // Render the real authenticated page, but isolate browser actions from live settings.
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
  await page.route('**/settings', (route) =>
    route.fulfill({ contentType: 'text/html', body: response.text() })
  )
  await page.route('**/api/**', (route) => {
    const isUsage = route.request().url().endsWith('/api/ai/usage')
    const isEvaluation = route.request().url().endsWith('/api/ai/evaluations')
    return route.fulfill({
      json: isUsage
        ? usage.body()
        : isEvaluation
          ? evaluations.body()
          : { connections: [], aiEnabled: false, ...(route.request().postDataJSON() || {}) },
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('http://localhost/alogaritm--app/whatsapp/settings')
  await page.locator('#settings-ai').waitFor({ state: 'visible' })
  await page.locator('#chatgptModelPicker').selectOption('__custom__')
  await page.locator('[name="chatgptModel"]').fill('unsaved-model-test')
  for (const name of ['skills', 'evaluation', 'business', 'payments', 'behavior', 'usage']) {
    await page.locator(`[data-settings-menu="${name}"]`).click()
    await page.locator(`#settings-${name}`).waitFor({ state: 'visible' })
    assert.equal(await page.locator('[data-settings-panel]:visible').count(), 1)
  }
  await page.locator('#usageCards .wa-usage-card').first().waitFor()
  assert.equal(await page.locator('#usageCards .wa-usage-card').count(), 2)
  assert.equal(await page.locator('#quotaCards .wa-quota-card').count(), 2)
  assert.equal(await page.locator('#settingsForm button[type="submit"]').count(), 0)
  await page.locator('[data-settings-menu="ai"]').click()
  assert.equal(await page.locator('[name="chatgptModel"]').inputValue(), 'unsaved-model-test')
  await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
  const times = page.locator('time[data-relative-time]')
  assert.isAbove(await times.count(), 0)
  assert.match((await times.first().textContent())!, /^(\d+(m|h|d|mo|y) ago|just now)$/)
  assert.include((await times.first().getAttribute('title'))!, 'WIB')

  await page.setViewportSize({ width: 390, height: 640 })
  for (const name of ['skills', 'evaluation', 'business', 'payments', 'ai', 'usage']) {
    await page.locator(`[data-settings-menu="${name}"]`).click()
    await page.locator(`#settings-${name}`).waitFor({ state: 'visible' })
    const width = await page.evaluate<{ document: number; viewport: number }>(
      '({ document: document.documentElement.scrollWidth, viewport: window.innerWidth })'
    )
    assert.isAtMost(width.document, width.viewport)
  }
  await page.locator('[data-settings-menu="ai"]').click()
  await page.locator('#codexCheck').scrollIntoViewIfNeeded()
  const bounds = await page.locator('#codexCheck').boundingBox()
  assert.isNotNull(bounds)
  assert.isAtMost(bounds!.y + bounds!.height, 640)
  assert.isAbove(await page.evaluate<number>('window.scrollY'), 0)
  assert.deepEqual(errors, [])
})
