// Real loopback HTTP responses (WebKit cannot fulfill mocked 302 responses).
// No accounts, database, live OAuth or customer traffic.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { chromium, webkit } from 'playwright'

test('network recovery, strict CSP, and auth redirects in a real browser', async () => {
  const script = await readFile(new URL('../public/assets/workspace.js', import.meta.url), 'utf8')
  const css = await readFile(new URL('../public/assets/network.css', import.meta.url), 'utf8')
  const engine = process.env.PLAYWRIGHT_BROWSER === 'webkit' ? webkit : chromium
  let mode = 'healthy'
  let base
  let authorizationUrl
  let authorizationCalls = 0
  const authorizationServer = createServer((req, res) => {
    authorizationCalls += 1
    res.end('Authorization fixture must never be fetched')
  })
  const calls = []
  const server = createServer((req, res) => {
    const path = new URL(req.url, base).pathname
    if (path.endsWith('/workspace.js')) { res.setHeader('Content-Type', 'text/javascript'); return res.end(script) }
    if (path.endsWith('/network.css')) { res.setHeader('Content-Type', 'text/css'); return res.end(css) }
    if (path.includes('/api/')) {
      calls.push({ path, method: req.method })
      if (mode === 'drop') return req.socket.destroy()
      if (mode === 'redirect') { res.writeHead(302, { Location: authorizationUrl }); return res.end() }
      if (mode === 'unauthenticated') {
        res.writeHead(401, { 'Content-Type': 'application/json', 'X-WhatsApp-Auth': 'required' })
        return res.end('{"code":"AUTH_REQUIRED"}')
      }
      if (mode === 'unavailable') {
        res.writeHead(503, { 'Content-Type': 'application/json', 'X-Request-ID': 'test-request' })
        return res.end('{"error":"Fixture unavailable"}')
      }
      res.setHeader('X-WhatsApp-Workspace', '1:v1')
      if (path.endsWith('/workspace')) { res.writeHead(204); return res.end() }
      res.setHeader('Content-Type', 'application/json')
      return res.end('{"ok":true}')
    }
    res.setHeader('Content-Type', 'text/html')
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${mode === 'csp' ? "'none'" : "'self'"}`)
    if (path.endsWith('/login')) return res.end('<h1>Sign in fixture</h1>')
    res.end(`<!doctype html><html><head><meta name="app-url" content="${base}/whatsapp">
      <meta name="whatsapp-workspace" content="1:v1"><link rel="stylesheet" href="/network.css">
      <script src="/workspace.js"></script></head><body><h1>Workspace fixture</h1>
      <aside id="networkNotice" class="wa-network-notice" role="status" hidden><span id="networkNoticeText"></span>
      <button id="networkRetry">Retry</button><button id="networkCopy">Copy diagnostics</button>
      <textarea id="networkDetails" hidden readonly></textarea></aside></body></html>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => authorizationServer.listen(0, '127.0.0.1', resolve))
  authorizationUrl = `http://127.0.0.1:${authorizationServer.address().port}/authorize`
  base = `http://127.0.0.1:${server.address().port}`
  let browser
  try {
    browser = await engine.launch({ headless: true })
    const page = await browser.newPage()
    await page.goto(`${base}/whatsapp/`)
    assert.equal(await page.evaluate(async () => (await fetch('/whatsapp/api/messages')).status), 200)
    mode = 'drop'
    await page.evaluate(() => fetch('/whatsapp/api/messages?jid=private&code=secret').catch(() => {}))
    await page.locator('#networkNotice').waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => window.waNetwork.snapshot().failure.kind), 'network_error')
    const count = calls.length
    assert.equal(await page.evaluate(async () => (await fetch('/whatsapp/api/send', { method: 'POST' })).status), 503)
    await page.evaluate(() => Promise.all(Array.from({ length: 10 }, () => fetch('/whatsapp/api/messages'))))
    assert.equal(calls.length, count, 'regular polling and mutations remain blocked during recovery')
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.waNetwork.snapshot())), /private|secret/)
    mode = 'unavailable'
    await page.evaluate(() => window.waNetwork.retry())
    await page.evaluate(() => window.waNetwork.retry())
    assert.equal(await page.evaluate(() => window.waNetwork.snapshot().paused), true)
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: `/private/tmp/network-${engine.name()}.png` })
    mode = 'healthy'
    await page.locator('#networkRetry').click()
    await page.locator('#networkNotice').waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(async () => (await fetch('/whatsapp/api/messages')).status), 200)
    assert.equal(calls.some(call => call.method === 'POST'), false, 'failed mutations were never replayed')
    await page.close()
    for (const authMode of ['unauthenticated', 'redirect']) {
      mode = authMode
      const authPage = await browser.newPage()
      await authPage.goto(`${base}/whatsapp/`).catch(error => {
        if (!/interrupted|cancelled|canceled/i.test(String(error))) throw error
      })
      await authPage.waitForURL(`${base}/whatsapp/login`)
      // Chromium can report an unfollowed redirect target as a request event.
      // Verify actual HTTP traffic at the destination instead.
      assert.equal(authorizationCalls, 0, 'fetch must not follow OAuth redirects')
      await authPage.close()
    }
    mode = 'csp'
    const cspPage = await browser.newPage()
    await cspPage.goto(`${base}/whatsapp/`)
    await cspPage.waitForFunction(() => window.waNetwork.snapshot().paused)
    assert.equal(await cspPage.evaluate(() => window.waNetwork.snapshot().failure.kind), 'csp_blocked')
    await cspPage.close()
  } finally {
    await browser?.close()
    server.closeAllConnections()
    authorizationServer.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await new Promise(resolve => authorizationServer.close(resolve))
  }
})
