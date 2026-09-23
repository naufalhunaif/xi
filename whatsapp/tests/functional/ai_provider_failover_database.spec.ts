import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { ensureDefaults, readSettings, saveSettings } from '#services/settings_service'
import { readAccountQuotas } from '#services/ai_quota_service'
import { resetQuota, saveQuotaWindows, quotaState } from '#services/ai_quota_store'
import {
  clearProviderLimit,
  exhaustedUntil,
  planProviderRun,
  providerLimit,
  recordProviderLimit,
  runWithProviderFailover,
  settingsForProvider,
  switchableFailure,
} from '#services/ai_provider_failover'
import type { QuotaWindow } from '#services/ai_quota_contract'

const now = () => Date.now()
const window = (extra: Partial<QuotaWindow> = {}): QuotaWindow => ({
  key: 'five_hour',
  bucket: 'five_hour',
  minutes: 300,
  usedPercent: 100,
  resetsAt: Math.floor((Date.now() + 2 * 3600_000) / 1000),
  status: 'rejected',
  observedAt: Date.now(),
  ...extra,
})
async function storeWindows(provider: 'chatgpt' | 'claude', windows: QuotaWindow[]) {
  const row = await quotaState(provider)
  await saveQuotaWindows(provider, row.generation, windows, true)
}

test.group('AI engine failover (disposable DB; no provider process)', (group) => {
  group.setup(async () => {
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable database required')
    await ensureDefaults()
  })
  group.each.setup(async () => {
    await resetQuota('chatgpt')
    await resetQuota('claude')
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_provider: 'chatgpt', ai_failover: false })
  })

  test('only a full window that has not reset counts as exhausted', ({ assert }) => {
    assert.isNumber(exhaustedUntil([window()]))
    assert.isNull(exhaustedUntil([window({ usedPercent: 82, status: 'allowed_warning' })]))
    assert.isNull(exhaustedUntil([window({ usedPercent: null, status: 'unknown' })]))
    assert.isNull(exhaustedUntil([window({ resetsAt: Math.floor((Date.now() - 60_000) / 1000) })]))
    // No reported reset time still bounds the cooldown instead of parking the engine forever.
    const observedAt = Date.now() - 60_000
    const until = exhaustedUntil([window({ resetsAt: null, observedAt })])
    assert.equal(until, observedAt + 30 * 60_000)
  })

  test('a provider refusal is recorded, then expires or is cleared', async ({ assert }) => {
    assert.isNull(await providerLimit('chatgpt'))
    const until = await recordProviderLimit('chatgpt', 'USAGE_LIMIT')
    assert.isAbove(until, now() + 14 * 60_000)
    const limit = await providerLimit('chatgpt')
    assert.equal(limit?.code, 'USAGE_LIMIT')
    assert.equal(limit?.provider, 'chatgpt')
    await clearProviderLimit('chatgpt')
    assert.isNull(await providerLimit('chatgpt'))
    // A provider-reported window is enough on its own; no refusal needs to happen first.
    await storeWindows('claude', [window()])
    assert.isNotNull(await providerLimit('claude'))
    await resetQuota('claude')
    assert.isNull(await providerLimit('claude'))
    // Signing in again drops a recorded refusal with the rest of the quota state.
    await recordProviderLimit('claude', 'AI_AUTH_REQUIRED')
    await resetQuota('claude')
    assert.isNull(await providerLimit('claude'))
  })

  test('the owner engine stays first unless it is the exhausted one', async ({ assert }) => {
    const off = await planProviderRun(await readSettings())
    assert.deepEqual(off.order, ['chatgpt'])
    await saveSettings({ aiFailover: true })
    const on = await readSettings()
    assert.isTrue(on.aiFailover)
    const enabled = await planProviderRun(on)
    assert.deepEqual(enabled.order, ['chatgpt', 'claude'])
    await recordProviderLimit('chatgpt', 'USAGE_LIMIT')
    const switched = await planProviderRun(on)
    assert.deepEqual(switched.order, ['claude'])
    assert.equal(switched.configured, 'chatgpt')
    assert.equal(switched.limits[0].provider, 'chatgpt')
    // Both exhausted: no point burning a second engine on the same turn.
    await recordProviderLimit('claude', 'USAGE_LIMIT')
    const both = await planProviderRun(on)
    assert.deepEqual(both.order, [])
    let attempts = 0
    await assert.rejects(
      () =>
        runWithProviderFailover(
          both,
          async () => {
            attempts++
            return 'unexpected'
          },
          () => ''
        ),
      /jeda/
    )
    assert.equal(attempts, 0)
    // Failover stays off unless the owner enabled it.
    await saveSettings({ aiFailover: false })
    const disabled = await planProviderRun(await readSettings())
    assert.deepEqual(disabled.order, [])
    await assert.rejects(
      () =>
        runWithProviderFailover(
          disabled,
          async () => {
            attempts++
            return 'unexpected'
          },
          () => ''
        ),
      /jeda/
    )
    assert.equal(attempts, 0)
    const recovered = await planProviderRun(
      on,
      Math.max(...both.limits.map((limit) => limit.until)) + 1
    )
    assert.deepEqual(recovered.order, ['chatgpt', 'claude'])
  })

  test('the turn moves to the other engine only for a provider refusal', async ({ assert }) => {
    const plan = {
      configured: 'chatgpt' as const,
      order: ['chatgpt' as const, 'claude' as const],
      limits: [],
    }
    const events: string[] = []
    const tried: string[] = []
    const result = await runWithProviderFailover(
      plan,
      async (provider) => {
        tried.push(provider)
        if (provider === 'chatgpt') throw new Error('USAGE_LIMIT')
        return 'answered'
      },
      (error) => (error as Error).message,
      (event) => events.push(`${event.type}:${event.provider}`)
    )
    assert.equal(result, 'answered')
    assert.deepEqual(tried, ['chatgpt', 'claude'])
    assert.deepEqual(events, ['refused:chatgpt', 'switch:claude', 'recovered:claude'])
    assert.isNotNull(await providerLimit('chatgpt'))
    assert.isNull(await providerLimit('claude'))
    // A business or output failure is not a reason to spend the other engine's quota.
    const second: string[] = []
    await assert.rejects(
      () =>
        runWithProviderFailover(
          plan,
          async (provider) => {
            second.push(provider)
            throw new Error('AI_OUTPUT_INVALID')
          },
          (error) => (error as Error).message
        ),
      /AI_OUTPUT_INVALID/
    )
    assert.deepEqual(second, ['chatgpt'])
    // The last engine's refusal surfaces instead of being swallowed.
    await assert.rejects(
      () =>
        runWithProviderFailover(
          plan,
          async () => {
            throw new Error('USAGE_LIMIT')
          },
          (error) => (error as Error).message
        ),
      /USAGE_LIMIT/
    )
    assert.isNotNull(await providerLimit('claude'))
    for (const code of ['USAGE_LIMIT', 'AI_AUTH_REQUIRED', 'ACCESS_DENIED'])
      assert.isTrue(switchableFailure(code))
    for (const code of ['AI_OUTPUT_INVALID', 'BUSINESS_EVIDENCE_MISSING', 'AI_UNAVAILABLE', ''])
      assert.isFalse(switchableFailure(code))
  })

  test('a switched run never inherits the other engine MCP grants', ({ assert }) => {
    const settings = {
      aiProvider: 'chatgpt',
      mcpConnections: [
        {
          slug: 'store',
          url: 'https://example.com/mcp',
          enabled: true,
          authenticated: true,
          sharedAuthenticated: false,
          chatgptAuthenticated: true,
          claudeAuthenticated: false,
        },
        {
          slug: 'invoice',
          url: 'https://example.com/mcp',
          enabled: true,
          authenticated: true,
          sharedAuthenticated: true,
          chatgptAuthenticated: true,
          claudeAuthenticated: false,
        },
      ],
    }
    assert.strictEqual(settingsForProvider(settings, 'chatgpt'), settings)
    const claude = settingsForProvider(settings, 'claude')
    assert.equal(claude.aiProvider, 'claude')
    assert.deepEqual(
      claude.mcpConnections.map((row) => [row.slug, row.authenticated]),
      [
        ['store', false],
        ['invoice', true],
      ]
    )
    assert.isTrue(settings.mcpConnections[0].authenticated)
  })

  test('the quota view reports the recorded limit and the configured engine', async ({
    assert,
  }) => {
    await saveSettings({ aiFailover: true })
    const until = await recordProviderLimit('claude', 'USAGE_LIMIT')
    const quotas = await readAccountQuotas(async () => ({}))
    assert.equal(quotas.configuredProvider, 'chatgpt')
    assert.isTrue(quotas.failoverEnabled)
    const claude = quotas.providers.find((row: any) => row.provider === 'claude')
    assert.equal(claude?.limitedUntil, until)
    assert.equal(claude?.limitedCode, 'USAGE_LIMIT')
    assert.isNull(quotas.providers.find((row: any) => row.provider === 'chatgpt')?.limitedUntil)
  })
})
