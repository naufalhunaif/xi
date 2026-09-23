import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { ensureWorkspaceRegistry } from '#services/workspace_service'
import { inWorkspace } from '#services/workspace_context'
import { evaluationSignature, evaluateConversation } from '#services/conversation_evaluation_service'
import { learningOverview, runConversationLearning, setLearningEnabled, rollbackLearning } from '#services/conversation_learning_service'
import { LEARNING_SKILL } from '#services/learning_contract'
import { replayFixture } from '#tests/fixtures/learning_replay'

if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE'))) throw new Error('Use the disposable --learning test runner.')
const scope = { id: 1, prefix: '', version: randomUUID(), phone: null }
const run = (fn: () => Promise<void>) => inWorkspace(scope, fn)
const original = 'Keep wording friendly. Human verification is required for payments.'
async function seed(count = 3, kind = 'photo_initiative') {
  const settings = await readSettings(true)
  for (let i = 0; i < count; i++) {
    const jid = `${80000000 + i}@lid`
    const [anchor] = await db.table('whatsapp_messages').insert({ message_id: `ai-${i}`, jid, direction: 'out', sender_type: 'ai', body: 'Ini foto', status: 'sent', created_at: new Date() })
    await db.table('whatsapp_conversation_evaluations').insert({ jid, version: randomUUID(), anchor_id: anchor, event_id: 0, skill_signature: evaluationSignature(settings), skills_json: '[]', status: 'completed', result_json: JSON.stringify({ learningSignals: [{ kind, evidenceMessageIds: [`ai-${i}`] }] }), created_at: new Date(), updated_at: new Date() })
  }
  const state = await learningOverview()
  await setLearningEnabled(true, state.revision)
  return settings
}
const successfulReplay = () => {
  let calls = 0
  return async () => replayFixture(++calls % 2 === 0)
}
test.group('Learning integration in disposable DB; providers mocked', group => {
  group.setup(async () => { await ensureDefaults(); await ensureWorkspaceRegistry() })
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    await db.from('whatsapp_workspace_state').where('id', 1).update({ active_id: 1, version: scope.version })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    await db.table('whatsapp_skills').insert({ name: 'evaluation', description: '', content: original, created_at: new Date(), updated_at: new Date() })
    return () => db.rollbackGlobalTransaction()
  })
  test('applies only the supplement, audits tests, rolls back and disables learning', ({ assert }) => run(async () => {
    const settings = await seed()
    assert.isTrue(await runConversationLearning(settings, successfulReplay()))
    let result = await learningOverview()
    assert.equal(result.versions[0].status, 'applied')
    assert.equal(result.versions[0].tests.after.filter((row: any) => row.passed).length, 8)
    assert.notProperty(result.patterns[0] || {}, 'evidence')
    assert.equal((await db.from('whatsapp_skills').where('name', 'evaluation').firstOrFail()).content, original)
    assert.include((await db.from('whatsapp_skills').where('name', LEARNING_SKILL).firstOrFail()).content, 'Inisiatif setelah foto')
    assert.lengthOf(await db.from('whatsapp_messages'), 3)
    assert.isFalse(await runConversationLearning(await readSettings(true), async () => { throw new Error('Must not repeat') }))
    await rollbackLearning(result.activeVersion!, result.revision, 'owner')
    result = await learningOverview()
    assert.isFalse(result.enabled)
    assert.equal(result.versions[0].status, 'rolled_back')
    assert.notInclude((await db.from('whatsapp_skills').where('name', LEARNING_SKILL).firstOrFail()).content, 'Inisiatif setelah foto')
    await assert.rejects(() => rollbackLearning(result.versions[0].id, result.revision, 'owner'))
  }))
  test('insufficient, protected and stale evidence never invoke provider', ({ assert }) => run(async () => {
    const settings = await seed(2)
    const never = async () => { throw new Error('Unexpected provider call') }
    assert.isFalse(await runConversationLearning(settings, never))
    assert.lengthOf(await db.from('whatsapp_learning_versions'), 0)
    await db.from('whatsapp_conversation_evaluations').update({ result_json: JSON.stringify({ learningSignals: [{ kind: 'protected_business', evidenceMessageIds: ['ai-0'] }] }) })
    assert.isFalse(await runConversationLearning(settings, never))
    assert.lengthOf(await db.from('whatsapp_learning_versions'), 0)
  }))
  test('new customer messages invalidate evidence before applying', ({ assert }) => run(async () => {
    const settings = await seed()
    let calls = 0
    assert.isFalse(await runConversationLearning(settings, async () => {
      if (++calls === 2) await db.table('whatsapp_messages').insert({ message_id: 'new', jid: '80000000@lid', direction: 'in', body: 'Sudah dijawab', status: 'received', created_at: new Date() })
      return replayFixture(calls === 2)
    }))
    assert.equal((await learningOverview()).versions[0].status, 'failed')
    assert.isNull(await db.from('whatsapp_skills').where('name', LEARNING_SKILL).first())
  }))
  test('same-quality baseline does not activate a candidate', ({ assert }) => run(async () => {
    const settings = await seed()
    assert.isFalse(await runConversationLearning(settings, async () => replayFixture()))
    assert.equal((await learningOverview()).versions[0].status, 'rejected')
    assert.isNull(await db.from('whatsapp_skills').where('name', LEARNING_SKILL).first())
  }))
  test('provider failure is recorded without repeating or modifying skills', ({ assert }) => run(async () => {
    const settings = await seed()
    assert.isFalse(await runConversationLearning(settings, async () => { throw new Error('USAGE_LIMIT') }))
    assert.equal((await learningOverview()).versions[0].status, 'failed')
    assert.include((await learningOverview()).versions[0].error!, 'Batas pemakaian')
    assert.equal((await db.from('whatsapp_skills').where('name', 'evaluation').firstOrFail()).content, original)
  }))
  test('failed simulations can retry after cooldown, with a maximum of three attempts', ({ assert }) => run(async () => {
    const settings = await seed()
    let calls = 0
    const unavailable = async () => { calls++; throw new Error('USAGE_LIMIT') }
    await runConversationLearning(settings, unavailable)
    await runConversationLearning(settings, unavailable)
    assert.equal(calls, 1)
    for (let attempt = 0; attempt < 3; attempt++) {
      await db.from('whatsapp_learning_state').where('id', 1).update({ next_run_at: new Date(Date.now() - 1000) })
      await runConversationLearning(settings, unavailable)
    }
    assert.equal(calls, 3)
    assert.lengthOf(await db.from('whatsapp_learning_versions'), 3)
  }))
  test('manual supplement edits prevent rollback from overwriting them', ({ assert }) => run(async () => {
    const settings = await seed()
    await runConversationLearning(settings, successfulReplay())
    const state = await learningOverview()
    await db.from('whatsapp_skills').where('name', LEARNING_SKILL).update({ content: 'Manual content' })
    await assert.rejects(() => rollbackLearning(state.activeVersion!, state.revision, 'owner'))
    assert.isTrue((await learningOverview()).blocked)
    assert.equal((await db.from('whatsapp_skills').where('name', LEARNING_SKILL).firstOrFail()).content, 'Manual content')
  }))
  test('workspace changes or pausing during simulation prevent application', ({ assert }) => run(async () => {
    const settings = await seed()
    let calls = 0
    await runConversationLearning(settings, async () => {
      if (++calls === 2) {
        const state = await learningOverview()
        await setLearningEnabled(false, state.revision)
      }
      return replayFixture(calls === 2)
    })
    assert.equal((await learningOverview()).versions[0].status, 'failed')
    assert.isNull(await db.from('whatsapp_skills').where('name', LEARNING_SKILL).first())
  }))
  test('manual skill changes during simulation block application', ({ assert }) => run(async () => {
    const settings = await seed()
    assert.isFalse(await runConversationLearning(settings, async () => {
      await db.from('whatsapp_skills').where('name', 'evaluation').update({ content: 'Owner changed this' })
      return replayFixture(false)
    }))
    assert.equal((await learningOverview()).versions[0].status, 'failed')
    assert.equal((await db.from('whatsapp_skills').where('name', 'evaluation').firstOrFail()).content, 'Owner changed this')
  }))
  test('toggle requires current revision and active workspace', ({ assert }) => run(async () => {
    const state = await learningOverview()
    assert.isFalse(state.enabled)
    await assert.rejects(() => setLearningEnabled(true, 'stale'))
    await db.from('whatsapp_workspace_state').where('id', 1).update({ version: randomUUID() })
    await assert.rejects(() => setLearningEnabled(true, state.revision))
  }))
  test('evaluation rejects invented learning evidence and customer-only evidence', ({ assert }) => run(async () => {
    await seed()
    const settings = await readSettings(true)
    await db.table('whatsapp_messages').insert({ message_id: 'customer', jid: '80000000@lid', direction: 'in', body: 'Ukuran apa?', status: 'received', created_at: new Date() })
    const result = { summary: 'Test', stage: 'selection', missedNeeds: [], nextAction: '', limitations: [], evidenceMessageIds: ['customer'], learningSignals: [{ kind: 'repeated_question', evidenceMessageIds: ['customer'] }] }
    assert.isFalse(await evaluateConversation('80000000@lid', settings, async () => result as any))
  }))
})
