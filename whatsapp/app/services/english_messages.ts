// Tampilan selalu Inggris (v3.6.5): pesan error/status API yang masih ditulis dalam bahasa Indonesia
// diterjemahkan di batas respons memakai katalog public/lang/en.js (kunci Indonesia → Inggris).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

let catalog: Record<string, string> | null = null
function load() {
  if (catalog) return catalog
  catalog = {}
  try {
    const require = createRequire(import.meta.url)
    const path = require.resolve('../../public/lang/en.js')
    const sandbox = { window: {} as { waLocales?: Record<string, Record<string, string>> } }
    vm.runInNewContext(readFileSync(path, 'utf8'), sandbox)
    catalog = sandbox.window.waLocales?.en || {}
  } catch {
    catalog = {}
  }
  return catalog
}

/** Teks Indonesia → Inggris bila ada di katalog; selain itu apa adanya. Akhiran titik dihormati. */
export function toEnglish(text: string): string {
  if (!text) return text
  const en = load()
  if (en[text]) return en[text]
  const trimmed = text.trim()
  if (en[trimmed]) return en[trimmed]
  const noDot = trimmed.replace(/[.!]$/, '')
  if (en[noDot]) return `${en[noDot]}${trimmed.endsWith('.') ? '.' : ''}`
  if (en[`${trimmed}.`]) return en[`${trimmed}.`].replace(/\.$/, '')
  return text
}

/** Terjemahkan field `error` / `message` (string) pada badan JSON; objek lain dibiarkan. */
export function englishBody<T>(body: T): T {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body
  const record = body as Record<string, unknown>
  let changed = false
  const out: Record<string, unknown> = { ...record }
  for (const key of ['error', 'message', 'status', 'reason', 'detail']) {
    if (typeof record[key] === 'string') {
      const value = toEnglish(record[key] as string)
      if (value !== record[key]) {
        out[key] = value
        changed = true
      }
    }
  }
  return changed ? (out as T) : body
}
