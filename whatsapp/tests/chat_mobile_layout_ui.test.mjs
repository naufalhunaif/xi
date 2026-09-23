// Real Edge page and styles, isolated browser requests. No DB, AI or WhatsApp calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

const root = new URL('../', import.meta.url)
const edge = new Edge({ cache: false })
edge.mount(new URL('resources/views', root).pathname)
const contacts = [
  { jid: 'first@lid', contact_name: 'Customer one', handling_mode: 'ai', last_message: 'Ada size S?', unread_count: 1, unanswered_count: 1 },
  { jid: 'second@lid', contact_name: 'Customer two', handling_mode: 'cs', last_message: 'Sudah transfer', unread_count: 0, unanswered_count: 0 },
]
const base = {
  appUrl: 'https://chat.test/whatsapp', bundle: 'https://chat.test',
  csrfToken: 'fixture', workspaceVersion: 'fixture', workspaceId: '1',
  account: { name: 'Demo', username: 'demo@example.test' },
  connection: { status: 'connected', status_label: 'Terhubung', phone: '' },
  contacts,
  messages: [
    { id: 1, message_id: 'one', direction: 'in', sender_type: 'customer', contact_name: 'Customer one', body: 'Ada size S?', reactions: [] },
    { id: 2, message_id: 'two', direction: 'out', sender_type: 'ai', body: 'Ada bos, warna navy.', reactions: [] },
  ],
  oauth: { connected: true }, claudeOauth: { connected: true },
  settings: { aiEnabled: false, aiProvider: 'chatgpt', aiFailover: false, codexBin: 'codex', claudeBin: 'claude', chatgptModel: 'gpt-6-astra', claudeModel: 'opus', chatgptReasoning: 'high', claudeReasoning: 'medium', skills: [], mcpConnections: [], paymentMethods: [] },
}
const scripts = new Set(['theme.js', 'i18n.js', 'sidebar_boot.js', 'app.js'])

async function install(context) {
  const errors = []
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)))
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.startsWith('/whatsapp/assets/') || path.startsWith('/whatsapp/lang/')) {
      const file = path.split('/').pop()
      if (file.endsWith('.js') && !scripts.has(file) && !path.includes('/lang/'))
        return route.fulfill({ contentType: 'text/javascript', body: '' })
      return route.fulfill({
        contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript',
        body: await readFile(new URL(`public${path.replace('/whatsapp', '')}`, root), 'utf8'),
      })
    }
    if (path.startsWith('/store/assets/'))
      return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: await readFile(new URL(`..${path}`, root), 'utf8') })
    if (path.includes('/api/')) {
      if (path.endsWith('/api/contacts')) return route.fulfill({ json: { contacts } })
      if (path.endsWith('/api/messages')) return route.fulfill({ json: { messages: base.messages, hasMore: false } })
      if (path.endsWith('/api/status')) return route.fulfill({ json: base.connection })
      return route.fulfill({ json: {} })
    }
    const selectedJid = url.searchParams.get('jid') || ''
    const selectedContact = contacts.find((row) => row.jid === selectedJid) || null
    return route.fulfill({
      contentType: 'text/html',
      body: await edge.render('pages/dashboard', { ...base, page: 'chat', selectedJid, selectedContact }),
    })
  })
  return errors
}
const visible = (page, selector) => page.locator(selector).first().isVisible()

const engines = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? [['webkit', webkit]] : process.env.PLAYWRIGHT_BROWSER === 'chromium' ? [['chromium', chromium]] : [['chromium', chromium], ['webkit', webkit]]
for (const [name, engine] of engines) {
  test(`${name}: phone shows the chat list first and the room only after opening a chat`, async () => {
    const browser = await engine.launch({ headless: true })
    try {
      for (const lang of ['id', 'en']) {
        const context = await browser.newContext({ viewport: { width: 390, height: 780 } })
        const errors = await install(context)
        const page = await context.newPage()
        await page.goto('https://chat.test/whatsapp/?inbox=cs')
        // The page owns its language key; read it back rather than guessing the workspace suffix.
        await page.evaluate((language) => {
          const app = document.querySelector('meta[name="app-url"]').content.replace(/\/$/, '')
          const workspace = document.querySelector('meta[name="whatsapp-workspace-id"]').content
          localStorage.setItem(
            workspace === '1' ? `${app}:ui-language` : `${app}:${workspace}:ui-language`,
            language
          )
        }, lang)
        await page.reload()
        await page.waitForSelector('.wa-chat-grid')

        // List view: contacts and their queue filters, no room and no composer.
        assert.equal(await page.locator('#main').getAttribute('data-room'), 'list')
        assert.equal(await visible(page, '.wa-contact-panel'), true)
        assert.equal(await visible(page, '#inboxFilters'), true)
        assert.equal(await visible(page, '#chat'), false)
        assert.equal(await visible(page, '#messageForm'), false)
        assert.equal(await visible(page, '#roomBack'), false)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        // The list gets the full pane instead of a 240px strip above the room.
        const listHeight = await page.locator('#contacts').evaluate((el) => el.clientHeight)
        assert.ok(listHeight > 300, `chat list height ${listHeight}`)
        await page.screenshot({ path: `/private/tmp/chat-mobile-list-${name}-${lang}.png`, fullPage: true })

        // Opening a chat swaps to the room, keeping the queue it was opened from.
        await page.locator('.wa-contact[data-jid="second@lid"]').click()
        await page.waitForFunction(() => document.getElementById('main').dataset.room === 'open')
        assert.equal(await visible(page, '#chat'), true)
        assert.equal(await visible(page, '#messageForm'), true)
        assert.equal(await visible(page, '.wa-contact-panel'), false)
        assert.equal(await visible(page, '#inboxFilters'), false)
        assert.equal(await visible(page, '#roomBack'), true)
        assert.equal(await page.locator('#roomName').innerText(), 'Customer two')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        assert.match(
          await page.locator('#roomBack').getAttribute('aria-label'),
          lang === 'en' ? /Back to chat list/ : /Kembali ke daftar chat/
        )
        await page.screenshot({ path: `/private/tmp/chat-mobile-room-${name}-${lang}.png`, fullPage: true })

        // Back returns to the list and preserves the selected queue.
        await page.locator('#roomBack').click()
        await page.waitForFunction(() => document.getElementById('main').dataset.room === 'list')
        assert.equal(new URL(page.url()).searchParams.get('jid'), null)
        assert.equal(new URL(page.url()).searchParams.get('inbox'), 'cs')
        assert.equal(await visible(page, '.wa-contact-panel'), true)
        assert.equal(await visible(page, '#chat'), false)
        assert.deepEqual(errors, [])
        await context.close()
      }

      // Desktop keeps both panes and hides the back control.
      const wide = await browser.newContext({ viewport: { width: 1440, height: 900 } })
      const errors = await install(wide)
      const page = await wide.newPage()
      await page.goto('https://chat.test/whatsapp/?jid=first%40lid')
      await page.waitForSelector('.wa-chat-grid')
      assert.equal(await visible(page, '.wa-contact-panel'), true)
      assert.equal(await visible(page, '#chat'), true)
      assert.equal(await visible(page, '#roomBack'), false)
      assert.equal(await page.locator('.topbar, #menu-toggle').count(), 0)
      // A previously expanded preference cannot widen the permanent icon rail.
      await page.evaluate(() => localStorage.setItem('https://chat.test/whatsapp:sidebar-collapsed', 'false'))
      await page.reload()
      for (const width of [320, 390, 768, 1024, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 })
        const rail = await page.locator('#sidebar').boundingBox()
        const main = await page.locator('#main').boundingBox()
        const room = await page.locator('#chat').boundingBox()
        const composer = await page.locator('#messageForm').boundingBox()
        assert.equal(rail.width, width <= 760 ? 52 : 64)
        assert.equal(main.x, rail.width)
        assert.equal(main.y, 0)
        assert.equal(main.height, 900)
        assert.equal(room.y, 0)
        assert.equal(room.x + room.width, width)
        assert.equal(composer.y + composer.height, 900)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
        if (width === 1440) {
          await page.screenshot({ path: '/private/tmp/whatsapp-fullscreen-desktop.png' })
          await page.locator('#launcherButton').click()
          assert.equal(await visible(page, '#launcherMenu'), true)
          const menu = await page.locator('#launcherMenu').boundingBox()
          assert.ok(menu.x >= rail.width && menu.y >= 0 && menu.y + menu.height <= 900)
          await page.keyboard.press('Escape')
          assert.equal(await visible(page, '#launcherMenu'), false)
        }
      }
      assert.deepEqual(errors, [])
      await wide.close()
    } finally {
      await browser.close()
    }
  })
}
