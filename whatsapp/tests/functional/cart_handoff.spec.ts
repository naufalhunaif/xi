import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { readCart } from '#services/cart_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import { readSettings } from '#services/settings_service'
import { startTrace, readTrace } from '#services/trace_service'
import { holdUnverifiedCartReply } from '#services/ai_cart_service'
import type { AiDecision } from '#services/ai_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000668899@lid'
const draft: AiDecision = {
  decision: 'reply',
  message: 'Harga yang belum sah',
  initiative: 'Bayar sekarang',
  images: [{ url: 'https://example.com/unverified.jpg', caption: '' }],
  reason: '',
  note: 'Pelanggan membutuhkan ukuran di luar katalog.',
}

test.group('Cart validation handoff', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  for (const scenario of ['size', 'price', 'stock', 'product', 'understanding']) {
    test(`${scenario}: unresolved catalog validation completes without sending unverified replies`, async ({
      assert,
    }) => {
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      const confirmation = randomUUID()
      await db.table('whatsapp_messages').insert({
        message_id: confirmation,
        jid,
        direction: 'in',
        sender_type: 'customer',
        body: 'Ukuran custom sesuai pembahasan',
        status: 'received',
        created_at: new Date(),
      })
      const run = (await beginGoalTurn(jid, confirmation))!
      const cart = await readCart(jid)
      const events: string[] = []
      const socket = {
        readMessages: async () => {
          events.push('read')
        },
        sendPresenceUpdate: async () => {
          events.push('presence')
        },
        sendMessage: async () => {
          events.push('send')
          throw new Error('Unexpected send')
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
        createReviewDecision: async () => {
          throw new Error('Fixture: provider unavailable; no real AI calls')
        },
      })
      const trace = await startTrace(jid, { text: 'Validasi cart fixture' })
      await worker.deliverAiDecision(
        run,
        socket,
        await readSettings(),
        {
          ...draft,
          cartVersion: cart.version,
          cartIntent: {
            action: 'sync',
            confirmationMessageId: confirmation,
            removeItemIds: [],
            items: [
              {
                id: '',
                productId: 'fixture',
                name: 'Jas fixture',
                image: '',
                size: 'XXL',
                quantity: 1,
                unitPrice: 705000,
                measurements: [],
                note: '',
              },
            ],
            recipient: { name: '', phone: '', address: '' },
            shipping: { service: '', cost: null },
            note: '',
          },
          cartEvidence: {
            products:
              scenario === 'product'
                ? []
                : [
                    {
                      id: 'fixture',
                      name: 'Jas fixture',
                      imageUrls: ['https://example.com/fixture.jpg'],
                      sizes: [
                        {
                          size_name:
                            scenario === 'size' || scenario === 'understanding' ? 'S' : 'XXL',
                          price: scenario === 'price' ? 800000 : 705000,
                          stock: scenario === 'stock' ? 0 : 5,
                        },
                      ],
                    },
                  ],
            shipping: [],
          },
        },
        [],
        false,
        trace,
        undefined,
        scenario === 'understanding'
      )
      const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(contact.handling_mode, 'ai')
      assert.include(contact.chat_note, 'CATALOG_')
      assert.isNull(contact.handoff_reason)
      assert.deepEqual(events, [])
      const saved = await readCart(jid)
      if (scenario === 'product') assert.deepEqual(saved, cart)
      else {
        assert.lengthOf(saved.items, 1)
        assert.isNull(saved.items[0].unitPrice)
        assert.equal(saved.items[0].catalogVerification, 'pending')
        assert.isFalse(saved.totalComplete)
      }
      assert.lengthOf(
        await db.from('whatsapp_messages').where('jid', jid).where('direction', 'out'),
        0
      )
      const goal = await readConversationGoal(jid)
      assert.isNull(goal.next_run_at)
      assert.isNull(goal.last_error)
      assert.equal(goal.status, 'waiting')
      const stored = await readTrace(jid, trace.id)
      assert.equal(stored?.status, 'completed')
      assert.equal(stored?.steps.find((step: any) => step.key === 'cart')?.status, 'completed')
    })
  }

  test('unverified custom price hands off normally but cannot re-handoff while understanding CS', ({
    assert,
  }) => {
    const held = holdUnverifiedCartReply(draft)
    assert.equal(held.decision, 'handoff')
    assert.equal(held.message, '')
    assert.equal(held.initiative, '')
    assert.deepEqual(held.images, [])
    assert.isNull(held.cartIntent)
    const understood = holdUnverifiedCartReply(draft, 'Harga perlu diperiksa', true)
    assert.equal(understood.decision, 'silent')
    assert.equal(understood.handoff_category, 'none')
    assert.isNull(understood.goal?.follow_up)
  })
})
