/* eslint-disable @unicorn/no-await-expression-member -- Inline awaited assertions keep DB snapshots local to each assertion. */
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import {
  beginGoalTurn,
  claimConversationGoal,
  dueConversationGoals,
  invalidateConversationGoal,
  isCurrentGoalRun,
  pauseGoalRun,
  readConversationGoal,
  saveGoalDecision,
  scheduledGoalStillAllowed,
} from '#services/conversation_goal_service'
import { buildTurnContext } from '#services/context_service'
import { setHandlingMode } from '#services/message_service'
import type { AiDecision } from '#services/ai_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'
import { readSettings } from '#services/settings_service'
import { startTrace, readTrace } from '#services/trace_service'

const jid = '10000000991234@lid'
const skills = [
  { name: 'bisnis', content: 'Tunggu ukuran. Susulan 12 jam, lalu 72 jam; dua kali; 08–20 WIB.' },
]
const decision: AiDecision = {
  decision: 'reply',
  message: 'Total terverifikasi',
  initiative: 'Di tunggu ukurannya ya bos',
  reason: 'Sesuai skill',
  note: 'Menunggu ukuran',
  goal: {
    objective: 'Lengkapi pesanan pelanggan',
    status: 'waiting',
    waiting_for: 'ukuran',
    next_action: 'Tunggu ukuran yang sudah diminta',
    follow_up: {
      skill_name: 'bisnis',
      reason: 'Data ukuran sudah diminta',
      first_delay_hours: 12,
      repeat_delay_hours: 72,
      max_attempts: 2,
      send_start_hour: 8,
      send_end_hour: 20,
      time_zone: 'Asia/Jakarta',
    },
  },
}
const daytime = new Date('2027-01-02T10:00:00+07:00')
async function incoming(room = jid, sender = 'customer') {
  const id = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: id,
    jid: room,
    direction: sender === 'customer' ? 'in' : 'out',
    sender_type: sender,
    body: 'Pesan uji lokal',
    status: 'received',
    created_at: new Date(),
  })
  return id
}
async function seed(room = jid) {
  const id = await incoming(room)
  const run = (await beginGoalTurn(room, id))!
  await saveGoalDecision(run, decision, skills)
  return run
}
async function makeDue(room = jid) {
  await db.from('whatsapp_chat_goals').where('jid', room).update({ next_run_at: daytime })
}

test.group('Persistent per-customer goals', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })
  test('persists goal, policy and schedule, includes it in context, and isolates rooms', async ({
    assert,
  }) => {
    await seed()
    const stored = await readConversationGoal(jid)
    assert.equal(stored.objective, decision.goal!.objective)
    assert.equal(stored.status, 'waiting')
    assert.isNotNull(stored.next_run_at)
    assert.equal(stored.followup_count, 0)
    assert.include((await buildTurnContext(jid, [])).prompt, 'Lengkapi pesanan pelanggan')
    await initializeDatabase()
    assert.equal((await readConversationGoal(jid)).version, stored.version)
    assert.isNull(await readConversationGoal('10000000991235@lid'))
  })
  test('waiting_answer can follow skill scheduling, waiting_approval cannot auto-follow-up', async ({
    assert,
  }) => {
    const first = (await beginGoalTurn(jid, await incoming()))!
    await saveGoalDecision(
      first,
      { ...decision, goal: { ...decision.goal!, status: 'waiting_answer' } },
      skills
    )
    assert.isNotNull((await readConversationGoal(jid)).next_run_at)
    const second = (await beginGoalTurn(jid, await incoming()))!
    await saveGoalDecision(
      second,
      { ...decision, goal: { ...decision.goal!, status: 'waiting_approval' } },
      skills
    )
    const goal = await readConversationGoal(jid)
    assert.equal(goal.status, 'waiting_approval')
    assert.isNull(goal.next_run_at)
    await makeDue()
    assert.isNull(await claimConversationGoal(jid, skills, daytime))
  })
  test('reserves a due job once, persists counter across turns, and never resets the cap', async ({
    assert,
  }) => {
    await seed()
    await makeDue()
    assert.include(
      (await dueConversationGoals(daytime)).map((row) => row.jid),
      jid
    )
    const claimed = await Promise.all([
      claimConversationGoal(jid, skills, daytime),
      claimConversationGoal(jid, skills, daytime),
    ])
    assert.lengthOf(claimed.filter(Boolean), 1)
    const run = claimed.find(Boolean)!
    assert.isNotNull(run)
    assert.isNull(await claimConversationGoal(jid, skills, daytime))
    assert.isTrue(await scheduledGoalStillAllowed(run!, skills, daytime))
    await saveGoalDecision(run!, decision, skills, true)
    assert.equal((await readConversationGoal(jid)).followup_count, 1)
    const newId = await incoming()
    await invalidateConversationGoal(jid)
    const fresh = (await beginGoalTurn(jid, newId))!
    await saveGoalDecision(fresh, decision, skills)
    assert.equal((await readConversationGoal(jid)).followup_count, 1)
    await makeDue()
    const second = (await claimConversationGoal(jid, skills, daytime))!
    await saveGoalDecision(second, decision, skills, true)
    assert.equal((await readConversationGoal(jid)).followup_count, 2)
    assert.isNull((await readConversationGoal(jid)).next_run_at)
    await makeDue()
    assert.isNull(await claimConversationGoal(jid, skills, daytime))
  })
  test('invalidates on any new customer/owner message, even before the event invalidation finishes', async ({
    assert,
  }) => {
    const firstId = await incoming()
    const run = (await beginGoalTurn(jid, firstId))!
    assert.isTrue(await isCurrentGoalRun(run))
    await incoming(jid, 'owner')
    assert.isFalse(await isCurrentGoalRun(run))
    assert.isNull(await saveGoalDecision(run, decision, skills))
    assert.isNull(await beginGoalTurn(jid, firstId))
    await invalidateConversationGoal(jid, true)
    assert.equal((await readConversationGoal(jid)).status, 'paused')
  })
  test('CS takeover cancels schedules and running output; AI resume does not restore an old schedule', async ({
    assert,
  }) => {
    await seed()
    await makeDue()
    const run = (await claimConversationGoal(jid, skills, daytime))!
    await setHandlingMode(jid, 'cs')
    assert.isFalse(await isCurrentGoalRun(run))
    assert.isFalse(await scheduledGoalStillAllowed(run, skills, daytime))
    assert.isNull((await readConversationGoal(jid)).next_run_at)
    await setHandlingMode(jid, 'ai')
    assert.isNull(await claimConversationGoal(jid, skills, daytime))
  })
  test('completed, missing permission, removed/changed skill and scheduled silent never keep sending', async ({
    assert,
  }) => {
    for (const modified of [
      { ...decision, goal: { ...decision.goal!, status: 'completed' as const } },
      { ...decision, goal: { ...decision.goal!, follow_up: null } },
      { ...decision, decision: 'silent' as const, message: '' },
      { ...decision, decision: 'handoff' as const, message: '' },
    ]) {
      const id = await incoming()
      const run = (await beginGoalTurn(jid, id))!
      await saveGoalDecision(run, modified, skills, true)
      assert.isNull((await readConversationGoal(jid)).next_run_at)
    }
    for (const changedSkills of [[], [{ name: 'bisnis', content: 'Aturan berubah' }]]) {
      await seed()
      await makeDue()
      assert.isNull(await claimConversationGoal(jid, changedSkills, daytime))
      assert.equal((await readConversationGoal(jid)).status, 'paused')
    }
  })
  test('rechecks send hours, pauses failed attempts, and never automatically retries uncertain sends', async ({
    assert,
  }) => {
    await seed()
    await makeDue()
    const evening = new Date('2027-01-02T23:00:00+07:00')
    assert.isNull(await claimConversationGoal(jid, skills, evening))
    assert.equal(
      new Date((await readConversationGoal(jid)).next_run_at).toISOString(),
      '2027-01-03T01:00:00.000Z'
    )
    await makeDue()
    const run = (await claimConversationGoal(jid, skills, daytime))!
    assert.isFalse(await scheduledGoalStillAllowed(run, skills, evening))
    await pauseGoalRun(run, 'Send result uncertain')
    assert.isFalse(await isCurrentGoalRun(run))
    assert.isNull(await claimConversationGoal(jid, skills, daytime))
    assert.equal((await readConversationGoal(jid)).followup_count, 1)
  })

  test('worker sends and stores two AI bubbles, reads first, and saves the goal only after delivery', async ({
    assert,
  }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const id = await incoming()
    const run = (await beginGoalTurn(jid, id))!
    const events: string[] = []
    const socket = {
      readMessages: async () => {
        events.push('read')
      },
      sendPresenceUpdate: async (state: string) => {
        events.push(state)
      },
      sendMessage: async (_jid: string, payload: { text: string }) => {
        events.push(payload.text)
        return { key: { id: randomUUID() } }
      },
    }
    // Exercise the real worker delivery path; only WhatsApp transport is a local double.
    const worker = Object.create(WhatsappListen.prototype) as any
    Object.assign(worker, { socketOpen: true, receivedPending: true, syncReadyAt: 0, ingesting: 0 })
    worker.socket = socket
    worker.stopping = false
    await worker.deliverAiDecision(run, socket, { ...(await readSettings()), skills }, decision, [
      { remoteJid: jid, id, fromMe: false },
    ])
    const bubbles = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('sender_type', 'ai')
      .orderBy('id')
    assert.deepEqual(
      bubbles.map((row) => row.body),
      [decision.message, decision.initiative]
    )
    assert.equal(events[0], 'read')
    assert.isBelow(events.indexOf('available'), events.indexOf('composing'))
    assert.isBelow(events.indexOf('composing'), events.indexOf(decision.message))
    assert.equal((await readConversationGoal(jid)).status, 'waiting')
    assert.isNotNull((await readConversationGoal(jid)).next_run_at)
  }).timeout(10_000)

  test('worker records rejected photo preparation separately from successful MCP calls', async ({
    assert,
  }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const id = await incoming()
    const run = (await beginGoalTurn(jid, id))!
    let sends = 0
    const socket = {
      sendMessage: async () => {
        sends++
        return { key: { id: randomUUID() } }
      },
    }
    const worker = Object.create(WhatsappListen.prototype) as any
    Object.assign(worker, {
      socketOpen: true,
      receivedPending: true,
      syncReadyAt: 0,
      ingesting: 0,
      socket,
      stopping: false,
    })
    const trace = await startTrace(jid, { text: 'Foto pilihan' })
    trace.emit({
      key: 'tool',
      label: 'business_chameleon-cloth · list_records',
      status: 'completed',
    })
    await assert.rejects(
      async () =>
        worker.deliverAiDecision(
          run,
          socket,
          { ...(await readSettings()), skills, mcpConnections: [] },
          { ...decision, images: [{ url: 'https://unknown.example/photo.jpg', caption: '' }] },
          [],
          false,
          trace
        ),
      /belum terverifikasi/
    )
    await trace.finish('failed', { error: 'Pengiriman gagal.' })
    const saved = (await readTrace(jid, trace.id))!
    assert.equal(saved.steps[0].status, 'completed')
    assert.equal(saved.steps[1].key, 'outgoing-media')
    assert.equal(saved.steps[1].status, 'failed')
    assert.include(saved.steps[1].detail.error, 'Sumber gambar')
    assert.equal(sends, 0)
  })

  test('worker AI off blocks all output, and CS takeover between bubbles cancels the initiative', async ({
    assert,
  }) => {
    const events: string[] = []
    const socket = {
      readMessages: async () => {},
      sendPresenceUpdate: async () => {},
      sendMessage: async (_jid: string, payload: { text: string }) => {
        events.push(payload.text)
        await setHandlingMode(jid, 'cs')
        return { key: { id: randomUUID() } }
      },
    }
    const worker = Object.create(WhatsappListen.prototype) as any
    Object.assign(worker, { socketOpen: true, receivedPending: true, syncReadyAt: 0, ingesting: 0 })
    worker.socket = socket
    worker.stopping = false
    const id = await incoming()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    await worker.deliverAiDecision(
      (await beginGoalTurn(jid, id))!,
      socket,
      { ...(await readSettings()), skills },
      decision,
      []
    )
    assert.lengthOf(events, 0)
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    await worker.deliverAiDecision(
      (await beginGoalTurn(jid, id, { retryFailed: true }))!,
      socket,
      { ...(await readSettings()), skills },
      decision,
      []
    )
    assert.deepEqual(events, [decision.message])
    assert.equal((await readConversationGoal(jid)).status, 'paused')
    assert.isNull((await readConversationGoal(jid)).next_run_at)
  }).timeout(10_000)
})
