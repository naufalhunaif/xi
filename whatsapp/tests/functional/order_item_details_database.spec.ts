import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import {
  readCart,
  saveCart,
  approveCustom,
  reportPayment,
  confirmPayment,
} from '#services/cart_service'
import { applyAiCartIntent } from '#services/ai_cart_service'
import type { CartIntent } from '#services/cart_contract'
import { groupOrderSnapshot, groupOrderParts } from '#services/order_operations_service'

// Adding physical custom measurements invalidates the previous package quote.
// Positive persistence tests supply the refreshed quote instead of bypassing that guard.
const fixtureShipping = [
  {
    service: 'REG',
    cost: 10000,
    quote: { destinationCode: 'FIXTURE-DEST', weightKg: 1 },
  },
]

const productionDetails = (source: string) => ({
  heightCm: 168,
  weightKg: 84,
  fit: 'regular',
  color: 'Black',
  material: '',
  lapel: 'peak',
  buttons: '2',
  measurements: [{ name: 'Lingkar pinggang', value: 96, basis: 'body' as const }],
  notes: 'Tanpa belahan belakang',
  pending: [],
  sourceMessageIds: [source],
})
test.group('Isolated production detail persistence', (group) => {
  group.each.skip(process.env.ORDER_DETAILS_DB_TEST !== '1', 'Disposable database only.')
  group.setup(async () => {
    if (process.env.ORDER_DETAILS_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable database only.')
    await initializeDatabase()
  })
  async function fixture() {
    const jid = `${randomUUID()}@lid`
    const source = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: source,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      body: 'TB 168 BB 84, regular. Pinggang badan 96 cm. Peak hitam dua kancing, tanpa belahan belakang.',
      created_at: new Date(),
    })
    const empty = await readCart(jid)
    const cart = await saveCart(jid, empty.version, {
      items: [
        {
          productId: 'fixture',
          name: 'Pants Black',
          image: 'https://example.com/fixture.jpg',
          size: 'custom',
          requestedSize: '38',
          quantity: 1,
          unitPrice: 100000,
          measurements: {},
          note: '',
        },
      ],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Private fixture address' },
      shipping: { service: 'REG', cost: 10000 },
      note: '',
    })
    const intent = {
      action: 'sync' as const,
      confirmationMessageId: source,
      items: cart.items.map((i) => ({
        ...i,
        measurements: [],
        productionDetails: productionDetails(source),
      })),
      recipient: cart.recipient,
      shipping: cart.shipping,
      note: '',
      removeItemIds: [],
    }
    return { jid, cart, intent }
  }
  test('AI facts survive sync, reload and verified checkout; production uses the same snapshot', async ({
    assert,
  }) => {
    const f = await fixture()
    let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, {
      products: [],
      shipping: fixtureShipping,
    })
    assert.equal(cart.items[0].productionDetails?.weightKg, 84)
    assert.equal(cart.items[0].approval, 'pending')
    cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
    // A legacy client/address-only sync must not silently erase production facts or approval.
    cart = await saveCart(f.jid, cart.version, {
      ...cart,
      items: cart.items.map(({ productionDetails: _details, ...item }) => item),
    })
    assert.equal(cart.items[0].approval, 'approved')
    const reloaded = await readCart(f.jid)
    assert.equal(reloaded.items[0].productionDetails?.heightCm, 168)
    cart = await reportPayment(f.jid, cart.version, undefined, 'fixture-cs')
    const [methodId] = await db.table('whatsapp_payment_methods').insert({
      name: 'Fixture',
      destination: '0000',
      account_name: 'Fixture',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const order = await confirmPayment(
      f.jid,
      {
        verified: true,
        version: cart.version,
        amount: 110000,
        methodId,
        requestKey: randomUUID(),
        reference: randomUUID(),
      },
      'fixture-cs'
    )
    assert.deepEqual(order.cart.items[0].productionDetails, cart.items[0].productionDetails)
    const operationsRow = await db
      .from('whatsapp_order_operations')
      .where('order_id', order.id)
      .firstOrFail()
    const operations = JSON.parse(operationsRow.data_json)
    assert.equal(operations.stage, 'production')
    assert.isNotNull(operations.startedOn)
    const snapshot = groupOrderSnapshot({
      id: order.id,
      paid: order.paid,
      total: order.total,
      snapshot_json: JSON.stringify(order.cart),
    })
    const message = groupOrderParts(snapshot)
      .map((part) => part.text)
      .join('\n')
    assert.include(message, '168 cm')
    assert.include(message, '84 kg')
    assert.include(message, 'Lingkar pinggang: 96 cm')
    assert.notInclude(message, 'Private fixture address')
    assert.notInclude(message, '628000000001')
  })
  test('rejects missing/cross-room/AI-only sources without changing the cart', async ({
    assert,
  }) => {
    const f = await fixture()
    const other = await fixture()
    const aiSource = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: aiSource,
      direction: 'out',
      sender_type: 'ai',
      status: 'sent',
      body: 'Guessed facts',
      created_at: new Date(),
    })
    for (const ids of [[], ['missing'], [other.intent.confirmationMessageId], [aiSource]]) {
      f.intent.items[0].productionDetails.sourceMessageIds = ids
      await assert.rejects(
        () => applyAiCartIntent(f.jid, f.cart.version, f.intent, { products: [], shipping: [] }),
        /pesan sumber|Pesan sumber/
      )
      const reloaded = await readCart(f.jid)
      assert.equal(reloaded.version, f.cart.version)
    }
  })
  test('measurement changes revoke approval; height/weight alone cannot approve custom sizes', async ({
    assert,
  }) => {
    const f = await fixture()
    let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, {
      products: [],
      shipping: fixtureShipping,
    })
    cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
    cart.items[0].productionDetails!.measurements[0].value = 98
    cart = await saveCart(f.jid, cart.version, cart)
    assert.equal(cart.items[0].approval, 'pending')
    cart.items[0].productionDetails!.measurements = []
    cart = await saveCart(f.jid, cart.version, cart)
    await assert.rejects(
      () => approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs'),
      /ukuran custom/
    )
  })
  test('facts stay per item and are not copied to a replacement product', async ({ assert }) => {
    const f = await fixture()
    let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, {
      products: [],
      shipping: fixtureShipping,
    })
    cart = await saveCart(f.jid, cart.version, {
      ...cart,
      items: [
        cart.items[0],
        {
          ...cart.items[0],
          id: undefined,
          productId: 'another-wearer',
          productionDetails: { ...cart.items[0].productionDetails!, heightCm: 180, weightKg: 70 },
        },
      ],
    })
    assert.equal(cart.items[0].productionDetails?.heightCm, 168)
    assert.equal(cart.items[1].productionDetails?.heightCm, 180)
    cart.items[0].productId = 'replacement'
    cart.items[0].productionDetails = null
    cart = await saveCart(f.jid, cart.version, cart)
    assert.isNull(cart.items[0].productionDetails)
    assert.equal(cart.items[1].productionDetails?.heightCm, 180)
  })

  for (const representation of ['structured', 'legacy'] as const)
    test(`typographic edits preserve approved sizes and conflicting duplicates are atomic: ${representation}`, async ({
      assert,
    }) => {
      const f = await fixture()
      let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, {
        products: [],
        shipping: fixtureShipping,
      })
      if (representation === 'legacy') {
        cart.items[0].measurements = { 'Lingkar pinggang': 96 }
        cart.items[0].productionDetails!.measurements = []
        cart = await saveCart(f.jid, cart.version, cart)
      }
      cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
      if (representation === 'legacy')
        cart.items[0].measurements = { ' ＬＩＮＧＫＡＲ   ＰＩＮＧＧＡＮＧ ': 96 }
      else
        cart.items[0].productionDetails!.measurements[0].name =
          ' ＬＩＮＧＫＡＲ   ＰＩＮＧＧＡＮＧ '
      cart = await saveCart(f.jid, cart.version, cart)
      assert.equal(cart.items[0].approval, 'approved')
      const before = cart.version
      if (representation === 'legacy')
        cart.items[0].measurements = { 'Lingkar pinggang': 96, ' lingkar  pinggang ': 98 }
      else
        cart.items[0].productionDetails!.measurements = [
          { name: 'Lingkar pinggang', value: 96, basis: 'body' },
          { name: ' lingkar  pinggang ', value: 98, basis: 'body' },
        ]
      await assert.rejects(() => saveCart(f.jid, cart.version, cart), /duplikat/)
      const reloaded = await readCart(f.jid)
      assert.equal(reloaded.version, before)
    })

  for (const change of ['basis', 'requestedSize', 'sourceOnly'] as const)
    test(`custom size approval scope: ${change}`, async ({ assert }) => {
      const f = await fixture()
      let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, {
        products: [],
        shipping: fixtureShipping,
      })
      cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
      if (change === 'basis') cart.items[0].productionDetails!.measurements[0].basis = 'garment'
      if (change === 'requestedSize') cart.items[0].requestedSize = '40'
      if (change === 'sourceOnly')
        cart.items[0].productionDetails!.sourceMessageIds.push('retained-reference')
      cart = await saveCart(f.jid, cart.version, cart)
      assert.equal(cart.items[0].approval, change === 'sourceOnly' ? 'approved' : 'pending')
    })

  test('adding physical details cannot reuse an unsupported shipping quote', async ({ assert }) => {
    const f = await fixture()
    await assert.rejects(
      () =>
        applyAiCartIntent(f.jid, f.cart.version, f.intent, {
          products: [],
          shipping: [],
        }),
      /Ongkir belum cocok/
    )
    const unchanged = await readCart(f.jid)
    assert.equal(unchanged.version, f.cart.version)
    assert.isNull(unchanged.items[0].productionDetails)
  })

  // Synthetic state transitions motivated by E0188/E0481. These execute persistence
  // and approval boundaries, not an AI model or the private customer transcript.
  async function hybridFixture() {
    const jid = `${randomUUID()}@lid`
    const source = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: source,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      body: 'Pilih jas XL hitam. Dada badan 108 cm, tinggi 180, berat 80.',
      created_at: new Date(),
    })
    const product = {
      id: 'hybrid-suit',
      name: 'Fixture Suit Black',
      imageUrls: ['https://example.com/hybrid-suit.jpg'],
      sizes: [{ size_name: 'XL', price: 400000, stock: 3 }],
    }
    const details = {
      heightCm: 180,
      weightKg: 80,
      fit: 'regular',
      color: 'Black',
      material: '',
      lapel: '',
      buttons: '',
      measurements: [{ name: 'Lingkar dada', value: 108, basis: 'body' as const }],
      notes: '',
      pending: [],
      sourceMessageIds: [source],
    }
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId: source,
      items: [
        {
          id: '',
          productId: product.id,
          name: product.name,
          image: product.imageUrls[0],
          size: 'XL',
          requestedSize: '',
          modelType: 'catalog',
          quantity: 1,
          unitPrice: 400000,
          measurements: [],
          productionDetails: details,
          note: '',
        },
      ],
      recipient: { name: '', phone: '', address: '' },
      shipping: { service: '', cost: null },
      note: '',
      removeItemIds: [],
    }
    const evidence = { products: [product], shipping: [] }
    const empty = await readCart(jid)
    const cart = await applyAiCartIntent(jid, empty.version, intent, evidence)
    intent.items[0].id = cart.items[0].id
    async function customer(body: string) {
      const id = randomUUID()
      await db.table('whatsapp_messages').insert({
        jid,
        message_id: id,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        body,
        created_at: new Date(),
      })
      intent.confirmationMessageId = id
      intent.items[0].productionDetails!.sourceMessageIds.push(id)
      return id
    }
    return { jid, cart, intent, evidence, customer }
  }

  test('body dimensions used for catalog fit do not manufacture custom approval or price', async ({
    assert,
  }) => {
    const f = await hybridFixture()
    const reloaded = await readCart(f.jid)
    const item = reloaded.items[0]
    assert.equal(item.size, 'XL')
    assert.equal(item.requestedSize, '')
    assert.equal(item.approval, 'standard')
    assert.equal(item.unitPrice, 400000)
    assert.deepEqual(item.productionDetails?.measurements, [
      { name: 'Lingkar dada', value: 108, basis: 'body' },
    ])
  })

  test('catalog label plus alteration keeps identity and base label but cannot reuse ready price or self-approve', async ({
    assert,
  }) => {
    const f = await hybridFixture()
    await f.customer('XL tetap, lengan jas dibuat 58 cm, badan tetap hitam.')
    const item = f.intent.items[0]
    item.size = 'custom'
    item.requestedSize = 'XL'
    item.productionDetails!.measurements.push({
      name: 'Panjang lengan',
      value: 58,
      basis: 'garment',
    })
    const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(cart.items[0].id, f.cart.items[0].id)
    assert.equal(cart.items[0].modelType, 'catalog')
    assert.equal(cart.items[0].productId, 'hybrid-suit')
    assert.equal(cart.items[0].image, f.cart.items[0].image)
    assert.equal(cart.items[0].referenceMessageId, '')
    assert.equal(cart.items[0].size, 'custom')
    assert.equal(cart.items[0].requestedSize, 'XL')
    assert.equal(cart.items[0].approval, 'pending')
    assert.equal(cart.items[0].modelApproval, 'standard')
    assert.isNull(cart.items[0].unitPrice)
    assert.isTrue(cart.onlyPendingCustomPrices)
    assert.equal(cart.items[0].productionDetails?.color, 'Black')
    assert.deepEqual(cart.items[0].productionDetails?.measurements, [
      { name: 'Lingkar dada', value: 108, basis: 'body' },
      { name: 'Panjang lengan', value: 58, basis: 'garment' },
    ])
  })

  test('returning to standard sizing retracts the alteration while preserving wearer and independent design facts', async ({
    assert,
  }) => {
    const f = await hybridFixture()
    await f.customer('XL dengan lengan jadi 58 cm.')
    f.intent.items[0].size = 'custom'
    f.intent.items[0].requestedSize = 'XL'
    f.intent.items[0].productionDetails!.measurements.push({
      name: 'Panjang lengan',
      value: 58,
      basis: 'garment',
    })
    let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    await f.customer('Tidak usah pendekkan lengan, XL standar saja. Warna tetap hitam.')
    f.intent.items[0].size = 'XL'
    f.intent.items[0].requestedSize = ''
    f.intent.items[0].unitPrice = 400000
    f.intent.items[0].productionDetails!.measurements = [
      { name: 'Lingkar dada', value: 108, basis: 'body' },
    ]
    cart = await applyAiCartIntent(f.jid, cart.version, f.intent, f.evidence)
    const reloaded = await readCart(f.jid)
    const saved = reloaded.items[0]
    assert.equal(saved.id, f.cart.items[0].id)
    assert.equal(saved.size, 'XL')
    assert.equal(saved.requestedSize, '')
    assert.equal(saved.approval, 'standard')
    assert.equal(saved.unitPrice, 400000)
    assert.equal(saved.productionDetails?.color, 'Black')
    assert.equal(saved.productionDetails?.heightCm, 180)
    assert.deepEqual(saved.productionDetails?.measurements, [
      { name: 'Lingkar dada', value: 108, basis: 'body' },
    ])
  })

  test('an explicit correction changes only the garment dimension and invalidates its prior approval', async ({
    assert,
  }) => {
    const f = await hybridFixture()
    await f.customer('XL dengan lengan jadi 58 cm.')
    f.intent.items[0].size = 'custom'
    f.intent.items[0].requestedSize = 'XL'
    f.intent.items[0].productionDetails!.measurements.push({
      name: 'Panjang lengan',
      value: 58,
      basis: 'garment',
    })
    let cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
    await f.customer('Ralat, lengan jadi 59 cm. Yang lain tetap.')
    f.intent.items[0].productionDetails!.measurements.find((m) => m.basis === 'garment')!.value = 59
    cart = await applyAiCartIntent(f.jid, cart.version, f.intent, f.evidence)
    assert.equal(cart.items[0].approval, 'pending')
    assert.equal(cart.items[0].requestedSize, 'XL')
    assert.equal(cart.items[0].productionDetails?.color, 'Black')
    assert.deepEqual(cart.items[0].productionDetails?.measurements, [
      { name: 'Lingkar dada', value: 108, basis: 'body' },
      { name: 'Panjang lengan', value: 59, basis: 'garment' },
    ])
  })
})
