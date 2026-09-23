import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { readSettings, ensureDefaults } from '#services/settings_service'
import {
  alreadyAnalyzedMessage,
  beginGoalTurn,
  invalidateConversationGoal,
  readConversationGoal,
  saveGoalDecision,
  pauseGoalRun,
  failedGoalMessage,
} from '#services/conversation_goal_service'
import { requestAiReview, requestRecentAiReviews } from '#services/ai_review_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const isolatedDatabase = process.env.DISCOUNT_DB_TEST === '1'
if (isolatedDatabase) {
  // Seed before the older suites open rollback transactions. No production database is used.
  await ensureDefaults()
  const fixtureSkill = {
    name: 'waiting-regression-fixture',
    content: 'Jawab berdasarkan bukti; tunggu pesan baru setelah selesai.',
    created_at: new Date(),
    updated_at: new Date(),
  }
  await db.table('whatsapp_skills').insert(fixtureSkill)
}

async function incoming(jid: string) {
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    jid,
    message_id: messageId,
    direction: 'in',
    sender_type: 'customer',
    body: 'Saya tunggu dulu ya',
    status: 'received',
    created_at: new Date(Date.now() - 120000),
  })
  return messageId
}

async function waitingRoom(status = 'waiting_answer') {
  const jid = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
  const messageId = await incoming(jid)
  const run = (await beginGoalTurn(jid, messageId))!
  await saveGoalDecision(
    run,
    {
      decision: 'silent',
      message: '',
      reason: 'Menunggu pelanggan',
      note: '',
      goal: {
        objective: 'Menunggu pilihan',
        status: status as any,
        waiting_for: 'Pilihan pelanggan',
        next_action: 'Tunggu pesan baru',
        follow_up: null,
      },
    },
    []
  )
  return { jid, messageId, run }
}

function worker() {
  const instance = Object.assign(Object.create(WhatsappListen.prototype), {
    socket: {},
    stopping: false,
    readyForAi: () => true,
    pendingTurns: new Map(),
    chatLocks: new Map(),
    workScheduleOpen: new Map(),
    setActivity: async () => {},
  }) as any
  Object.defineProperty(instance, 'logger', { value: { error: () => {}, info: () => {} } })
  return instance
}

test.group('Waiting rooms do not run unchanged analysis', (group) => {
  if (!isolatedDatabase) return
  group.setup(async () => {
    await initializeDatabase()
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_enabled: true, sweep_enabled: true })
  })

  test('silent waiting remains idle across repeated backlog, reviews and reconnects', async ({
    assert,
  }) => {
    for (const status of ['waiting', 'waiting_answer', 'waiting_payment', 'waiting_approval']) {
      const { jid, messageId } = await waitingRoom(status)
      const before = await readConversationGoal(jid)
      assert.isTrue(await alreadyAnalyzedMessage(jid))
      const instance = worker()
      instance.createReviewDecision = async () => assert.fail('Waiting must not call AI')
      instance.customerTurnContext = async () => assert.fail('Skip before assembling context')
      const settings = await readSettings(true)
      for (let tick = 0; tick < 3; tick++) {
        assert.isNull(await beginGoalTurn(jid, messageId))
        await requestAiReview(jid, 'reconnected')
        await requestAiReview(jid, 'enabled')
        await requestAiReview(jid, 'schedule_open')
        await instance.reviewChat({ jid, reason: 'reconnected' }, settings)
        await instance.answerBacklog(jid, settings)
        const message = await db
          .from('whatsapp_messages')
          .where('message_id', messageId)
          .firstOrFail()
        await instance.recoverStoredSyncMessage(message)
      }
      const queue = await db.from('whatsapp_ai_reviews').where('jid', jid).first()
      assert.isNull(queue)
      const after = await readConversationGoal(jid)
      assert.equal(after.version, before.version)
      assert.equal(after.status, status)
      assert.equal(Number(after.analyzed_anchor_id), Number(before.anchor_id))
    }
  })

  test('global wakeup skips analyzed rooms, but queues fresh messages', async ({ assert }) => {
    const idle = await waitingRoom()
    const fresh = await waitingRoom()
    await incoming(fresh.jid)
    await invalidateConversationGoal(fresh.jid)
    for (const reason of ['enabled', 'reconnected', 'schedule_open'] as const) {
      await requestRecentAiReviews(reason, 48)
      const oldRequest = await db.from('whatsapp_ai_reviews').where('jid', idle.jid).first()
      const newRequest = await db.from('whatsapp_ai_reviews').where('jid', fresh.jid).first()
      assert.isNull(oldRequest)
      assert.isNotNull(newRequest)
    }
  })

  test('completed analysis survives invalidation, while new input or a real human decision can run', async ({
    assert,
  }) => {
    const { jid, messageId } = await waitingRoom()
    await invalidateConversationGoal(jid, true)
    assert.isNull(await beginGoalTurn(jid, messageId))
    await requestAiReview(jid, 'human_decision')
    const request = await db.from('whatsapp_ai_reviews').where('jid', jid).first()
    assert.isNotNull(request)
    assert.isNotNull(await beginGoalTurn(jid, messageId, { humanDecision: true }))
    assert.isNull(await beginGoalTurn(jid, messageId, { humanDecision: true }))
    const next = await incoming(jid)
    await invalidateConversationGoal(jid)
    assert.isNotNull(await beginGoalTurn(jid, next))
  })

  test('two workers cannot claim the same unchanged message concurrently', async ({ assert }) => {
    const jid = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
    const messageId = await incoming(jid)
    const claims = await Promise.all([beginGoalTurn(jid, messageId), beginGoalTurn(jid, messageId)])
    assert.lengthOf(claims.filter(Boolean), 1)
  })

  test('failed snapshot stays paused across sweeps and reconnects until explicit activation or new input', async ({
    assert,
  }) => {
    const jid = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
    const messageId = await incoming(jid)
    const run = (await beginGoalTurn(jid, messageId))!
    await pauseGoalRun(run, 'Proses gagal; menunggu aktivasi ulang atau pesan baru.')
    assert.isFalse(await alreadyAnalyzedMessage(jid)) // Failed is never mislabeled as successful.
    const instance = worker()
    instance.createReviewDecision = async () => assert.fail('Paused failure must not call AI')
    const stored = await db.from('whatsapp_messages').where('message_id', messageId).firstOrFail()
    for (let tick = 0; tick < 3; tick++) {
      assert.isTrue(await failedGoalMessage(jid, messageId))
      assert.isNull(await beginGoalTurn(jid, messageId))
      await requestAiReview(jid, 'reconnected')
      await requestAiReview(jid, 'schedule_open')
      await instance.recoverStoredSyncMessage(stored)
      await instance.reviewChat({ jid, reason: 'reconnected' }, await readSettings(true))
      await instance.answerBacklog(jid, await readSettings(true))
    }
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    await requestAiReview(jid, 'enabled')
    assert.isNotNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    const retried = await beginGoalTurn(jid, messageId, { retryFailed: true })
    assert.isNotNull(retried)
    await pauseGoalRun(retried!, 'Masih gagal')
    const next = await incoming(jid)
    assert.isFalse(await failedGoalMessage(jid, next))
    assert.isNotNull(await beginGoalTurn(jid, next))
  })

  test('backlog SQL excludes analyzed waiting rooms before dispatch, while untouched input remains eligible', async ({
    assert,
  }) => {
    const idle = await waitingRoom()
    const failed = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
    const failedMessage = await incoming(failed)
    await pauseGoalRun((await beginGoalTurn(failed, failedMessage))!, 'Fixture failed')
    const fresh = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
    await incoming(fresh)
    const instance = worker()
    const visited: string[] = []
    instance.answerBacklog = async (jid: string) => {
      visited.push(jid)
    }
    await instance.sweepUnanswered()
    assert.notInclude(visited, idle.jid)
    assert.notInclude(visited, failed)
    assert.include(visited, fresh)
  })
})
