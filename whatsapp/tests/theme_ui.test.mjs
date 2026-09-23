// Real Edge pages and styles, isolated browser requests. No DB, AI or WhatsApp calls.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

const root = new URL('../', import.meta.url)
const edge = new Edge({ cache: false })
edge.mount(new URL('resources/views', root).pathname)
const contact = { jid: 'fixture@lid', contact_name: 'Customer', handling_mode: 'ai', last_message: 'Can I see the details?', unread_count: 1 }
const state = {
  appUrl: 'https://theme.test/whatsapp', bundle: 'https://theme.test',
  csrfToken: 'fixture', workspaceVersion: 'fixture', workspaceId: '1',
  account: { name: 'Demo', username: 'demo@example.test' },
  connection: { status: 'connected', status_label: 'Terhubung', phone: '' },
  contacts: [contact], selectedContact: contact, selectedJid: contact.jid,
  messages: [
    { id: 1, message_id: 'one', direction: 'in', sender_type: 'customer', contact_name: 'Customer', body: 'Can I see the details?', reactions: [] },
    { id: 2, message_id: 'two', direction: 'out', sender_type: 'ai', body: 'Of course. Which colour would you prefer?', reactions: [] },
    { id: 3, message_id: 'three', direction: 'out', sender_type: 'cs', body: 'The custom model is approved.', reactions: [] },
  ],
  oauth: { connected: true }, claudeOauth: { connected: true },
  settings: { aiWorkMode: 'always', aiWorkDays: '1,2,3,4,5,6,7', aiWorkTimezone: 'Asia/Jakarta', aiWorkStart: '08:00', aiWorkEnd: '17:00', aiEnabled: false, aiProvider: 'chatgpt', codexBin: 'codex', claudeBin: 'claude', chatgptModel: 'gpt-6-astra', claudeModel: 'opus', chatgptReasoning: 'high', claudeReasoning: 'medium', skills: [], mcpConnections: [], paymentMethods: [] },
}
const scripts = new Set(['theme.js', 'motion.js', 'settings.js', 'i18n.js', 'sidebar_boot.js', 'model_settings.js', 'order_item_details.js'])

async function install(context, { blocked = false, cartData = null } = {}) {
  const errors = []
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  if (blocked) await context.addInitScript(() => {
    Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new Error('Blocked storage') }
  })
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    const path = url.pathname
    if (path.startsWith('/whatsapp/assets/') || path.startsWith('/whatsapp/lang/')) {
      const file = path.split('/').pop()
      if (file.endsWith('.js') && !scripts.has(file) && !(cartData && file === 'cart.js') && !path.includes('/lang/')) return route.fulfill({ contentType: 'text/javascript', body: '' })
      return route.fulfill({ contentType: file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/javascript', body: await readFile(new URL(`public${path.replace('/whatsapp', '')}`, root), 'utf8') })
    }
    if (path.startsWith('/store/assets/')) return route.fulfill({ contentType: path.endsWith('.css') ? 'text/css' : 'image/svg+xml', body: await readFile(new URL(`..${path}`, root), 'utf8') })
    if (path.includes('/api/')) {
      assert.equal(route.request().method(), 'GET', 'Theme tests must not mutate data')
      return route.fulfill({ json: path === '/whatsapp/api/cart' && cartData ? cartData : {} })
    }
    const page = path.endsWith('/settings') ? 'settings' : path.endsWith('/orders') ? 'orders' : 'chat'
    return route.fulfill({ contentType: 'text/html', body: await edge.render('pages/dashboard', { ...state, page, workspaceId: url.searchParams.get('workspace') || '1' }) })
  })
  return errors
}
const mode = page => page.locator('html').getAttribute('data-theme')
const checkMode = (page, value) => page.waitForFunction(expected => document.documentElement.dataset.theme === expected, value)
const css = (page, selector, property) => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], property)
const contrast = (a, b) => {
  const luminance = color => color.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => { n /= 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }).reduce((sum, n, i) => sum + n * [.2126, .7152, .0722][i], 0)
  const x = luminance(a), y = luminance(b)
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05)
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
  test(`${name}: populated cart delivery and native skill upload stay readable in both themes`, async () => {
    const items = [
      { id: 'jacket', name: 'Custom navy jacket', quantity: 1, unitPrice: 485000, size: 'S', measurements: {}, image: '', productionDetails: { color: 'Navy', lapel: 'Notch', buttons: '2', heightCm: 170, notes: 'Follow the approved reference.', pending: ['Waist measurement'] } },
      { id: 'pants', name: 'Navy pants', quantity: 1, unitPrice: 220000, size: '30', measurements: {}, image: '', productionDetails: { color: 'Navy', notes: 'Match the jacket.' } },
    ]
    const cart = { version: 'fixture', items: [], recipient: {}, shipping: { cost: null }, total: 0, discount: 0 }
    const cartData = { cart, customerBalance: { balance: 224000, entries: [] }, orders: [{ id: 1, number: 'INV-TEST-0001', status: 'active', paid: 714000, balance: 0, total: 714000, operations: { stage: 'production' }, cart: { ...cart, items, subtotal: 705000, recipient: { name: 'Example customer', phone: '628000000000', address: 'Example street, Sample district, Sample city 12345' }, shipping: { service: 'YES', cost: 9000 }, note: 'Customer confirmed the product, size and shipping option. Production follows the approved reference.' } }] }
    const browser = await engine.launch({ headless: true })
    try {
      for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' })
        const errors = await install(context, { cartData })
        const page = await context.newPage()
        for (const theme of ['dark', 'light']) {
          await page.goto('https://theme.test/whatsapp/settings#general')
          await page.locator('#uiTheme').selectOption(theme)
          await page.locator('#uiLanguage').selectOption(width === 390 ? 'id' : 'en')
          await page.locator('[data-settings-menu=skills]').click()
          await page.locator('#skillFile').waitFor({ state: 'visible' })
          const uploadBg = await css(page, '#skillFile', 'backgroundColor')
          assert.ok(contrast(await css(page, '#skillFile', 'color'), uploadBg) >= 4.5)
          if (theme === 'dark') {
            assert.equal(uploadBg, 'rgb(23, 23, 25)')
            const button = await page.locator('#skillFile').evaluate(el => {
              const style = getComputedStyle(el, '::file-selector-button')
              return { background: style.backgroundColor, color: style.color }
            })
            assert.equal(button.background, 'rgb(34, 34, 37)')
            assert.ok(contrast(button.color, button.background) >= 4.5)
          }
          await page.locator('#skillFile').setInputFiles({ name: 'example-skill.md', mimeType: 'text/markdown', buffer: Buffer.from('# Test only') })
          assert.equal(await page.locator('#skillFile').evaluate(el => el.files[0].name), 'example-skill.md')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
          await page.screenshot({ path: `/private/tmp/wa-theme-${name}-upload-${theme}-${width}.png`, fullPage: true })
          await page.goto('https://theme.test/whatsapp/')
          await page.locator('#cartOpen').click()
          await page.locator('[data-order-detail="1"]').click()
          await page.locator('.wa-order-delivery').scrollIntoViewIfNeeded()
          const background = await css(page, '.wa-order-delivery', 'backgroundColor')
          assert.equal(background, theme === 'dark' ? 'rgb(13, 25, 43)' : 'rgb(240, 244, 250)')
          for (const selector of ['h3', 'small', 'p']) {
            assert.ok(contrast(await css(page, `.wa-order-delivery ${selector}`, 'color'), background) >= 4.5, `${theme} delivery ${selector} contrast`)
          }
          for (const kind of ['specification', 'measurement', 'notes', 'pending']) {
            const selector = `#orderDetailContent .wa-item-production-field--${kind}`
            assert.ok(contrast(await css(page, `${selector} dd`, 'color'), await css(page, selector, 'backgroundColor')) >= 4.5)
          }
          if (width === 1440 && theme === 'dark') {
            await page.locator('.wa-order-copy').hover()
            assert.equal(await css(page, '.wa-order-copy', 'backgroundColor'), 'rgb(48, 48, 52)')
          }
          assert.equal(await page.locator('#orderDetailPanel').isVisible(), true)
          assert.equal(await page.locator('#cartMainPanel').isVisible(), width > 760)
          assert.equal(await page.locator('#cartDialog').evaluate(el => el.scrollWidth > el.clientWidth), false)
          await page.screenshot({ path: `/private/tmp/wa-theme-${name}-delivery-${theme}-${width}.png`, fullPage: true })
          await page.locator('#orderDetailClose').click()
          assert.equal(await page.locator('#cartMainPanel').isVisible(), true)
          await page.locator('#cartClose').click()
        }
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally { await browser.close() }
  })
  test(`${name}: Auto/Light/Dark persists, follows OS, themes real chat/settings/orders and wallpaper`, async () => {
    const browser = await engine.launch({ headless: true })
    try {
      const context = await browser.newContext({ colorScheme: 'dark', viewport: { width: 1440, height: 1000 } })
      const errors = await install(context)
      const page = await context.newPage()
      await page.goto('https://theme.test/whatsapp/settings#general')
      assert.equal(await mode(page), 'dark')
      assert.equal(await page.locator('#uiTheme').inputValue(), 'auto')
      assert.equal(await page.locator('#uiTheme').getAttribute('name'), null)
      assert.deepEqual(await page.locator('#uiTheme option').allTextContents(), ['Auto — system', 'Light', 'Dark'])
      await page.emulateMedia({ colorScheme: 'light' }); await checkMode(page, 'light')
      await page.locator('#uiTheme').selectOption('dark'); await checkMode(page, 'dark')
      await page.emulateMedia({ colorScheme: 'dark' })
      await page.emulateMedia({ colorScheme: 'light' }); assert.equal(await mode(page), 'dark')
      await page.reload(); assert.equal(await page.locator('#uiTheme').inputValue(), 'dark')
      assert.ok(contrast(await css(page, '#uiTheme', 'color'), await css(page, '#uiTheme', 'backgroundColor')) >= 4.5)
      await page.locator('[data-settings-menu=ai]').click()
      await page.locator('#chatgptModelPicker').waitFor({ state: 'visible' })
      await page.waitForFunction(() => document.querySelector('[data-settings-menu=ai]').getAttribute('aria-current') === 'page')
      await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})))
      })
      await page.screenshot({ path: `/private/tmp/wa-theme-${name}-settings.png`, fullPage: true })
      assert.equal(await css(page, '#chatgptModelPicker', 'colorScheme'), 'dark')
      assert.ok(contrast(await css(page, '#chatgptModelPicker', 'color'), await css(page, '#chatgptModelPicker', 'backgroundColor')) >= 4.5)
      assert.equal(await css(page, '#chatgptModelPicker', 'backgroundColor'), 'rgb(23, 23, 25)')
      assert.ok(contrast(await css(page, '#chatgptModelPicker', 'webkitTextFillColor'), await css(page, '#chatgptModelPicker', 'backgroundColor')) >= 4.5)
      const tab = await context.newPage()
      await tab.goto('https://theme.test/whatsapp/settings#general')
      await tab.locator('#uiTheme').selectOption('light'); await checkMode(page, 'light')
      await tab.locator('#uiTheme').selectOption('auto'); await page.emulateMedia({ colorScheme: 'dark' }); await checkMode(page, 'dark')
      await tab.close()
      await page.goto('https://theme.test/whatsapp/settings?workspace=2#general')
      assert.equal(await page.locator('#uiTheme').inputValue(), 'auto')
      await page.goto('https://theme.test/whatsapp/settings#general')
      await page.locator('#uiTheme').selectOption('dark')
      await page.locator('#uiLanguage').selectOption('id')
      assert.deepEqual(await page.locator('#uiTheme option').allTextContents(), ['Auto — mengikuti sistem', 'Terang', 'Gelap'])
      for (const theme of ['dark', 'light']) {
        await page.goto('https://theme.test/whatsapp/settings#general')
        await page.locator('#uiTheme').selectOption(theme)
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 })
          await page.goto('https://theme.test/whatsapp/')
          assert.equal(await mode(page), theme)
          if (theme === 'dark') {
            for (const surface of ['body', '#messages']) {
              assert.equal(await css(page, surface, 'backgroundColor'), 'rgb(0, 0, 0)', `${surface} AMOLED black`)
            }
            assert.equal(await css(page, '.sidebar', 'backgroundColor'), 'rgb(17, 17, 19)')
            for (const surface of ['.wa-composer', '.wa-panel'])
              assert.equal(await css(page, surface, 'backgroundColor'), 'rgb(23, 23, 25)', `${surface} lifted charcoal`)
          }
          assert.match(await css(page, '#messages', 'backgroundImage'), /chat-pattern\.svg/)
          for (const bubble of ['.message.in', '.message.out.source-ai', '.message.out.source-cs']) {
            assert.ok(contrast(await css(page, bubble, 'color'), await css(page, bubble, 'backgroundColor')) >= 4.5, `${theme} ${bubble} contrast`)
          }
          assert.equal(await css(page, '.message', 'backgroundImage'), 'none')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
          await page.screenshot({ path: `/private/tmp/wa-theme-${name}-chat-${theme}-${width}.png`, fullPage: true })
          if (width === 1440) {
            const button = page.locator('#cartOpen')
            const originalBox = await button.boundingBox()
            await button.hover({ position: { x: originalBox.width - 5, y: originalBox.height / 2 } })
            await page.waitForFunction(() => parseFloat(document.getElementById('cartOpen').style.getPropertyValue('--wa-magnet-x')) > 0)
            await button.evaluate(el => el.getAnimations().forEach(a => a.finish()))
            const attraction = await css(page, '#cartOpen', 'translate')
            const [x, y] = attraction.split(' ').map(parseFloat)
            assert.ok(x > 0 && x <= 2 && Math.abs(y) <= 3, `bounded magnet: ${attraction}`)
            assert.equal(await button.evaluate(el => el.offsetWidth), Math.round(originalBox.width))
            await page.mouse.down()
            await button.evaluate(el => el.getAnimations().forEach(a => a.finish()))
            assert.equal(await css(page, '#cartOpen', 'scale'), '0.97')
            assert.equal(await button.evaluate(el => el.style.getPropertyValue('--wa-magnet-x')), '')
            await page.mouse.up()
            await page.mouse.move(1, 1)
            assert.equal(await button.evaluate(el => el.style.getPropertyValue('--wa-magnet-y')), '')
            // Disabled changes and keyboard/touch input must never leave a displaced control.
            await button.hover({ position: { x: originalBox.width - 5, y: originalBox.height / 2 } })
            await page.waitForFunction(() => document.getElementById('cartOpen').style.getPropertyValue('--wa-magnet-x') !== '')
            await button.evaluate(el => { el.disabled = true })
            await page.waitForFunction(() => document.getElementById('cartOpen').style.getPropertyValue('--wa-magnet-x') === '')
            await button.evaluate(el => { el.disabled = false })
            await button.dispatchEvent('pointermove', { pointerType: 'touch', clientX: originalBox.x + 8, clientY: originalBox.y + 8 })
            assert.equal(await button.evaluate(el => el.style.getPropertyValue('--wa-magnet-x')), '')
            await button.focus()
            assert.equal(await button.evaluate(el => el.style.getPropertyValue('--wa-magnet-x')), '')
            await page.mouse.move(1, 1)
            await page.evaluate(() => window.waMotion.showDialog(document.getElementById('cartDialog')))
            assert.ok(await page.locator('#cartDialog').evaluate(el => el.open && el.getAnimations().length > 0))
            // Reduced motion interrupts an active sheet cleanly and closes immediately.
            await page.emulateMedia({ reducedMotion: 'reduce' })
            await page.waitForFunction(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
            await page.evaluate(() => window.waMotion.closeDialog(document.getElementById('cartDialog')))
            await page.waitForFunction(() => !document.getElementById('cartDialog').open, null, { timeout: 1000 })
            assert.equal(await page.locator('#cartDialog').evaluate(el => el.open), false)
            await button.hover()
            assert.equal(await css(page, '#cartOpen', 'translate'), 'none')
            assert.equal(await css(page, '#cartOpen', 'transitionDuration'), '0s')
            await page.emulateMedia({ reducedMotion: 'no-preference' })
            await page.waitForFunction(() => !matchMedia('(prefers-reduced-motion: reduce)').matches)
            await page.mouse.move(1, 1)
          }
          await page.locator('#cartDialog').evaluate(el => el.showModal())
          await page.evaluate(() => window.waOrderItemDetails(document.getElementById('cartItems'), {
            productionDetails: { color: 'Navy', heightCm: 170, lapel: 'Notch', notes: 'Two buttons', pending: ['Waist measurement'] },
          }))
          for (const kind of ['specification', 'measurement', 'notes', 'pending']) {
            const field = `.wa-item-production-field--${kind}`
            assert.ok(contrast(await css(page, `${field} dd`, 'color'), await css(page, field, 'backgroundColor')) >= 4.5, `${theme} ${kind} contrast`)
          }
          for (const panel of ['.wa-cart-dialog', '.wa-cart-current', '.wa-cart-balance', '.wa-cart-orders']) {
            assert.ok(contrast(await css(page, panel, 'color'), await css(page, panel, 'backgroundColor')) >= 4.5, `${theme} ${panel} contrast`)
          }
          await page.screenshot({ path: `/private/tmp/wa-theme-${name}-cart-${theme}-${width}.png`, fullPage: true })
          await page.goto('https://theme.test/whatsapp/orders')
          assert.equal(await mode(page), theme)
          await page.locator('#orderDrawer').evaluate(el => el.showModal())
          assert.ok(contrast(await css(page, '#orderDrawer', 'color'), await css(page, '#orderDrawer', 'backgroundColor')) >= 4.5)
          await page.locator('#orderDrawer').evaluate(el => el.close())
        }
      }
      assert.deepEqual(errors, [])
      await context.close()
      const blocked = await browser.newContext({ colorScheme: 'dark' })
      const blockedErrors = await install(blocked, { blocked: true })
      const fallback = await blocked.newPage()
      await fallback.goto('https://theme.test/whatsapp/settings#general')
      assert.equal(await mode(fallback), 'dark')
      await fallback.locator('#uiTheme').selectOption('light')
      assert.equal(await mode(fallback), 'light')
      assert.deepEqual(blockedErrors, [])
      await blocked.close()
    } finally { await browser.close() }
  })
}
