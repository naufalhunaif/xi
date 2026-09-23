import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('settings switches autosave, coalesce rapid changes, recover errors, and import skills once', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  try {
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_enabled: false, ai_provider: 'chatgpt' })
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
    const requests: any[] = []
    let release!: () => void
    const firstResponse = new Promise<void>((resolve) => {
      release = resolve
    })
    let fail = false
    let saved: any = { aiEnabled: false, aiProvider: 'chatgpt' }
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/settings', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/api/settings/skills/9999/download'))
        return route.fulfill({
          contentType: 'text/markdown; charset=utf-8',
          headers: { 'content-disposition': 'attachment; filename="skill-uji.md"' },
          body: 'Jawab ringkas.',
        })
      if (path.endsWith('/api/settings') && route.request().method() === 'POST') {
        const body = route.request().postDataJSON()
        requests.push(body)
        if (requests.length === 1) await firstResponse
        if (fail) return route.fulfill({ status: 422, json: { error: 'Koneksi uji gagal.' } })
        saved = { ...saved, ...body }
        if (body.mcpConnections)
          saved.mcpConnections = Object.entries(body.mcpConnections).map(([slug, enabled]) => ({
            slug,
            enabled,
          }))
        if (body.skills)
          saved.skills = [
            {
              id: 9999,
              name: 'skill-uji',
              updatedAt: new Date().toISOString(),
              updatedAtLabel: 'hari ini WIB',
            },
          ]
        return route.fulfill({ json: saved })
      }
      return route.fulfill({ json: { connections: [], connected: false } })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('http://localhost/alogaritm--app/whatsapp/settings')
    assert.equal(await page.locator('#settings input[type="checkbox"]').count(), 0)
    assert.equal(await page.locator('#settingsForm button[type="submit"]').count(), 0)
    const toggle = page.getByRole('switch', { name: 'Balas otomatis', exact: true })
    const first = page.waitForRequest('**/api/settings')
    await toggle.click()
    await first
    await toggle.click()
    await toggle.click()
    release()
    await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    assert.isTrue(saved.aiEnabled)
    assert.lengthOf(requests, 1)
    fail = true
    await toggle.click()
    await page.locator('#settingsSaveState.error').waitFor()
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    fail = false
    await toggle.click()
    await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
    assert.isFalse(saved.aiEnabled)
    await page.locator('[name="chatgptModel"]').fill('test-model')
    await page.locator('[data-settings-menu="behavior"]').click()
    await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
    assert.deepEqual(requests.at(-1), { chatgptModel: 'test-model' })
    await page.locator('[name="historyLimit"]').fill('999')
    await page.locator('[name="historyLimit"][aria-invalid="true"]').waitFor()
    assert.notEqual(requests.at(-1).historyLimit, '999')
    await page.locator('[name="historyLimit"]').fill('50')
    await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
    await page.locator('[data-settings-menu="business"]').click()
    await page.locator('[data-mcp-enabled]').first().click()
    await page.locator('#settingsSaveState').getByText('Tersimpan', { exact: true }).waitFor()
    assert.deepEqual(Object.keys(requests.at(-1)), ['mcpConnections'])
    assert.lengthOf(Object.keys(requests.at(-1).mcpConnections), 1)
    await page.locator('[data-settings-menu="skills"]').click()
    await page.locator('#skillFile').setInputFiles({
      name: 'skill-uji.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('Jawab ringkas.'),
    })
    await page.locator('[data-skill-row="9999"]').waitFor()
    const downloadLink = page.locator('[data-skill-download="9999"]')
    assert.equal(await downloadLink.getAttribute('aria-label'), 'Unduh skill')
    const downloaded = page.waitForEvent('download')
    await downloadLink.click()
    const file = await downloaded
    assert.equal(file.suggestedFilename(), 'skill-uji.md')
    assert.isNull(await file.failure())
    await page.evaluate("window.waI18n.setLanguage('en')")
    assert.equal(await downloadLink.getAttribute('aria-label'), 'Download skill')
    await page.setViewportSize({ width: 390, height: 740 })
    assert.isAtMost(await page.evaluate<number>('document.documentElement.scrollWidth'), 390)
    await page.screenshot({ path: '/private/tmp/whatsapp-skill-download-mobile.png' })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate("window.waI18n.setLanguage('id')")
    assert.lengthOf(
      requests.filter((body) => body.skills),
      1
    )
    assert.deepEqual(Object.keys(requests.at(-1)), ['skills'])
    await page.locator('[data-settings-menu="ai"]').click()
    await page.locator('#settings-ai').waitFor({ state: 'visible' })
    await page.screenshot({ path: '/private/tmp/whatsapp-settings-autosave-desktop.png' })
    await page.setViewportSize({ width: 390, height: 740 })
    await page.locator('#sidebar').waitFor({ state: 'hidden' })
    await page.screenshot({
      path: '/private/tmp/whatsapp-settings-autosave-mobile.png',
      animations: 'disabled',
    })
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
