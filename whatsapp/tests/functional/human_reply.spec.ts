/* eslint-disable @unicorn/no-await-expression-member -- Local snapshots for assertions. */
import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { queueOutgoingMessage, setHandlingMode } from '#services/message_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000993456@lid'

function workerWith(sendMessage: (...args: any[]) => Promise<any>) {
  const worker = Object.create(WhatsappListen.prototype) as any
  worker.socket = { sendMessage }
  worker.pendingTurns = new Map()
  return worker
}

test.group('Human replies return the room to AI', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('returns to AI only after the final queued CS bubble succeeds; preserves global OFF', async ({
    assert,
  }) => {
    // Never exercise any real queued customer message, even with a mocked transport.
    assert.isNull(await db.from('whatsapp_messages').where('status', 'queued').first())
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    await queueOutgoingMessage({ jid, body: 'Balasan CS satu' })
    await queueOutgoingMessage({ jid, body: 'Balasan CS dua' })
    let sends = 0
    const worker = workerWith(async (target) => {
      assert.equal(target, jid)
      assert.equal(
        (await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode,
        'cs'
      )
      sends++
      return { key: { id: randomUUID() } }
    })
    await worker.flushOutbox()
    assert.equal(sends, 2)
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    assert.equal(contact.handling_mode, 'ai')
    assert.isNull(contact.handoff_reason)
    assert.isNull(contact.handoff_at)
    assert.equal((await db.from('whatsapp_settings').where('id', 1).first()).ai_enabled, 0)
    const messages = await db.from('whatsapp_messages').where('jid', jid)
    assert.isTrue(messages.every((row) => row.status === 'sent' && row.sender_type === 'cs'))
  })

  for (const failure of ['throw', 'unconfirmed']) {
    test(`${failure} delivery keeps the room in CS`, async ({ assert }) => {
      assert.isNull(await db.from('whatsapp_messages').where('status', 'queued').first())
      await queueOutgoingMessage({ jid, body: 'Balasan CS' })
      const worker = workerWith(async (target) => {
        assert.equal(target, jid)
        if (failure === 'throw') throw new Error('Simulated transport failure')
        return undefined
      })
      await worker.flushOutbox()
      assert.equal(
        (await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode,
        'cs'
      )
      assert.equal((await db.from('whatsapp_messages').where('jid', jid).first()).status, 'failed')
    })
  }

  test('a phone reply resumes AI without generating an extra response, and duplicates are ignored', async ({
    assert,
  }) => {
    await setHandlingMode(jid, 'cs', 'Butuh jawaban manusia')
    const worker = workerWith(async () => {
      assert.fail('Recording a human reply must not send anything')
    })
    const id = randomUUID()
    const message = {
      key: { id, remoteJid: jid, fromMe: true },
      message: { conversation: 'Sudah kami cek.' },
    }
    await worker.onMessage(message)
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'ai')
    // An old echo cannot undo a subsequent deliberate handoff.
    await setHandlingMode(jid, 'cs')
    await worker.onMessage(message)
    assert.equal((await db.from('whatsapp_contacts').where('jid', jid).first()).handling_mode, 'cs')
    const messages = await db.from('whatsapp_messages').where('jid', jid)
    assert.lengthOf(messages, 1)
    assert.equal(messages[0].sender_type, 'owner')
  })
})
