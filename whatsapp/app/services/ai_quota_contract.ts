export type QuotaWindow = {
  key: string
  bucket: string
  minutes: number | null
  usedPercent: number | null
  resetsAt: number | null
  status: 'allowed' | 'allowed_warning' | 'rejected' | 'unknown'
  observedAt: number
}
const object = (value: any): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : {}
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)
const reset = (value: unknown) =>
  finite(value) && value > 0 && value < 100_000_000_000 ? Math.floor(value) : null
const percent = (value: unknown) => (finite(value) && value >= 0 ? Math.min(100, value) : null)
const label = (value: unknown, fallback: string) =>
  typeof value === 'string' && /^[a-zA-Z0-9_. -]{1,80}$/.test(value) ? value : fallback

/** Only provider-reported quota fields; token counts/context-window usage are not quotas. */
export function codexQuotaWindows(value: unknown, now = Date.now()): QuotaWindow[] {
  const data = object(value)
  const buckets = object(data.rateLimitsByLimitId)
  const entries = Object.keys(buckets).length
    ? Object.entries(buckets)
    : data.rateLimits
      ? [[data.rateLimits.limitId || 'codex', data.rateLimits]]
      : []
  return entries.slice(0, 20).flatMap(([id, raw]) => {
    const bucket = object(raw)
    return ['primary', 'secondary'].flatMap((kind) => {
      const window = object(bucket[kind])
      if (!Object.keys(window).length) return []
      const usedPercent = percent(window.usedPercent)
      return [
        {
          key: `${label(id, 'codex')}:${kind}`,
          bucket: label(bucket.limitName, label(id, 'codex')),
          minutes:
            finite(window.windowDurationMins) && window.windowDurationMins > 0
              ? window.windowDurationMins
              : null,
          usedPercent,
          resetsAt: reset(window.resetsAt),
          status:
            usedPercent === null
              ? ('unknown' as const)
              : usedPercent >= 100
                ? ('rejected' as const)
                : ('allowed' as const),
          observedAt: now,
        },
      ]
    })
  })
}

const claudeMinutes: Record<string, number | null> = {
  five_hour: 300,
  seven_day: 10080,
  seven_day_opus: 10080,
  seven_day_sonnet: 10080,
  seven_day_overage_included: 10080,
  overage: null,
}
export function claudeQuotaWindows(event: Record<string, any>, now = Date.now()): QuotaWindow[] {
  if (event.type !== 'rate_limit_event') return []
  const info = object(event.rate_limit_info)
  const windows = new Map<string, QuotaWindow>()
  const add = (key: string, raw: any, status?: unknown) => {
    if (!Object.hasOwn(claudeMinutes, key)) return
    const value = object(raw)
    windows.set(key, {
      key,
      bucket: key,
      minutes: claudeMinutes[key],
      usedPercent: finite(value.utilization) ? percent(value.utilization * 100) : null,
      resetsAt: reset(value.resetsAt ?? value.resets_at),
      status:
        status === 'allowed' || status === 'allowed_warning' || status === 'rejected'
          ? status
          : 'unknown',
      observedAt: now,
    })
  }
  // Recent CLI versions report both windows; older versions report the limiting one only.
  for (const [key, value] of Object.entries(object(info.unifiedWindows))) add(key, value)
  const key = info.rateLimitType ?? info.rate_limit_type
  if (typeof key === 'string') {
    if (!windows.has(key) || finite(info.utilization)) add(key, info, info.status)
    else if (info.status === 'rejected') windows.get(key)!.status = 'rejected'
  }
  return [...windows.values()]
}

export function quotaPresentation(windows: QuotaWindow[], now = Date.now()) {
  return windows.map((window) => {
    const expired = window.resetsAt !== null && window.resetsAt * 1000 <= now
    const stale = now - window.observedAt > 300_000
    return {
      ...window,
      expired,
      stale,
      remainingPercent:
        expired || window.usedPercent === null
          ? null
          : Math.round((100 - window.usedPercent) * 10) / 10,
    }
  })
}
