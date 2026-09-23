import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { applyAiCartIntent, safeCatalogQuestion, holdCatalogDraft } from '#services/ai_cart_service'
import {
  readCart,
  listOrders,
  checkoutFromBalance,
  tryConfirmedBalanceCheckout,
} from '#services/cart_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import { buildTurnContext } from '#services/context_service'
import { startTrace, readTrace } from '#services/trace_service'
import type { CartIntent } from '#services/cart_contract'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const question = 'Mau jas saja atau sekalian celana biar serasi, bos?'
const product = {
  id: 'signature-navy',
  name: 'Basic Suit - Signature Navy',
  imageUrls: ['https://example.com/navy.jpg'],
}
const evidence = (size: any) => ({
  products: [{ ...product, sizes: size ? [size] : [] }],
  shipping: [],
})
async function fixture() {
  const jid = `${randomUUID()}@lid`
  const confirmation = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: confirmation,
    jid,
    direction: 'in',
    sender_type: 'customer',
    body: 'Iya',
    status: 'received',
    created_at: new Date(),
  })
  const intent: CartIntent = {
    action: 'sync',
    confirmationMessageId: confirmation,
    removeItemIds: [],
    items: [
      {
        id: '',
        productId: product.id,
        name: product.name,
        image: '',
        size: 'S',
        quantity: 1,
        unitPrice: 500000,
        modelType: 'catalog',
        measurements: [],
        note: '',
        productionDetails: {
          heightCm: 167,
          weightKg: 55,
          fit: 'slim fit',
          color: 'Navy',
          material: '',
          lapel: '',
          buttons: '',
          measurements: [],
          notes: '',
          pending: [],
          sourceMessageIds: [confirmation],
        },
      },
    ],
    recipient: { name: '', phone: '', address: '' },
    shipping: { service: '', cost: null },
    note: 'Pilihan size S slim fit disetujui; pilihan jas/celana belum dijawab.',
  }
  return { jid, confirmation, intent }
}

test.group('Catalog draft recovery (disposable DB; mocked provider/socket)', (group) => {
  group.setup(async () => {
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable database required')
    await ensureDefaults()
    await db.table('whatsapp_skills').insert({
      name: 'fixture-catalog',
      content: 'Test only',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
  })
  for (const scenario of [
    'question_without_cart',
    'missing_size',
    'existing_cart',
    'model_review',
    'invalid_repair',
    'new_message',
  ])
    test(`custom inquiry keeps main's flow before cart: ${scenario}`, async ({ assert }) => {
      const data = await fixture()
      const { jid } = data
      let before = await readCart(jid)
      if (scenario === 'existing_cart')
        before = await applyAiCartIntent(
          jid,
          before.version,
          data.intent,
          evidence({ size_name: 'S', price: 500000, stock: 5 })
        )
      await db
        .from('whatsapp_messages')
        .where('message_id', data.confirmation)
        .update({ body: 'Ini berapa gan', media_type: 'image', media_url: '/media/fixture.jpg' })
      await db
        .table('whatsapp_messages')
        .insert({
          message_id: randomUUID(),
          jid,
          direction: 'out',
          sender_type: 'ai',
          body: 'Mau dibantu cek kemungkinan custom sesuai foto ini?',
          status: 'sent',
          created_at: new Date(),
        })
      const confirmation = randomUUID()
      await db
        .table('whatsapp_messages')
        .insert({
          message_id: confirmation,
          jid,
          direction: 'in',
          sender_type: 'customer',
          body: 'Iya',
          status: 'received',
          created_at: new Date(),
        })
      const draft: CartIntent = {
        ...data.intent,
        confirmationMessageId: confirmation,
        items: [
          {
            ...data.intent.items[0],
            productId: '',
            modelType: 'custom',
            size: '',
            referenceMessageId: data.confirmation,
            unitPrice: null,
          },
        ],
      }
      await assert.rejects(
        () => applyAiCartIntent(jid, before.version, draft, { products: [], shipping: [] }),
        /Pilihan ukuran belum lengkap/
      )
      const question = 'Untuk warnanya mau mengikuti foto atau ada pilihan lain, bos?'
      const continuation: any = {
        decision: 'reply',
        message: question,
        initiative: '',
        images: [],
        reason: '',
        note: `Pelanggan setuju pemeriksaan model foto ${data.confirmation}; ukuran belum dipilih.`,
        cartIntent: null,
        goal: {
          objective: 'Membantu pemeriksaan model custom',
          status: 'waiting_answer',
          waiting_for: 'Pilihan warna',
          next_action: 'Gunakan pilihan warna sebelum pengecekan model',
          follow_up: null,
        },
      }
      const writes: string[] = []
      let calls = 0
      const socket = {
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
        sendMessage: async (_jid: string, payload: any) => {
          writes.push(payload.text)
          return { key: { id: randomUUID() } }
        },
      }
      const worker = Object.create(WhatsappListen.prototype) as any
      Object.assign(worker, {
        socket,
        socketOpen: true,
        receivedPending: true,
        syncReadyAt: 0,
        ingesting: 0,
        stopping: false,
        customerTurnContext: () => buildTurnContext(jid, [confirmation]),
        createReviewDecision: async (
          _settings: any,
          prompt: string,
          _activity: any,
          _media: any,
          context: string
        ) => {
          calls++
          assert.include(prompt, data.confirmation)
          assert.include(context, 'Mau dibantu cek kemungkinan custom')
          assert.include(context, 'Iya')
          if (scenario === 'new_message') {
            const newer = randomUUID()
            await db
              .table('whatsapp_messages')
              .insert({
                message_id: newer,
                jid,
                direction: 'in',
                sender_type: 'customer',
                body: 'Batal custom, mau katalog saja',
                status: 'received',
                created_at: new Date(),
              })
            await beginGoalTurn(jid, newer)
          }
          return scenario === 'invalid_repair'
            ? { ...continuation, cartIntent: draft }
            : scenario === 'model_review'
              ? {
                  ...continuation,
                  decision: 'handoff',
                  message: '',
                  handoff_category: 'human_authorization',
                  reason: 'Pemeriksaan kelayakan model dari foto memerlukan CS.',
                  goal: {
                    ...continuation.goal,
                    status: 'waiting_approval',
                    waiting_for: 'Keputusan kelayakan model oleh CS',
                  },
                }
              : continuation
        },
      })
      const run = await beginGoalTurn(jid, confirmation)
      const trace = await startTrace(jid, { text: 'Custom inquiry fixture' })
      const deliver = () =>
        worker.deliverAiDecision(
          run,
          socket,
          readSettingsCache,
          {
            ...continuation,
            message:
              scenario === 'question_without_cart' ? question : 'Pesanan custom sudah masuk.',
            cartVersion: before.version,
            cartIntent: scenario === 'question_without_cart' ? null : draft,
          },
          [],
          false,
          trace
        )
      const readSettingsCache = await readSettings()
      if (scenario === 'invalid_repair')
        await assert.rejects(deliver, /Pilihan ukuran belum lengkap/)
      else await deliver()
      assert.equal(calls, scenario === 'question_without_cart' ? 0 : 1)
      const cart = await readCart(jid)
      assert.equal(cart.version, before.version)
      assert.deepEqual(cart.items, before.items)
      assert.lengthOf(await listOrders(jid), 0)
      assert.lengthOf(
        await db
          .from('whatsapp_order_payments as p')
          .join('whatsapp_orders as o', 'o.id', 'p.order_id')
          .where('o.jid', jid),
        0
      )
      if (['new_message', 'invalid_repair', 'model_review'].includes(scenario))
        assert.deepEqual(writes, [])
      else {
        assert.deepEqual(writes, [question])
        assert.equal((await readConversationGoal(jid)).status, 'waiting_answer')
        assert.notEqual(
          (await db.from('whatsapp_contacts').where('jid', jid).first())?.handling_mode,
          'cs'
        )
      }
      if (scenario === 'model_review')
        assert.equal(
          (await db.from('whatsapp_contacts').where('jid', jid).first())?.handling_mode,
          'cs'
        )
    }).timeout(15000)

  for (const stock of [1, 2])
    test(`separate wearer lines share catalog stock, not production facts: stock ${stock}`, async ({
      assert,
    }) => {
      const { jid, intent } = await fixture()
      intent.items.push(structuredClone(intent.items[0]))
      intent.items[1].productionDetails!.heightCm = 175
      intent.items[1].productionDetails!.weightKg = 65
      const cart = await applyAiCartIntent(
        jid,
        (await readCart(jid)).version,
        intent,
        evidence({ size_name: 'S', price: 500000, stock })
      )
      assert.lengthOf(cart.items, 2)
      assert.notEqual(cart.items[0].id, cart.items[1].id)
      assert.deepEqual(
        cart.items.map((item) => item.productionDetails?.heightCm),
        [167, 175]
      )
      assert.isTrue(
        cart.items.every(
          (item) => item.catalogVerification === (stock < 2 ? 'pending' : 'verified')
        )
      )
      assert.deepEqual(
        cart.items.map((item) => item.unitPrice),
        stock < 2 ? [null, null] : [500000, 500000]
      )
      assert.lengthOf(await listOrders(jid), 0)
    })

  test('adding another line rechecks stock used by a retained line', async ({ assert }) => {
    const { jid, intent } = await fixture()
    const stock = evidence({ size_name: 'S', price: 500000, stock: 1 })
    const first = await applyAiCartIntent(jid, (await readCart(jid)).version, intent, stock)
    intent.items[0].id = first.items[0].id
    intent.items.push({ ...structuredClone(intent.items[0]), id: '', size: 's' })
    const cart = await applyAiCartIntent(jid, first.version, intent, stock)
    assert.isTrue(cart.items.every((item) => item.catalogVerification === 'pending'))
    assert.deepEqual(
      cart.items.map((item) => item.unitPrice),
      [null, null]
    )
    assert.lengthOf(cart.items, 2)
  })

  test('quantities accumulate per size while an unchanged multi-line cart needs no new lookup', async ({
    assert,
  }) => {
    const { jid, intent } = await fixture()
    intent.items.push({ ...structuredClone(intent.items[0]), quantity: 2 })
    const stock = evidence({ size_name: 'S', price: 500000, stock: 3 })
    const first = await applyAiCartIntent(jid, (await readCart(jid)).version, intent, stock)
    first.items.forEach((item, index) => {
      intent.items[index].id = item.id
    })
    const retained = await applyAiCartIntent(jid, first.version, intent, {
      products: [],
      shipping: [],
    })
    assert.isTrue(retained.items.every((item) => item.catalogVerification === 'verified'))
    intent.items[0].quantity = 2
    const exceeded = await applyAiCartIntent(jid, retained.version, intent, stock)
    assert.deepEqual(
      exceeded.items.map((item) => item.unitPrice),
      [null, null]
    )
  })

  test('different catalog sizes do not consume each other’s stock', async ({ assert }) => {
    const { jid, intent } = await fixture()
    intent.items.push({ ...structuredClone(intent.items[0]), size: 'M' })
    const cart = await applyAiCartIntent(jid, (await readCart(jid)).version, intent, {
      products: [
        {
          ...product,
          sizes: ['S', 'M'].map((size_name) => ({ size_name, price: 500000, stock: 1 })),
        },
      ],
      shipping: [],
    })
    assert.isTrue(cart.items.every((item) => item.catalogVerification === 'verified'))
  })

  for (const [code, size] of [
    ['CATALOG_SIZE_MISSING', null],
    ['CATALOG_PRICE_MISMATCH', { size_name: 'S', price: 510000, stock: 5 }],
    ['CATALOG_STOCK_UNVERIFIED', { size_name: 'S', price: 500000, stock: 0 }],
    ['CATALOG_STOCK_UNVERIFIED', { size_name: 'S', price: 500000 }],
  ] as const)
    test(`${code}: stores selection and details without granting financial authority`, async ({
      assert,
    }) => {
      const { jid, intent } = await fixture()
      const cart = await applyAiCartIntent(
        jid,
        (await readCart(jid)).version,
        intent,
        evidence(size)
      )
      assert.equal(cart.catalogIssues?.[0].code, code)
      assert.equal(cart.items[0].catalogVerification, 'pending')
      assert.isNull(cart.items[0].unitPrice)
      assert.equal(cart.items[0].size, 'S')
      assert.equal(cart.items[0].productionDetails?.heightCm, 167)
      assert.equal(cart.items[0].productionDetails?.weightKg, 55)
      assert.equal(cart.items[0].productionDetails?.fit, 'slim fit')
      assert.isFalse(cart.totalComplete)
      assert.isNull(await tryConfirmedBalanceCheckout(jid, cart.version))
      await assert.rejects(
        () => checkoutFromBalance(jid, cart.version, intent.confirmationMessageId, ''),
        /belum disetujui/
      )
      assert.lengthOf(await listOrders(jid), 0)
      const context = await buildTurnContext(jid, [])
      assert.include(context.prompt, 'pending')
      assert.include(context.prompt, 'slim fit')
      // A later verified MCP result clears pending; the old draft cannot use the retained-item shortcut.
      intent.items[0].id = cart.items[0].id
      intent.items[0].unitPrice = 500000
      const verified = await applyAiCartIntent(
        jid,
        cart.version,
        intent,
        evidence({ size_name: 'S', price: 500000, stock: 5 })
      )
      assert.equal(verified.items[0].catalogVerification, 'verified')
      assert.equal(verified.items[0].unitPrice, 500000)
      assert.isUndefined(verified.catalogIssues)
    })

  for (const repair of ['incomplete', 'verified', 'unavailable', 'stale', 'changed-selection'])
    test(`worker ${repair}: bounded retry, no automatic CS handoff`, async ({ assert }) => {
      const { jid, intent, confirmation } = await fixture()
      const writes: string[] = []
      let calls = 0
      const socket = {
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
        sendMessage: async (_jid: string, payload: any) => {
          writes.push(payload.text)
          return { key: { id: randomUUID() } }
        },
      }
      const worker = Object.create(WhatsappListen.prototype) as any
      const initial = await readCart(jid)
      const decision: any = {
        decision: 'reply',
        message: question,
        initiative: 'Transfer Rp500.000 sekarang',
        images: [],
        reason: '',
        note: intent.note,
        cartIntent: intent,
        cartVersion: initial.version,
        cartEvidence: evidence({ size_name: 'S', price: 500000, stock: 0 }),
        goal: {
          objective: 'Melengkapi pesanan Signature Navy',
          status: 'waiting_answer',
          waiting_for: 'Jas saja atau dengan celana',
          next_action: 'Tunggu pilihan',
          follow_up: null,
        },
      }
      Object.assign(worker, {
        socket,
        socketOpen: true,
        receivedPending: true,
        syncReadyAt: 0,
        ingesting: 0,
        stopping: false,
        customerTurnContext: () => buildTurnContext(jid, []),
        createReviewDecision: async () => {
          calls++
          if (repair === 'unavailable') throw new Error('Mock provider unavailable')
          if (repair === 'stale') {
            const newer = randomUUID()
            await db.table('whatsapp_messages').insert({
              message_id: newer,
              jid,
              direction: 'in',
              body: 'Ganti model',
              status: 'received',
              created_at: new Date(),
            })
            await beginGoalTurn(jid, newer)
          }
          const updated = structuredClone(intent)
          updated.items[0].unitPrice = 500000
          if (repair === 'changed-selection') updated.items[0].size = 'XL'
          return {
            ...decision,
            initiative: '',
            cartIntent: updated,
            cartEvidence: evidence({
              size_name: 'S',
              price: 500000,
              stock: repair === 'verified' ? 5 : 0,
            }),
          }
        },
      })
      const run = await beginGoalTurn(jid, confirmation)
      const trace = await startTrace(jid, { text: 'Catalog fixture' })
      await worker.deliverAiDecision(run, socket, await readSettings(), decision, [], false, trace)
      assert.equal(calls, 1)
      assert.deepEqual(writes, repair === 'stale' ? [] : [question])
      const cart = await readCart(jid)
      assert.equal(cart.items[0].size, 'S')
      assert.equal(
        cart.items[0].catalogVerification,
        repair === 'verified' ? 'verified' : 'pending'
      )
      assert.lengthOf(await listOrders(jid), 0)
      const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
      assert.notEqual(contact?.handling_mode, 'cs')
      if (repair !== 'stale') {
        assert.equal((await readConversationGoal(jid)).status, 'waiting_answer')
        assert.equal((await readTrace(jid, trace.id))?.status, 'completed')
      }
    }).timeout(15000)

  test('pending evidence cannot leak prices, promises, media, or follow-ups', ({ assert }) => {
    assert.isTrue(safeCatalogQuestion(question))
    for (const body of [
      'Harga Rp500.000. Mau jas atau celana?',
      'Mau jas ready atau celana?',
      'Mau jas dikirim besok atau celana?',
      'Size S sudah benar?',
    ])
      assert.isFalse(safeCatalogQuestion(body))
    const held = holdCatalogDraft(
      {
        decision: 'reply',
        message: 'Rp500.000',
        initiative: 'Bayar sekarang',
        images: [{ url: 'https://example.com/x', caption: '' }],
        reason: '',
        note: '',
      },
      [{ code: 'CATALOG_STOCK_UNVERIFIED', productId: 'test', size: 'S' }]
    )
    assert.equal(held.decision, 'silent')
    assert.equal(held.handoff_category, 'none')
    assert.isNull(held.cartIntent)
    assert.deepEqual(held.images, [])
    assert.equal(held.initiative, '')
  })
})

await import('./cart_handoff.spec.js')
await import('./catalog_custom_draft.spec.js')
