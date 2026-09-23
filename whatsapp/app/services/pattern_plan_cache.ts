/** Bounded process-local cache for compiled policy plans. Customer data must never be a value. */
export class PatternPlanCache<T> {
  private entries = new Map<string, { expiresAt: number; value: T }>()
  constructor(
    private maximum = 64,
    private ttl = 30 * 60_000,
    private now = Date.now
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || !Number.isFinite(ttl) || ttl <= 0)
      throw new Error('Invalid pattern cache bounds')
  }

  read(key: string, build: () => T) {
    const now = this.now()
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id)
    const cached = this.entries.get(key)
    if (cached) {
      this.entries.delete(key)
      this.entries.set(key, cached)
      return { value: cached.value, status: 'hit' as const }
    }
    const value = build()
    while (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!)
    this.entries.set(key, { value, expiresAt: now + this.ttl })
    return { value, status: 'miss' as const }
  }
}
