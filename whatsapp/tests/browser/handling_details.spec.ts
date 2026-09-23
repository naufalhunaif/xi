import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('handling badge explains handoff safely, supports keyboard/mobile, and clears stale reasons', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000990115@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'handling-browser',
      jid,
      contact_name: 'Handling Fixture',
      direction: 'in',
      body: 'Pesanan custom',
      status: 'received',
      created_at: new Date(),
    })
    const response = await client.get(`/?jid=${jid}`).withSession({
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Test',
        username: 'test',
      },
    })
    response.assertStatus(200)
    const page = await browserContext.newPage()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.setViewportSize({ width: 1440, height: 900 })
    const errors: string[] = []
    const writes: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let contact = {
      jid,
      contact_name: 'Handling Fixture',
      handling_mode: 'cs',
      ai_excluded: false,
      handoff_reason: 'Ukuran di luar katalog; harga custom perlu persetujuan.',
      handling_note: 'Jas peak lapel, 1 pcs.\n<img src=x onerror=alert(1)>',
      goal_waiting_for: 'Persetujuan ukuran dan harga',
      goal_next_action: 'Periksa ukuran custom sebelum mengonfirmasi harga.',
    }
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (route.request().method() !== 'GET') writes.push(path)
      return route.fulfill({
        json: path.endsWith('/contacts')
          ? { contacts: [contact] }
          : { messages: [], hasMore: false },
      })
    })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    const badge = page.locator('#roomMode')
    const panel = page.locator('#roomHandlingDetails')
    await badge.getByText('Handled by CS').waitFor()
    assert.equal(await badge.getAttribute('title'), contact.handoff_reason)
    await badge.focus()
    await page.keyboard.press('Enter')
    await panel.waitFor({ state: 'visible' })
    assert.equal(await badge.getAttribute('aria-expanded'), 'true')
    assert.include(await panel.innerText(), 'Handoff reason')
    assert.include(await panel.innerText(), contact.goal_next_action)
    assert.include(await panel.innerText(), contact.handling_note)
    assert.equal(await panel.locator('img').count(), 0)
    await page.screenshot({ path: '/private/tmp/whatsapp-handling-details-desktop.png' })
    await page.keyboard.press('Escape')
    await panel.waitFor({ state: 'hidden' })
    assert.isTrue(await badge.evaluate((el) => el.ownerDocument.activeElement === el))
    await page.setViewportSize({ width: 320, height: 780 })
    await badge.click()
    const bounds = await panel.boundingBox()
    assert.isAtLeast(bounds!.x, 0)
    assert.isAtMost(bounds!.x + bounds!.width, 320)
    assert.isAtLeast(bounds!.y, 0)
    assert.isAtMost(bounds!.y + bounds!.height, 780)
    await page.screenshot({ path: '/private/tmp/whatsapp-handling-details-mobile.png' })
    // Live updates retain an open panel without stale reasons or duplicating sections.
    contact = {
      ...contact,
      handoff_reason: 'Model custom sudah disetujui; verifikasi biaya tambahan.',
    }
    await page.evaluate('document.dispatchEvent(new Event("ai-exclusions:updated"))')
    await panel.getByText(contact.handoff_reason, { exact: true }).waitFor()
    assert.equal(await panel.locator('dl').count(), 1)
    await page.evaluate('window.waI18n.setLanguage("id")')
    await panel.getByText('Alasan pengalihan', { exact: true }).waitFor()
    await page.locator('#roomHandlingDetailsClose').click()
    await panel.waitFor({ state: 'hidden' })
    contact = {
      ...contact,
      handling_mode: 'ai',
      goal_waiting_for: 'Jawaban pelanggan',
      goal_next_action: '',
    }
    await page.evaluate('document.dispatchEvent(new Event("ai-exclusions:updated"))')
    await badge.getByText('Ditangani AI').waitFor()
    await badge.click()
    assert.notInclude(await panel.innerText(), contact.handoff_reason)
    assert.notInclude(await panel.innerText(), contact.handling_note)
    assert.include(await panel.innerText(), 'Jawaban pelanggan')
    contact = { ...contact, handling_mode: 'cs', handoff_reason: '' }
    await page.evaluate('document.dispatchEvent(new Event("ai-exclusions:updated"))')
    await badge.getByText('Ditangani CS').waitFor()
    await panel.waitFor({ state: 'hidden' })
    await badge.click()
    assert.include(await panel.innerText(), 'Belum ada alasan pengalihan tercatat')
    assert.notInclude(await panel.innerText(), 'Jawaban pelanggan')
    assert.notInclude(await panel.innerText(), contact.handling_note)
    await page.locator('#roomName').click()
    await panel.waitFor({ state: 'hidden' })
    // Opening the room may acknowledge its visible message, but inspecting details
    // must never change handling mode, order data, or send a reply.
    assert.deepEqual(
      writes.filter((path) => !path.endsWith('/contacts/read')),
      []
    )
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(30_000)
