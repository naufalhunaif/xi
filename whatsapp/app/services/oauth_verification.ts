import type { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'

/** Safe categories only: CLI errors may contain URLs, codes or credentials. */
export function deviceLoginFailure(output: string, timedOut = false) {
  const text = stripVTControlCharacters(output)
  if (/ENOENT|command not found|no such file/i.test(text))
    return 'Node atau Codex tidak ditemukan oleh layanan WEB. Periksa lokasi perintah Codex.'
  if (/EACCES|EPERM|permission denied/i.test(text))
    return 'Layanan WEB tidak memiliki izin menjalankan Codex atau menyimpan login.'
  if (/unknown (?:option|argument)|unexpected argument.*device-auth/i.test(text))
    return 'Versi Codex belum mendukung login perangkat. Perbarui build aplikasi.'
  if (/certificate|TLS|SSL/i.test(text))
    return 'Koneksi aman server ke OpenAI gagal. Periksa sertifikat dan koneksi server.'
  if (/device.*(?:disabled|not enabled)/i.test(text))
    return 'Aktifkan device code login di pengaturan keamanan ChatGPT.'
  if (/\b403\b|forbidden|access denied/i.test(text))
    return 'Permintaan login ditolak OpenAI. Periksa izin device code dan akses server.'
  if (
    /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timed out|dns error|connection error|error sending request/i.test(
      text
    )
  )
    return 'Server belum dapat terhubung ke OpenAI. Periksa koneksi server.'
  if (timedOut)
    return 'Kode login ChatGPT belum diterima dari OpenAI. Periksa koneksi server lalu mulai ulang login.'
  return 'Login ChatGPT belum berhasil. Mulai ulang login.'
}

export function deviceLoginDetails(output: string) {
  const text = stripVTControlCharacters(output)
  const verificationUrl =
    text.match(/https:\/\/auth\.openai\.com\/codex\/device(?=$|[\s)])/m)?.[0] || ''
  const labelled = new Set<string>()
  const legacy = new Set<string>()
  let sawHeading = false
  let awaitingCode = false
  // Do not assume a fixed length/case for provider-issued codes. Only accept the
  // bounded token directly under an explicit CLI code heading (or after its colon).
  const heading =
    /^(?:\d+[.)]\s*)?(?:(?:enter|use|copy)\s+(?:(?:this|the|your)\s+)?)?(?:(?:your|this)\s+)?(?:(?:one[- ]time|device|verification|user)\s+)?code\b/i
  const candidate = (value: string) => {
    const token = value.replace(/\s*\(expires\b[^)]*\)\s*$/i, '').trim()
    if (token.length < 6 || token.length > 32) return ''
    if (!/^(?:[A-Za-z0-9]{6,24}|[A-Za-z0-9]{2,12}(?:-[A-Za-z0-9]{2,12}){1,2})$/.test(token))
      return ''
    if (
      /^(?:waiting|connected|pending|loading|failed|failure|success|expired|timeout|disabled|unavailable|requesting|undefined)$/i.test(
        token
      )
    )
      return ''
    return token
  }
  for (const raw of text.split(/[\r\n]/)) {
    const line = raw.trim()
    if (!line) continue
    if (/https?:\/\//i.test(line)) {
      awaitingCode = false
      continue
    }
    const match = line.match(heading)
    if (match) {
      sawHeading = true
      const tail = line.slice(match[0].length).trim()
      if (tail.startsWith(':')) {
        const code = candidate(tail.slice(1))
        if (code) labelled.add(code)
        awaitingCode = !tail.slice(1).trim()
      } else {
        awaitingCode = !tail || /^\(expires\b[^)]*\)$/i.test(tail)
      }
      continue
    }
    if (awaitingCode) {
      const code = candidate(line)
      if (code) labelled.add(code)
      awaitingCode = false
    }
    // Compatibility with older bare uppercase output. Arbitrary mixed-case log
    // words are never eligible for this fallback; new formats require a heading.
    const old = line.match(/^([A-Z0-9]{4}-[A-Z0-9]{4,5}|[A-Z0-9]{9})(?:\s*\(expires\b[^)]*\))?$/i)
    if (old && /^[A-Z0-9-]+$/.test(old[1])) legacy.add(old[1])
  }
  const codes = sawHeading ? labelled : legacy
  return { verificationUrl, userCode: codes.size === 1 ? [...codes][0] : '' }
}

export type VerificationSession = {
  loginId: string
  codeSubmitted: boolean
  expiresAt: number
  loginOutput: string
  loginError: string
  loginProcess?: { stdin: Writable; killed: boolean; exitCode: number | null }
}

export async function writeClaudeVerification(
  session: VerificationSession,
  loginId: unknown,
  value: unknown
) {
  const child = session.loginProcess
  if (
    !child ||
    child.killed ||
    child.exitCode !== null ||
    session.expiresAt <= Date.now() ||
    typeof loginId !== 'string' ||
    !loginId ||
    loginId !== session.loginId
  ) {
    throw new Error('Sesi login berakhir. Mulai ulang login.')
  }
  if (session.codeSubmitted) throw new Error('Kode sedang diverifikasi.')
  const code = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9_-]{8,2048}#[A-Za-z0-9_-]{8,512}$/.test(code)) {
    throw new Error('Tempel kode autentikasi lengkap, termasuk bagian setelah #.')
  }
  // Bind a pasted code to the exact CLI flow, not merely the same phone/account.
  const output = stripVTControlCharacters(`${session.loginOutput}\n${session.loginError}`)
  const urls = output.match(/https?:\/\/[^\s]+/g) || []
  const expected = urls
    .map((url) => {
      try {
        return new URL(url).searchParams.get('state')
      } catch {
        return null
      }
    })
    .find(Boolean)
  if (!expected || code.split('#')[1] !== expected) {
    throw new Error('Kode bukan dari sesi login ini. Buka tautan login terbaru.')
  }
  if (!child.stdin.writable || child.stdin.destroyed)
    throw new Error('Sesi login berakhir. Mulai ulang login.')
  session.codeSubmitted = true
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${code}\n`, (error) => (error ? reject(error) : resolve()))
    })
  } catch {
    session.codeSubmitted = false
    throw new Error('Kode belum terkirim. Mulai ulang login.')
  }
}
