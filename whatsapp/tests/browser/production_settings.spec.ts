import { test } from '@japa/runner'
import { defaultProductionPolicy, validateProductionPolicy } from '#services/production_contract'

test('production panel autosaves, preserves edits, shows errors and fits desktop/mobile', async ({
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
  const errors: string[] = []
  const writes: unknown[] = []
  let policy = defaultProductionPolicy()
  let conflict = false
  const data = () => ({ policy, evaluationReady: true, signals: [], history: [] })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/settings', (route) =>
    route.fulfill({ contentType: 'text/html', body: response.text() })
  )
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith('/api/settings/production')) {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON()
        writes.push(body)
        try {
          if (conflict) throw new Error('Production settings changed. Reload before editing.')
          policy = { ...validateProductionPolicy(body), version: `version-${writes.length}` }
        } catch (error) {
          return route.fulfill({ status: 422, json: { error: (error as Error).message } })
        }
      }
      return route.fulfill({ json: data() })
    }
    return route.fulfill({
      json: { connected: false, connections: [], found: true, status: 'disconnected' },
    })
  })
  await page.setViewportSize({ width: 1440, height: 950 })
  await page.goto('http://localhost/alogaritm--app/whatsapp/settings#production')
  const field = (name: string) =>
    page.locator(`[data-production-kind="custom"][data-production-field="${name}"]`)
  await field('minDays').waitFor()
  const controlHeights = await page.evaluate<number[]>(
    "Array.from(document.querySelectorAll('#productionRules input, #productionRules select')).map(el => el.getBoundingClientRect().height)"
  )
  assert.isTrue(
    controlHeights.every((height) => height === 36),
    JSON.stringify(controlHeights)
  )
  const info = page.locator('[data-info-target="productionInfo"]')
  const popover = page.locator('#productionInfo')
  assert.isFalse(await popover.isVisible())
  await info.focus()
  await page.keyboard.press('Enter')
  assert.isTrue(await popover.isVisible())
  assert.equal(await info.getAttribute('aria-expanded'), 'true')
  assert.include(await popover.innerText(), '80%')
  assert.lengthOf(writes, 0)
  await page.screenshot({ path: '/private/tmp/whatsapp-production-info-desktop.png' })
  await page.keyboard.press('Escape')
  assert.isFalse(await popover.isVisible())
  assert.isTrue(await info.evaluate((el) => el.ownerDocument.activeElement === el))
  const rowTops = await page.evaluate<number[]>(
    "Array.from(document.querySelectorAll('.wa-production-rule:first-child .wa-production-options select')).map(el => el.getBoundingClientRect().top)"
  )
  assert.equal(rowTops[0], rowTops[1])
  assert.equal(
    await page.locator('#settings-title-production').textContent(),
    'Production & Pre-order'
  )
  await field('minDays').fill('10')
  await field('estimateDays').fill('14')
  await field('maxDays').fill('20')
  await field('enabled').click()
  await page.waitForFunction(
    "document.getElementById('productionSaveStatus')?.textContent === 'Saved'"
  )
  assert.equal(policy.rules.custom.enabled, true)
  assert.equal(policy.rules.custom.estimateDays, 14)
  assert.equal(policy.rules.custom.minDays, 10)
  assert.equal(policy.rules.custom.maxDays, 20)
  await page.locator('#productionAuto').click()
  await page.waitForFunction(
    "document.getElementById('productionSaveStatus')?.textContent === 'Saved'"
  )
  assert.isFalse(policy.autoAdjust)
  await field('estimateDays').fill('5')
  await field('estimateDays').blur()
  await page.locator('#productionSaveStatus.error').waitFor()
  assert.equal(policy.rules.custom.estimateDays, 14)
  await field('estimateDays').fill('15')
  await field('estimateDays').blur()
  await page.waitForFunction(
    "document.getElementById('productionSaveStatus')?.textContent === 'Saved'"
  )
  assert.equal(policy.rules.custom.estimateDays, 15)
  await page.screenshot({ path: '/private/tmp/whatsapp-production-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('#sidebar').waitFor({ state: 'hidden' })
  await field('maxDays').scrollIntoViewIfNeeded()
  const dimensions = await page.evaluate<{ full: number; viewport: number }>(
    '({full: document.documentElement.scrollWidth, viewport: innerWidth})'
  )
  assert.isAtMost(dimensions.full, dimensions.viewport)
  assert.equal(await field('dayType').evaluate((el) => el.getBoundingClientRect().height), 40)
  assert.equal(
    await page.evaluate<string>(
      "getComputedStyle(document.querySelector('[data-production-field=dayType]')).fontSize"
    ),
    '16px'
  )
  await page.screenshot({ path: '/private/tmp/whatsapp-production-mobile.png' })
  await info.click()
  const bounds = await popover.boundingBox()
  assert.isAtLeast(bounds!.x, 0)
  assert.isAtMost(bounds!.x + bounds!.width, 390)
  assert.isAtLeast(bounds!.y, 0)
  assert.isAtMost(bounds!.y + bounds!.height, 844)
  await page.screenshot({ path: '/private/tmp/whatsapp-production-info-mobile.png' })
  await popover.locator('[data-info-close]').click()
  assert.isFalse(await popover.isVisible())
  conflict = true
  await field('estimateDays').fill('16')
  await field('estimateDays').blur()
  await page.locator('#productionSaveStatus.error').waitFor()
  assert.equal(policy.rules.custom.estimateDays, 15)
  assert.include((await page.locator('#productionSaveStatus').textContent()) || '', 'Reload')
  page.on('dialog', (dialog) => dialog.accept())
  conflict = false
  await page.locator('#productionReload').click()
  await page.waitForFunction(
    "document.getElementById('productionSaveStatus')?.textContent === 'Autosaved'"
  )
  assert.equal(await field('estimateDays').inputValue(), '15')
  assert.deepEqual(errors, [])
}).timeout(60_000)
