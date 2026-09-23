import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { readSettings } from '#services/settings_service'
import { runLeanProvider, type LeanProviderSettings } from '#services/lean/lean_provider'
import { ensureLeanTables } from '#services/lean/lean_tables'
import { invalidateCatalogDigest } from '#services/lean/lean_catalog_service'

/**
 * Ciri model otomatis: AI melihat foto katalog SEKALI per foto dan menulis
 * ≤ 12 kata (warna, kerah, kancing, breasted) ke features_ai. Ciri yang diisi
 * admin (features) selalu menang. Dijalankan di latar setelah Sync katalog.
 */
const CIRI_SCHEMA = {
  type: 'object',
  properties: {
    ciri: {
      type: 'string',
      description:
        'Maksimal 12 kata, bahasa Indonesia, tanpa nama produk: warna sebenarnya (putih/broken white/gading/cream/navy…), jenis kerah (shawl/peak/notch) dan warnanya (senada/hitam kontras), jumlah kancing, single/double breasted, detail mencolok lain. Kosong bila bukan foto pakaian.',
    },
  },
  required: ['ciri'],
  additionalProperties: false,
}

const SYSTEM =
  'Kamu mendeskripsikan foto produk jas/tuxedo untuk katalog CS. Jawab hanya JSON sesuai schema. Jangan menebak bahan atau harga.'

let running = new Set<string>()

export async function describeCatalogPhotos(limit = 12, log?: (line: string) => void) {
  const scope = workspaceScope().prefix
  if (running.has(scope)) return { done: 0, skipped: 'running' as const }
  running.add(scope)
  try {
    await ensureLeanTables()
    const rows = await db
      .from('whatsapp_lean_catalog')
      .where('active', 1)
      .whereNotNull('photo_url')
      .where('photo_url', '!=', '')
      .where('features', '')
      .where((q) => q.whereNull('features_ai_photo').orWhereRaw('features_ai_photo <> photo_url'))
      .orderBy('id', 'asc')
      .limit(limit)
    if (!rows.length) return { done: 0 }
    const raw = await readSettings(true)
    const settings: LeanProviderSettings = {
      ...raw,
      aiProvider: raw.aiProvider === 'claude' ? 'claude' : 'chatgpt',
    }
    let done = 0
    for (const row of rows) {
      const photo = String(row.photo_url)
      const directory = await mkdtemp(join(tmpdir(), 'wa-ciri-'))
      try {
        const response = await fetch(photo, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`Foto ${response.status}`)
        const type = response.headers.get('content-type') || ''
        const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg'
        const path = join(
          directory,
          `${createHash('sha1').update(photo).digest('hex').slice(0, 12)}.${ext}`
        )
        await writeFile(path, Buffer.from(await response.arrayBuffer()))
        const result = await runLeanProvider(
          settings,
          {
            system: SYSTEM,
            user: `Produk: ${row.product}${row.color ? ` - ${row.color}` : ''}. Deskripsikan ciri yang terlihat di foto terlampir.`,
          },
          [path],
          'lean-ciri',
          CIRI_SCHEMA
        )
        const parsed = JSON.parse(result.text) as { ciri?: string }
        const ciri = String(parsed.ciri || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160)
        await db
          .from('whatsapp_lean_catalog')
          .where('id', row.id)
          .update({ features_ai: ciri, features_ai_photo: photo, updated_at: new Date() })
        done++
        log?.(`${row.product} - ${row.color}: ${ciri || '(kosong)'}`)
      } catch (error) {
        // Foto yang gagal dicatat supaya tidak diulang tiap sync; sync berikutnya (foto berubah) mencoba lagi.
        await db
          .from('whatsapp_lean_catalog')
          .where('id', row.id)
          .update({ features_ai_photo: photo, updated_at: new Date() })
        log?.(
          `${row.product} - ${row.color}: gagal (${error instanceof Error ? error.message : String(error)})`
        )
      } finally {
        await rm(directory, { recursive: true, force: true }).catch(() => {})
      }
    }
    if (done) invalidateCatalogDigest()
    return { done, remaining: rows.length === limit }
  } finally {
    running.delete(scope)
  }
}
