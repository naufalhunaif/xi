/* eslint-disable @unicorn/no-await-expression-member -- Keep snapshot assertions inline in rollback-only tests. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { ensureDefaults, readSettings } from '#services/settings_service'
import {
  readProductionPolicy,
  saveProductionPolicy,
  recordProductionSignal,
  productionOverview,
} from '#services/production_service'
import {
  defaultProductionPolicy,
  validateProductionPolicy,
  productionDataContext,
  type ProductionSignal,
} from '#services/production_contract'
import { evaluateConversation } from '#services/conversation_evaluation_service'

const signal = (
  id = randomUUID(),
  direction: 'shorter' | 'longer' = 'shorter'
): ProductionSignal => ({
  kind: 'custom',
  direction,
  reason: 'Pelanggan keberatan dengan waktu produksi custom.',
  evidenceMessageIds: [id],
})
async function configure(autoAdjust = true, estimate = 14) {
  const input = defaultProductionPolicy()
  input.autoAdjust = autoAdjust
  input.rules.custom = {
    enabled: true,
    minDays: 10,
    maxDays: 16,
    estimateDays: estimate,
    dayType: 'calendar',
    startsAfter: 'payment_details',
  }
  return (await saveProductionPolicy(input)).policy
}
test.group('Local production settings and bounded evaluation', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    for (const table of [
      'whatsapp_production_policy',
      'whatsapp_production_changes',
      'whatsapp_production_signals',
    ])
      await db.from(table).delete()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    return () => db.rollbackGlobalTransaction()
  })
  test('starts unconfigured; validates bounds, persists independently and refuses stale edits', async ({
    assert,
  }) => {
    assert.deepEqual(await readProductionPolicy(), defaultProductionPolicy())
    const initial = defaultProductionPolicy()
    initial.rules.custom.enabled = true
    assert.throws(() => validateProductionPolicy(initial), /Set the minimum/)
    const saved = await configure()
    assert.equal((await readSettings()).production.rules.custom.estimateDays, 14)
    await assert.rejects(() => saveProductionPolicy(defaultProductionPolicy()), /changed/)
    saved.rules.custom.estimateDays = 9
    await assert.rejects(() => saveProductionPolicy(saved), /permitted range/)
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 14)
    const context = productionDataContext(await readProductionPolicy())
    assert.include(context, 'bukan MCP')
    assert.include(context, 'Jangan mengganti estimasi/tanggal yang sudah disepakati')
  })
  test('requires three different customers; changes one day, records evidence and never mutates orders', async ({
    assert,
  }) => {
    const policy = await configure()
    const orders = await db.from('whatsapp_orders').select('*')
    const a = signal()
    for (let i = 0; i < 4; i++) await recordProductionSignal('100000000001@lid', policy.version, a)
    await recordProductionSignal('100000000002@lid', policy.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 14)
    await recordProductionSignal('100000000003@lid', policy.version, signal())
    const after = await readProductionPolicy()
    assert.equal(after.rules.custom.estimateDays, 13)
    assert.notEqual(after.version, policy.version)
    const history = await productionOverview()
    assert.equal(history.history[0].actor, 'ai_eval')
    assert.lengthOf(history.history[0].evidence, 3)
    assert.deepEqual(await db.from('whatsapp_orders').select('*'), orders)
    for (let i = 4; i < 8; i++)
      await recordProductionSignal(`10000000000${i}@lid`, after.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 13)
  })
  test('mixed feedback needs 80 percent support and null retracts the customer vote', async ({
    assert,
  }) => {
    const policy = await configure()
    await recordProductionSignal('100000000010@lid', policy.version, signal(randomUUID(), 'longer'))
    for (let i = 1; i <= 3; i++)
      await recordProductionSignal(`10000000001${i}@lid`, policy.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 14)
    await recordProductionSignal('100000000013@lid', policy.version, null)
    assert.equal(
      (await productionOverview()).signals.find((s) => s.direction === 'shorter')?.customers,
      2
    )
    await recordProductionSignal('100000000014@lid', policy.version, signal())
    await recordProductionSignal('100000000015@lid', policy.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 13)
  })
  test('never crosses owner bounds and honors disabled auto adjustment', async ({ assert }) => {
    let policy = await configure(false, 10)
    for (let i = 1; i <= 4; i++)
      await recordProductionSignal(`10000000002${i}@lid`, policy.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 10)
    policy = (await saveProductionPolicy({ ...policy, autoAdjust: true })).policy
    for (let i = 1; i <= 4; i++)
      await recordProductionSignal(`10000000003${i}@lid`, policy.version, signal())
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 10)
    assert.equal(
      (await productionOverview()).history.filter((h) => h.actor === 'ai_eval').length,
      0
    )
  })
  test('stale evaluations, disabled AI and recycled evidence cannot adjust settings', async ({
    assert,
  }) => {
    const original = await configure()
    const old = signal()
    await recordProductionSignal('100000000041@lid', original.version, old)
    const policy = (await saveProductionPolicy({ ...original, autoAdjust: false })).policy
    await recordProductionSignal('100000000042@lid', original.version, signal())
    await recordProductionSignal('100000000041@lid', policy.version, old)
    assert.lengthOf((await productionOverview()).signals, 0)
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    await recordProductionSignal('100000000043@lid', policy.version, signal())
    assert.lengthOf((await productionOverview()).signals, 0)
  })
  test('committed evaluation passes real customer evidence to the policy service, without a send', async ({
    assert,
  }) => {
    await configure()
    await db.table('whatsapp_skills').insert({
      name: 'production-test-eval',
      content: 'Observe only.',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const settings = await readSettings(true)
    for (let i = 1; i <= 3; i++) {
      const jid = `10000000005${i}@lid`
      const id = randomUUID()
      await db.table('whatsapp_messages').insert({
        jid,
        message_id: id,
        direction: 'in',
        sender_type: 'customer',
        body: 'Produksi custom 14 hari terlalu lama, saya tidak jadi pesan.',
        status: 'received',
        created_at: new Date(),
      })
      assert.isTrue(
        await evaluateConversation(jid, settings, async () => ({
          summary: 'Keberatan waktu tunggu.',
          stage: 'selection',
          missedNeeds: [],
          nextAction: 'Ikuti skill.',
          limitations: ['Bukan bukti konversi.'],
          evidenceMessageIds: [id],
          productionSignal: signal(id),
        }))
      )
      assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 1)
    }
    assert.equal((await readProductionPolicy()).rules.custom.estimateDays, 13)
  })
  test('rejects AI-authored evidence and discards an evaluation after an owner edit', async ({
    assert,
  }) => {
    const policy = await configure()
    await db.table('whatsapp_skills').insert({
      name: 'production-evidence-eval',
      content: 'Observe only.',
      created_at: new Date(),
      updated_at: new Date(),
    })
    const jid = '100000000061@lid'
    const id = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: id,
      direction: 'out',
      sender_type: 'ai',
      body: 'Estimasi 14 hari.',
      status: 'sent',
      created_at: new Date(),
    })
    const result = {
      summary: 'Test',
      stage: 'selection' as const,
      missedNeeds: [],
      nextAction: '',
      limitations: [],
      evidenceMessageIds: [id],
      productionSignal: signal(id),
    }
    assert.isFalse(await evaluateConversation(jid, await readSettings(true), async () => result))
    assert.lengthOf((await productionOverview()).signals, 0)
    const other = '100000000062@lid'
    const inbound = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid: other,
      message_id: inbound,
      direction: 'in',
      sender_type: 'customer',
      body: 'Produksi terlalu lama.',
      status: 'received',
      created_at: new Date(),
    })
    assert.isFalse(
      await evaluateConversation(other, await readSettings(true), async () => {
        await saveProductionPolicy({ ...policy, autoAdjust: false })
        return { ...result, evidenceMessageIds: [inbound], productionSignal: signal(inbound) }
      })
    )
    assert.lengthOf((await productionOverview()).signals, 0)
  })
})
