/* eslint-disable @unicorn/no-await-expression-member -- Local DB snapshots for assertions. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import { saveSettings } from '#services/settings_service'
import { setHandlingMode } from '#services/message_service'
import {
  requestAiReview,
  requestRecentAiReviews,
  finishAiReview,
} from '#services/ai_review_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import { readSettings } from '#services/settings_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000995555@lid'
const other = '10000000995556@lid'
const date = new Date(Date.now() - 10_000)
async function message(
  direction = 'in',
  body = 'Pertanyaan pelanggan',
  created = date,
  room = jid
) {
  const id = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: id,
    jid: room,
    direction,
    sender_type: direction === 'in' ? 'customer' : 'cs',
    body,
    status: direction === 'in' ? 'received' : 'sent',
    created_at: created,
  })
  return id
}
function makeWorker(assert: any) {
  const worker = Object.create(WhatsappListen.prototype) as any
  Object.defineProperty(worker, 'logger', { value: { error: () => {} } })
  Object.assign(worker, {
    socketOpen: true,
    receivedPending: true,
    syncReadyAt: 0,
    ingesting: 0,
    ingestion: Promise.resolve(),
    pendingTurns: new Map(),
    chatLocks: new Map(),
    workScheduleOpen: new Map(),
    stopping: false,
    reviewing: false,
    socket: { sendMessage: async () => assert.fail('No real or redundant message may be sent') },
  })
  worker.rememberContact = async () => {}
  return worker
}
async function priorityRequest() {
  await requestAiReview(jid, 'enabled')
  // Our fixture is processed first; unrelated requests remain untouched.
  await db
    .from('whatsapp_ai_reviews')
    .where('jid', jid)
    .update({ requested_at: new Date(1000) })
}

test.group('AI activation and reconnect recovery', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('reviewed customer photo keeps its message ID for custom-cart evidence', async ({ assert }) => {
    const id = await message('in', 'Model ini bisa custom?')
    await db.from('whatsapp_messages').where('message_id', id).update({ media_type: 'image', media_url: '/media/fixture.jpg' })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const worker = makeWorker(assert)
    worker.imagePathOfMessage = async () => '/fixture/reference.jpg'
    let calls = 0
    worker.createReviewDecision = async (...args: any[]) => {
      calls++
      assert.equal(args[5][0].messageId, id)
      return { decision: 'silent', message: '', reason: 'Fixture', note: '' }
    }
    await worker.reviewChat({ jid, reason: 'enabled' }, await readSettings(true))
    assert.equal(calls, 1)
  })

  test('activating a room creates one immediate review and a newer activation survives old completion', async ({
    assert,
  }) => {
    await setHandlingMode(jid, 'ai')
    const first = await db.from('whatsapp_ai_reviews').where('jid', jid).firstOrFail()
    assert.equal(first.status, 'pending')
    await setHandlingMode(jid, 'ai')
    await finishAiReview(jid, first.version)
    const rows = await db.from('whatsapp_ai_reviews').where('jid', jid)
    assert.lengthOf(rows, 1)
    assert.notEqual(rows[0].version, first.version)
  })

  test('global OFF to ON queues recent AI rooms, not rooms deliberately assigned to CS', async ({
    assert,
  }) => {
    await message()
    await message('in', 'CS room', date, other)
    await setHandlingMode(other, 'cs')
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    await saveSettings({ aiEnabled: true })
    assert.isNotNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', other).first())
  })

  test('reconnect sweep does not revisit a room whose latest message is already from CS', async ({
    assert,
  }) => {
    await message()
    await message('out', 'Jawaban CS', new Date(date.getTime() + 1000))
    await message('in', 'Belum dijawab', date, other)
    await requestRecentAiReviews('reconnected', 48)
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    assert.isNotNull(await db.from('whatsapp_ai_reviews').where('jid', other).first())
  })

  test('review after CS uses complete context and can choose silent, without a duplicate reply', async ({
    assert,
  }) => {
    await message()
    await message('out', 'Jawaban CS sudah lengkap', new Date(date.getTime() + 1000))
    await setHandlingMode(jid, 'ai')
    await priorityRequest()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const worker = makeWorker(assert)
    let calls = 0
    worker.createReviewDecision = async (
      _settings: any,
      trigger: string,
      _activity: any,
      _media: any,
      context: string
    ) => {
      calls++
      assert.include(trigger, 'BUKAN pesan pelanggan baru')
      assert.include(context, 'Pertanyaan pelanggan')
      assert.include(context, 'Jawaban CS sudah lengkap')
      return { decision: 'silent', message: '', reason: 'Sudah ditangani', note: 'Tuntas' }
    }
    await worker.consumeAiReviews()
    assert.equal(calls, 1)
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
  })

  test('global OFF and unfinished reconnect sync keep activation pending', async ({ assert }) => {
    await message()
    await priorityRequest()
    const worker = makeWorker(assert)
    worker.createReviewDecision = async () => assert.fail('AI must wait')
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    await worker.consumeAiReviews()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    worker.receivedPending = false
    await worker.consumeAiReviews()
    worker.receivedPending = true
    worker.ingesting = 1
    await worker.consumeAiReviews()
    assert.equal((await db.from('whatsapp_ai_reviews').where('jid', jid).first()).status, 'pending')
  })

  for (const output of ['handoff', 'reply'] as const) {
    test(`human answer review blocks a model's ${output}, preserves its notes and waits without another CS handoff`, async ({
      assert,
    }) => {
      await message()
      await message(
        'out',
        'Ukuran sudah dijawab, alamat lengkapnya mana?',
        new Date(date.getTime() + 1000)
      )
      await setHandlingMode(jid, 'ai')
      await priorityRequest()
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      const worker = makeWorker(assert)
      worker.createReviewDecision = async () => ({
        decision: output,
        message: 'Jawaban duplikat',
        initiative: 'Pertanyaan duplikat',
        reason: 'Masih perlu CS',
        note: 'CS sudah menjawab ukuran. Menunggu alamat.',
        goal: {
          objective: 'Lengkapi alamat',
          status: 'waiting_answer',
          waiting_for: 'Alamat pelanggan',
          next_action: 'Tunggu alamat',
          follow_up: null,
        },
      })
      await worker.consumeAiReviews()
      const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
      assert.equal(contact.handling_mode, 'ai')
      assert.include(contact.chat_note, 'Menunggu alamat')
      const goal = await readConversationGoal(jid)
      assert.equal(goal.status, 'waiting_answer')
      assert.isNull(goal.next_run_at)
      assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
      // Reactivation/restart must not reopen the same handoff either.
      await priorityRequest()
      await worker.consumeAiReviews()
      assert.equal(
        (await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode,
        'ai'
      )
    })
  }

  test('new customer input ends understanding-only mode and may request a genuine new human decision', async ({
    assert,
  }) => {
    await message('out', 'Jawaban CS', date)
    await message('in', 'Saya butuh keputusan baru yang berbeda', new Date(date.getTime() + 1000))
    await setHandlingMode(jid, 'ai')
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const worker = makeWorker(assert)
    worker.createReviewDecision = async (_settings: any, trigger: string) => {
      assert.notInclude(trigger, 'MODE MEMAHAMI JAWABAN CS')
      return {
        decision: 'handoff',
        message: '',
        reason: 'Keputusan baru membutuhkan manusia',
        note: '',
      }
    }
    await worker.reviewChat({ jid, reason: 'human_reply' }, await readSettings(true))
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'cs')
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
  })

  for (const answered of [false, true]) {
    test(`reactivation forwards only the unanswered current size question (answered=${answered})`, async ({
      assert,
    }) => {
      const question = 'Gan kalo tinggi 168 berat 84 bagusnya celana pake no berapa ya'
      await message('in', question, date)
      if (answered)
        await db.table('whatsapp_messages').insert({
          message_id: randomUUID(),
          jid,
          direction: 'out',
          sender_type: 'ai',
          body: 'Estimasi regular 38.',
          status: 'sent',
          created_at: new Date(date.getTime() + 1000),
        })
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      const worker = makeWorker(assert)
      let seen: string | undefined
      worker.createReviewDecision = async (...args: any[]) => {
        seen = args[7]
        return { decision: 'silent', message: '', reason: 'Isolated routing check', note: '' }
      }
      await worker.reviewChat({ jid, reason: 'enabled' }, await readSettings(true))
      assert.equal(seen, answered ? '' : question)
    })
  }

  test('history is deduplicated and dated correctly; old own messages cannot override CS mode', async ({
    assert,
  }) => {
    const latest = await message('in', 'Terbaru', date)
    await setHandlingMode(jid, 'cs')
    const worker = makeWorker(assert)
    const old = {
      key: { id: randomUUID(), remoteJid: jid, fromMe: true },
      messageTimestamp: Math.floor((date.getTime() - 60_000) / 1000),
      message: { conversation: 'Balasan lama' },
    }
    await worker.ingestMessages([old, old], true)
    const rows = await db.from('whatsapp_messages').where('jid', jid).orderBy('created_at')
    assert.lengthOf(rows, 2)
    assert.equal(rows[0].message_id, old.key.id)
    assert.equal(rows[1].message_id, latest)
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'cs')
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    assert.isNotNull(await beginGoalTurn(jid, latest))
  })

  test('missed incoming and phone replies are stored before one review is queued', async ({
    assert,
  }) => {
    await setHandlingMode(jid, 'cs')
    const worker = makeWorker(assert)
    const base = Math.floor(Date.now() / 1000) - 5
    const incoming = {
      key: { id: randomUUID(), remoteJid: jid, fromMe: false },
      messageTimestamp: base,
      message: { conversation: 'Pesan offline' },
    }
    const outgoing = {
      key: { id: randomUUID(), remoteJid: jid, fromMe: true },
      messageTimestamp: base + 1,
      message: { conversation: 'Dijawab dari HP' },
    }
    await worker.ingestMessages([outgoing, incoming], true)
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'ai')
    const requests = await db.from('whatsapp_ai_reviews').where('jid', jid)
    assert.lengthOf(requests, 1)
    assert.equal(requests[0].reason, 'human_reply')
    assert.isFalse(worker.readyForAi())
  })

  test('read, delivery and media updates preserve the original message time', async ({
    assert,
  }) => {
    const id = await message('in', 'Waktu tetap', new Date('2026-01-02T03:04:05Z'))
    const before = await db.from('whatsapp_messages').where('message_id', id).firstOrFail()
    await db
      .from('whatsapp_messages')
      .where('message_id', id)
      .update({ status: 'read', media_status: 'ready' })
    const after = await db.from('whatsapp_messages').where('message_id', id).firstOrFail()
    assert.equal(new Date(after.created_at).getTime(), new Date(before.created_at).getTime())
  })

  test('one failed message does not drop the remaining batch; durable retry deduplicates on recovery', async ({
    assert,
  }) => {
    const worker = makeWorker(assert)
    const first = {
      key: { id: randomUUID(), remoteJid: jid },
      message: { conversation: 'Pertama' },
      messageTimestamp: Math.floor(Date.now() / 1000) - 10,
    }
    const second = {
      key: { id: randomUUID(), remoteJid: jid },
      message: { conversation: 'Kedua' },
      messageTimestamp: Math.floor(Date.now() / 1000) - 5,
    }
    const store = worker.storeSyncedMessage.bind(worker)
    let failed = false
    worker.storeSyncedMessage = async (item: any) => {
      if (item.key.id === first.key.id && !failed) {
        failed = true
        throw new Error('Transient storage failure')
      }
      return store(item)
    }
    await worker.ingestMessages([first, second], true)
    assert.isNotNull(await db.from('whatsapp_messages').where('message_id', second.key.id).first())
    assert.isNotNull(
      await db.from('whatsapp_sync_retries').where('message_id', first.key.id).first()
    )
    // Simulate worker restart: retry comes from DB, not an in-memory callback.
    const restarted = makeWorker(assert)
    await db
      .from('whatsapp_sync_retries')
      .where('message_id', first.key.id)
      .update({ next_attempt_at: new Date(1000) })
    await restarted.retrySyncMessages()
    await restarted.retrySyncMessages()
    await restarted.ingestMessages([first, second], true)
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
    assert.isNull(await db.from('whatsapp_sync_retries').where('message_id', first.key.id).first())
    const ordered = await db.from('whatsapp_messages').where('jid', jid).orderBy('created_at')
    assert.deepEqual(
      ordered.map((row) => row.message_id),
      [first.key.id, second.key.id]
    )
  })

  test('history media/profile downloads do not hold the following text message', async ({
    assert,
  }) => {
    const worker = makeWorker(assert)
    let release!: (value: null) => void
    const background = new Promise<null>((resolve) => {
      release = resolve
    })
    worker.rememberContact = () => background
    worker.prepareMedia = async (item: any) =>
      item.message.imageMessage
        ? {
            visual: true,
            mediaType: 'image',
            extension: 'jpg',
            thumbnailUrl: '/thumbnail.jpg',
            mediaMime: 'image/jpeg',
          }
        : null
    worker.downloadMedia = () => background
    const media = {
      key: { id: randomUUID(), remoteJid: jid },
      message: { imageMessage: { caption: 'Foto' } },
      messageTimestamp: Math.floor(Date.now() / 1000) - 5,
    }
    const text = {
      key: { id: randomUUID(), remoteJid: jid },
      message: { conversation: 'Lanjut' },
      messageTimestamp: Math.floor(Date.now() / 1000),
    }
    try {
      await worker.ingestMessages([media, text], true)
      assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 2)
      assert.equal(worker.ingesting, 0)
      assert.equal(
        (await db.from('whatsapp_messages').where('message_id', media.key.id).first()).media_status,
        'downloading'
      )
    } finally {
      release(null)
      await background
      await worker.ingestion
      // Let the deferred media callback finish its read-only stale-room check.
      await new Promise((resolve) => setTimeout(resolve, 30))
    }
  })

  test('permanent ingestion failures stop after five attempts and retain their retry record', async ({
    assert,
  }) => {
    const worker = makeWorker(assert)
    let attempts = 0
    worker.storeSyncedMessage = async () => {
      attempts++
      throw new Error('Invalid payload')
    }
    const item = {
      key: { id: randomUUID(), remoteJid: jid },
      message: { conversation: 'Tertunda' },
    }
    await worker.ingestMessages([item], true)
    for (let count = 0; count < 6; count++) {
      await db
        .from('whatsapp_sync_retries')
        .where('message_id', item.key.id)
        .update({ next_attempt_at: new Date(1000) })
      await worker.retrySyncMessages()
    }
    assert.equal(attempts, 5)
    const retry = await db
      .from('whatsapp_sync_retries')
      .where('message_id', item.key.id)
      .firstOrFail()
    assert.equal(retry.status, 'failed')
    assert.include(retry.payload_json, 'Tertunda')
  })
})
