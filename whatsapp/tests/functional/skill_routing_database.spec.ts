import { test } from '@japa/runner'
import { fileURLToPath } from 'node:url'
import { createReply } from '#services/ai_service'
import { initializeDatabase } from '#services/init_model'
import { resetQuota } from '#services/ai_quota_store'
import { startTrace, readTrace, type TraceEvent } from '#services/trace_service'

test.group('Skill routing pipeline (disposable DB and local provider fixture)', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Use isolated --skill-routing runner.')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable database required')
    await initializeDatabase()
  })
  test('coalesced trace retains all stages and terminal outcome in the database', async ({
    assert,
  }) => {
    const trace = await startTrace('trace-coalescing-fixture@lid', { messages: [] })
    for (let index = 0; index < 55; index++) {
      trace.emit({ key: `step-${index}`, label: `Step ${index}`, status: 'running' })
      trace.emit({
        key: `step-${index}`,
        label: `Step ${index}`,
        status: 'completed',
        detail: { index },
      })
    }
    await trace.finish('completed', { decision: 'silent' })
    const saved = await readTrace('trace-coalescing-fixture@lid', trace.id)
    assert.equal(saved?.status, 'completed')
    assert.lengthOf(saved!.steps, 55)
    assert.isTrue(saved!.steps.every((step: any) => step.status === 'completed'))
    assert.deepEqual(saved!.decision, { decision: 'silent' })
  })
  for (const scenario of [
    'SIMPLE',
    'READ',
    'LATE',
    'UNCERTAIN',
    'LOW_SAVING',
    'SCHEMA_ERROR',
    'CONTEXT_ERROR',
    'PATTERN_NAVY',
    'PATTERN_MAROON',
  ]) {
    test(`routed reply ${scenario} preserves context and bounds fallback`, async ({ assert }) => {
      await resetQuota('chatgpt')
      const events: TraceEvent[] = []
      const pending = createReply(
        {
          aiProvider: 'chatgpt',
          aiFailover: false,
          codexBin: fileURLToPath(
            new URL('../fixtures/skill_routing_provider.mjs', import.meta.url)
          ),
          skills: [
            {
              name: 'chameleon-cs-gabungan-2',
              content:
                'RETIRED_RULE_MUST_NOT_RETURN\n# STATUS DAN PRIORITAS SKILL\nBerkas ini bukan acuan aktif bila skill modular tersedia. Jangan muat atau terapkan berkas ini bersamaan dengan skill modular. Gunakan skill modular yang sesuai kebutuhan.',
            },
            ...[
              'cs-chameleon-cloth',
              'cs-chameleon-konteks',
              'cs-chameleon-media',
              'cs-chameleon-batas',
              'cs-chameleon-eval',
            ].map((name) => ({ name, content: `CURRENT_${name}` })),
            {
              name: 'chameleon-cs-gabungan',
              content: `# Kebijakan\n${'CORE_RULE_ORIGINAL\n'.repeat(scenario === 'LOW_SAVING' ? 15000 : 1)}## Katalog\nCATALOG_RULE_ORIGINAL\n## Pembayaran\n${'DEFERRED_PAYMENT_ORIGINAL\n'.repeat(300)}`,
            },
          ],
          mcpConnections: [],
        },
        `harga jas SCENARIO_${scenario}`,
        undefined,
        undefined,
        'CUSTOMER_HISTORY_ORIGINAL' +
          (scenario.startsWith('PATTERN_')
            ? `\nCURRENT_VARIANT=${scenario.slice(8).toLowerCase()}`
            : ''),
        [],
        (event) => events.push(event)
      )
      if (scenario.endsWith('_ERROR')) {
        let failure: any
        try {
          await pending
        } catch (error) {
          failure = error
        }
        const code = scenario === 'SCHEMA_ERROR' ? 'AI_SCHEMA_INVALID' : 'AI_CONTEXT_LIMIT'
        assert.equal(failure?.detail.code, code)
        const traces = events.filter(
          (event) => event.key === 'analysis' && event.status === 'failed'
        )
        assert.isTrue(traces.every((event) => (event.detail as any).code === code))
        assert.lengthOf(
          events.filter((event) => event.key === 'analysis' && event.status === 'running'),
          1
        )
        const detail = traces.at(-1)!.detail as any
        assert.equal(detail.code, code)
        assert.equal(detail.diagnosticsVersion, 3)
        assert.isTrue(detail.routingFieldRequired)
        assert.match(detail.schemaFingerprint, /^[a-f0-9]{16}$/)
        assert.equal(detail.workerPid, process.pid)
        assert.equal(detail.toolCallsInTask, 0)
        assert.notInclude(JSON.stringify(events), 'private-fixture')
        assert.isFalse(events.some((event) => event.key === 'skill-routing-fallback'))
        return
      }
      const decision = await pending
      const runtime = (events.find((event) => event.key === 'skill-routing')?.detail as any).runtime
      assert.equal(runtime.workerPid, process.pid)
      assert.equal(runtime.policyVersion, 'beta-followups-v2')
      assert.match(runtime.fingerprint, /^[a-f0-9]{16}$/)
      assert.equal(
        (events.find((event) => event.key === 'skill-routing')?.detail as any).sourceSelection
          .excluded[0].name,
        'chameleon-cs-gabungan-2'
      )
      assert.equal(decision.decision, 'reply')
      assert.equal(
        decision.message,
        scenario.startsWith('PATTERN_')
          ? `Rincian yang ditanyakan: badan ${scenario.slice(8).toLowerCase()}.`
          : ['READ', 'LATE', 'LOW_SAVING'].includes(scenario)
            ? 'Pembayaran transfer tersedia.'
            : 'Harga produk tersedia.'
      )
      const fallback = ['LATE', 'UNCERTAIN'].includes(scenario)
      assert.equal(
        events.filter((event) => event.key === 'skill-routing-fallback').length,
        fallback ? 1 : 0
      )
      assert.equal(
        events.filter(
          (event) => /^(skill-fallback:)?analysis$/.test(event.key) && event.status === 'completed'
        ).length,
        fallback ? 2 : 1
      )
      assert.equal(
        (events.find((event) => event.key === 'skill-routing')?.detail as any).delivery,
        scenario === 'LOW_SAVING' ? 'full-content' : 'routed'
      )
      if (scenario === 'READ')
        assert.isTrue(events.some((event) => JSON.stringify(event).includes('read_business_skill')))
      if (scenario.startsWith('PATTERN_')) {
        const cacheEvent = events.find((event) => event.key === 'pattern-cache')?.detail as any
        assert.equal(cacheEvent.status, 'hit')
        assert.isFalse(cacheEvent.customerDataCached)
        assert.notInclude(JSON.stringify(cacheEvent), 'CURRENT_VARIANT')
        assert.isTrue(events.some((event) => JSON.stringify(event).includes('catalog-design')))
      }
    })
  }
})
