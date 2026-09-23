import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Edge } from 'edge.js'
import { chromium, webkit } from 'playwright'

for (const [engineName, engine] of [
  ['chromium', chromium],
  ['webkit', webkit],
]) {
  test(`${engineName}: working hours autosave, translations, validation and responsive dark/light`, async () => {
    const edge = new Edge({ cache: false })
    edge.mount(new URL('../resources/views', import.meta.url).pathname)
    const browser = await engine.launch({ headless: true })
    try {
      for (const [theme, width, language] of [
        ['light', 1280, 'en'],
        ['dark', 390, 'id'],
      ]) {
        const settings = {
          aiEnabled: true,
          aiWorkMode: 'always',
          aiWorkTimezone: 'Asia/Jakarta',
          aiWorkDays: '1,2,3,4,5,6,7',
          aiWorkStart: '09:00',
          aiWorkEnd: '17:00',
        }
        const html = await edge.render('partials/settings/work_hours', { settings })
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        })
        const page = await context.newPage(),
          errors = [],
          requests = []
        page.on('pageerror', (e) => errors.push(e.message))
        await context.route('**/*', async (route) => {
          const path = new URL(route.request().url()).pathname
          if (path === '/settings')
            return route.fulfill({
              contentType: 'text/html',
              body: `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="app-url" content="https://schedule.test"><meta name="csrf-token" content="fixture">${['/store.css', '/assets/app.css', '/assets/forms.css', '/assets/theme.css', '/assets/work_hours.css'].map((p) => `<link rel="stylesheet" href="${p}">`).join('')}</head><body class="workspace-ui"><main style="padding:16px;max-width:650px"><div class="wa-panel wa-settings-panel"><form id="settingsForm"><button name="aiEnabled" class="wa-switch" type="button" role="switch" aria-checked="true" value="true" aria-label="AI"></button><section id="settings-work-hours"><h2 data-i18n="Jam kerja AI">Jam kerja AI</h2>${html}</section><span id="settingsSaveState"></span></form></div></main><script src="/lang/${language}.js"></script><script src="/fixture-i18n.js"></script><script src="/assets/app.js"></script><script src="/assets/work_hours.js"></script></body></html>`,
            })
          if (path === '/store.css')
            return route.fulfill({
              contentType: 'text/css',
              body: await readFile(
                new URL('../../store/assets/css/app.css', import.meta.url),
                'utf8'
              ),
            })
          if (path === '/fixture-i18n.js')
            return route.fulfill({
              contentType: 'text/javascript',
              body: `window.waI18n={t:(s)=>window.waLocales.${language}[s]||s}; document.querySelectorAll('[data-i18n]').forEach(e=>e.textContent=waI18n.t(e.dataset.i18n));`,
            })
          if (path.startsWith('/assets/') || path.startsWith('/lang/'))
            return route.fulfill({
              contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript',
              body: await readFile(new URL(`../public${path}`, import.meta.url), 'utf8'),
            })
          if (path === '/api/settings') {
            const input = route.request().postDataJSON()
            requests.push(input)
            if (input.aiWorkTimezone === 'Invalid')
              return route.fulfill({ status: 422, json: { error: 'Zona waktu tidak valid.' } })
            Object.assign(settings, input)
            return route.fulfill({ json: settings })
          }
          return route.fulfill({ json: {} })
        })
        await page.goto('https://schedule.test/settings')
        await page.locator('#settings-work-hours').evaluate(el => { el.dataset.settingsPanel = 'work-hours' })
        assert.equal(
          await page.locator('h2').textContent(),
          language === 'en' ? 'AI working hours' : 'Jam kerja AI'
        )
        assert.equal(await page.locator('#aiWorkFields').isVisible(), false)
        const save = async (key, value, action) => {
          const response = page.waitForResponse(
            (r) => r.url().endsWith('/api/settings') && r.request().postDataJSON()?.[key] === value
          )
          await action()
          await response
        }
        await save('aiWorkMode', 'scheduled', () =>
          page.locator('[name=aiWorkMode]').selectOption('scheduled')
        )
        assert.ok(await page.locator('#aiWorkFields').isVisible())
        await save('aiWorkDays', '1,2,3,4,5,6', () => page.locator('[data-work-day="7"]').click())
        assert.equal(
          await page.locator('[data-work-day="7"]').getAttribute('aria-pressed'),
          'false'
        )
        await save('aiWorkStart', '22:00', () => page.locator('[name=aiWorkStart]').fill('22:00'))
        assert.ok(await page.locator('#aiWorkOvernight').isVisible())
        await save('aiWorkEnd', '06:00', () => page.locator('[name=aiWorkEnd]').fill('06:00'))
        const sizes = await page
          .locator('[name=aiWorkTimezone], [name=aiWorkStart], [name=aiWorkEnd], [name=aiWorkMode]')
          .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)))
        assert.ok(
          sizes.every((h) => h === sizes[0]),
          sizes.join(',')
        )
        const colors = await page
          .locator('[data-work-day="1"]')
          .evaluate((el) => ({
            bg: getComputedStyle(el).backgroundColor,
            fg: getComputedStyle(el).color,
          }))
        assert.notEqual(colors.bg, colors.fg)
        await page.locator('[data-work-day="2"]').focus()
        await save('aiWorkDays', '1,3,4,5,6', () => page.keyboard.press('Space'))
        await save('aiWorkTimezone', 'Invalid', () =>
          page.locator('[name=aiWorkTimezone]').fill('Invalid')
        )
        await page.locator('[name=aiWorkTimezone][aria-invalid=true]').waitFor()
        assert.equal(settings.aiWorkTimezone, 'Asia/Jakarta')
        await save('aiWorkTimezone', 'Asia/Makassar', () =>
          page.locator('[name=aiWorkTimezone]').fill('Asia/Makassar')
        )
        await save('aiEnabled', false, () => page.locator('[name=aiEnabled]').click())
        await page.waitForFunction(
          () =>
            document.getElementById('aiWorkStatus').textContent ===
            window.waI18n.t('Balas otomatis nonaktif')
        )
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false
        )
        assert.ok(requests.every((p) => Object.keys(p).length === 1))
        assert.deepEqual(errors, [])
        await page.screenshot({
          path: `/private/tmp/wa-working-hours-${engineName}-${theme}.png`,
          fullPage: true,
        })
        await context.close()
      }
    } finally {
      await browser.close()
    }
  })
}
