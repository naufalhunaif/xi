import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('inbox badges refresh in server order and hidden rooms do not acknowledge background loads', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000448877@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'inbox-browser',
      jid,
      direction: 'in',
      sender_type: 'customer',
      contact_name: 'Inbox Browser',
      body: 'Halo',
      status: 'received',
      created_at: new Date(),
    })
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Pemilik',
        username: 'owner',
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
    const reads: any[] = []
    let currentId = 701
    let reverse = false
    let goalStatus = 'waiting_answer'
    let aiRunning = true
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path.endsWith('/contacts/read')) {
        reads.push(route.request().postDataJSON())
        return route.fulfill({ json: { ok: true } })
      }
      if (path.endsWith('/contacts')) {
        const contacts = [
          {
            jid,
            contact_name: 'Inbox Browser',
            handling_mode: 'ai',
            goal_status: goalStatus,
            goal_waiting_for: 'Alamat pelanggan',
            unread_count: reads.length ? 0 : 2,
          },
          {
            jid: '10000000448878@lid',
            contact_name: 'Room Baru',
            ai_running: aiRunning,
            activity: aiRunning ? 'Thinking…' : 'Typing…',
            handling_mode: 'ai',
            unread_count: 7,
          },
        ]
        return route.fulfill({ json: { contacts: reverse ? contacts.reverse() : contacts } })
      }
      if (path.endsWith('/messages') && currentId > 702) {
        const params = new URL(route.request().url()).searchParams
        const all = Array.from({ length: currentId - 702 }, (_, index) => ({
          id: 703 + index,
          message_id: `incoming-${703 + index}`,
          jid,
          direction: 'in',
          sender_type: 'customer',
          body: `Pesan ${703 + index}`,
          status: 'received',
        }))
        const pending = all.filter((item) => item.id > Number(params.get('after') || 0))
        return route.fulfill({
          json: {
            messages: params.has('latest') ? all.slice(-50) : pending.slice(0, 50),
            hasMore: params.has('latest') ? all.length > 50 : pending.length > 50,
          },
        })
      }
      if (path.endsWith('/messages'))
        return route.fulfill({
          json: {
            hasMore: false,
            messages: [
              {
                id: currentId,
                message_id: `incoming-${currentId}`,
                jid,
                direction: 'in',
                sender_type: 'customer',
                body: 'Halo',
                status: 'received',
              },
            ],
          },
        })
      return route.fulfill({ json: {} })
    })
    await page.addInitScript({
      content:
        'window.inboxVisible = false; Object.defineProperty(document, "hidden", { get: () => !window.inboxVisible }); document.hasFocus = () => window.inboxVisible;',
    })
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.locator('.wa-unread-count').getByText('7', { exact: true }).waitFor()
    const backgroundRoom = page.locator('.wa-contact[data-jid="10000000448878@lid"]')
    await backgroundRoom.locator('.wa-contact-content small').getByText('Thinking…').waitFor()
    assert.isTrue(await backgroundRoom.evaluate((el) => el.classList.contains('ai-running')))
    assert.isFalse(await backgroundRoom.evaluate((el) => el.classList.contains('active')))
    assert.include(
      await backgroundRoom.evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow
      ),
      'rgb(24, 134, 91)'
    )
    aiRunning = false
    await backgroundRoom.locator('.wa-contact-content small').getByText('Typing…').waitFor()
    assert.equal(
      await backgroundRoom.evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow
      ),
      'none'
    )
    assert.include(
      await page
        .locator('.wa-contact.active')
        .evaluate((el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow),
      'rgb(24, 134, 91)'
    )
    await page.locator('#roomGoalStatus').getByText('Menunggu jawaban', { exact: true }).waitFor()
    assert.equal(await page.locator('#roomGoalStatus').getAttribute('title'), 'Alamat pelanggan')
    goalStatus = 'waiting_approval'
    await page
      .locator('#roomGoalStatus')
      .getByText('Menunggu persetujuan', { exact: true })
      .waitFor()
    assert.lengthOf(reads, 0)
    reverse = true
    await page.waitForFunction(
      'document.querySelector("#contacts a")?.dataset.jid === "10000000448878@lid"'
    )
    await page.evaluate(
      'window.inboxVisible = true; document.dispatchEvent(new Event("visibilitychange"));'
    )
    await page.waitForFunction(
      '!document.querySelector("#contacts a[data-jid=\\"10000000448877@lid\\"] .wa-unread-count")'
    )
    assert.isAtLeast(reads.length, 1)
    assert.equal(reads.at(-1).throughId, currentId)
    assert.equal(reads.at(-1).jid, jid)
    await page.evaluate('window.inboxVisible = false;')
    const previousReads = reads.length
    currentId = 702
    await page.locator('.message[data-id="702"]').waitFor()
    assert.lengthOf(reads, previousReads)
    currentId = 862
    await page.locator('.message[data-id="862"]').waitFor()
    await page.locator('.message[data-id="703"]').waitFor()
    await page.locator('.message[data-id="780"]').waitFor()
    await page.waitForFunction('document.querySelectorAll("#messages .message").length === 162')
    assert.lengthOf(reads, previousReads)
    await page.screenshot({ path: '/private/tmp/whatsapp-inbox-counts.png' })
    const inbox = await client.get('/').withSession(session)
    await page.route('**/whatsapp/', (route) =>
      route.fulfill({ contentType: 'text/html', body: inbox.text() })
    )
    aiRunning = true
    await page.goto('http://localhost/alogaritm--app/whatsapp/')
    await page.locator('.wa-contact.ai-running').waitFor()
    assert.equal(await page.locator('.wa-contact.active').count(), 0)
    assert.equal(await page.locator('#messages').getAttribute('data-jid'), '')
    assert.include(
      await backgroundRoom.evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow
      ),
      'rgb(24, 134, 91)'
    )
    await page.screenshot({ path: '/private/tmp/whatsapp-inbox-ai-running.png' })
    aiRunning = false
    await page.locator('.wa-contact.ai-running').waitFor({ state: 'detached' })
    assert.equal(
      await backgroundRoom.evaluate(
        (el) => el.ownerDocument.defaultView!.getComputedStyle(el).boxShadow
      ),
      'none'
    )
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
})
