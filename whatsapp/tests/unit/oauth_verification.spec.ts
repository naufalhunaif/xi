import { test } from '@japa/runner'
import { PassThrough, Writable } from 'node:stream'
import {
  deviceLoginDetails,
  deviceLoginFailure,
  writeClaudeVerification,
  type VerificationSession,
} from '#services/oauth_verification'

function fixture(): VerificationSession {
  return {
    loginId: 'test-login',
    codeSubmitted: false,
    expiresAt: Date.now() + 60_000,
    loginOutput: 'Open https://claude.ai/oauth/authorize?state=fixture_state',
    loginError: '',
    loginProcess: { stdin: new PassThrough(), killed: false, exitCode: null },
  }
}
const code = 'synthetic_test_code#fixture_state'

test('Claude verification writes a single line to the matching pending process', async ({
  assert,
}) => {
  const session = fixture()
  await writeClaudeVerification(session, 'test-login', code)
  assert.equal((session.loginProcess!.stdin as PassThrough).read().toString(), `${code}\n`)
  assert.isTrue(session.codeSubmitted)
  assert.notInclude(JSON.stringify(session), code)
  await assert.rejects(
    () => writeClaudeVerification(session, 'test-login', code),
    /sedang diverifikasi/
  )
})

test('Claude rejects stale sessions, other workspaces and mismatched OAuth state', async ({
  assert,
}) => {
  const session = fixture()
  await assert.rejects(
    () => writeClaudeVerification(session, 'another-login', code),
    /Sesi login berakhir/
  )
  await assert.rejects(
    () => writeClaudeVerification(session, 'test-login', 'synthetic_test_code#other_state'),
    /bukan dari sesi/
  )
  session.expiresAt = Date.now() - 1
  await assert.rejects(
    () => writeClaudeVerification(session, 'test-login', code),
    /Sesi login berakhir/
  )
  assert.isFalse(session.codeSubmitted)
  assert.isNull((session.loginProcess!.stdin as PassThrough).read())
})

test('Claude rejects malformed and multiline input without echoing secrets', async ({ assert }) => {
  for (const value of ['', null, {}, 'only_code', `${code}\nsecond_line`, 'a'.repeat(3000)]) {
    const session = fixture()
    await assert.rejects(
      () => writeClaudeVerification(session, 'test-login', value),
      /Tempel kode autentikasi lengkap/
    )
    assert.isFalse(session.codeSubmitted)
  }
})

test('Claude rejects missing or closed processes and missing state', async ({ assert }) => {
  for (const mode of ['missing', 'killed', 'closed', 'no-state']) {
    const session = fixture()
    if (mode === 'missing') session.loginProcess = undefined
    if (mode === 'killed') session.loginProcess!.killed = true
    if (mode === 'closed') session.loginProcess!.stdin.destroy()
    if (mode === 'no-state') session.loginOutput = 'Waiting for login'
    await assert.rejects(() => writeClaudeVerification(session, 'test-login', code))
    assert.isFalse(session.codeSubmitted)
  }
})

test('Claude stdin failure returns a safe retry error', async ({ assert }) => {
  const session = fixture()
  const stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback(new Error('EPIPE'))
    },
  })
  stdin.on('error', () => {})
  session.loginProcess!.stdin = stdin
  await assert.rejects(
    () => writeClaudeVerification(session, 'test-login', code),
    /Kode belum terkirim/
  )
  assert.isFalse(session.codeSubmitted)
})

test('ChatGPT device codes are extracted without ANSI formatting or URL fragments', ({
  assert,
}) => {
  assert.deepEqual(
    deviceLoginDetails('Open https://auth.openai.com/codex/device\n\u001b[32mABCD-1234\u001b[0m\n'),
    {
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    }
  )
  assert.equal(deviceLoginDetails('Your code:\n  ABC123XYZ\n').userCode, 'ABC123XYZ')
  assert.equal(deviceLoginDetails('https://example.com/ABCD-1234\nWaiting for login').userCode, '')
  assert.equal(deviceLoginDetails('Open https://example.com/device').verificationUrl, '')
  assert.equal(deviceLoginDetails('  ABCD-1234 (expires in 15 minutes)\r\n').userCode, 'ABCD-1234')
  assert.equal(
    deviceLoginDetails('Your code: ABCD-1234 (expires in 15 minutes)').userCode,
    'ABCD-1234'
  )
  assert.equal(deviceLoginDetails('Code: ABC123XYZ').userCode, 'ABC123XYZ')
  assert.equal(deviceLoginDetails('connected\nhttps://example.com/?code=ABCD-1234').userCode, '')
  assert.equal(deviceLoginDetails('https://auth.openai.com/codex/device-other').verificationUrl, '')
  assert.equal(deviceLoginDetails('AB12-CD345\n').userCode, 'AB12-CD345')
})

test('ChatGPT startup errors give actionable categories without leaking CLI output', ({
  assert,
}) => {
  for (const [input, expected] of [
    ['spawn codex ENOENT secret-fixture', 'tidak ditemukan'],
    ['EACCES secret-fixture', 'izin'],
    ['unexpected argument --device-auth secret-fixture', 'Versi Codex'],
    ['TLS certificate secret-fixture', 'sertifikat'],
    ['device code disabled secret-fixture', 'Aktifkan'],
    ['HTTP 403 secret-fixture', 'ditolak'],
    ['ETIMEDOUT secret-fixture', 'koneksi server'],
  ]) {
    const message = deviceLoginFailure(input)
    assert.include(message, expected)
    assert.notInclude(message, 'secret-fixture')
  }
  assert.include(deviceLoginFailure('', true), 'belum diterima')
})

test('ChatGPT code heading accepts mixed-case provider codes without changing their case or length', ({
  assert,
}) => {
  const url = 'https://auth.openai.com/codex/device'
  for (const deviceCode of [
    'aB12cD34',
    'aB12cD345',
    'abcd-12Ef',
    'Ab12-cD345',
    'AB12-CD34-EF56',
    '12345678',
  ]) {
    for (const content of [
      `2. Enter this one-time code (expires in 15 minutes)\n   \u001b[94m${deviceCode}\u001b[0m\n`,
      `Enter this one-time code (expires in 15 minutes)\n\u00a0\u00a0 ${deviceCode}\n`,
      `Your device code: ${deviceCode}\n`,
      `Code:\n${deviceCode}\n`,
    ])
      assert.equal(deviceLoginDetails(`${url}\n${content}`).userCode, deviceCode)
  }
})

test('flexible code parsing still rejects logs, URLs, unrelated tokens and ambiguous codes', ({
  assert,
}) => {
  for (const output of [
    'Connected\nWaiting\naB12cD345\n',
    'Your code:\nWaiting\n',
    'Your code:\nhttps://example.com/Ab12-cD345\n',
    'Error: code expired\naB12cD345\n',
    'Device code: aB12cD345\nDevice code: zY98xW765\n',
    'Your code: secret_token_with_underscores\n',
    `Your code: ${'A'.repeat(100)}\n`,
  ])
    assert.equal(deviceLoginDetails(output).userCode, '')
})
