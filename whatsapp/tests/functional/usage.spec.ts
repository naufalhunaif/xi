import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { usageFromEvent, recordUsage, readUsage } from '#services/usage_service'

test.group('AI usage', () => {
  test('normalizes cache tokens without double counting and ignores intermediate events', ({
    assert,
  }) => {
    assert.deepEqual(
      usageFromEvent('chatgpt', {
        type: 'turn.completed',
        usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 },
      }),
      { input: 100, cached: 80, output: 10, cacheWrite: 0 }
    )
    assert.deepEqual(
      usageFromEvent('claude', {
        type: 'result',
        usage: {
          input_tokens: 20,
          cache_read_input_tokens: 80,
          cache_creation_input_tokens: 30,
          output_tokens: 10,
        },
      }),
      { input: 130, cached: 80, output: 10, cacheWrite: 30 }
    )
    assert.isNull(
      usageFromEvent('claude', {
        type: 'assistant',
        usage: { input_tokens: 20, output_tokens: 10 },
      })
    )
    assert.isNull(usageFromEvent('chatgpt', { type: 'turn.completed' }))
  })

  test('persists usage, distinguishes missing tokens, and excludes old runs', async ({
    assert,
  }) => {
    await initializeDatabase()
    await db.beginGlobalTransaction()
    try {
      const previousReport = await readUsage()
      const before = previousReport.providers.find((p) => p.provider === 'chatgpt')!
      await recordUsage({
        provider: 'chatgpt',
        model: 'usage-test',
        status: 'completed',
        usage: { input: 100, output: 10, cached: 80, cacheWrite: 20 },
        durationMs: 1500,
      })
      await recordUsage({
        provider: 'chatgpt',
        model: 'usage-test',
        status: 'failed',
        usage: null,
        durationMs: 2000,
      })
      await db.table('whatsapp_ai_usage').insert({
        provider: 'chatgpt',
        status: 'completed',
        input_tokens: 99999,
        output_tokens: 10,
        cached_tokens: 0,
        duration_ms: 1,
        created_at: new Date('2000-01-01'),
      })
      const report = await readUsage()
      const after = report.providers.find((p) => p.provider === 'chatgpt')!
      assert.equal(after.input - before.input, 100)
      assert.equal(after.output - before.output, 10)
      assert.equal(after.runs - before.runs, 2)
      assert.equal(after.measured - before.measured, 1)
      assert.equal(after.failed - before.failed, 1)
      assert.isNull(report.recent[0].tokens)
    } finally {
      await db.rollbackGlobalTransaction()
    }
  })

  test('attributes tokens to the phase that spent them', async ({ assert }) => {
    await initializeDatabase()
    await db.beginGlobalTransaction()
    try {
      const phase = `spec-${Date.now()}`
      await recordUsage({
        provider: 'chatgpt',
        phase: `${phase}-analysis`,
        model: 'usage-test',
        status: 'completed',
        usage: { input: 400, output: 20, cached: 300, cacheWrite: 50 },
        durationMs: 1000,
      })
      await recordUsage({
        provider: 'chatgpt',
        phase: `${phase}-recheck`,
        model: 'usage-test',
        status: 'completed',
        usage: { input: 900, output: 30, cached: 700, cacheWrite: 0 },
        durationMs: 2000,
      })
      // A run without a phase still appears, grouped under a name instead of vanishing.
      await recordUsage({
        provider: 'chatgpt',
        model: 'usage-test',
        status: 'completed',
        usage: { input: 10, output: 1, cached: 0, cacheWrite: 0 },
        durationMs: 100,
      })
      const report = await readUsage()
      const analysis = report.phases.find((row) => row.phase === `${phase}-analysis`)
      const recheck = report.phases.find((row) => row.phase === `${phase}-recheck`)
      assert.deepEqual(
        { runs: analysis?.runs, input: analysis?.input, cached: analysis?.cached },
        { runs: 1, input: 400, cached: 300 }
      )
      assert.equal(recheck?.input, 900)
      assert.isTrue(report.phases.some((row) => row.phase === 'lainnya'))
      // The most expensive phase leads, so the biggest cost is the first thing read.
      const ordered = report.phases.map((row) => row.input + row.output)
      assert.deepEqual(
        ordered,
        [...ordered].sort((a, b) => b - a)
      )
      assert.equal(report.recent[0].phase, '')
      assert.equal(report.recent[1].phase, `${phase}-recheck`)
      assert.equal(report.recent[1].cached, 700)
    } finally {
      await db.rollbackGlobalTransaction()
    }
  })

  test('usage endpoint requires account authentication', async ({ client }) => {
    const response = await client.get('/api/ai/usage').redirects(0)
    response.assertStatus(302)
  })
})
