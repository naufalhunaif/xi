import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('room header separates identity and status from actions on desktop and mobile', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339003@lid'
  const name = 'Naufal Hunaif — Pelanggan dengan nama panjang'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'room-header-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: name,
      body: 'Pesan uji',
      status: 'received',
      created_at: new Date(),
    })
    const response = await client.get(`/?jid=${jid}`).withSession({
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
    let mode = 'ai'
    let goal = 'waiting_answer'
    const errors: string[] = []
    const writes: any[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/contacts/mode')) {
        const body = route.request().postDataJSON()
        writes.push(body)
        mode = body.mode
        goal = mode === 'cs' ? 'waiting_cs' : 'completed'
        return route.fulfill({ json: { ok: true } })
      }
      if (path.endsWith('/contacts'))
        return route.fulfill({
          json: {
            contacts: [{ jid, contact_name: name, handling_mode: mode, goal_status: goal }],
          },
        })
      return route.fulfill({ json: { connections: [], messages: [], hasMore: false } })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('#roomGoalStatus').getByText('Menunggu jawaban').waitFor()
    assert.equal(await page.locator('#roomMode').textContent(), 'Ditangani AI')
    assert.equal(await page.locator('#roomName').getAttribute('title'), name)
    assert.equal(await page.locator('#roomHandling #roomGoalStatus').count(), 0)
    const identity = await page.locator('.wa-room-identity').boundingBox()
    const actions = await page.locator('#roomHandling').boundingBox()
    assert.isAtMost(identity!.x + identity!.width, actions!.x)
    await page
      .locator('.wa-room-title')
      .screenshot({ path: '/private/tmp/wa-room-header-desktop.png' })
    await page.locator('#roomModeButton').click()
    await page.locator('#roomMode').getByText('Ditangani CS').waitFor()
    assert.equal(await page.locator('#roomGoalStatus').textContent(), '')
    await page.locator('#roomModeButton').click()
    await page.locator('#roomGoalStatus').getByText('Selesai').waitFor()
    assert.deepEqual(writes, [
      { jid, mode: 'cs' },
      { jid, mode: 'ai' },
    ])
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 })
      await page.locator('#sidebar').waitFor({ state: 'hidden' })
      const status = await page.locator('#roomStatus').boundingBox()
      const handling = await page.locator('#roomHandling').boundingBox()
      const header = await page.locator('.wa-room-title').boundingBox()
      assert.isAtLeast(handling!.y, status!.y + status!.height)
      for (const id of ['roomModeButton', 'roomExclusionButton', 'cartOpen']) {
        const box = await page.locator(`#${id}`).boundingBox()
        assert.isAtLeast(box!.x, header!.x)
        assert.isAtMost(box!.x + box!.width, header!.x + header!.width)
        assert.isAtMost(box!.y + box!.height, header!.y + header!.height)
      }
      const composer = await page.locator('#messageForm').boundingBox()
      assert.isAtMost(composer!.y + composer!.height, 844)
      assert.isTrue(await page.locator('#roomGoalStatus').isVisible())
      await page.screenshot({ path: `/private/tmp/wa-room-header-${width}.png` })
    }
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
