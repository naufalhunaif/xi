import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import { applyAiCartIntent, resolveCartIssues, CartReferenceError } from '#services/ai_cart_service'
import { readCart, approveCustom, saveCart, listOrders } from '#services/cart_service'
import { cartSize, type CartIntent } from '#services/cart_contract'
import { beginGoalTurn, alreadyAnalyzedMessage } from '#services/conversation_goal_service'
import { readSettings } from '#services/settings_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000990117@lid'
const products = [
  {
    id: 'suit-black',
    name: 'Casual Suit - Black',
    imageUrls: ['https://example.com/suit.jpg'],
    sizes: [{ size_name: 'XL', price: 400000, stock: 5 }],
  },
  {
    id: 'pants-black',
    name: 'Pants - Black 2.0',
    imageUrls: ['https://example.com/pants.jpg'],
    sizes: [
      { size_name: '37', price: 220000, stock: 5 },
      { size_name: '38', price: 220000, stock: 0 },
    ],
  },
]
async function incoming() {
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: messageId,
    jid,
    direction: 'in',
    sender_type: 'customer',
    body: 'Black aja biar serasi',
    status: 'received',
    created_at: new Date(),
  })
  return messageId
}
function intent(confirmationMessageId: string): CartIntent {
  return {
    action: 'sync',
    confirmationMessageId,
    removeItemIds: [],
    items: products.map((product, index) => ({
      id: '',
      productId: product.id,
      name: product.name,
      image: '',
      size: index ? 'custom 38' : 'XL',
      quantity: 1,
      unitPrice: index ? null : 400000,
      modelType: 'catalog',
      measurements: [],
      note: '',
    })),
    recipient: { name: '', phone: '', address: '' },
    shipping: { service: '', cost: null },
    note: '',
  }
}
test.group('Catalog garment with custom size', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  for (const scenario of [
    'missing_id',
    'not_in_room',
    'not_visual',
    'not_loaded',
    'valid',
    'other_room',
    'outgoing',
  ])
    test(`custom reference validation: ${scenario}`, async ({ assert }) => {
      const confirmation = await incoming()
      const reference = await incoming()
      await db
        .from('whatsapp_messages')
        .where('message_id', reference)
        .update({
          media_type: scenario === 'not_visual' ? null : 'image',
          media_url: scenario === 'not_loaded' ? null : '/media/fixture.jpg',
          ...(scenario === 'other_room' ? { jid: 'different-room@lid' } : {}),
          ...(scenario === 'outgoing' ? { direction: 'out', sender_type: 'cs' } : {}),
        })
      const draft = intent(confirmation)
      draft.items = [
        {
          ...draft.items[0],
          modelType: 'custom',
          unitPrice: null,
          referenceMessageId:
            scenario === 'missing_id' ? '' : scenario === 'not_in_room' ? 'invented' : reference,
        },
      ]
      const before = await readCart(jid)
      if (scenario === 'valid') {
        const cart = await applyAiCartIntent(jid, before.version, draft, {
          products: [],
          shipping: [],
        })
        assert.equal(cart.items[0].referenceMessageId, reference)
        assert.equal(cart.items[0].image, '/media/fixture.jpg')
        assert.equal(cart.items[0].productId, `custom:${reference}`)
        assert.isNull(cart.items[0].unitPrice)
      } else {
        let caught: unknown
        try {
          await applyAiCartIntent(jid, before.version, draft, { products: [], shipping: [] })
        } catch (error) {
          caught = error
        }
        assert.instanceOf(caught, CartReferenceError)
        assert.equal(
          (caught as CartReferenceError).referenceIssue,
          ['other_room', 'outgoing'].includes(scenario) ? 'not_in_room' : scenario
        )
        const after = await readCart(jid)
        assert.equal(after.version, before.version)
      }
      assert.lengthOf(await listOrders(jid), 0)
    })

  test('invalid custom reference finishes a held decision without repeated waiting analysis', async ({
    assert,
  }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const messageId = await incoming()
    const run = await beginGoalTurn(jid, messageId)
    const cart = await readCart(jid)
    const draft = intent(messageId)
    draft.items = [
      { ...draft.items[0], modelType: 'custom', referenceMessageId: 'invented', unitPrice: null },
    ]
    const sent: unknown[] = []
    const socket = {
      readMessages: async () => {},
      sendPresenceUpdate: async () => {},
      sendMessage: async (...args: unknown[]) => {
        sent.push(args)
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
      workScheduleOpen: new Map(),
    })
    const events: any[] = []
    await worker.deliverAiDecision(
      run,
      socket,
      await readSettings(),
      {
        decision: 'reply',
        message: 'Pesanan sudah masuk',
        initiative: 'Silakan bayar',
        reason: '',
        note: '',
        cartVersion: cart.version,
        cartIntent: draft,
        cartEvidence: { products: [], shipping: [] },
      },
      [],
      false,
      { emit: (event: unknown) => events.push(event), finish: async () => {} }
    )
    assert.deepEqual(sent, [])
    const after = await readCart(jid)
    assert.equal(after.version, cart.version)
    assert.isTrue(await alreadyAnalyzedMessage(jid, messageId))
    const goal = await db.from('whatsapp_chat_goals').where('jid', jid).firstOrFail()
    assert.equal(goal.status, 'paused') // Human handoff pauses automation but records the analyzed anchor.
    assert.isNull(goal.next_run_at)
    assert.isNull(goal.last_error)
    assert.isNull(await beginGoalTurn(jid, messageId))
    const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
    assert.equal(contact.handling_mode, 'cs')
    assert.include(contact.handoff_reason, 'foto referensi')
    assert.equal(
      events.findLast((event) => event.key === 'cart')?.detail?.code,
      'CART_REFERENCE_UNAVAILABLE'
    )
  })

  for (const askWaist of [false, true])
    test(`worker saves custom Black 38 before ${askWaist ? 'asking waist in cm' : 'silent CS handoff'}`, async ({
      assert,
    }) => {
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      const messageId = await incoming()
      const run = await beginGoalTurn(jid, messageId)
      const previous = await readCart(jid)
      const writes: string[] = []
      const socket = {
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
        sendMessage: async (_jid: string, payload: { text: string }) => {
          writes.push(payload.text)
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
      await worker.deliverAiDecision(
        run,
        socket,
        await readSettings(),
        {
          decision: 'reply',
          message: askWaist ? 'Boleh info lingkar pinggangnya berapa cm, bos?' : 'Rp220.000',
          initiative: 'Bayar sekarang',
          reason: '',
          note: 'Pelanggan memilih celana Black custom nomor 38.',
          goal: {
            objective: 'Melengkapi pesanan',
            status: 'waiting_answer',
            waiting_for: 'Lingkar pinggang dalam cm',
            next_action: 'Verifikasi ukuran dan harga custom setelah ukuran jelas',
            follow_up: null,
          },
          cartVersion: previous.version,
          cartIntent: intent(messageId),
          cartEvidence: { products, shipping: [] },
        },
        []
      )
      const cart = await readCart(jid)
      assert.lengthOf(cart.items, 2)
      assert.equal(cart.items[0].unitPrice, 400000)
      const pants = cart.items[1]
      assert.equal(pants.name, 'Pants - Black 2.0')
      assert.equal(pants.modelType, 'catalog')
      assert.equal(pants.image, products[1].imageUrls[0])
      assert.equal(pants.size, 'custom')
      assert.equal(pants.requestedSize, '38')
      assert.equal(pants.quantity, 1)
      assert.isNull(pants.unitPrice)
      assert.deepEqual(pants.measurements, {})
      assert.equal(pants.approval, 'pending')
      assert.equal(pants.modelApproval, 'standard')
      assert.isFalse(cart.totalComplete)
      assert.lengthOf(await listOrders(jid), 0)
      assert.deepEqual(writes, askWaist ? ['Boleh info lingkar pinggangnya berapa cm, bos?'] : [])
      const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(contact.handling_mode, askWaist ? 'ai' : 'cs')
      if (!askWaist) assert.include(contact.handoff_reason, 'harga custom perlu verifikasi CS')
      await assert.rejects(
        () => approveCustom(jid, cart.version, pants.id, true, '', 'test'),
        /dalam cm/
      )
    }).timeout(10_000)

  test('measurement questions never repeat a recorded waist, publish prices, or re-handoff during CS review', async ({
    assert,
  }) => {
    const draft = intent(await incoming())
    const initial = await readCart(jid)
    const cart = await applyAiCartIntent(jid, initial.version, draft, { products, shipping: [] })
    const decision = {
      decision: 'reply' as const,
      message: 'Lingkar pinggangnya berapa cm, bos?',
      initiative: 'Bayar sekarang',
      reason: '',
      note: '',
      goal: {
        objective: 'Lengkapi ukuran',
        status: 'waiting_answer' as const,
        waiting_for: 'Lingkar pinggang',
        next_action: 'Tunggu ukuran',
        follow_up: null,
      },
    }
    assert.equal(resolveCartIssues(decision, cart).decision, 'reply')
    assert.equal(
      resolveCartIssues(
        { ...decision, message: 'Harga Rp220.000. Lingkar pinggang berapa cm?' },
        cart
      ).decision,
      'handoff'
    )
    assert.equal(resolveCartIssues(decision, cart, true).decision, 'silent')
    cart.items[1].measurements = { 'Lingkar pinggang': 96 }
    assert.equal(resolveCartIssues(decision, cart).decision, 'handoff')
  })

  test('a new jacket custom draft can ask about sleeves before a verified price exists', async ({ assert }) => {
    const draft = intent(await incoming())
    draft.items[0].size = 'custom'
    draft.items[0].unitPrice = null
    const empty = await readCart(jid)
    const cart = await applyAiCartIntent(jid, empty.version, draft, { products, shipping: [] })
    const question = 'Dawané lengen jas pinten sentimeter, Mas?'
    const reply: any = {
      decision: 'reply', message: '', initiative: question, note: '', reason: '',
      customSizeQuestion: { itemId: '', productId: 'suit-black', measurementName: 'Panjang lengan',
        basis: 'garment', kind: 'missing_value', question },
      goal: { status: 'waiting_answer', waiting_for: 'Panjang lengan jas', follow_up: null },
    }
    assert.isTrue(cart.onlyPendingCustomPrices)
    assert.equal(cart.items[0].approval, 'pending')
    assert.isNull(cart.items[0].unitPrice)
    const resolved = resolveCartIssues(reply, cart)
    assert.equal(resolved.decision, 'reply')
    assert.equal(resolved.message, question)
    assert.equal(resolved.initiative, '')
    assert.isNull(resolved.cartIntent)
    const reread = await readCart(jid)
    assert.equal(reread.version, cart.version)
    assert.isNull(reread.items[0].unitPrice)
  })

  test('ready-stock prices are not custom quotes; only human evidence sets the custom price', async ({
    assert,
  }) => {
    const messageId = await incoming()
    const draft = intent(messageId)
    draft.items[1].unitPrice = 220000
    let cart = await readCart(jid)
    cart = await applyAiCartIntent(jid, cart.version, draft, { products, shipping: [] })
    assert.isNull(cart.items[1].unitPrice)
    const quoted = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: quoted,
      jid,
      direction: 'out',
      sender_type: 'cs',
      body: 'Celana Black custom nomor 38 harganya Rp250.000',
      status: 'sent',
      created_at: new Date(),
    })
    const changed = intent(messageId)
    changed.items.forEach((item, index) => {
      item.id = cart.items[index].id
    })
    changed.items[1].unitPrice = 250000
    changed.items[1].priceMessageId = quoted
    cart = await applyAiCartIntent(jid, cart.version, changed, { products, shipping: [] })
    assert.equal(cart.items[1].unitPrice, 250000)
    assert.equal(cart.items[1].priceMessageId, quoted)
    assert.equal(cart.items[1].approval, 'pending')
    assert.isFalse(cart.totalComplete)
    // Changing the clothing number invalidates the prior size approval.
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: cart.items.map((item, i) =>
        i ? { ...item, measurements: { 'Lingkar pinggang': 96 } } : item
      ),
    })
    cart = await approveCustom(jid, cart.version, cart.items[1].id, true, '', 'test')
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: cart.items.map((item, i) => (i ? { ...item, requestedSize: '40' } : item)),
    })
    assert.equal(cart.items[1].approval, 'pending')
  })

  test('standard unavailable stock remains a non-payable draft and custom labels never become cm measurements', async ({
    assert,
  }) => {
    assert.deepEqual(cartSize('Custom no. 38'), { size: 'custom', requestedSize: '38' })
    assert.throws(() => cartSize('custom 38', '40'), /tidak konsisten/)
    const draft = intent(await incoming())
    draft.items[1].size = '38'
    draft.items[1].unitPrice = 220000
    const cart = await readCart(jid)
    await applyAiCartIntent(jid, cart.version, draft, { products, shipping: [] })
    const after = await readCart(jid)
    assert.lengthOf(after.items, 2)
    assert.equal(after.items[1].catalogVerification, 'pending')
    assert.isNull(after.items[1].unitPrice)
    assert.isFalse(after.totalComplete)
  })
})
