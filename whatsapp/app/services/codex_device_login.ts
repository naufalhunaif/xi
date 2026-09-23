import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { deviceLoginDetails, deviceLoginFailure } from '#services/oauth_verification'

/** Capture the CLI streams without holding the HTTP request open for the whole login. */
export function watchDeviceLogin(
  child: ChildProcessWithoutNullStreams,
  { responseMs = 1500, codeMs = 60_000 } = {}
) {
  let pending = true
  let stdout = ''
  let stderr = ''
  // A pipe chunk may end halfway through the code. Only parse terminated lines,
  // otherwise a valid-looking prefix could be exposed and cancel the deadline.
  const complete = (value: string) =>
    value.slice(0, Math.max(value.lastIndexOf('\n'), value.lastIndexOf('\r')) + 1)
  const output = () => `${complete(stdout)}\n${complete(stderr)}`
  let failure = ''
  let resolveReady: () => void = () => {}
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const release = () => {
    clearTimeout(responseTimer)
    resolveReady()
  }
  const finish = (message = '', terminate = false) => {
    if (!pending) return
    pending = false
    failure = message
    clearTimeout(codeTimer)
    release()
    // Do not retain device codes after completion, cancellation or expiration.
    stdout = ''
    stderr = ''
    if (terminate) child.kill('SIGTERM')
  }
  const responseTimer = setTimeout(resolveReady, responseMs)
  const codeTimer = setTimeout(() => {
    const parsed = deviceLoginDetails(output())
    finish(
      parsed.verificationUrl
        ? 'Format kode perangkat dari Codex belum dapat dibaca. Periksa versi Codex pada layanan WEB.'
        : deviceLoginFailure(`${stdout}\n${stderr}`, true),
      true
    )
  }, codeMs)
  const receive = () => {
    const parsed = deviceLoginDetails(output())
    if (parsed.verificationUrl && parsed.userCode) {
      clearTimeout(codeTimer)
      release()
    }
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    if (!pending) return
    stdout = `${stdout}${chunk}`.slice(-20_000)
    receive()
  })
  child.stderr.on('data', (chunk) => {
    if (!pending) return
    stderr = `${stderr}${chunk}`.slice(-20_000)
    receive()
  })
  child.on('error', (error) => finish(deviceLoginFailure(error.message)))
  child.on('close', (code, signal) => {
    if (!pending) return
    finish(
      code === 0
        ? ''
        : signal
          ? 'Proses login ChatGPT berhenti. Mulai ulang login dan periksa layanan WEB.'
          : deviceLoginFailure(`${stdout}\n${stderr}`)
    )
  })
  return {
    ready,
    cancel: () => finish('', true),
    snapshot: () => ({
      pending,
      ...deviceLoginDetails(pending ? output() : ''),
      error: failure,
    }),
  }
}
