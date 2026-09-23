import { test } from '@japa/runner'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import { createReply } from '#services/ai_service'
import { initializeDatabase } from '#services/init_model'
import { resetQuota } from '#services/ai_quota_store'
import type { TraceEvent } from '#services/trace_service'
import env from '#start/env'

test.group('Compact opt-in pipeline with offline provider', (group) => {
  let skills: Array<{ name: string; content: string }>
  group.each.skip(
    process.env.DISCOUNT_DB_TEST !== '1' || !process.env.COMPACT_SKILL_FIXTURE_DIR,
    'Use isolated --compact-reply runner.'
  )
  group.setup(async () => {
    if (!process.env.COMPACT_SKILL_FIXTURE_DIR || process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable DB required')
    await initializeDatabase()
    const directory = process.env.COMPACT_SKILL_FIXTURE_DIR
    skills = await Promise.all(
      (await readdir(directory))
        .filter((file) => file.endsWith('.md'))
        .map(async (file) => ({
          name: file.replace(/\.md$/, ''),
          content: await readFile(join(directory, file), 'utf8'),
        }))
    )
  })
  for (const scenario of [
    'BASIC',
    'SALES_STEP',
    'SALES_MESSAGE',
    'SALES_PAUSED',
    'SALES_FULL',
    'CART',
    'CONTRACT',
    'LATE_CONTRACT',
    'CATALOG_PHOTO',
    'PHOTO_DOCS',
    'EDITED',
    'DISABLED',
    'INDEX',
    'INDEX_ESCALATE',
    'ADAPTIVE_SIMPLE',
    'ADAPTIVE_ESCALATE',
    'ADAPTIVE_FAIL',
  ]) {
    test(`compact pipeline ${scenario} preserves exact context and bounds normal input`, async ({
      assert,
    }) => {
      await resetQuota('chatgpt')
      const events: TraceEvent[] = []
      const text =
        scenario === 'CART' ? 'Sama' : scenario.startsWith('ADAPTIVE') ? 'Harga jas' : 'Halo bos'
      const current = `${text}\nSCENARIO_${scenario}`
      const original =
        'CURRENT_FACT_UNCHANGED\nQUOTED_ORIGINAL_UNCHANGED\nCUSTOMER_CORRECTION_UNCHANGED'
      const enabled = !['DISABLED', 'SALES_FULL'].includes(scenario)
      // Env.set stores values without casting; preserve the validated boolean type.
      env.set('AI_COMPACT_REPLY_ENABLED', enabled as unknown as string)
      const decision = await createReply(
        {
          aiProvider: 'chatgpt',
          aiFailover: false,
          chatgptModel: 'gpt-5.6-sol',
          chatgptReasoning: 'high',
          codexBin: fileURLToPath(
            new URL('../fixtures/compact_reply_provider.mjs', import.meta.url)
          ),
          skills:
            scenario === 'EDITED'
              ? skills.map((skill) =>
                  skill.name === 'cs-chameleon-cloth'
                    ? { ...skill, content: skill.content + '\nOWNER_NEW_RULE' }
                    : skill
                )
              : skills,
          mcpConnections: [],
          routingContext: {
            indexContext: original,
            runtimeRules: 'DEFERRED_APP_CONTRACT_SENTINEL',
            hasCart: scenario === 'CART',
            lastQuestion: scenario === 'CART' ? 'Nama penerima?' : '',
            waitingFor: scenario === 'CART' ? 'Nama penerima' : '',
            ...(/^(INDEX|ADAPTIVE)/.test(scenario)
              ? {
                  activeState: {
                    currentText: current,
                    currentMessageCount: 1,
                    hasMedia: false,
                    hasQuote: false,
                    cartVersion: 'v1',
                    cartItems: 0,
                    orderCount: 0,
                    pendingMemory: false,
                    lastMessageId: '',
                    lastMessageDigest: '',
                    lastSender: '',
                    previousExternalId: 0,
                    lastQuestion: '',
                    waitingFor: '',
                    checkpoint: null,
                  },
                }
              : {}),
          },
        },
        current,
        undefined,
        undefined,
        original,
        [],
        (event) => events.push(event)
      )
      if (scenario.startsWith('SALES')) {
        const sent: string[] = []
        await sendAiMessageSequence(
          decision,
          false,
          async () => true,
          async (body) => {
            sent.push(body)
            return true
          }
        )
        assert.deepEqual(
          sent,
          scenario === 'SALES_PAUSED'
            ? ['Siap bos.']
            : scenario === 'SALES_MESSAGE'
              ? ['Mau pre-order Choco size S, bos?']
              : ['Choco size S sedang kosong bos.', 'Mau pre-order Choco size S, bos?']
        )
        const progress = events.find((event) => event.key === 'sales-progress')!.detail as any
        assert.equal(progress.extraAiCalls, 0)
        assert.equal(progress.waitReason, scenario === 'SALES_PAUSED' ? 'customer_paused' : 'none')
      }
      if (/^(INDEX|ADAPTIVE)/.test(scenario)) {
        const models = events
          .filter((e) => e.key.endsWith(':model-selection'))
          .map((e) => (e.detail as any).modelSelection)
        assert.equal(
          models[0].model,
          scenario.startsWith('INDEX') ? 'gpt-5.6-luna' : 'gpt-5.6-terra'
        )
        if (scenario.endsWith('ESCALATE') || scenario.endsWith('FAIL')) {
          assert.lengthOf(models, 2)
          assert.equal(models[1].model, 'gpt-5.6-sol')
          assert.equal(decision.message, 'PRIMARY_REPLY')
        } else assert.lengthOf(models, 1)
        if (scenario === 'INDEX') {
          assert.isDefined(decision.indexReply)
          assert.isFalse(events.some((e) => e.key === 'skill-routing'))
          assert.isBelow(
            (events.find((e) => e.key === 'index-prompt-size')!.detail as any).characters,
            24000
          )
          console.log(
            JSON.stringify({
              scenario,
              indexPromptCharacters: (
                events.find((e) => e.key === 'index-prompt-size')!.detail as any
              ).characters,
              routingMs: (events.find((e) => e.key === 'routing-timing')!.detail as any).durationMs,
            })
          )
        }
        return
      }
      const route = events.find((event) => event.key === 'skill-routing')!.detail as any
      const size = events.find((event) => event.key === 'prompt-size')!.detail as any
      const phases = events.filter(
        (event) => /(?:^|:)analysis$/.test(event.key) && event.status === 'completed'
      )
      assert.lengthOf(phases, scenario === 'LATE_CONTRACT' ? 2 : 1)
      assert.equal(
        route.compactPolicy.eligible,
        !['EDITED', 'DISABLED', 'SALES_FULL'].includes(scenario)
      )
      assert.equal(decision.decision, scenario.includes('CONTRACT') ? 'handoff' : 'reply')
      if (scenario === 'LATE_CONTRACT') {
        assert.deepEqual(
          phases.map((event) => event.key),
          ['analysis', 'compact-expand:analysis']
        )
        assert.isFalse(events.some((event) => event.key === 'skill-routing-fallback'))
        assert.deepEqual(
          (events.find((event) => event.key === 'skill-routing-expand')!.detail as any).fields,
          ['approvalWait']
        )
      } else if (['CATALOG_PHOTO', 'PHOTO_DOCS'].includes(scenario)) {
        assert.lengthOf(decision.images || [], 1)
        assert.isFalse(events.some((event) => event.key === 'skill-routing-expand'))
      }
      if (!['EDITED', 'DISABLED', 'SALES_FULL'].includes(scenario)) {
        assert.equal(size.profile, 'compact-reply-v11')
        if (size.tokens > 9000) console.log(JSON.stringify({ scenario, sections: size.sections }))
        assert.isAtMost(size.tokens, 9000)
        assert.isFalse(size.overTarget)
        assert.isFalse(events.some((event) => event.key === 'business-recheck-run'))
        // Only counts, never private source content or customer payloads.
        console.log(
          JSON.stringify({
            scenario,
            estimatedInitialTextTokens: size.tokens,
            excludesProviderAndImageOverhead: true,
          })
        )
      } else {
        assert.equal(
          route.compactPolicy.reason,
          scenario === 'EDITED' ? 'source_version_not_reviewed' : 'opt_in_disabled'
        )
        if (scenario === 'EDITED')
          assert.include(route.compactPolicy.unreviewed, 'cs-chameleon-cloth')
        console.log(JSON.stringify({ scenario, estimatedInitialTextTokens: size.tokens }))
      }
      env.set('AI_COMPACT_REPLY_ENABLED', true as unknown as string)
    })
  }
})
