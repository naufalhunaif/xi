import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import sharp from 'sharp'
import { ensureDefaults } from '#services/settings_service'

test('CS attachment preview, cancellation, multipart submission and composer viewport', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000339957@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'media-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Test Lampiran',
      body: 'Boleh kirim dokumen?',
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
    const sent: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    let completed = false
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/messages/send')) {
        assert.include(route.request().headers()['content-type'], 'multipart/form-data; boundary=')
        sent.push(route.request().postData() || '')
        completed = true
        return route.fulfill({ json: { ok: true } })
      }
      if (path.endsWith('/contacts'))
        return route.fulfill({
          json: { contacts: [{ jid, contact_name: 'Test Lampiran', handling_mode: 'cs' }] },
        })
      if (path.endsWith('/messages'))
        return route.fulfill({
          json: {
            messages: completed
              ? [
                  {
                    id: 200001,
                    message_id: 'uploaded-pdf',
                    jid,
                    direction: 'out',
                    sender_type: 'cs',
                    body: 'Penawaran',
                    media_type: 'document',
                    media_name: 'penawaran.pdf',
                    media_url: '/example.pdf',
                    status: 'sent',
                  },
                ]
              : [],
            hasMore: false,
          },
        })
      return route.fulfill({ json: {} })
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    const png = await sharp({
      create: { width: 24, height: 20, channels: 3, background: '#55aa88' },
    })
      .png()
      .toBuffer()
    await page
      .locator('#mediaInput')
      .setInputFiles({ name: 'gambar.png', mimeType: 'image/png', buffer: png })
    assert.isTrue(await page.locator('#mediaPreview').isVisible())
    await page.locator('#cancelMedia').click()
    assert.isFalse(await page.locator('#mediaComposer').isVisible())
    assert.equal(await page.locator('[name="body"]').getAttribute('maxlength'), '4096')
    await page.locator('#mediaInput').setInputFiles({
      name: 'penawaran.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n%%EOF'),
    })
    await page.locator('[name="body"]').fill('Penawaran')
    await page.screenshot({ path: '/private/tmp/whatsapp-cs-upload-desktop.png' })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('#sidebar').waitFor({ state: 'hidden' })
    const composer = await page.locator('#messageForm').boundingBox()
    assert.isAtLeast(composer!.x, 0)
    assert.isAtMost(composer!.x + composer!.width, 390)
    assert.isAtMost(composer!.y + composer!.height, 844)
    await page.screenshot({
      path: '/private/tmp/whatsapp-cs-upload-mobile.png',
      animations: 'disabled',
    })
    await page.locator('#messageForm button[type="submit"]').click()
    await page.locator('.message-document').getByText('penawaran.pdf ↓').waitFor()
    assert.lengthOf(sent, 1)
    assert.include(sent[0], 'filename="penawaran.pdf"')
    assert.include(sent[0], 'Penawaran')
    assert.isFalse(await page.locator('#mediaComposer').isVisible())
    assert.equal(await page.locator('[name="body"]').inputValue(), '')
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(60_000)
