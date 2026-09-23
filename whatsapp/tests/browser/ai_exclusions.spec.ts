import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('manage no-AI contacts from settings and room without unrelated saves', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339002@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'exclusion-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Kontak pribadi',
      body: 'Pesan uji',
      status: 'received',
      created_at: new Date(),
    })
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Test CS',
        username: 'test',
      },
    }
    const settings = await client.get('/settings').withSession(session)
    const room = await client.get(`/?jid=${jid}`).withSession(session)
    settings.assertStatus(200)
    room.assertStatus(200)
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
    const writes: any[] = []
    let excluded = false
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/settings', (route) =>
      route.fulfill({ contentType: 'text/html', body: settings.text() })
    )
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: room.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/contacts/exclusion')) {
        const body = route.request().postDataJSON()
        writes.push(body)
        excluded = body.excluded
        return route.fulfill({ json: { ok: true } })
      }
      if (path.endsWith('/api/settings')) writes.push('unrelated')
      if (path.endsWith('/ai/exclusions'))
        return route.fulfill({ json: { contacts: [{ jid, name: 'Kontak pribadi', excluded }] } })
      if (path.endsWith('/contacts'))
        return route.fulfill({
          json: {
            contacts: [
              { jid, contact_name: 'Kontak pribadi', handling_mode: 'cs', ai_excluded: excluded },
            ],
          },
        })
      return route.fulfill({ json: { connections: [], messages: [], hasMore: false } })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('http://localhost/alogaritm--app/whatsapp/settings#behavior')
    await page.locator('#exclusionContact').selectOption(jid)
    await page.locator('#exclusionAdd').click()
    await page.locator('.wa-exclusion-row').getByText('Kontak pribadi').waitFor()
    assert.isTrue(excluded)
    await page
      .locator('.wa-exclusions')
      .screenshot({ path: '/private/tmp/whatsapp-exclusions-settings.png' })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('#roomExclusionButton[aria-pressed="true"]').waitFor()
    assert.isTrue(await page.locator('#roomModeButton').isDisabled())
    await page.locator('#roomExclusionButton').click()
    await page.locator('#roomExclusionButton[aria-pressed="false"]').waitFor()
    assert.isFalse(excluded)
    await page.locator('#roomExclusionButton').click()
    await page.locator('#roomExclusionButton[aria-pressed="true"]').waitFor()
    assert.isTrue(excluded)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#sidebar').waitFor({ state: 'hidden' })
    const button = await page.locator('#roomExclusionButton').boundingBox()
    assert.isAtMost(button!.x + button!.width, 390)
    const header = await page.locator('.wa-room-title').boundingBox()
    const cart = await page.locator('#cartOpen').boundingBox()
    assert.isAtLeast(cart!.y, header!.y)
    assert.isAtMost(cart!.y + cart!.height, header!.y + header!.height)
    assert.isAtMost(cart!.x + cart!.width, header!.x + header!.width)
    const composer = await page.locator('#messageForm').boundingBox()
    assert.isAtMost(composer!.y + composer!.height, 844)
    await page.screenshot({
      path: '/private/tmp/whatsapp-exclusions-room-mobile.png',
      animations: 'disabled',
    })
    await page.goto('http://localhost/alogaritm--app/whatsapp/settings#behavior')
    await page.locator('[data-remove-exclusion]').click()
    await page.locator('#exclusionList').getByText('Belum ada kontak').waitFor()
    assert.isFalse(excluded)
    assert.deepEqual(
      writes.map((body) => body.excluded),
      [true, false, true, false]
    )
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
