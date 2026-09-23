import { test } from '@japa/runner'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { watchDeviceLogin } from '#services/codex_device_login'

function fixture() {
  const events = new EventEmitter()
  const process = Object.assign(events, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kills: 0,
    kill() {
      this.kills++
      events.emit('close', null, 'SIGTERM')
      return true
    },
  })
  return { process, child: process as unknown as ChildProcessWithoutNullStreams }
}
const link = 'https://auth.openai.com/codex/device'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('device code arriving after HTTP response remains readable from split CLI streams', async ({
  assert,
}) => {
  const { process, child } = fixture()
  const login = watchDeviceLogin(child, { responseMs: 2, codeMs: 1000 })
  try {
    await login.ready
    assert.isTrue(login.snapshot().pending)
    assert.equal(login.snapshot().userCode, '')
    assert.equal(process.kills, 0)
    process.stdout.write(`Welcome to Codex\n1. Open this link\n\u001b[94m${link}\u001b[0m\n`)
    process.stderr.write('2. Enter this one-time code (expires in 15 minutes)\n\u001b[94mABCD-')
    assert.equal(login.snapshot().userCode, '')
    process.stderr.write('1234\u001b[0m\n')
    assert.equal(login.snapshot().verificationUrl, link)
    assert.equal(login.snapshot().userCode, 'ABCD-1234')
  } finally {
    login.cancel()
  }
})

test('valid code clears acquisition deadline and waits for login completion', async ({
  assert,
}) => {
  const { process, child } = fixture()
  const login = watchDeviceLogin(child, { responseMs: 1000, codeMs: 15 })
  try {
    process.stdout.write(`${link}\nABCD-1234\n`)
    await login.ready
    await sleep(30)
    assert.isTrue(login.snapshot().pending)
    assert.equal(process.kills, 0)
    process.emit('close', 0, null)
    assert.deepEqual(login.snapshot(), {
      pending: false,
      userCode: '',
      verificationUrl: '',
      error: '',
    })
  } finally {
    login.cancel()
  }
})

test('missing code stops within deadline, without retry or leaking output', async ({ assert }) => {
  for (const output of ['', `${link}\nunsupported-fixture-code\n`]) {
    const { process, child } = fixture()
    const login = watchDeviceLogin(child, { responseMs: 1, codeMs: 10 })
    process.stdout.write(output)
    await login.ready
    await sleep(25)
    assert.isFalse(login.snapshot().pending)
    assert.equal(process.kills, 1)
    assert.include(login.snapshot().error, output ? 'Format kode' : 'belum diterima')
    assert.notInclude(JSON.stringify(login.snapshot()), 'unsupported-fixture-code')
  }
})

test('cancellation ignores old output and cannot stop a replacement session', async ({
  assert,
}) => {
  const first = fixture()
  const second = fixture()
  const oldLogin = watchDeviceLogin(first.child, { responseMs: 2, codeMs: 10 })
  const newLogin = watchDeviceLogin(second.child, { responseMs: 2, codeMs: 1000 })
  try {
    oldLogin.cancel()
    first.process.stdout.write(`${link}\nABCD-1234\n`)
    second.process.stdout.write(`${link}\nWXYZ-9876\n`)
    await sleep(25)
    assert.equal(oldLogin.snapshot().userCode, '')
    assert.equal(newLogin.snapshot().userCode, 'WXYZ-9876')
    assert.equal(second.process.kills, 0)
  } finally {
    newLogin.cancel()
  }
})

test('spawn, permission and killed-process errors are safe and clear pending state', async ({
  assert,
}) => {
  for (const mode of ['ENOENT', 'EACCES', 'SIGKILL']) {
    const { process, child } = fixture()
    const login = watchDeviceLogin(child)
    if (mode === 'SIGKILL') process.emit('close', null, mode)
    else process.emit('error', new Error(`${mode} private-token-fixture`))
    await login.ready
    assert.isFalse(login.snapshot().pending)
    assert.isNotEmpty(login.snapshot().error)
    assert.notInclude(login.snapshot().error, 'private-token-fixture')
  }
})

test('mixed code split at a valid-looking prefix is not published before its line is complete', async ({
  assert,
}) => {
  const { process, child } = fixture()
  const login = watchDeviceLogin(child, { responseMs: 1, codeMs: 1000 })
  try {
    process.stdout.write(`${link}\n2. Enter this one-time code (expires in 15 minutes)\n`)
    process.stdout.write('ABCD-1234')
    await login.ready
    assert.equal(login.snapshot().userCode, '')
    process.stdout.write('z\u001b[0m\n')
    assert.equal(login.snapshot().userCode, 'ABCD-1234z')
    assert.equal(process.kills, 0)
  } finally {
    login.cancel()
  }
})

test('a mixed-case code emitted on stderr completes readiness and survives the old deadline', async ({
  assert,
}) => {
  const { process, child } = fixture()
  const login = watchDeviceLogin(child, { responseMs: 1000, codeMs: 15 })
  try {
    process.stdout.write(`${link}\n`)
    process.stderr.write('Your code:\n\u001b[94maB12cD34\u001b[0m\n')
    await login.ready
    await sleep(30)
    assert.equal(login.snapshot().userCode, 'aB12cD34')
    assert.isTrue(login.snapshot().pending)
    assert.equal(login.snapshot().error, '')
    assert.equal(process.kills, 0)
  } finally {
    login.cancel()
  }
})
