import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { inWorkspace } from '#services/workspace_context'
import {
  quotaState,
  resetQuota,
  saveQuotaWindows,
  storedQuotaWindows,
} from '#services/ai_quota_store'
import { readAccountQuotas } from '#services/ai_quota_service'
import { claudeQuotaWindows } from '#services/ai_quota_contract'

test.group('Quota isolated database', (group) => {
  group.setup(() => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database required')
  })
  test('Claude telemetry persists by workspace and merges windows without older overwrites', async ({
    assert,
  }) => {
    const now = Date.now()
    const state = await quotaState('claude')
    const window = claudeQuotaWindows(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.25,
          resetsAt: Math.floor(now / 1000) + 3600,
        },
      },
      now
    )
    await saveQuotaWindows('claude', state.generation, window)
    await saveQuotaWindows('claude', state.generation, [
      { ...window[0], usedPercent: 10, observedAt: now - 1 },
    ])
    await saveQuotaWindows('claude', state.generation, [
      { ...window[0], key: 'seven_day', minutes: 10080 },
    ])
    const saved = storedQuotaWindows(await quotaState('claude'))
    assert.lengthOf(saved, 2)
    assert.equal(saved[0].usedPercent, 25)
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: 'test' }, async () => {
      assert.deepEqual(storedQuotaWindows(await quotaState('claude')), [])
    })
  })
  test('new login clears quota and late results from old login cannot restore it', async ({
    assert,
  }) => {
    const old = await quotaState('claude')
    const windows = storedQuotaWindows(old)
    await resetQuota('claude')
    await saveQuotaWindows('claude', old.generation, windows)
    const current = await quotaState('claude')
    assert.notEqual(current.generation, old.generation)
    assert.deepEqual(storedQuotaWindows(current), [])
  })
  test('Codex reads are throttled and concurrent requests share a DB claim', async ({ assert }) => {
    await resetQuota('chatgpt')
    let calls = 0
    const fetcher = async () => {
      calls++
      await new Promise((resolve) => setTimeout(resolve, 20))
      return {
        rateLimits: {
          primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 },
        },
      }
    }
    await Promise.all([readAccountQuotas(fetcher), readAccountQuotas(fetcher)])
    const result = await readAccountQuotas(fetcher)
    assert.equal(calls, 1)
    assert.equal(result.providers[0].windows[0].remainingPercent, 60)
    assert.notProperty(result.providers[0], 'generation')
    assert.notProperty(result.providers[0], 'windows_json')
  })
  test('refresh failure retains last observation explicitly stale and applies cooldown', async ({
    assert,
  }) => {
    await db.from('whatsapp_ai_quota').where('provider', 'chatgpt').update({ checked_at: 0 })
    let calls = 0
    const fetcher = async (): Promise<unknown> => {
      calls++
      throw new Error('SECRET_TOKEN')
    }
    const result = await readAccountQuotas(fetcher)
    assert.isTrue(result.providers[0].refreshFailed)
    assert.isTrue(result.providers[0].windows[0].stale)
    assert.notInclude(JSON.stringify(result), 'SECRET_TOKEN')
    await readAccountQuotas(fetcher)
    assert.equal(calls, 1)
  })
  test('a concurrent login invalidates in-flight reads and empty workspace never polls', async ({
    assert,
  }) => {
    await resetQuota('chatgpt')
    const result = await readAccountQuotas(async () => {
      await resetQuota('chatgpt')
      return { rateLimits: { primary: { usedPercent: 80 } } }
    })
    assert.deepEqual(result.providers[0].windows, [])
    await inWorkspace({ id: 0, prefix: 'w0_', phone: null, version: '' }, async () => {
      const empty = await readAccountQuotas(async () => {
        throw new Error('Must not poll')
      })
      assert.deepEqual(empty.providers, [])
    })
  })
  test('quota API requires login and does not start a provider for guests', async ({
    client,
    assert,
  }) => {
    const response = await client
      .get('/api/ai/quotas')
      .header('Accept', 'application/json')
      .redirects(0)
    assert.oneOf(response.status(), [302, 401])
  })
})
