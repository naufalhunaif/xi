import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../public/assets/workspace.js', import.meta.url), 'utf8')
function setup(fetch, origin = 'https://shop.test') {
  const calls = []
  const navigations = []
  const events = {}
  const documentEvents = {}
  let now = 1_800_000_000_000
  let tick
  const navigator = { onLine: true }
  const window = {
    fetch: async (...args) => { calls.push(args); return fetch(...args) },
    addEventListener(name, fn) { events[name] = fn },
    dispatchEvent(event) { events[event.type]?.(event) },
  }
  const document = {
    querySelector: (selector) => ({ content: selector.includes('workspace') ? '1:v1' : 'https://shop.test/whatsapp' }),
    documentElement: { style: {} },
    getElementById() { return null },
    addEventListener(name, fn) { documentEvents[name] = fn }, hidden: false,
  }
  class Clock extends Date { static now() { return now } }
  vm.runInNewContext(source, { window, document, URL, Headers, Request, Response, Date: Clock,
    navigator, DOMException, AbortController, Event, setTimeout, clearTimeout,
    location: { href: `${origin}/whatsapp/`, origin, replace: (url) => navigations.push(url) },
    setInterval(fn) { tick = fn },
  })
  return { window, document, calls, navigations, navigator, events, documentEvents,
    tick: () => tick(), advance(ms) { now += ms } }
}
const url = 'https://shop.test/whatsapp/api/status'
test('API sends session credentials and does not follow login redirects', async () => {
  const app = setup(async () => Response.json({ status: 'connected' }))
  const result = await app.window.fetch(url, { headers: { 'x-csrf-token': 'test' }, method: 'POST', body: '{}' })
  assert.equal(result.status, 200)
  const options = app.calls[0][1]
  assert.equal(options.redirect, 'manual')
  assert.equal(options.credentials, 'same-origin')
  assert.equal(options.mode, 'same-origin')
  assert.equal(options.headers.get('x-whatsapp-workspace'), '1:v1')
  assert.equal(options.headers.get('x-csrf-token'), 'test')
  assert.equal(options.body, '{}')
})
test('parallel expired requests navigate once and stop all subsequent polling', async () => {
  const app = setup(async () => Response.json({ code: 'AUTH_REQUIRED' }, { status: 401, headers: { 'X-WhatsApp-Auth': 'required' } }))
  await Promise.allSettled([app.window.fetch(url), app.window.fetch(url), app.window.fetch(url)])
  assert.deepEqual(app.navigations, ['https://shop.test/whatsapp/login'])
  assert.equal(app.window.waAuthExpired, true)
  await assert.rejects(() => app.window.fetch(url))
  assert.equal(app.calls.length, 3)
})
test('an in-flight success cannot override the login navigation', async () => {
  let release
  const app = setup(async () => app.calls.length === 1
    ? Response.json({}, { status: 401, headers: { 'X-WhatsApp-Auth': 'required' } })
    : new Promise((resolve) => { release = resolve }))
  const first = app.window.fetch(url).catch(() => {})
  const second = app.window.fetch(url).catch(() => {})
  await first
  release(Response.json({}, { headers: { 'X-WhatsApp-Workspace': '2:v2' } }))
  await second
  assert.deepEqual(app.navigations, ['https://shop.test/whatsapp/login'])
})
test('legacy redirects never fetch the OAuth destination', async () => {
  const app = setup(async () => ({ type: 'opaqueredirect' }))
  await assert.rejects(() => app.window.fetch(url))
  assert.equal(app.calls.length, 1)
  assert.deepEqual(app.navigations, ['https://shop.test/whatsapp/login'])
})
test('upstream account outage backs off without deleting session or navigating', async () => {
  const app = setup(async () => Response.json({}, { status: 503, headers: { 'X-WhatsApp-Auth': 'unavailable' } }))
  await app.window.fetch(url)
  const retry = await app.window.fetch(url)
  assert.equal(retry.status, 503)
  assert.equal(app.calls.length, 1)
  assert.deepEqual(app.navigations, [])
})
test('network failures do not retry mutations or immediately flood the server', async () => {
  const app = setup(async () => { throw new TypeError('network') })
  await assert.rejects(() => app.window.fetch(url, { method: 'POST', body: '{}' }))
  assert.equal((await app.window.fetch(url)).status, 503)
  assert.equal(app.calls.length, 1)
})
test('origin mismatch navigates without leaking API headers or cookies cross-origin', async () => {
  const app = setup(async () => Response.json({}), 'https://www.shop.test')
  await assert.rejects(() => app.window.fetch(url))
  assert.equal(app.calls.length, 0)
  assert.deepEqual(app.navigations, ['https://shop.test/whatsapp/login'])
})
test('unrelated fetches and provider-specific 401s do not start Account login', async () => {
  const app = setup(async () => Response.json({}, { status: 401 }))
  assert.equal((await app.window.fetch(url)).status, 401)
  await app.window.fetch('https://other.test/api')
  assert.equal(app.calls[1][1], undefined)
  assert.deepEqual(app.navigations, [])
})
test('workspace changes remain isolated and bootstrap scripts are CSP compatible', async () => {
  const app = setup(async () => Response.json({}, { headers: { 'X-WhatsApp-Workspace': '2:v2' } }))
  await assert.rejects(() => app.window.fetch(url))
  assert.deepEqual(app.navigations, ['https://shop.test/whatsapp/'])
  const layout = await readFile(new URL('../resources/views/components/layout.edge', import.meta.url), 'utf8')
  assert.doesNotMatch(layout, /<script\s*>/)
  assert.match(layout, /sidebar_boot\.js/)
})

test('a failed connection sends only a single probe and never replays a POST', async () => {
  let healthy = false
  let release
  const app = setup(async (url) => {
    if (!healthy) throw new TypeError('network')
    if (url.endsWith('/workspace')) return new Promise(resolve => { release = resolve })
    return Response.json({ ok: true })
  })
  await assert.rejects(() => app.window.fetch(url, { method: 'POST', body: '{}' }))
  app.advance(60_000)
  await Promise.all([app.window.fetch(url), app.window.fetch(url)])
  assert.equal(app.calls.length, 1)
  healthy = true
  const retry = app.window.waNetwork.retry()
  await app.window.waNetwork.retry()
  assert.equal(app.calls.length, 2)
  release(new Response(null, { status: 204, headers: { 'X-WhatsApp-Workspace': '1:v1' } }))
  await retry
  assert.equal(app.window.waNetwork.snapshot().failures, 0)
  assert.equal((await app.window.fetch(url)).status, 200)
  assert.equal(app.calls.filter(([, options]) => options.method === 'POST').length, 1)
})

test('three failure waves pause automatic retries and diagnostics exclude query secrets', async () => {
  const app = setup(async () => { throw new TypeError('private code=secret') })
  await assert.rejects(() => app.window.fetch(`${url}?jid=private&code=secret`))
  await app.window.waNetwork.retry()
  await app.window.waNetwork.retry()
  assert.equal(app.window.waNetwork.snapshot().paused, true)
  const before = app.calls.length
  app.advance(120_000)
  app.tick()
  await app.window.fetch(url)
  assert.equal(app.calls.length, before)
  assert.doesNotMatch(JSON.stringify(app.window.waNetwork.snapshot()), /private|secret|\?jid/)
})

test('a heartbeat without authenticated workspace identity cannot resume polling', async () => {
  let healthy = false
  const app = setup(async () => {
    if (!healthy) throw new TypeError('network')
    return new Response(null, { status: 204 })
  })
  await assert.rejects(() => app.window.fetch(url))
  healthy = true
  await app.window.waNetwork.retry()
  assert.equal((await app.window.fetch(url)).status, 503)
  assert.equal(app.window.waNetwork.snapshot().failure.kind, 'unexpected_response')
})

test('offline, pagehide and caller cancellation do not create retry storms', async () => {
  const app = setup(async () => Response.json({ ok: true }))
  app.events.pagehide()
  await assert.rejects(() => app.window.fetch(url), { name: 'AbortError' })
  assert.equal(app.calls.length, 0)
  const other = setup(async () => Response.json({ ok: true }))
  other.navigator.onLine = false
  assert.equal((await other.window.fetch(url)).status, 503)
  assert.equal(other.calls.length, 0)
  const canceled = setup(async () => Response.json({ ok: true }))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => canceled.window.fetch(url, { signal: controller.signal }), { name: 'AbortError' })
  assert.equal(canceled.window.waNetwork.snapshot().failures, 0)
})

test('CSP diagnostics identify the directive without recording query strings or policy', () => {
  const app = setup(async () => Response.json({}))
  app.documentEvents.securitypolicyviolation({
    blockedURI: `${url}?code=secret`, effectiveDirective: 'connect-src', originalPolicy: 'private-policy',
  })
  const diagnostic = app.window.waNetwork.snapshot()
  assert.equal(diagnostic.failure.kind, 'csp_blocked')
  assert.equal(diagnostic.paused, true)
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private-policy/)
})
