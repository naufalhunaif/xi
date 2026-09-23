import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const source = await readFile(new URL('../public/assets/chatgpt_login.js', import.meta.url), 'utf8')
function setup() {
  const window = { open() { throw new Error('must not open a waiting tab') } }
  vm.runInNewContext(source, { window, URL, AbortController, setTimeout, clearTimeout })
  return window.waChatgptLogin
}
test('login waits inline for the response without opening a tab', async () => {
  const login = setup()
  const response = { pending: true, userCode: 'ABCD-1234' }
  assert.equal(await login.request(async (signal) => {
    assert.equal(signal.aborted, false)
    return response
  }), response)
})
test('a stalled request times out and aborts without replaying the POST', async () => {
  const login = setup()
  let calls = 0
  let signal
  await assert.rejects(() => login.request((value) => {
    calls++
    signal = value
    return new Promise(() => {})
  }, 5), /Permintaan login belum selesai/)
  assert.equal(signal.aborted, true)
  assert.equal(calls, 1)
})
test('request failures propagate to the inline error display', async () => {
  await assert.rejects(() => setup().request(async () => { throw new Error('fixture error') }), /fixture error/)
})
test('only the exact OpenAI device page can be shown as the Login link', () => {
  const login = setup()
  assert.equal(login.verificationUrl('https://auth.openai.com/codex/device'), 'https://auth.openai.com/codex/device')
  for (const url of ['https://auth.openai.com.evil.test/codex/device', 'http://auth.openai.com/codex/device',
    'https://user:password@auth.openai.com/codex/device', 'javascript:alert(1)', 'https://auth.openai.com/other',
    'https://auth.openai.com/codex/device?redirect=evil', 'https://auth.openai.com/codex/device#secret']) {
    assert.equal(login.verificationUrl(url), '')
  }
})
