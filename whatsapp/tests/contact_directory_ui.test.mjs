import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium, webkit } from 'playwright'

for (const [engineName, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  test(`${engineName}: contact table, photos, address search and private CSV download`, async () => {
    const browser = await engine.launch({ headless: true })
    try {
      for (const [width, language, theme] of [
        [1440, 'en', 'light'],
        [390, 'id', 'dark'],
      ]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } })
        await context.addInitScript(
          (lang) => localStorage.setItem('https://contacts.test:ui-language', lang),
          language
        )
        const page = await context.newPage(),
          errors = [],
          requests = []
        page.on('pageerror', (error) => errors.push(error.message))
        const contacts = [
          {
            jid: '10000000@lid',
            name: 'Example customer',
            phone: '628000000001',
            photo: '/avatar.svg',
            addresses: [
              {
                name: 'Recipient one',
                phone: '08123456789',
                address: 'New street 10\nSample city',
                source: 'cart',
              },
              {
                name: 'Recipient two',
                phone: '08987654321',
                address: 'Old street 12',
                source: 'order',
              },
            ],
          },
          {
            jid: '20000000@lid',
            name: '<img onerror=alert(1)>',
            phone: '',
            photo: '/missing.jpg',
            addresses: [],
          },
        ]
        await context.route('**/*', async (route) => {
          assert.equal(route.request().method(), 'GET')
          const url = new URL(route.request().url())
          requests.push(url.pathname + url.search)
          if (url.pathname === '/')
            return route.fulfill({
              contentType: 'text/html; charset=utf-8',
              body: `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="app-url" content="https://contacts.test"><link rel="stylesheet" href="/store.css"><link rel="stylesheet" href="/assets/contact_directory.css"><link rel="stylesheet" href="/assets/forms.css"><link rel="stylesheet" href="/assets/theme.css"><style>body{margin:0;padding:20px;font:14px Arial;background:${theme === 'dark' ? '#000' : '#fafafa'};color:${theme === 'dark' ? '#eee' : '#222'}}*{box-sizing:border-box}</style></head><body class="workspace-ui">${await readFile(new URL('../resources/views/partials/contact_directory.edge', import.meta.url), 'utf8')}<script src="/lang/en.js"></script><script src="/lang/id.js"></script><script src="/assets/i18n.js"></script><script src="/assets/contact_directory.js"></script></body></html>`,
            })
          if (url.pathname === '/store.css')
            return route.fulfill({
              contentType: 'text/css; charset=utf-8',
              body: await readFile(
                new URL('../../store/assets/css/app.css', import.meta.url),
                'utf8'
              ),
            })
          if (/^\/(assets|lang)\//.test(url.pathname))
            return route.fulfill({
              contentType: url.pathname.endsWith('.css')
                ? 'text/css; charset=utf-8'
                : 'text/javascript; charset=utf-8',
              body: await readFile(new URL('../public' + url.pathname, import.meta.url), 'utf8'),
            })
          if (url.pathname === '/avatar.svg')
            return route.fulfill({
              contentType: 'image/svg+xml',
              body: '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" fill="#29946a"/></svg>',
            })
          if (url.pathname === '/missing.jpg') return route.fulfill({ status: 404 })
          if (url.pathname === '/api/contact-directory') {
            const selected = url.searchParams.get('query') ? [contacts[0]] : contacts
            return route.fulfill({
              json: { contacts: selected, total: selected.length, page: 1, limit: 30 },
            })
          }
          if (url.pathname === '/api/contact-directory/export') {
            assert.equal(url.searchParams.get('query'), 'Old street')
            assert.equal(url.searchParams.get('language'), language)
            return route.fulfill({
              contentType: 'text/csv; charset=utf-8',
              body: '\uFEFF"Contact","Address"\r\n"Example customer","Old street 12"\r\n',
            })
          }
          throw new Error('Unexpected request ' + url.pathname)
        })
        await page.goto('https://contacts.test/')
        await page.locator('#directoryRows tr').nth(1).waitFor()
        assert.equal(await page.locator('#directoryRows tr').count(), 2)
        assert.equal(await page.locator('.wa-directory-address').count(), 2)
        await page.waitForFunction(
          () => document.querySelectorAll('#directoryRows img').length === 1
        )
        assert.match(await page.locator('#directoryRows').textContent(), /<img onerror=alert\(1\)>/)
        assert.equal(
          await page.locator('#directoryRows tr').nth(1).locator('td').nth(1).textContent(),
          '—'
        )
        assert.equal(
          await page.locator('.wa-directory-contact').first().getAttribute('href'),
          'https://contacts.test/?jid=10000000%40lid'
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true
        )
        await page.screenshot({
          path: `/private/tmp/contact-directory-${engineName}-${width}.png`,
          fullPage: true,
        })
        await page.locator('#directorySearch').fill('Old street')
        await page.waitForFunction(
          () => document.querySelectorAll('#directoryRows tr').length === 1
        )
        const downloadPromise = page.waitForEvent('download')
        await page.locator('#directoryExport').click()
        const download = await downloadPromise
        assert.equal(download.suggestedFilename(), 'contacts-addresses.csv')
        assert.match(await readFile(await download.path(), 'utf8'), /Old street 12/)
        assert.ok(requests.some((url) => url.startsWith('/api/contact-directory/export?')))
        assert.deepEqual(errors, [])
        await context.close()
      }
    } finally {
      await browser.close()
    }
  })
}
