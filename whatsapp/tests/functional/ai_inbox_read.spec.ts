import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import WhatsappListen from '../../commands/whatsapp_listen.js'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { beginGoalTurn } from '#services/conversation_goal_service'
import { latestInboxMessages, markRoomRead } from '#services/contact_inbox_service'

const jid = '10000000443329@lid'
async function incoming(body: string) {
  const id = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: id,
    jid,
    direction: 'in',
    sender_type: 'customer',
    body,
    status: 'received',
    created_at: new Date(),
  })
  return db.from('whatsapp_messages').where('message_id', id).firstOrFail()
}
async function unread() {
  const inbox = await latestInboxMessages()
  return inbox.find((row) => row.jid === jid)!.unread_count
}
test.group('AI reply marks its workspace snapshot read', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    return () => db.rollbackGlobalTransaction()
  })
  for (const scenario of ['success', 'new-incoming', 'failed', 'manual-read'] as const) {
    test(scenario, async ({ assert }) => {
      await incoming('Pertanyaan pertama')
      const anchor = await incoming('Pertanyaan kedua')
      const run = await beginGoalTurn(jid, anchor.message_id)
      assert.isNotNull(run)
      const worker = Object.create(WhatsappListen.prototype) as any
      Object.assign(worker, {
        socketOpen: true,
        receivedPending: true,
        syncReadyAt: 0,
        ingesting: 0,
        ingestion: Promise.resolve(),
        stopping: false,
      })
      let sent = 0
      let readReceipts = 0
      let newMessage: any = null
      const socket = {
        readMessages: async () => {
          readReceipts++
        },
        sendPresenceUpdate: async () => {},
        sendMessage: async () => {
          if (scenario === 'failed') throw new Error('Transport uji gagal')
          if (scenario === 'new-incoming' || scenario === 'manual-read') {
            newMessage = await incoming('Pesan baru saat jawaban dikirim')
            if (scenario === 'manual-read') await markRoomRead(jid, Number(newMessage.id))
          }
          sent++
          return { key: { id: randomUUID() } }
        },
      }
      worker.socket = socket
      const settings = await readSettings(true)
      const deliver = () =>
        worker.deliverAiDecision(
          run,
          socket,
          settings,
          { decision: 'reply', message: 'Balasan uji', reason: '', note: '' },
          [{ id: anchor.message_id, remoteJid: jid, fromMe: false }]
        )
      if (scenario === 'failed') {
        await assert.rejects(deliver, /Transport uji gagal/)
        assert.equal(await unread(), 2)
        assert.equal(sent, 0)
      } else {
        await deliver()
        assert.equal(sent, 1)
        assert.equal(await unread(), scenario === 'new-incoming' ? 1 : 0)
        const profile = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
        assert.equal(
          Number(profile.workspace_read_id),
          Number(scenario === 'manual-read' ? newMessage.id : anchor.id)
        )
      }
      assert.equal(readReceipts, 1)
    }).timeout(10_000)
  }
})
