import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { isAiWorking, validateWorkSchedule, workScheduleDefaults } from '#services/ai_work_schedule'
import { ensureDefaults, readSettings, saveSettings } from '#services/settings_service'
import { inWorkspace } from '#services/workspace_context'
import { requestRecentAiReviews } from '#services/ai_review_service'
import { beginGoalTurn } from '#services/conversation_goal_service'
import { readCart } from '#services/cart_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'
import DashboardController from '#controllers/dashboard_controller'

test.group('AI working hours (isolated DB, no providers or WhatsApp)', (group) => {
  group.setup(async () => {
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable DB required')
    await ensureDefaults()
    await db
      .table('whatsapp_skills')
      .insert({
        name: 'schedule-fixture',
        content: 'Fixture only',
        created_at: new Date(),
        updated_at: new Date(),
      })
  })
  const base = {
    ...workScheduleDefaults,
    aiEnabled: true,
    aiWorkMode: 'scheduled',
    aiWorkDays: '1,2,3,4,5',
  }
  for (const [iso, open] of [
    ['2026-09-14T01:59:59Z', false],
    ['2026-09-14T02:00:00Z', true],
    ['2026-09-14T09:59:59Z', true],
    ['2026-09-14T10:00:00Z', false],
    ['2026-09-19T05:00:00Z', false],
  ] as const)
    test(`Jakarta boundaries ${iso}`, ({ assert }) => {
      assert.equal(isAiWorking(base, new Date(iso)), open)
    })
  test('overnight belongs to start day, including Sunday to Monday', ({ assert }) => {
    const schedule = { ...base, aiWorkDays: '7', aiWorkStart: '22:00', aiWorkEnd: '06:00' }
    assert.isFalse(isAiWorking(schedule, new Date('2026-09-20T14:59:59Z')))
    assert.isTrue(isAiWorking(schedule, new Date('2026-09-20T15:00:00Z')))
    assert.isTrue(isAiWorking(schedule, new Date('2026-09-20T22:59:59Z')))
    assert.isFalse(isAiWorking(schedule, new Date('2026-09-20T23:00:00Z')))
    assert.isFalse(isAiWorking(schedule, new Date('2026-09-21T16:00:00Z')))
  })
  test('timezone is explicit, DST transitions and disabled/empty schedules fail safe', ({
    assert,
  }) => {
    const now = new Date('2026-09-14T01:30:00Z')
    assert.isFalse(isAiWorking(base, now))
    assert.isTrue(isAiWorking({ ...base, aiWorkTimezone: 'Asia/Makassar' }, now))
    const dst = {
      ...base,
      aiWorkDays: '7',
      aiWorkTimezone: 'America/New_York',
      aiWorkStart: '01:00',
      aiWorkEnd: '03:00',
    }
    assert.isTrue(isAiWorking(dst, new Date('2026-11-01T05:30:00Z')))
    assert.isTrue(isAiWorking(dst, new Date('2026-11-01T06:30:00Z')))
    assert.isFalse(isAiWorking(dst, new Date('2026-11-01T08:00:00Z')))
    assert.isTrue(isAiWorking({ ai_enabled: 1 }))
    assert.isFalse(isAiWorking({ ...base, aiEnabled: false }))
    assert.isFalse(isAiWorking({ ...base, aiWorkDays: '' }))
    assert.isFalse(isAiWorking({ ...base, aiWorkTimezone: 'invalid' }))
  })
  test('validation rejects bad values and partial autosave preserves settings/master toggle', async ({
    assert,
  }) => {
    for (const input of [
      { aiWorkMode: 'human' },
      { aiWorkTimezone: 'Mars/Now' },
      { aiWorkStart: '24:00' },
      { aiWorkDays: '0,8' },
      { aiWorkEnd: '09:00' },
    ])
      assert.throws(() => validateWorkSchedule({ ...workScheduleDefaults, ...input }))
    await saveSettings({ ...base })
    await saveSettings({ aiWorkDays: '5,1,1' })
    await saveSettings({ historyLimit: 75 })
    const settings = await readSettings()
    assert.equal(settings.aiWorkDays, '1,5')
    assert.equal(settings.aiWorkStart, '09:00')
    assert.isTrue(settings.aiEnabled)
    await assert.rejects(() => saveSettings({ aiWorkTimezone: 'Invalid' }))
    assert.equal((await readSettings()).aiWorkTimezone, 'Asia/Jakarta')
  })
  test('schedule isolated per WhatsApp number and survives init/re-read', async ({ assert }) => {
    await inWorkspace({ id: 91, prefix: 'w91_', phone: null, version: 'fixture' }, async () => {
      await ensureDefaults()
      assert.equal((await readSettings()).aiWorkMode, 'always')
      await saveSettings({
        aiWorkTimezone: 'Asia/Jayapura',
        aiWorkMode: 'scheduled',
        aiWorkDays: '6,7',
      })
      await ensureDefaults()
      assert.equal((await readSettings()).aiWorkDays, '6,7')
    })
    assert.equal((await readSettings()).aiWorkDays, '1,5')
    assert.equal((await readSettings()).aiWorkTimezone, 'Asia/Jakarta')
  })
  async function room(mode = 'ai', excluded = false, direction = 'in') {
    const jid = `${randomUUID()}@lid`,
      messageId = randomUUID()
    await db
      .table('whatsapp_contacts')
      .insert({
        jid,
        name: 'Fixture',
        handling_mode: mode,
        ai_excluded: excluded,
        handoff_reason: mode === 'cs' ? 'Operator review' : null,
        updated_at: new Date(),
      })
    await db
      .table('whatsapp_messages')
      .insert({
        jid,
        message_id: messageId,
        direction,
        sender_type: direction === 'out' ? 'owner' : 'customer',
        body: 'Fixture only',
        status: 'received',
        created_at: new Date(),
      })
    return { jid, messageId }
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
    Object.defineProperty(instance, 'logger', { value: { error: () => {} } })
    return instance
  }
  test('outside hours blocks final sends and cart mutations, but displays CS without overwriting assignment', async ({
    assert,
  }) => {
    await saveSettings({ aiWorkMode: 'scheduled', aiWorkDays: '', aiEnabled: true })
    const { jid, messageId } = await room()
    const w = worker()
    assert.isFalse(await w.canSendAiReply(jid, w.socket))
    const initial = await readCart(jid)
    const run = await beginGoalTurn(jid, messageId)
    w.waitForDeliverySync = async () => true
    await w.deliverAiDecision(
      run,
      w.socket,
      await readSettings(),
      {
        decision: 'reply',
        message: 'Must not send',
        cartVersion: initial.version,
        cartIntent: { action: 'cancel' },
      },
      []
    )
    assert.equal((await readCart(jid)).version, initial.version)
    const contacts = await (new DashboardController() as any).contacts()
    assert.equal(contacts.find((c: any) => c.jid === jid)?.handling_mode, 'cs')
    assert.isTrue(contacts.find((c: any) => c.jid === jid)?.schedule_paused)
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'ai')
    await saveSettings({ aiWorkMode: 'always' })
    assert.isTrue(await w.canSendAiReply(jid, w.socket))
    const cs = await room('cs'),
      excluded = await room('ai', true)
    assert.isFalse(await w.canSendAiReply(cs.jid, w.socket))
    assert.isFalse(await w.canSendAiReply(excluded.jid, w.socket))
  })
  test('opening/resuming queues only unanswered eligible rooms; repeated ticks do not requeue', async ({
    assert,
  }) => {
    await db.from('whatsapp_ai_reviews').delete()
    const incoming = await room(),
      cs = await room('cs'),
      excluded = await room('ai', true),
      answered = await room('ai', false, 'out')
    await requestRecentAiReviews('schedule_open', 48)
    const requests = await db.from('whatsapp_ai_reviews').select('jid')
    assert.include(
      requests.map((r) => r.jid),
      incoming.jid
    )
    for (const r of [cs, excluded, answered])
      assert.notInclude(
        requests.map((r) => r.jid),
        r.jid
      )
    await db.from('whatsapp_ai_reviews').delete()
    const w = worker()
    let reviews = 0
    w.reviewChat = async () => {
      reviews++
    }
    await saveSettings({ aiWorkMode: 'scheduled', aiWorkDays: '' })
    await w.consumeAiReviews()
    assert.equal(reviews, 0)
    await saveSettings({ aiWorkMode: 'always' })
    await w.consumeAiReviews()
    assert.equal(reviews, 1)
    // No new incoming message. Removing fixture queue makes an erroneous rescan observable.
    await db.from('whatsapp_ai_reviews').delete()
    await w.consumeAiReviews()
    assert.equal(reviews, 1)
  })
  test('outside hours pauses automatic notices and AI outbox, but allows manual CS sends', async ({ assert }) => {
    await saveSettings({ aiWorkMode: 'scheduled', aiWorkDays: '' })
    const { jid } = await room('cs')
    const ids = [randomUUID(), randomUUID()]
    await db.table('whatsapp_messages').insert(ids.map((messageId, index) => ({
      jid, message_id: messageId, direction: 'out', sender_type: index ? 'cs' : 'ai',
      body: index ? 'Human reply' : 'AI reply', status: 'queued', created_at: new Date(),
    })))
    const w = worker(), sent: string[] = []
    w.socket = { sendMessage: async (_jid: string, payload: any) => { sent.push(payload.text); return { key: { id: randomUUID() } } } }
    await w.sendPaymentWaitNotice()
    assert.lengthOf(sent, 0)
    await w.flushOutbox()
    assert.deepEqual(sent, ['Human reply'])
    assert.equal((await db.from('whatsapp_messages').where('message_id', ids[0]).first()).status, 'queued')
  })
  test('restart inside scheduled hours recovers unanswered chats without requiring sweep', async ({ assert }) => {
    await db.from('whatsapp_ai_reviews').delete()
    const now = new Date(), utcHour = String(now.getUTCHours()).padStart(2, '0')
    // Pick a two-hour interval containing now, including midnight wrapping.
    const end = String((now.getUTCHours() + 2) % 24).padStart(2, '0')
    await saveSettings({ aiWorkMode: 'scheduled', aiWorkDays: '1,2,3,4,5,6,7', aiWorkTimezone: 'UTC', aiWorkStart: `${utcHour}:00`, aiWorkEnd: `${end}:00`, sweepEnabled: false })
    const r = await room()
    const w = worker(), reviewed: string[] = []
    w.reviewChat = async (request: { jid: string }) => { reviewed.push(request.jid) }
    await w.consumeAiReviews()
    const queued = await db.from('whatsapp_ai_reviews').where('jid', r.jid).first()
    assert.isTrue(reviewed.includes(r.jid) || queued?.status === 'pending')
  })
})
