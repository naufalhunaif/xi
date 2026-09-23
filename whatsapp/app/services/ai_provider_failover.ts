import db from '#services/workspace_database'
import { quotaState, storedQuotaWindows, type QuotaProvider } from '#services/ai_quota_store'
import type { QuotaWindow } from '#services/ai_quota_contract'
import { AiProcessFailure } from '#services/ai_failure_service'

export const AI_PROVIDERS: QuotaProvider[] = ['chatgpt', 'claude']
export const otherProvider = (provider: QuotaProvider): QuotaProvider =>
  provider === 'claude' ? 'chatgpt' : 'claude'
export const aiProviderOf = (value: unknown): QuotaProvider =>
  value === 'claude' ? 'claude' : 'chatgpt'

export type ProviderLimit = { provider: QuotaProvider; until: number; code: string }
export type ProviderPlan = {
  configured: QuotaProvider
  order: QuotaProvider[]
  limits: ProviderLimit[]
}

/** A provider-reported window that is full and has not reset yet. Warnings are not exhaustion. */
export function exhaustedUntil(windows: QuotaWindow[], now = Date.now()) {
  let until = 0
  for (const window of windows) {
    const full =
      window.status === 'rejected' || (window.usedPercent !== null && window.usedPercent >= 100)
    if (!full) continue
    const resets =
      window.resetsAt === null ? window.observedAt + FALLBACK_COOLDOWN_MS : window.resetsAt * 1000
    if (resets > now) until = Math.max(until, resets)
  }
  return until || null
}

const FALLBACK_COOLDOWN_MS = 30 * 60_000
/** Short enough that a recovered provider returns on its own, long enough to stop retry storms. */
const minimumCooldown = (code: string) =>
  code === 'USAGE_LIMIT' ? 15 * 60_000 : code === 'AI_AUTH_REQUIRED' ? 10 * 60_000 : 5 * 60_000

/** Failure codes that mean this provider cannot serve the turn, so another one may. */
export const switchableFailure = (code: string) =>
  ['USAGE_LIMIT', 'ACCESS_DENIED', 'AI_AUTH_REQUIRED'].includes(code)

export async function providerLimit(provider: QuotaProvider, now = Date.now()) {
  const row = await quotaState(provider)
  const recorded = Number(row.limited_until || 0)
  const reported = exhaustedUntil(storedQuotaWindows(row), now) || 0
  const until = Math.max(recorded > now ? recorded : 0, reported > now ? reported : 0)
  if (until <= now) return null
  const code = recorded > now ? String(row.limited_code || 'USAGE_LIMIT') : 'USAGE_LIMIT'
  return { provider, until, code } satisfies ProviderLimit
}

/** Records only what the provider itself refused; never a business or validation failure. */
export async function recordProviderLimit(provider: QuotaProvider, code: string, now = Date.now()) {
  const row = await quotaState(provider)
  const reported = exhaustedUntil(storedQuotaWindows(row), now) || 0
  const until = Math.max(reported, now + minimumCooldown(code))
  await db
    .from('whatsapp_ai_quota')
    .where('provider', provider)
    .update({ limited_until: until, limited_code: code.slice(0, 64) })
  return until
}

export async function clearProviderLimit(provider: QuotaProvider) {
  await quotaState(provider)
  await db
    .from('whatsapp_ai_quota')
    .where('provider', provider)
    .where('limited_until', '>', 0)
    .update({ limited_until: null, limited_code: null })
}

/** Owner's engine stays first unless it is known to be out of quota right now. */
export async function planProviderRun(
  settings: { aiProvider?: string; aiFailover?: boolean },
  now = Date.now()
): Promise<ProviderPlan> {
  const configured = aiProviderOf(settings.aiProvider)
  if (!settings.aiFailover) {
    const limit = await providerLimit(configured, now)
    return { configured, order: limit ? [] : [configured], limits: limit ? [limit] : [] }
  }
  const fallback = otherProvider(configured)
  const [limited, fallbackLimited] = await Promise.all([
    providerLimit(configured, now),
    providerLimit(fallback, now),
  ])
  const limits = [limited, fallbackLimited].filter(Boolean) as ProviderLimit[]
  return {
    configured,
    order: [configured, fallback].filter(
      (provider) => !limits.some((limit) => limit.provider === provider)
    ),
    limits,
  }
}

/** MCP authorization is per engine: a switched run must not inherit the other engine's grants. */
export function settingsForProvider<
  T extends {
    aiProvider?: string
    mcpConnections: Array<{ authenticated: boolean; [key: string]: any }>
  },
>(settings: T, provider: QuotaProvider): T {
  if (aiProviderOf(settings.aiProvider) === provider) return settings
  return {
    ...settings,
    aiProvider: provider,
    mcpConnections: settings.mcpConnections.map((connection) => ({
      ...connection,
      authenticated: Boolean(
        connection.sharedAuthenticated ||
        (provider === 'claude' ? connection.claudeAuthenticated : connection.chatgptAuthenticated)
      ),
    })),
  }
}

export type FailoverEvent =
  | { type: 'switch'; provider: QuotaProvider; configured: QuotaProvider }
  | { type: 'refused'; provider: QuotaProvider; code: string; next: QuotaProvider }
  | { type: 'recovered'; provider: QuotaProvider; configured: QuotaProvider }

/** Runs the planned engines in order. Only a provider refusal moves on; other errors surface. */
export async function runWithProviderFailover<T>(
  plan: ProviderPlan,
  attempt: (provider: QuotaProvider) => Promise<T>,
  failureCode: (error: unknown) => string,
  onEvent?: (event: FailoverEvent) => void
): Promise<T> {
  if (!plan.order.length) {
    const limit = plan.limits.find((item) => item.provider === plan.configured) || plan.limits[0]
    if (limit)
      throw new AiProcessFailure({
        stage: 'provider',
        provider: limit.provider,
        code: limit.code,
        message: 'Mesin AI masih dalam jeda batas pemakaian atau akses layanan.',
        action:
          'Tunggu waktu pemulihan pada pengaturan AI; proses tidak memanggil layanan selama jeda masih aktif.',
        retryable: true,
      })
    throw new Error('Mesin AI belum tersedia.')
  }
  for (const [index, provider] of plan.order.entries()) {
    if (provider !== plan.configured)
      onEvent?.({ type: 'switch', provider, configured: plan.configured })
    try {
      const result = await attempt(provider)
      await clearProviderLimit(provider).catch(() => {})
      if (provider !== plan.configured)
        onEvent?.({ type: 'recovered', provider, configured: plan.configured })
      return result
    } catch (error) {
      const code = failureCode(error)
      if (!switchableFailure(code)) throw error
      await recordProviderLimit(provider, code).catch(() => {})
      const next = plan.order[index + 1]
      if (!next) throw error
      onEvent?.({ type: 'refused', provider, code, next })
    }
  }
  throw new Error('Mesin AI belum tersedia.')
}
