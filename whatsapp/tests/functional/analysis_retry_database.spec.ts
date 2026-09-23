import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { ensureDefaults } from '#services/settings_service'
import {
  beginGoalTurn,
  readConversationGoal,
  saveGoalDecision,
  pauseGoalRun,
  invalidateConversationGoal,
} from '#services/conversation_goal_service'
import {
  scheduleAnalysisRetry,
  readAnalysisRecovery,
  markGoalDelivery,
  recoverInterruptedAnalyses,
  recoverLegacyPausedAnalyses,
  recoverCatalogConsentHandoffs,
  presentedAnalysisStatus,
} from '#services/analysis_retry_service'
import { AiProcessFailure, type AiFailureDetail } from '#services/ai_failure_service'
import { startTrace } from '#services/trace_service'
import { diagnosticStep } from '#services/diagnostic_contract'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const failure: AiFailureDetail = {
  stage: 'provider',
  provider: 'chatgpt',
  code: 'AI_UNAVAILABLE',
  message: 'Layanan sementara tidak dapat dihubungi.',
  action: 'Coba ulang.',
  retryable: true,
}
const silent = {
  decision: 'silent' as const,
  message: '',
  reason: 'Menunggu pelanggan',
  note: '',
  goal: {
    objective: 'Pilihan pelanggan',
    status: 'waiting_answer' as const,
    waiting_for: 'Jawaban',
    next_action: 'Tunggu',
    follow_up: null,
  },
}
async function fixture() {
  const jid = `${Math.floor(Math.random() * 1e14)}@lid`
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    jid,
    message_id: messageId,
    direction: 'in',
    sender_type: 'customer',
    body: 'Produk ini tersedia?',
    status: 'received',
    created_at: new Date(Date.now() - 10000),
  })
  await db
    .table('whatsapp_contacts')
    .insert({ jid, handling_mode: 'ai', ai_excluded: false, updated_at: new Date() })
  const run = (await beginGoalTurn(jid, messageId))!
  return { jid, messageId, run }
}
async function makeDue(jid: string) {
  await db
    .from('whatsapp_chat_goals')
    .where('jid', jid)
    .update({ next_run_at: new Date(Date.now() - 1000) })
}
function worker() {
  const value = Object.assign(Object.create(WhatsappListen.prototype), {
    socket: {},
    stopping: false,
    readyForAi: () => true,
    pendingTurns: new Map(),
    chatLocks: new Map(),
    setActivity: async () => {},
    canSendAiReply: async () => true,
    customerTurnContext: async () => ({
      prompt: 'Konteks asli',
      access: {},
      routing: {},
      sections: [],
    }),
    imagePathOfMessage: async () => null,
  }) as any
  Object.defineProperty(value, 'logger', { value: { error: () => {}, info: () => {} } })
  return value
}

test.group('Durable bounded analysis recovery', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Disposable database only')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable DB only')
    await ensureDefaults()
    await db.table('whatsapp_skills').insert({
      name: 'retry-fixture',
      content: 'Jawab sesuai bukti.',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
  })
  group.each.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    await db.from('whatsapp_chat_goals').delete()
    await db.from('whatsapp_settings').where('id', 1).update({
      ai_enabled: true,
      ai_provider: 'chatgpt',
      ai_failover: false,
    })
  })
  test('paused analysis is due after backoff and only one concurrent claimant can retry', async ({
    assert,
  }) => {
    const f = await fixture()
    const scheduled = await scheduleAnalysisRetry(f.run, failure)
    assert.equal(scheduled?.status, 'scheduled')
    const goal = await readConversationGoal(f.jid)
    assert.equal(presentedAnalysisStatus(goal), 'retrying')
    assert.isAbove(new Date(goal.next_run_at).getTime(), Date.now() + 28000)
    assert.isNull(await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: f.run.version }))
    await makeDue(f.jid)
    const claims = await Promise.all(
      [0, 1].map(() => beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: f.run.version }))
    )
    assert.lengthOf(claims.filter(Boolean), 1)
  })
  test('budget persists across new worker instances and stops after two retries', async ({
    assert,
  }) => {
    const f = await fixture()
    let run = f.run
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await scheduleAnalysisRetry(run, failure)
      if (attempt < 2) {
        assert.equal(result?.status, 'scheduled')
        await makeDue(f.jid)
        run = (await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: run.version }))!
      } else assert.equal(result?.status, 'exhausted')
    }
    const saved = await readConversationGoal(f.jid)
    assert.equal(readAnalysisRecovery(saved.recovery_json)?.attempts, 2)
    assert.isNull(saved.next_run_at)
    assert.isNull(await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: run.version }))
  })
  test('actual worker retries while AI stays on; successful waiting never runs again', async ({
    assert,
  }) => {
    const f = await fixture()
    await scheduleAnalysisRetry(f.run, failure)
    await makeDue(f.jid)
    const instance = worker()
    let calls = 0
    instance.createReviewDecision = async () => {
      calls++
      return silent
    }
    instance.deliverAiDecision = async (
      run: any,
      _socket: any,
      _settings: any,
      decision: any,
      _keys: any,
      _scheduled: any,
      trace: any
    ) => {
      await saveGoalDecision(run, decision, [])
      await trace.finish('completed', decision)
    }
    await instance.consumeAnalysisRetries()
    await instance.consumeAnalysisRetries()
    assert.equal(calls, 1)
    const saved = await readConversationGoal(f.jid)
    assert.equal(saved.status, 'waiting_answer')
    assert.equal(Number(saved.analyzed_anchor_id), f.run.anchor_id)
  })
  test('a retry failure schedules the next attempt without manual activation', async ({
    assert,
  }) => {
    const f = await fixture()
    await scheduleAnalysisRetry(f.run, failure)
    await makeDue(f.jid)
    const instance = worker()
    instance.createReviewDecision = async () => {
      throw new AiProcessFailure(failure)
    }
    await instance.consumeAnalysisRetries()
    const saved = await readConversationGoal(f.jid)
    assert.equal(readAnalysisRecovery(saved.recovery_json)?.attempts, 1)
    assert.equal(presentedAnalysisStatus(saved), 'retrying')
    assert.isAbove(new Date(saved.next_run_at).getTime(), Date.now() + 110000)
  })
  test('AI off prevents the retry; CS, excluded, answered and changed rooms cannot be claimed', async ({
    assert,
  }) => {
    const f = await fixture()
    await scheduleAnalysisRetry(f.run, failure)
    await makeDue(f.jid)
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    const instance = worker()
    instance.createReviewDecision = async () => assert.fail('AI disabled')
    await instance.consumeAnalysisRetries()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    for (const variant of ['cs', 'excluded', 'answered', 'changed']) {
      const room = await fixture()
      await scheduleAnalysisRetry(room.run, failure)
      await makeDue(room.jid)
      if (variant === 'cs')
        await db.from('whatsapp_contacts').where('jid', room.jid).update({ handling_mode: 'cs' })
      if (variant === 'excluded')
        await db.from('whatsapp_contacts').where('jid', room.jid).update({ ai_excluded: true })
      if (variant === 'answered')
        await db.table('whatsapp_messages').insert({
          jid: room.jid,
          message_id: randomUUID(),
          direction: 'out',
          sender_type: 'ai',
          body: 'Sudah dijawab',
          status: 'sent',
          created_at: new Date(),
        })
      if (variant === 'changed') await invalidateConversationGoal(room.jid)
      assert.isNull(
        await beginGoalTurn(room.jid, room.messageId, { autoRetryVersion: room.run.version })
      )
    }
    await pauseGoalRun(f.run, 'fixture ended')
  })
  test('delivery failures and permanent provider configuration errors never regenerate a reply', async ({
    assert,
  }) => {
    const f = await fixture()
    await markGoalDelivery(f.run)
    const deliveryFailure = await scheduleAnalysisRetry(f.run, failure)
    assert.equal(deliveryFailure?.status, 'blocked')
    for (const code of [
      'AI_SCHEMA_INVALID',
      'AI_AUTH_REQUIRED',
      'AI_CONFIG_INVALID',
      'BUSINESS_EVIDENCE_MISSING',
    ]) {
      const room = await fixture()
      const result = await scheduleAnalysisRetry(room.run, { ...failure, code })
      assert.isNull(result?.nextAttemptAt)
    }
  })
  test('only a proven exited analysis owner is recovered, not live, unknown or delivery runs', async ({
    assert,
  }) => {
    const f = await fixture()
    const interruptedTrace = await startTrace(f.jid, {})
    await recoverInterruptedAnalyses(() => false)
    const liveGoal = await readConversationGoal(f.jid)
    assert.equal(liveGoal.status, 'processing')
    const delivering = await fixture()
    await markGoalDelivery(delivering.run)
    const legacy = await fixture()
    await db.from('whatsapp_chat_goals').where('jid', legacy.jid).update({ recovery_json: null })
    await recoverInterruptedAnalyses(
      (state) => state.anchorId === f.run.anchor_id || state.anchorId === delivering.run.anchor_id
    )
    assert.equal(presentedAnalysisStatus(await readConversationGoal(f.jid)), 'retrying')
    const deliveryGoal = await readConversationGoal(delivering.jid)
    const legacyGoal = await readConversationGoal(legacy.jid)
    assert.equal(deliveryGoal.status, 'processing')
    assert.equal(legacyGoal.status, 'processing')
    const cancelled = await db.from('whatsapp_ai_traces').where('id', interruptedTrace.id).first()
    assert.equal(cancelled.status, 'cancelled')
  })
  test('new customer input resets the budget and an older failure cannot pause the new turn', async ({
    assert,
  }) => {
    const f = await fixture()
    await scheduleAnalysisRetry(f.run, failure)
    await makeDue(f.jid)
    const retry = (await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: f.run.version }))!
    const messageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: messageId,
      direction: 'in',
      sender_type: 'customer',
      body: 'Pakai size S',
      status: 'received',
      created_at: new Date(),
    })
    const next = await beginGoalTurn(f.jid, messageId)
    assert.isNotNull(next)
    assert.isNull(await scheduleAnalysisRetry(retry, failure))
    const saved = await readConversationGoal(f.jid)
    assert.equal(saved.status, 'processing')
    assert.equal(readAnalysisRecovery(saved.recovery_json)?.attempts, 0)
  })
  test('remote diagnostics expose retry timing without customer context', ({ assert }) => {
    const step = diagnosticStep({
      key: 'analysis-retry',
      status: 'completed',
      detail: {
        status: 'scheduled',
        attempt: 1,
        maximum: 2,
        nextAttemptAt: '2026-09-20T03:00:00.000Z',
        customerText: 'PRIVATE_CUSTOMER_TEXT',
      },
    })
    assert.equal(step.retry?.status, 'scheduled')
    assert.equal(step.retry?.attempt, 1)
    assert.equal(step.retry?.nextAttemptAt, '2026-09-20T03:00:00.000Z')
    assert.notInclude(JSON.stringify(step), 'PRIVATE_CUSTOMER_TEXT')
  })
  test('legacy paused provider failure is adopted once; completed waiting and business failures stay paused', async ({
    assert,
  }) => {
    for (const stage of ['provider', 'processing'] as const) {
      const f = await fixture()
      const trace = await startTrace(f.jid, {})
      await pauseGoalRun(f.run, 'Old failure')
      await db.from('whatsapp_chat_goals').where('jid', f.jid).update({ recovery_json: null })
      await trace.finish('failed', { failure: { ...failure, stage } })
      await recoverLegacyPausedAnalyses()
      const first = await readConversationGoal(f.jid)
      assert.equal(presentedAnalysisStatus(first), stage === 'provider' ? 'retrying' : 'paused')
      await recoverLegacyPausedAnalyses()
      const second = await readConversationGoal(f.jid)
      assert.equal(second.recovery_json, first.recovery_json)
    }
  })
  test('known catalog-consent handoff recovers once only in rooms already AI', async ({
    assert,
  }) => {
    for (const mode of ['ai', 'cs']) {
      const f = await fixture()
      const decision = {
        ...silent,
        decision: 'handoff' as const,
        reason: 'Referensi persetujuan model tidak valid.',
      }
      await saveGoalDecision(f.run, decision, [])
      const trace = await startTrace(f.jid, {})
      await trace.finish('completed', {
        decision: decision.decision,
        summary: decision.reason,
      })
      await db.from('whatsapp_contacts').where('jid', f.jid).update({ handling_mode: mode })
      await recoverCatalogConsentHandoffs()
      const goal = await readConversationGoal(f.jid)
      assert.equal(presentedAnalysisStatus(goal), mode === 'ai' ? 'retrying' : 'paused')
      const before = goal.recovery_json
      await recoverCatalogConsentHandoffs()
      const second = await readConversationGoal(f.jid)
      assert.equal(second.recovery_json, before)
    }
  })
  test('the catalog wording fix can recover once after the earlier reference fix, within the same budget', async ({
    assert,
  }) => {
    const f = await fixture()
    const decision = {
      ...silent,
      decision: 'handoff' as const,
      reason: 'Detail desain katalog tidak cocok dengan permintaan yang disetujui CS.',
    }
    await saveGoalDecision(f.run, decision, [])
    const goal = await readConversationGoal(f.jid)
    const state = readAnalysisRecovery(goal.recovery_json)!
    await db
      .from('whatsapp_chat_goals')
      .where('jid', f.jid)
      .update({
        recovery_json: JSON.stringify({ ...state, technicalRecovered: true }),
      })
    const trace = await startTrace(f.jid, {})
    await trace.finish('completed', { decision: 'handoff', summary: decision.reason })
    await recoverCatalogConsentHandoffs()
    await makeDue(f.jid)
    const retry = (await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: f.run.version }))!
    const retried = await readConversationGoal(f.jid)
    assert.equal(readAnalysisRecovery(retried.recovery_json)?.attempts, 1)
    assert.isTrue(readAnalysisRecovery(retried.recovery_json)?.catalogWordingRecovered)
    await saveGoalDecision(retry, decision, [])
    await recoverCatalogConsentHandoffs()
    const stopped = await readConversationGoal(f.jid)
    assert.isNull(stopped.next_run_at)
    assert.equal(stopped.status, 'paused')
  })

  test('quota cooldown delays attempts without launching the model', async ({ assert }) => {
    const f = await fixture()
    await scheduleAnalysisRetry(f.run, { ...failure, code: 'USAGE_LIMIT' })
    await makeDue(f.jid)
    await db
      .table('whatsapp_ai_quota')
      .insert({ provider: 'chatgpt' })
      .onConflict('provider')
      .ignore()
    await db
      .from('whatsapp_ai_quota')
      .where('provider', 'chatgpt')
      .update({ limited_until: Date.now() + 3600000, limited_code: 'USAGE_LIMIT' })
    const instance = worker()
    instance.createReviewDecision = async () =>
      assert.fail('Provider cooldown must block paid runs')
    try {
      await instance.consumeAnalysisRetries()
      const goal = await readConversationGoal(f.jid)
      assert.equal(readAnalysisRecovery(goal.recovery_json)?.attempts, 0)
      assert.isAbove(new Date(goal.next_run_at).getTime(), Date.now() + 3500000)
    } finally {
      await db
        .from('whatsapp_ai_quota')
        .where('provider', 'chatgpt')
        .update({ limited_until: null, limited_code: null })
    }
  })

  test('notes mismatch in an AI room is recovered once, without taking over CS rooms or resending replies', async ({ assert }) => {
    for (const variant of ['ai', 'cs', 'sent', 'exhausted']) {
      const f = await fixture()
      const decision = { ...silent, decision: 'handoff' as const,
        reason: 'Catatan desain katalog memuat detail yang belum cocok dengan permintaan yang disetujui CS.' }
      await markGoalDelivery(f.run)
      await saveGoalDecision(f.run, decision, [])
      const trace = await startTrace(f.jid, {})
      await trace.finish('completed', { decision: 'handoff', summary: decision.reason }, variant === 'sent' ? 'sent-message' : undefined)
      if (variant === 'cs') await db.from('whatsapp_contacts').where('jid', f.jid).update({ handling_mode: 'cs' })
      if (variant === 'exhausted') {
        const old = await readConversationGoal(f.jid)
        await db.from('whatsapp_chat_goals').where('jid', f.jid).update({ recovery_json: JSON.stringify({ ...readAnalysisRecovery(old.recovery_json), attempts: 2 }) })
      }
      await recoverCatalogConsentHandoffs()
      let goal = await readConversationGoal(f.jid)
      assert.equal(presentedAnalysisStatus(goal), variant === 'ai' ? 'retrying' : 'paused')
      if (variant !== 'ai') continue
      assert.isTrue(readAnalysisRecovery(goal.recovery_json)?.catalogNotesRecovered)
      await makeDue(f.jid)
      const next = (await beginGoalTurn(f.jid, f.messageId, { autoRetryVersion: goal.version }))!
      await saveGoalDecision(next, decision, [])
      await recoverCatalogConsentHandoffs()
      goal = await readConversationGoal(f.jid)
      assert.equal(goal.status, 'paused')
      assert.isNull(goal.next_run_at)
      assert.equal(readAnalysisRecovery(goal.recovery_json)?.attempts, 1)
    }
  })
})
