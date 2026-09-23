import { createHash } from 'node:crypto'
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { initializeDatabase } from '#services/init_model'

export type CacheEntry = { value: unknown; storedAt: number; expiresAt: number }
export interface EvidenceStore {
  get(key: string): Promise<CacheEntry | null>
  put(key: string, entry: CacheEntry): Promise<void>
}

/** Exact semantic inputs, stable object order; array order and primitive types are significant. */
export function evidenceKey(value: unknown): string {
  const canonical = (item: any): any => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, canonical(item[key])])
      )
    return item
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}

export const evidenceStore: EvidenceStore = {
  async get(key) {
    await initializeDatabase()
    const row = await db.from('whatsapp_evidence_cache').where('cache_key', key).first()
    if (!row) return null
    return {
      value: JSON.parse(row.result_json),
      storedAt: Number(row.stored_at),
      expiresAt: Number(row.expires_at),
    }
  },
  async put(key, entry) {
    if (Buffer.byteLength(JSON.stringify(entry.value)) > 128 * 1024) return
    await initializeDatabase()
    // Bounded per workspace, including expired entries. No conversation/credentials in keys.
    await db.from('whatsapp_evidence_cache').where('expires_at', '<=', Date.now()).delete()
    const old = await db
      .from('whatsapp_evidence_cache')
      .select('cache_key')
      .orderBy('stored_at', 'desc')
      .offset(499)
      .limit(1000)
    if (old.length)
      await db
        .from('whatsapp_evidence_cache')
        .whereIn(
          'cache_key',
          old.map((row) => row.cache_key)
        )
        .delete()
    await db
      .table('whatsapp_evidence_cache')
      .insert({
        cache_key: key,
        result_json: JSON.stringify(entry.value),
        stored_at: entry.storedAt,
        expires_at: entry.expiresAt,
      })
      .onConflict('cache_key')
      .merge()
  },
}

export type CacheReport = {
  status: 'hit' | 'miss' | 'expired' | 'bypass' | 'unavailable' | 'coalesced'
  source: 'cache' | 'mcp'
  storedAt?: number
  expiresAt?: number
  reason?: string
}

/** Owned by one reply, shared by its phases, never retained for the next message. */
export function createTurnEvidenceCache(now = Date.now) {
  const entries = new Map<string, CacheEntry>()
  return new EvidenceCache(
    {
      get: async (key) => {
        const entry = entries.get(key)
        return entry ? structuredClone(entry) : null
      },
      put: async (key, entry) => {
        for (const [storedKey, value] of entries)
          if (value.expiresAt <= now()) entries.delete(storedKey)
        entries.delete(key)
        if (entries.size >= 64) entries.delete(entries.keys().next().value!)
        entries.set(key, structuredClone(entry))
      },
    },
    now
  )
}

/** Persistent result cache only; never replay an AI reply or a mutation. */
export class EvidenceCache {
  private pending = new Map<string, Promise<{ value: any; report: CacheReport }>>()
  constructor(
    private store: EvidenceStore = evidenceStore,
    private now = Date.now
  ) {}

  async readThrough(input: {
    key: unknown
    ttl: number
    fetch: () => Promise<any>
    valid: (value: any) => boolean
  }): Promise<{ value: any; report: CacheReport }> {
    if (!input.ttl)
      return { value: await input.fetch(), report: { status: 'bypass', source: 'mcp' } }
    const key = evidenceKey([workspaceScope().id, input.key])
    const pending = this.pending.get(key)
    if (pending) {
      const result = await pending
      return { ...result, report: { ...result.report, status: 'coalesced', source: 'cache' } }
    }
    const work = async () => {
      let status: CacheReport['status'] = 'miss'
      try {
        const entry = await this.store.get(key)
        if (entry) {
          if (
            entry.storedAt <= this.now() &&
            entry.expiresAt > this.now() &&
            input.valid(entry.value)
          )
            return {
              value: entry.value,
              report: {
                status: 'hit',
                source: 'cache',
                storedAt: entry.storedAt,
                expiresAt: entry.expiresAt,
              } as CacheReport,
            }
          status = 'expired'
        }
      } catch {
        status = 'unavailable'
      }
      const value = await input.fetch() // Failure is never replaced with stale data.
      const storedAt = this.now()
      const report: CacheReport = { status, source: 'mcp' }
      if (input.valid(value) && Buffer.byteLength(JSON.stringify(value)) <= 128 * 1024) {
        try {
          await this.store.put(key, { value, storedAt, expiresAt: storedAt + input.ttl })
          report.storedAt = storedAt
          report.expiresAt = storedAt + input.ttl
        } catch {
          report.reason = 'cache_write_unavailable'
        }
      } else report.reason = 'result_not_cacheable'
      return { value, report }
    }
    const promise = work()
    this.pending.set(key, promise)
    try {
      return await promise
    } finally {
      this.pending.delete(key)
    }
  }
}
