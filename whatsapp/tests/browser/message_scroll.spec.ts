import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test('long rooms open at newest and keep position through background history, media and fresh replies', async ({
  client,
  browserContext,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  const jid = '10000000990114@lid'
  try {
    await db.table('whatsapp_messages').insert({
      message_id: 'scroll-fixture',
      jid,
      contact_name: 'Scroll Fixture',
      direction: 'in',
      body: 'Initial',
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
    await page.setViewportSize({ width: 1440, height: 900 })
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const rows = Array.from({ length: 240 }, (_, rank) => ({
      id: rank >= 190 ? rank - 189 : rank + 51,
      message_id: `scroll-${rank}`,
      jid,
      body: `Message ${rank}\nSecond line`,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      created_at: new Date(Date.UTC(2030, 0, 1) + rank * 1000).toISOString(),
    }))
    let historyRequests = 0
    let release: (() => void) | undefined
    await page.route('**/whatsapp/?jid=*', (route) =>
      route.fulfill({ contentType: 'text/html', body: response.text() })
    )
    await page.route('**/api/**', async (route) => {
      const url = new URL(route.request().url())
      if (url.pathname.endsWith('/messages')) {
        const before = url.searchParams.get('before')
        if (before) {
          const end = rows.findIndex((row) => String(row.id) === before)
          const pending = rows.slice(Math.max(0, end - 50), end)
          historyRequests++
          if (historyRequests <= 2) {
            const gate = new Promise<void>((resolve) => {
              release = resolve
            })
            await page.evaluate((count) => {
              ;(globalThis as any).historyPageRequested = count
            }, historyRequests)
            await gate
          }
          return route.fulfill({ json: { messages: pending, hasMore: end > 50 } })
        }
        const latest = url.searchParams.has('latest')
        const pending = latest
          ? rows.slice(-50)
          : rows
              .filter((row) => row.id > Number(url.searchParams.get('after') || 0))
              .sort((a, b) => a.id - b.id)
        return route.fulfill({
          json: {
            messages: pending.slice(0, 50),
            hasMore: latest || pending.length > 50,
            syncCursor: Math.max(...rows.map((row) => row.id)),
          },
        })
      }
      if (url.pathname.endsWith('/contacts'))
        return route.fulfill({
          json: { contacts: [{ jid, contact_name: 'Scroll Fixture', handling_mode: 'ai' }] },
        })
      return route.fulfill({ json: {} })
    })
    const atBottom = () =>
      page.waitForFunction(
        '(() => { const el = document.querySelector("#messages"); return el.scrollHeight - el.clientHeight - el.scrollTop < 2 })()'
      )
    await page.goto(`http://localhost/alogaritm--app/whatsapp/?jid=${jid}`)
    await page.waitForFunction('(window.historyPageRequested || 0) === 1')
    await atBottom()
    assert.equal(await page.locator('#messages .message').last().getAttribute('data-id'), '50')
    release!()
    await page.waitForFunction('(window.historyPageRequested || 0) === 2')
    await atBottom()
    assert.equal(await page.locator('#messages .message').count(), 100)
    // Reading older content must stay anchored while the next history page prepends.
    await page.locator('#messages').evaluate((element) => {
      element.scrollTop -= 450
    })
    await page.waitForFunction(
      'document.querySelector("#messages").scrollHeight - document.querySelector("#messages").clientHeight - document.querySelector("#messages").scrollTop > 400'
    )
    // Wait for the scroll event rather than racing its asynchronous delivery.
    await page.evaluate(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
    )
    const anchor = await page.locator('#messages').evaluate((element) => {
      const top = element.getBoundingClientRect().top
      const item = [...element.querySelectorAll('.message')].find(
        (el) => el.getBoundingClientRect().bottom > top
      )!
      return { id: item.getAttribute('data-id'), offset: item.getBoundingClientRect().top - top }
    })
    release!()
    await page.waitForFunction('document.querySelectorAll("#messages .message").length === 240')
    const offset = await page
      .locator(`.message[data-id="${anchor.id}"]`)
      .evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.ownerDocument.querySelector('#messages')!.getBoundingClientRect().top
      )
    assert.closeTo(offset, anchor.offset, 2)
    // A genuinely new AI bubble follows to the bottom, even from older messages.
    rows.push({
      ...rows[239],
      id: 241,
      message_id: 'new-ai',
      body: 'Latest AI answer',
      direction: 'out',
      sender_type: 'ai',
      created_at: new Date(Date.UTC(2030, 0, 2)).toISOString(),
    })
    await page.locator('.message[data-id="241"]').waitFor()
    await atBottom()
    // Simulate late media expansion and a smaller viewport after the initial paint.
    await page.locator('.message[data-id="240"]').evaluate((element) => {
      const media = element.ownerDocument.createElement('div')
      media.style.height = '550px'
      element.append(media)
    })
    await atBottom()
    await page.setViewportSize({ width: 390, height: 780 })
    await page.waitForFunction(
      'document.querySelector("#sidebar").getBoundingClientRect().right <= 1'
    )
    await atBottom()
    const form = await page.locator('#messages').evaluate((element) => {
      const composer = element.ownerDocument.querySelector('.wa-composer')!.getBoundingClientRect()
      return {
        bottom: composer.bottom,
        height: element.ownerDocument.defaultView!.innerHeight,
        roomBottom: element.getBoundingClientRect().bottom,
        composerTop: composer.top,
      }
    })
    assert.isAtMost(form.bottom, form.height + 1)
    assert.isAtMost(form.roomBottom, form.composerTop + 1)
    await page.screenshot({ path: '/private/tmp/whatsapp-latest-room-mobile.png' })
    assert.deepEqual(errors, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
}).timeout(30_000)
