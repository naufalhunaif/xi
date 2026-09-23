import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { inWorkspace } from '#services/workspace_context'
import { EvidenceCache, evidenceStore } from '#services/evidence_cache'

test.group('Evidence cache disposable database', (group) => {
  group.setup(() => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database runner required')
  })
  test('persists across cache instances, isolates workspace tables, prunes expiry and bounds history', async ({
    assert,
  }) => {
    await initializeDatabase()
    await db.from('whatsapp_evidence_cache').delete()
    let calls = 0
    const input = {
      key: 'persisted',
      ttl: 60000,
      fetch: async () => ({ call: ++calls }),
      valid: () => true,
    }
    const first = await new EvidenceCache().readThrough(input)
    const second = await new EvidenceCache().readThrough(input)
    assert.equal(first.report.source, 'mcp')
    assert.equal(second.report.source, 'cache')
    assert.deepEqual(second.value, { call: 1 })
    assert.equal(calls, 1)
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, async () => {
      await initializeDatabase()
      assert.equal((await new EvidenceCache().readThrough(input)).report.source, 'mcp')
      assert.equal(Number((await db.from('whatsapp_evidence_cache').count('* as n').first()).n), 1)
    })
    assert.equal((await new EvidenceCache().readThrough(input)).report.source, 'cache')
    await db.from('whatsapp_evidence_cache').update({ expires_at: Date.now() - 1 })
    assert.equal((await new EvidenceCache().readThrough(input)).report.status, 'expired')
    const now = Date.now()
    await db.table('whatsapp_evidence_cache').multiInsert(
      Array.from({ length: 505 }, (_, index) => ({
        cache_key: index.toString(16).padStart(64, '0'),
        result_json: '{}',
        stored_at: now - 1000 + index,
        expires_at: now + 60000,
      }))
    )
    await evidenceStore.put('f'.repeat(64), {
      value: { test: true },
      storedAt: now,
      expiresAt: now + 60000,
    })
    assert.isAtMost(
      Number((await db.from('whatsapp_evidence_cache').count('* as n').first()).n),
      500
    )
    assert.deepEqual((await evidenceStore.get('f'.repeat(64)))?.value, { test: true })
  })
})
