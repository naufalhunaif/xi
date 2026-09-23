import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let cached: string | null = null

/** Versi aplikasi dari file VERSION di akar proyek (dipasang oleh installer/release). */
export function appVersion() {
  if (cached !== null) return cached
  try {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    cached = readFileSync(join(root, 'VERSION'), 'utf8').trim() || '0.0.0'
  } catch {
    cached = '0.0.0'
  }
  return cached
}
