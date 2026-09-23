import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('inbox tabs, pending reply counts, polling and compact mobile layout', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339959@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'inbox-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Perlu bantuan',
      body: 'Cek pesanan saya',
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
    const response = await client.get(`/?jid=${jid}`).withSession(session)
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
    await page.route('**/whatsapp/?**', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    const rows = [
      {
        jid,
        contact_name: 'Perlu bantuan',
        handling_mode: 'cs',
        unanswered_count: 2,
        unread_count: 0,
        needs_payment: false,
        has_order: true,
        body: 'Cek pesanan saya',
      },
      {
        jid: '10000000339960@lid',
        contact_name: 'Konfirmasi transfer',
        handling_mode: 'cs',
        unanswered_count: 0,
        unread_count: 1,
        needs_payment: true,
        has_order: true,
        body: 'Bukti transfer diterima',
      },
      {
        jid: '10000000339961@lid',
        contact_name: 'Ditangani AI',
        handling_mode: 'ai',
        unanswered_count: 1,
        unread_count: 1,
        needs_payment: false,
        has_order: false,
        body: 'Ada ukuran M?',
        ai_running: true,
      },
      {
        jid: '10000000339962@lid',
        contact_name: 'Sudah dibalas',
        handling_mode: 'ai',
        unanswered_count: 0,
        unread_count: 0,
        needs_payment: false,
        has_order: false,
        body: 'Terima kasih',
      },
    ]
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/contacts')) return route.fulfill({ json: { contacts: rows } })
      if (path.endsWith('/messages'))
        return route.fulfill({ json: { messages: [], hasMore: false } })
      return route.fulfill({ json: {} })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('.wa-contact').filter({ hasText: 'Ditangani AI' }).waitFor()
    const count = (key: string) =>
      page.locator(`[data-inbox-filter="${key}"] [data-filter-count]`).textContent()
    assert.equal(await count('all'), '4')
    assert.equal(await page.locator('[data-inbox-filter="all"]').count(), 1)
    assert.equal(await page.getByRole('button', { name: /^All(?:\s|$)/ }).count(), 0)
    assert.include(
      (await page.locator('[data-inbox-filter="ai"]').textContent()) || '',
      'Ditangani AI'
    )
    assert.equal(await count('ai'), '2')
    assert.equal(await count('cs'), '2')
    assert.equal(await count('payment'), '1')
    assert.equal(await count('order'), '2')
    assert.equal(await page.locator('#unansweredCount').textContent(), '2')
    await page.locator('[name="body"]').fill('Draf tetap aman')
    await page.locator('[data-inbox-filter="cs"]').click()
    assert.equal(await page.locator('.wa-contact:visible').count(), 2)
    assert.equal(await page.locator('#unansweredCount').textContent(), '1')
    await page.locator('#unansweredFilter').click()
    assert.equal(await page.locator('.wa-contact:visible').count(), 1)
    assert.include(
      (await page.locator('.wa-contact:visible').getAttribute('href')) || '',
      'inbox=cs'
    )
    assert.include(
      (await page.locator('.wa-contact:visible').getAttribute('href')) || '',
      'unanswered=1'
    )
    assert.equal(await page.locator('[name="body"]').inputValue(), 'Draf tetap aman')
    await page.locator('[data-inbox-filter="payment"]').click()
    assert.equal(await page.locator('#unansweredFilter').getAttribute('aria-pressed'), 'false')
    assert.equal(await page.locator('.wa-contact:visible').count(), 1)
    assert.include(
      (await page.locator('.wa-contact:visible').textContent()) || '',
      'Konfirmasi transfer'
    )
    await page.reload()
    await page.locator('.wa-contact:visible').filter({ hasText: 'Konfirmasi transfer' }).waitFor()
    assert.equal(
      await page.locator('[data-inbox-filter="payment"]').getAttribute('aria-pressed'),
      'true'
    )
    // Simulate payment confirmation arriving via the normal polling endpoint.
    rows[1].needs_payment = false
    await page.locator('#contacts .wa-empty').waitFor()
    assert.equal(await count('payment'), '0')
    await page.locator('[data-inbox-filter="all"]').click()
    await page.screenshot({ path: '/private/tmp/whatsapp-inbox-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#sidebar').waitFor({ state: 'hidden' })
    const composer = await page.locator('#messageForm').boundingBox()
    assert.isAtMost(composer!.y + composer!.height, 844)
    assert.isAtMost(composer!.x + composer!.width, 390)
    await page.locator('[data-inbox-filter="order"]').click()
    assert.equal(await page.locator('.wa-contact:visible').count(), 2)
    await page.screenshot({
      path: '/private/tmp/whatsapp-inbox-mobile.png',
      animations: 'disabled',
    })
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
