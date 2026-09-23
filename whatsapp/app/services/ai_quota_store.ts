import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import type { QuotaWindow } from '#services/ai_quota_contract'

export type QuotaProvider = 'chatgpt' | 'claude'
export async function quotaState(provider: QuotaProvider) {
  await initializeDatabase()
  await db
    .table('whatsapp_ai_quota')
    .insert({
      provider,
      generation: randomUUID(),
      windows_json: '[]',
      checked_at: 0,
    })
    .onConflict('provider')
    .ignore()
  return db.from('whatsapp_ai_quota').where('provider', provider).firstOrFail()
}
export function storedQuotaWindows(row: any): QuotaWindow[] {
  try {
    const parsed = JSON.parse(row.windows_json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
export async function resetQuota(provider: QuotaProvider) {
  await quotaState(provider)
  await db.from('whatsapp_ai_quota').where('provider', provider).update({
    generation: randomUUID(),
    windows_json: '[]',
    checked_at: 0,
    failed: false,
    limited_until: null,
    limited_code: null,
  })
}
export async function saveQuotaWindows(
  provider: QuotaProvider,
  generation: string,
  windows: QuotaWindow[],
  replace = false
) {
  await db.transaction(async (trx) => {
    const row = await trx
      .from('whatsapp_ai_quota')
      .where({ provider, generation })
      .forUpdate()
      .first()
    if (!row) return // Login changed while the worker/request was running.
    const merged = new Map(
      (replace ? [] : storedQuotaWindows(row)).map((window) => [window.key, window])
    )
    for (const window of windows) {
      if ((merged.get(window.key)?.observedAt || 0) <= window.observedAt)
        merged.set(window.key, window)
    }
    await trx
      .from('whatsapp_ai_quota')
      .where({ provider, generation })
      .update({
        windows_json: JSON.stringify([...merged.values()].slice(0, 40)),
        failed: false,
      })
  })
}
