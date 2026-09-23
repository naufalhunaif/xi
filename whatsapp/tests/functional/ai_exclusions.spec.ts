import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { setAiExcluded } from '#services/ai_exclusion_service'
import {
  queueOutgoingMessage,
  resumeAiAfterHumanReply,
  setHandlingMode,
} from '#services/message_service'
import { requestAiReview, requestRecentAiReviews } from '#services/ai_review_service'
import { beginGoalTurn } from '#services/conversation_goal_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000339001@lid'
const session = {
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Test CS',
    username: 'test',
  },
}
test.group('Contacts excluded from AI replies', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    await db.table('whatsapp_messages').insert({
      message_id: randomUUID(),
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Pesan uji',
      status: 'received',
      created_at: new Date(),
    })
    return () => db.rollbackGlobalTransaction()
  })
  test('exclusion survives human replies, explicit activation and reconnect reviews; manual messages remain allowed', async ({
    assert,
  }) => {
    await requestAiReview(jid, 'enabled')
    await setAiExcluded(jid, true)
    await assert.rejects(() => setHandlingMode(jid, 'ai'), /Jangan dibalas AI/)
    await resumeAiAfterHumanReply(jid)
    await requestAiReview(jid, 'human_reply')
    await requestRecentAiReviews('reconnected', 48)
    const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
    assert.equal(Number(contact.ai_excluded), 1)
    assert.equal(contact.handling_mode, 'cs')
    assert.isNull(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
    await queueOutgoingMessage({ jid, body: 'Balasan manual tetap boleh' })
    const queued = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('status', 'queued')
      .first()
    assert.isOk(queued)
    await setAiExcluded(jid, false)
    const removed = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
    assert.equal(Number(removed.ai_excluded), 0)
    assert.equal(removed.handling_mode, 'cs')
    await setHandlingMode(jid, 'ai')
    assert.isOk(await db.from('whatsapp_ai_reviews').where('jid', jid).first())
  })
  test('delivery checks exclusion again if it is added while AI is preparing to send', async ({
    assert,
  }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const message = await db.from('whatsapp_messages').where('jid', jid).firstOrFail()
    const run = await beginGoalTurn(jid, message.message_id)
    const worker = Object.create(WhatsappListen.prototype) as any
    Object.assign(worker, {
      socketOpen: true,
      receivedPending: true,
      syncReadyAt: 0,
      ingesting: 0,
      ingestion: Promise.resolve(),
      stopping: false,
    })
    let sends = 0
    const socket = {
      readMessages: async () => {},
      sendPresenceUpdate: async (state: string) => {
        if (state === 'composing') await setAiExcluded(jid, true)
      },
      sendMessage: async () => {
        sends++
        return { key: { id: randomUUID() } }
      },
    }
    worker.socket = socket
    await worker.deliverAiDecision(
      run,
      socket,
      await readSettings(true),
      { decision: 'reply', message: 'Tidak boleh terkirim', reason: '', note: '' },
      []
    )
    assert.equal(sends, 0)
    assert.isFalse(await worker.canSendAiReply(jid, socket))
    // Even inconsistent mode data cannot bypass the durable exclusion flag.
    await db.from('whatsapp_contacts').where('jid', jid).update({ handling_mode: 'ai' })
    assert.isFalse(await worker.canSendAiReply(jid, socket))
  }).timeout(10_000)
  test('endpoint requires login/CSRF and validates known contact and boolean state', async ({
    client,
    assert,
  }) => {
    const anonymous = await client
      .post('/api/contacts/exclusion')
      .json({ jid, excluded: true })
      .redirects(0)
    assert.isAtLeast(anonymous.status(), 300)
    const csrf = await client
      .post('/api/contacts/exclusion')
      .withSession(session)
      .json({ jid, excluded: true })
      .redirects(0)
    assert.isAtLeast(csrf.status(), 300)
    for (const body of [
      { jid, excluded: 'false' },
      { jid: 'unknown@lid', excluded: true },
      { jid: 'group@g.us', excluded: true },
    ]) {
      const response = await client
        .post('/api/contacts/exclusion')
        .withSession(session)
        .withCsrfToken()
        .json(body)
      response.assertStatus(422)
    }
    const added = await client
      .post('/api/contacts/exclusion')
      .withSession(session)
      .withCsrfToken()
      .json({ jid, excluded: true })
    added.assertStatus(200)
    const list = await client.get('/api/ai/exclusions').withSession(session)
    list.assertStatus(200)
    assert.isTrue(list.body().contacts.find((contact: any) => contact.jid === jid).excluded)
    const contacts = await client.get('/api/contacts').withSession(session)
    assert.isTrue(contacts.body().contacts.find((contact: any) => contact.jid === jid).ai_excluded)
  })
})
