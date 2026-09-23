import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { ensureDefaults } from '#services/settings_service'
import { saveProductionPolicy } from '#services/production_service'
import { defaultProductionPolicy } from '#services/production_contract'
import { applyAiCartIntent, resolveCartIssues } from '#services/ai_cart_service'
import { readCart, setItemFulfillment } from '#services/cart_service'
import { initialOperations } from '#services/order_operations_service'
import { humanPreorderDecision, fulfillmentFingerprint } from '#services/fulfillment_contract'
import type { CartIntent } from '#services/cart_contract'
import { verifyVisualDecision } from '#services/visual_match_contract'

const suit = {
  id: 'signature-navy',
  name: 'Basic Suit - Signature Navy',
  imageUrls: ['https://example.com/navy.jpg'],
}
const shirt = {
  id: 'oxford-white',
  name: 'Oxford Shirt - White',
  imageUrls: ['https://example.com/white.jpg'],
}
const evidence = (...products: Array<{ product: any; size: any }>) => ({
  products: products.map(({ product, size }) => ({ ...product, sizes: size ? [size] : [] })),
  shipping: [],
})
const item = (
  product: any,
  extra: Partial<CartIntent['items'][number]> = {}
): CartIntent['items'][number] => ({
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
  productionDetails: null,
  ...extra,
})
async function incoming(jid: string, body: string) {
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: messageId,
    jid,
    direction: 'in',
    sender_type: 'customer',
    body,
    status: 'received',
    created_at: new Date(),
  })
  return messageId
}
async function fromCs(jid: string, body: string, replyTo?: string) {
  const messageId = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: messageId,
    jid,
    direction: 'out',
    sender_type: 'cs',
    body,
    status: 'sent',
    reply_to_message_id: replyTo || null,
    created_at: new Date(),
  })
  return messageId
}
async function room() {
  const jid = `${randomUUID()}@lid`
  const confirmation = await incoming(jid, 'Iya')
  return { jid, confirmation }
}
function intent(confirmation: string, items: CartIntent['items'], note = ''): CartIntent {
  return {
    action: 'sync',
    confirmationMessageId: confirmation,
    removeItemIds: [],
    items,
    recipient: { name: '', phone: '', address: '' },
    shipping: { service: '', cost: null },
    note,
  }
}
async function cartVersion(jid: string) {
  const cart = await readCart(jid)
  return cart.version
}
async function enablePreorder() {
  const input = defaultProductionPolicy()
  input.rules.preorder = {
    enabled: true,
    minDays: 7,
    maxDays: 21,
    estimateDays: 14,
    dayType: 'calendar',
    startsAfter: 'payment_details',
  }
  await saveProductionPolicy(input)
}
/** Records the local CS decision the way the AI must cite it: request, then an immediate reply. */
async function preorderConsent(jid: string) {
  const requestMessageId = await incoming(jid, 'Kalau stoknya habis, bisa dipesan dulu?')
  const approvalMessageId = await fromCs(jid, 'Iya bisa pre-order bos', requestMessageId)
  return { requestMessageId, approvalMessageId }
}

test.group('Per-item fulfillment (disposable DB; mocked provider/socket)', (group) => {
  group.setup(async () => {
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable database required')
    await ensureDefaults()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
  })
  group.each.setup(async () => {
    await db.from('whatsapp_production_policy').delete()
  })

  for (const authorized of [false, true])
    test(`same SKU ready demand excludes only authorized PO: ${authorized}`, async ({ assert }) => {
      await enablePreorder()
      const { jid, confirmation } = await room()
      const consent = authorized ? await preorderConsent(jid) : null
      const cart = await applyAiCartIntent(
        jid,
        await cartVersion(jid),
        intent(confirmation, [
          item(suit),
          item(suit, { fulfillment: 'preorder', preorderConsent: consent }),
        ]),
        evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 1 } })
      )
      assert.deepEqual(
        cart.items.map((line) => line.catalogVerification),
        authorized ? ['verified', 'verified'] : ['pending', 'pending']
      )
      assert.deepEqual(
        cart.items.map((line) => line.fulfillment),
        authorized ? ['ready', 'preorder'] : ['ready', 'ready']
      )
    })

  test('stock failure in a ready line does not contaminate an authorized PO line with the same SKU', async ({
    assert,
  }) => {
    await enablePreorder()
    const { jid, confirmation } = await room()
    const cart = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [
        item(suit),
        item(suit, { fulfillment: 'preorder', preorderConsent: await preorderConsent(jid) }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 0 } })
    )
    assert.deepEqual(
      cart.items.map((line) => line.catalogVerification),
      ['pending', 'verified']
    )
    assert.deepEqual(
      cart.items.map((line) => line.unitPrice),
      [null, 500000]
    )
  })

  test('valid pre-order with zero stock proceeds, still verifying product, size and price', async ({
    assert,
  }) => {
    await enablePreorder()
    const { jid, confirmation } = await room()
    const consent = await preorderConsent(jid)
    const cart = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [item(suit, { fulfillment: 'preorder', preorderConsent: consent })]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 0 } })
    )
    assert.isUndefined(cart.issues)
    assert.equal(cart.items[0].fulfillment, 'preorder')
    assert.equal(cart.items[0].catalogVerification, 'verified')
    assert.equal(cart.items[0].unitPrice, 500000)
    assert.equal(cart.items[0].size, 'S')
    // Stock is waived, the rest of the catalog evidence is not.
    const wrongPrice = await applyAiCartIntent(
      jid,
      cart.version,
      intent(confirmation, [
        item(suit, { id: cart.items[0].id, unitPrice: 400000, fulfillment: 'preorder' }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 0 } })
    )
    assert.equal(wrongPrice.catalogIssues?.[0].code, 'CATALOG_PRICE_MISMATCH')
    assert.equal(wrongPrice.items[0].fulfillment, 'preorder')
    assert.isNull(wrongPrice.items[0].unitPrice)
    const wrongSize = await applyAiCartIntent(
      jid,
      wrongPrice.version,
      intent(confirmation, [
        item(suit, { id: cart.items[0].id, size: 'XL', fulfillment: 'preorder' }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 0 } })
    )
    assert.equal(wrongSize.catalogIssues?.[0].code, 'CATALOG_SIZE_MISSING')
    // Changed goods drop the old local decision instead of carrying it over.
    assert.equal(wrongSize.items[0].fulfillment, 'ready')
  })

  test('ready stock shortage never becomes pre-order on its own', async ({ assert }) => {
    await enablePreorder()
    const { jid, confirmation } = await room()
    const short = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [item(suit, { quantity: 3 })]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 1 } })
    )
    assert.equal(short.catalogIssues?.[0].code, 'CATALOG_STOCK_UNVERIFIED')
    assert.equal(short.items[0].fulfillment, 'ready')
    assert.isNull(short.items[0].unitPrice)
    // Claiming pre-order without a local decision keeps the draft ready and asks a human.
    const claimed = await applyAiCartIntent(
      jid,
      short.version,
      intent(confirmation, [
        item(suit, { id: short.items[0].id, quantity: 3, fulfillment: 'preorder' }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 1 } })
    )
    assert.equal(claimed.items[0].fulfillment, 'ready')
    assert.isTrue(claimed.issues?.some((issue) => issue.includes('PREORDER_NOT_AUTHORIZED')))
    assert.notEqual(claimed.issues?.length, claimed.catalogIssues?.length)
    const held = resolveCartIssues(
      {
        decision: 'reply',
        message: 'Stoknya ready kok bos',
        initiative: '',
        images: [],
        reason: '',
        note: '',
      } as any,
      claimed
    )
    assert.equal(held.decision, 'handoff')
    assert.equal(held.handoff_category, 'human_authorization')
    assert.equal(held.message, '')
    // Only the empty item turns into pre-order, and only through a recorded decision.
    const consent = await preorderConsent(jid)
    const marked = await applyAiCartIntent(
      jid,
      claimed.version,
      intent(confirmation, [
        item(suit, {
          id: claimed.items[0].id,
          quantity: 3,
          fulfillment: 'preorder',
          preorderConsent: consent,
        }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 1 } })
    )
    assert.equal(marked.items[0].fulfillment, 'preorder')
    assert.isUndefined(marked.issues)
  })

  test('pre-order without an available price routes the price to CS, not to payment', async ({
    assert,
  }) => {
    await enablePreorder()
    const { jid, confirmation } = await room()
    const consent = await preorderConsent(jid)
    const cart = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [
        item(suit, { unitPrice: null, fulfillment: 'preorder', preorderConsent: consent }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: null, stock: 0 } })
    )
    assert.equal(cart.items[0].fulfillment, 'preorder')
    assert.isNull(cart.items[0].unitPrice)
    assert.isFalse(cart.totalComplete)
    assert.isTrue(cart.issues?.some((issue) => issue.includes('PREORDER_PRICE_UNVERIFIED')))
    assert.isFalse(cart.onlyPendingCustomPrices)
    const held = resolveCartIssues(
      {
        decision: 'reply',
        message: 'Harganya Rp500.000, silakan transfer ya bos',
        initiative: 'Transfer sekarang',
        images: [],
        reason: '',
        note: '',
      } as any,
      cart
    )
    assert.equal(held.decision, 'handoff')
    assert.equal(held.message, '')
    assert.equal(held.initiative, '')
    assert.include(held.reason, 'PREORDER_PRICE_UNVERIFIED')
  })

  test('mixed ready and pre-order keeps one fulfillment per item', async ({ assert }) => {
    await enablePreorder()
    const { jid, confirmation } = await room()
    const consent = await preorderConsent(jid)
    const cart = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [
        item(suit, { fulfillment: 'preorder', preorderConsent: consent }),
        item(shirt, { unitPrice: 200000 }),
      ]),
      evidence(
        { product: suit, size: { size_name: 'S', price: 500000, stock: 0 } },
        { product: shirt, size: { size_name: 'S', price: 200000, stock: 4 } }
      )
    )
    assert.isUndefined(cart.issues)
    assert.deepEqual(
      cart.items.map((row) => [row.name, row.fulfillment]),
      [
        [suit.name, 'preorder'],
        [shirt.name, 'ready'],
      ]
    )
    const operations = initialOperations({ items: cart.items, recipient: cart.recipient })
    assert.equal(operations.kind, 'preorder')
    assert.isTrue(operations.mixedFulfillment)
    assert.equal(
      initialOperations({ items: [cart.items[1]], recipient: cart.recipient }).kind,
      'standard'
    )
  })

  for (const stock of [4, 0])
    test(`visual custom draft coexists with ready and approved PO, preserving stock checks: ${stock}`, async ({
      assert,
    }) => {
      await enablePreorder()
      const { jid, confirmation } = await room()
      const reference = await incoming(
        jid,
        'Tambahkan jas sesuai foto size S; kemeja ready dan jas PO tetap.'
      )
      await db.from('whatsapp_messages').where('message_id', reference).update({
        media_type: 'image',
        media_url: '/media/mixed-custom-fixture.jpg',
      })
      const poConsent = await preorderConsent(jid)
      const source = evidence(
        { product: suit, size: { size_name: 'S', price: 500000, stock: 0 } },
        { product: shirt, size: { size_name: 'S', price: 200000, stock } }
      )
      const draft = intent(confirmation, [
        item(suit, { fulfillment: 'preorder', preorderConsent: poConsent }),
        item(shirt, { unitPrice: 200000 }),
        item(
          { id: '', name: 'Custom jas referensi' },
          {
            modelType: 'custom',
            referenceMessageId: reference,
            unitPrice: null,
          }
        ),
      ])
      const checked = verifyVisualDecision(
        {
          decision: 'reply',
          message: 'Pilihan dicatat.',
          note: '',
          reason: '',
          cartIntent: draft,
          visualMatch: {
            status: 'no_match',
            targetImage: 1,
            productId: '',
            server: '',
            findings: [],
          },
        },
        [{ id: suit.id, server: 'fixture' }],
        reference,
        source.products.map((product) => ({ productId: product.id, name: product.name }))
      )
      const cart = await applyAiCartIntent(jid, await cartVersion(jid), checked.cartIntent!, source)
      assert.lengthOf(cart.items, 3)
      assert.deepEqual(
        cart.items.map((line) => [line.modelType, line.fulfillment]),
        [
          ['catalog', 'preorder'],
          ['catalog', 'ready'],
          ['custom', 'ready'],
        ]
      )
      assert.equal(cart.items[0].catalogVerification, 'verified')
      assert.equal(cart.items[0].unitPrice, 500000)
      assert.equal(cart.items[1].catalogVerification, stock ? 'verified' : 'pending')
      assert.equal(cart.items[1].unitPrice, stock ? 200000 : null)
      assert.equal(cart.items[2].referenceMessageId, reference)
      assert.isNull(cart.items[2].unitPrice)
      assert.equal(cart.items[2].modelApproval, 'pending')
      assert.equal(
        initialOperations({ items: cart.items, recipient: cart.recipient }).kind,
        'custom'
      )
      assert.isTrue(
        initialOperations({ items: cart.items, recipient: cart.recipient }).mixedFulfillment
      )
    })

  test('a catalog size with a fit preference stays that size', async ({ assert }) => {
    const { jid, confirmation } = await room()
    const cart = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [
        item(suit, {
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
        }),
      ]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 5 } })
    )
    assert.equal(cart.items[0].size, 'S')
    assert.equal(cart.items[0].requestedSize, '')
    assert.equal(cart.items[0].modelType, 'catalog')
    assert.equal(cart.items[0].approval, 'standard')
    assert.equal(cart.items[0].productionDetails?.fit, 'slim fit')
    assert.equal(cart.items[0].fulfillment, 'ready')
  })

  test('local settings and CS wording gate the pre-order decision', async ({ assert }) => {
    const { jid, confirmation } = await room()
    const consent = await preorderConsent(jid)
    // Pre-order settings are still disabled here.
    const blocked = await applyAiCartIntent(
      jid,
      await cartVersion(jid),
      intent(confirmation, [item(suit, { fulfillment: 'preorder', preorderConsent: consent })]),
      evidence({ product: suit, size: { size_name: 'S', price: 500000, stock: 0 } })
    )
    assert.equal(blocked.items[0].fulfillment, 'ready')
    assert.isTrue(blocked.issues?.some((issue) => issue.includes('PREORDER_NOT_AUTHORIZED')))
    await assert.rejects(
      () =>
        setItemFulfillment(
          jid,
          blocked.version,
          blocked.items[0].id,
          'preorder',
          'Diputuskan owner',
          'owner@test'
        ),
      /pre-order lokal/
    )
    await enablePreorder()
    const marked = await setItemFulfillment(
      jid,
      blocked.version,
      blocked.items[0].id,
      'preorder',
      'Diputuskan owner',
      'owner@test'
    )
    assert.equal(marked.items[0].fulfillment, 'preorder')
    assert.equal(marked.items[0].fulfillmentDecidedBy, 'owner@test')
    for (const body of [
      'Stok habis bos',
      'Pre-order belum bisa ya',
      'Bisa pre-order kalau sudah transfer DP?',
      'Iya bisa bos',
    ])
      assert.isFalse(humanPreorderDecision(body))
    for (const body of ['Iya bisa pre-order bos', 'Boleh PO ya kak', 'Oke kita inden dulu'])
      assert.isTrue(humanPreorderDecision(body))
  })

  test('fulfillment fingerprint follows the goods, the size and the count', ({ assert }) => {
    const base = { productId: 'a', name: 'Suit', size: 'S', quantity: 1, modelType: 'catalog' }
    assert.equal(fulfillmentFingerprint(base), fulfillmentFingerprint({ ...base, name: ' suit ' }))
    for (const change of [
      { productId: 'b' },
      { size: 'M' },
      { quantity: 2 },
      { modelType: 'custom' },
      { requestedSize: '38' },
    ])
      assert.notEqual(fulfillmentFingerprint(base), fulfillmentFingerprint({ ...base, ...change }))
  })
})
