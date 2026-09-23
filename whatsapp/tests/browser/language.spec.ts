import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('English is default, language persists and only UI labels change', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339005@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'language-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Pengaturan',
      body: 'Pembayaran',
      status: 'received',
      created_at: new Date(),
    })
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Pengaturan',
        username: 'test',
      },
    }
    const settings = await client.get('/settings').withSession(session)
    const room = await client.get(`/?jid=${jid}`).withSession(session)
    settings.assertStatus(200)
    room.assertStatus(200)
    const page = await browserContext.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors: string[] = []
    const writes: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/whatsapp/settings', (route) =>
      route.fulfill({ contentType: 'text/html', body: settings.text() })
    )
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: room.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() === 'POST' && !path.endsWith('/contacts/read')) writes.push(path)
      if (path.endsWith('/contacts'))
        return route.fulfill({
          json: {
            contacts: [
              {
                jid,
                contact_name: 'Pengaturan',
                handling_mode: 'ai',
                goal_status: 'waiting_answer',
              },
            ],
          },
        })
      if (path.endsWith('/status') && !path.includes('/ai/'))
        return route.fulfill({ json: { status: 'connected', phone: '628111111111' } })
      if (path.endsWith('/messages'))
        return route.fulfill({
          json: {
            messages: [
              {
                id: 5001,
                message_id: 'language-message',
                jid,
                contact_name: 'Pengaturan',
                body: 'Pembayaran',
                direction: 'in',
                sender_type: 'customer',
                status: 'received',
              },
            ],
            hasMore: false,
          },
        })
      if (path.endsWith('/cart'))
        return route.fulfill({
          json: {
            cart: {
              jid,
              version: 'test',
              items: [
                {
                  id: '1',
                  name: 'Pengaturan',
                  size: 'L',
                  quantity: 1,
                  unitPrice: 10000,
                  measurements: {},
                  note: '',
                  image: '',
                },
              ],
              recipient: { name: 'Pembayaran', phone: '0811111111', address: 'Pengaturan' },
              shipping: { service: 'REG', cost: 0 },
              total: 10000,
              paymentStatus: '',
            },
            orders: [],
            customerBalance: { balance: 0, entries: [] },
          },
        })
      return route.fulfill({ json: { connections: [], contacts: [], messages: [] } })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto('http://localhost/alogaritm--app/whatsapp/settings#general')
    await page.getByRole('heading', { name: 'General', exact: true }).waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), 'en')
    assert.equal(await page.locator('#uiLanguage').inputValue(), 'en')
    assert.equal(await page.locator('.wa-settings-heading').innerText(), 'Settings')
    assert.equal(await page.locator('.owner-info strong').innerText(), 'Pengaturan')
    await page.screenshot({ path: '/private/tmp/whatsapp-language-en.png' })
    await page.locator('#uiLanguage').selectOption('id')
    assert.equal(await page.locator('.wa-settings-heading').innerText(), 'Pengaturan')
    assert.equal(await page.locator('html').getAttribute('lang'), 'id')
    await page.reload()
    assert.equal(await page.locator('#uiLanguage').inputValue(), 'id')
    await page.getByRole('heading', { name: 'Umum', exact: true }).waitFor()
    await page.locator('[data-settings-menu="business"]').click()
    await page.locator('#mcpName').fill('Data bisnis saya')
    await page.locator('[data-settings-menu="general"]').click()
    await page.locator('#uiLanguage').selectOption('en')
    assert.equal(await page.locator('#mcpName').inputValue(), 'Data bisnis saya')
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('#roomMode').getByText('Handled by AI').waitFor()
    await page
      .locator('#roomGoalStatus')
      .getByText('Waiting for a reply', { exact: true })
      .waitFor()
    assert.equal(await page.locator('#roomName').innerText(), 'Pengaturan')
    assert.include(await page.locator('#messages').innerText(), 'Pembayaran')
    assert.equal(await page.locator('#roomModeButton').innerText(), 'Take over')
    assert.include(await page.locator('#unansweredFilter').innerText(), 'Unanswered')
    await page.locator('#cartOpen').click()
    await page.locator('#cartItems strong').getByText('Pengaturan', { exact: true }).waitFor()
    assert.include(await page.locator('#cartDetails').innerText(), 'Recipient')
    assert.include(await page.locator('#cartDetails').innerText(), 'Pembayaran')
    assert.equal(await page.locator('#cartCancel').innerText(), 'Cancel cart')
    await page.locator('#cartClose').click()
    await page.goto('http://localhost/alogaritm--app/whatsapp/settings#general')
    assert.equal(await page.locator('#uiLanguage').inputValue(), 'en')
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#sidebar').waitFor({ state: 'hidden' })
    await page.locator('#uiLanguage').selectOption('id')
    const languageSelect = await page.locator('#uiLanguage').boundingBox()
    assert.isAtLeast(languageSelect!.x, 0)
    assert.isAtMost(languageSelect!.x + languageSelect!.width, 390)
    await page.screenshot({
      path: '/private/tmp/whatsapp-language-id-mobile.png',
      animations: 'disabled',
    })
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
