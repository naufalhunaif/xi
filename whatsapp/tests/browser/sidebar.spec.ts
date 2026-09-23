import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('sidebar stays icon-only across pages and viewport sizes without a topbar', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339004@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'sidebar-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Kontak uji',
      body: 'Halo',
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
    const room = await client.get(`/?jid=${jid}`).withSession(session)
    const settings = await client.get('/settings').withSession(session)
    room.assertStatus(200)
    settings.assertStatus(200)
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
    const writes: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: room.text() })
    )
    await page.route('**/whatsapp/settings', (route) =>
      route.fulfill({ contentType: 'text/html', body: settings.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'POST' && !path.endsWith('/contacts/read')) writes.push(path)
      if (path.endsWith('/contacts'))
        return route.fulfill({
          json: { contacts: [{ jid, contact_name: 'Kontak uji', handling_mode: 'ai' }] },
        })
      return route.fulfill({
        json: { contacts: [], messages: [], connections: [], hasMore: false },
      })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    assert.equal(await page.locator('#menu-toggle, .topbar').count(), 0)
    assert.equal((await page.locator('#sidebar').boundingBox())!.width, 64)
    assert.equal((await page.locator('.shell').boundingBox())!.x, 64)
    assert.isFalse(await page.locator('.brand-name').isVisible())
    const composer = await page.locator('#messageForm').boundingBox()
    assert.isAtMost(composer!.y + composer!.height, 900)
    await page.locator('#launcherButton').click()
    assert.isTrue(await page.locator('#launcherMenu').isVisible())
    await page.keyboard.press('Escape')
    assert.isFalse(await page.locator('#launcherMenu').isVisible())
    await page.getByRole('link', { name: 'Pengaturan', exact: true }).click()
    assert.equal((await page.locator('#sidebar').boundingBox())!.width, 64)
    for (const width of [390, 1000, 1440]) {
      await page.setViewportSize({ width, height: 844 })
      assert.equal((await page.locator('#sidebar').boundingBox())!.width, width <= 760 ? 52 : 64)
      assert.isFalse(await page.locator('.brand-name').isVisible())
      assert.isTrue(await page.getByRole('link', { name: 'Chat', exact: true }).isVisible())
    }
    await page.reload()
    assert.equal((await page.locator('#sidebar').boundingBox())!.width, 64)
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
