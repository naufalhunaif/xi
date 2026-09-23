import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { readFile } from 'node:fs/promises'

test('old tab carries workspace header, reloads on switch and drops the selected room', async ({
  browserContext,
  assert,
}) => {
  const script = await readFile(app.publicPath('assets/workspace.js'), 'utf8')
  const page = await browserContext.newPage()
  const base = 'http://workspace.test/whatsapp'
  let version = 'a'
  let headers: string[] = []
  await page.route('http://workspace.test/**', async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/workspace.js'))
      return route.fulfill({ contentType: 'text/javascript', body: script })
    if (url.pathname.includes('/api/')) {
      headers.push(route.request().headers()['x-whatsapp-workspace'])
      return route.fulfill({ json: { ok: true }, headers: { 'X-WhatsApp-Workspace': version } })
    }
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta name="app-url" content="${base}"><meta name="whatsapp-workspace" content="${version}"><script src="${base}/workspace.js"></script><body><div id="room">${version}</div></body>`,
    })
  })
  await page.goto(`${base}/?jid=old-customer`)
  await page.evaluate(async () => {
    await fetch('/whatsapp/api/settings', { method: 'POST', body: 'value' })
  })
  assert.isTrue(headers.every((value) => value === 'a'))
  version = 'b'
  await page.evaluate(() => {
    void fetch('/whatsapp/api/workspace').catch(() => {})
  })
  await page.waitForURL(`${base}/`)
  assert.equal(await page.locator('#room').textContent(), 'b')
  await page.evaluate(async () => {
    await fetch('/whatsapp/api/settings', { method: 'POST' })
  })
  assert.equal(headers.at(-1), 'b')
  await page.close()
})

test('workspace header is never sent to unrelated apps or external origins', async ({
  browserContext,
  assert,
}) => {
  const script = await readFile(app.publicPath('assets/workspace.js'), 'utf8')
  const page = await browserContext.newPage()
  const observed: Record<string, string | undefined> = {}
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/whatsapp/')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta name="app-url" content="http://workspace.test/whatsapp"><meta name="whatsapp-workspace" content="a"><script>${script}</script>`,
      })
    observed[url.pathname] = route.request().headers()['x-whatsapp-workspace']
    return route.fulfill({ json: { ok: true }, headers: { 'Access-Control-Allow-Origin': '*' } })
  })
  await page.goto('http://workspace.test/whatsapp/')
  await page.evaluate(async () => {
    await fetch('/store/api/status')
    await fetch('http://external.test/api/status')
  })
  assert.isUndefined(observed['/store/api/status'])
  assert.isUndefined(observed['/api/status'])
  await page.close()
})
