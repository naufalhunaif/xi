/* eslint-disable @unicorn/no-await-expression-member -- Assertions inspect transactional snapshots. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import {
  applyAiCartIntent,
  humanQuoteContainsPrice,
  holdUnverifiedCartReply,
  shippingEvidence,
} from '#services/ai_cart_service'
import { parseCartIntent, type CartIntent } from '#services/cart_contract'
import { parseDecision } from '#services/ai_service'
import { buildTurnContext } from '#services/context_service'
import { operationalOrders, groupOrderSnapshot } from '#services/order_operations_service'
import {
  readCart,
  saveCart,
  approveCustom,
  approveModel,
  reportPayment,
  cancelCart,
  confirmPayment,
  listOrders,
  readCustomerBalance,
  applyCustomerBalance,
  cancelOrder,
} from '#services/cart_service'

const jid = '10000000667788@lid'
const actor = 'test-cs'
const item = {
  productId: 'basic-black',
  name: 'Basic Suit - Black',
  image: 'https://example.com/basic.jpg',
  size: 'custom',
  quantity: 1,
  unitPrice: 705000,
  measurements: { 'Panjang jas': 67, 'Panjang tangan': 59 },
  note: '',
}
const details = {
  recipient: { name: 'Pelanggan Uji', phone: '08120000000', address: 'Alamat uji lengkap' },
  shipping: { service: 'REG', cost: 8000 },
  note: '',
}
async function prepared() {
  const cart = await readCart(jid)
  return saveCart(jid, cart.version, { ...details, items: [item] })
}
async function paymentInput(version: string, amount = 713000) {
  const [methodId] = await db.table('whatsapp_payment_methods').insert({
    name: 'BANK UJI',
    destination: '000123',
    account_name: 'UJI',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  })
  return {
    version,
    verified: true,
    amount,
    methodId,
    reference: randomUUID(),
    requestKey: randomUUID(),
  }
}

test.group('Per-room cart and confirmed orders', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('new item quantity defaults to one but preserves explicitly chosen quantities', async ({
    assert,
  }) => {
    const empty = await readCart(jid)
    const withoutQuantity = { ...item, quantity: undefined }
    let cart = await saveCart(jid, empty.version, { ...details, items: [withoutQuantity] })
    assert.equal(cart.items[0].quantity, 1)
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], quantity: 3 }],
    })
    assert.equal(cart.items[0].quantity, 3)
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], quantity: undefined }],
    })
    assert.equal(cart.items[0].quantity, 3)
    assert.equal(cart.subtotal, 2115000)
    await assert.rejects(
      () => saveCart(jid, cart.version, { ...cart, items: [{ ...cart.items[0], quantity: 0 }] }),
      /Jumlah/
    )
  })

  test('recognizes human money formats without matching codes, phones or measurements', ({
    assert,
  }) => {
    for (const [body, amount] of [
      ['Jas, celana, rompi 880.000 bos', 880000],
      ['jas, celana 705.000 bos', 705000],
      ['Rp900.000', 900000],
      ['Harga model 900000', 900000],
      ['Jas 880rb bos', 880000],
      ['Setelan 1,25 juta', 1250000],
      ['Rp 880.000,00', 880000],
    ] as const)
      assert.isTrue(humanQuoteContainsPrice(body, amount), body)
    for (const body of [
      '628880000',
      'CXP880000',
      'CXP880.000',
      'TB 167 BB 56',
      '67.500cm',
      '-880.000',
      '880.000.123',
      'Jas 705.000 bos',
    ])
      assert.isFalse(humanQuoteContainsPrice(body, 880000), body)
    const held = holdUnverifiedCartReply({
      decision: 'reply',
      message: 'Harga Rp1',
      initiative: 'Bayar sekarang',
      reason: '',
      note: 'Produk dipahami',
    })
    assert.equal(held.decision, 'handoff')
    assert.equal(held.message, '')
    assert.equal(held.initiative, '')
    assert.equal(held.goal?.status, 'waiting_approval')
    assert.isNull(held.goal?.follow_up)
    assert.include(held.note, 'Produk dipahami')
    assert.equal(held.handoff_category, 'human_authorization')
  })

  test('stores definite product/image/measurements, rejects guesses and stale/cross-room edits', async ({
    assert,
  }) => {
    const cart = await prepared()
    assert.equal(cart.items[0].name, 'Basic Suit - Black')
    assert.equal(cart.items[0].measurements['Panjang tangan'], 59)
    assert.equal(cart.items[0].approval, 'pending')
    assert.equal(cart.subtotal, 705000)
    assert.equal(cart.discount, 0)
    assert.equal(cart.total, 713000)
    await assert.rejects(
      () =>
        saveCart(jid, cart.version, {
          ...cart,
          items: [{ ...cart.items[0], name: 'Sepertinya basic suit' }],
        }),
      /harus pasti/
    )
    await assert.rejects(
      () =>
        saveCart(jid, cart.version, {
          ...cart,
          items: [{ ...cart.items[0], measurements: { 'Panjang jas': 'sekitar 67' } }],
        }),
      /angka pasti/
    )
    await assert.rejects(() => saveCart(jid, 'stale', cart), /Cart berubah/)
    const another = await readCart('10000000667789@lid')
    await assert.rejects(
      () => saveCart(another.jid, another.version, { ...cart }),
      /Item cart tidak valid/
    )
    await assert.rejects(
      () =>
        saveCart(jid, cart.version, {
          ...cart,
          items: [{ ...cart.items[0], image: 'javascript:alert(1)' }],
        }),
      /URL gambar/
    )
  })

  test('custom approval is internal, cannot be forged by form data, and resets after changes', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], approval: 'approved', approvedBy: 'forged' }],
    })
    assert.equal(cart.items[0].approval, 'pending')
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    assert.equal(cart.items[0].approval, 'approved')
    assert.equal(cart.items[0].approvedBy, actor)
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], measurements: { 'Panjang jas': 68, 'Panjang tangan': 59 } }],
    })
    assert.equal(cart.items[0].approval, 'pending')
    cart = await approveCustom(
      jid,
      cart.version,
      cart.items[0].id,
      false,
      'Periksa lingkar dada',
      actor
    )
    assert.equal(cart.items[0].approval, 'rejected')
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 0)
  })

  test('transfer report creates no order; confirmation requires approved dimensions and checked funds', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await reportPayment(jid, cart.version)
    assert.lengthOf(await listOrders(jid), 0)
    const input = await paymentInput(cart.version)
    await assert.rejects(
      () => confirmPayment(jid, { ...input, verified: false }, actor),
      /Periksa dana/
    )
    await assert.rejects(() => confirmPayment(jid, input, actor), /custom belum disetujui/)
    assert.lengthOf(await listOrders(jid), 0)
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    const order = await confirmPayment(jid, { ...input, version: cart.version }, actor)
    assert.match(order.number, /^INV-\d{8}-[a-f0-9]{7}$/)
    const storedOrder = await db.from('whatsapp_orders').where('id', order.id).firstOrFail()
    assert.equal(storedOrder.order_number, order.number)
    assert.equal(groupOrderSnapshot(storedOrder).number, order.number)
    const search = await operationalOrders({ query: order.number })
    assert.equal(search.orders[0].id, order.id)
    assert.equal(search.orders[0].number, order.number)
    const paymentEvent = await db.from('whatsapp_cart_events').where('jid', jid)
      .where('action', 'payment_confirmed').orderBy('id', 'desc').firstOrFail()
    assert.equal(JSON.parse(paymentEvent.summary_json).orderNumber, order.number)
    assert.equal(order.paid, 713000)
    assert.equal(order.balance, 0)
    assert.equal(order.cart.items[0].measurements['Panjang jas'], 67)
    assert.lengthOf((await readCart(jid)).items, 0)
    assert.lengthOf(await db.from('whatsapp_order_payments').where('order_id', order.id), 1)
    const duplicate = await confirmPayment(jid, { ...input, version: cart.version }, actor)
    assert.equal(duplicate.number, order.number)
    assert.lengthOf(await listOrders(jid), 1)
  })

  test('DP receives one order number, later payment settles it; cancellation retains payment audit', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await reportPayment(jid, cart.version)
    const input = await paymentInput(cart.version, 350000)
    const order = await confirmPayment(jid, input, actor)
    assert.equal(order.balance, 363000)
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    const settled = await confirmPayment(
      jid,
      {
        ...input,
        orderId: order.id,
        requestKey: randomUUID(),
        reference: randomUUID(),
        amount: 363000,
      },
      actor
    )
    assert.equal(settled.number, order.number)
    assert.equal(settled.balance, 0)
    assert.equal(settled.overpayment, 0)
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    await cancelOrder(jid, order.id)
    assert.equal((await listOrders(jid))[0].status, 'cancelled')
    assert.lengthOf(await db.from('whatsapp_order_payments').where('order_id', order.id), 2)
  })

  test('overpayments accumulate once per receipt in the customer balance without changing order totals', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await reportPayment(jid, cart.version)
    const first = await paymentInput(cart.version, 770000)
    await assert.rejects(
      () => confirmPayment(jid, { ...first, verified: false }, actor),
      /Periksa dana/
    )
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    const order = await confirmPayment(jid, first, actor)
    assert.equal(order.total, 713000)
    assert.equal(order.paid, 770000)
    assert.equal(order.balance, 0)
    assert.equal(order.overpayment, 57000)
    await confirmPayment(jid, first, actor)
    let balance = await readCustomerBalance(jid)
    assert.equal(balance.balance, 57000)
    assert.lengthOf(balance.entries, 1)
    assert.equal(balance.entries[0].reference, first.reference)
    assert.equal(balance.entries[0].orderNumber, order.number)
    await assert.rejects(
      () => confirmPayment(jid, { ...first, orderId: order.id, requestKey: randomUUID() }, actor),
      /Referensi transfer/
    )

    cart = await prepared()
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await reportPayment(jid, cart.version)
    const dp = await confirmPayment(jid, await paymentInput(cart.version, 350000), actor)
    assert.equal(dp.balance, 306000)
    assert.equal(dp.balanceApplied, 57000)
    assert.equal(dp.cashPaid, 350000)
    const finalInput = {
      ...(await paymentInput((await readCart(jid)).version, 400000)),
      orderId: dp.id,
    }
    const final = await confirmPayment(jid, finalInput, actor)
    assert.equal(final.paid, 807000)
    assert.equal(final.cashPaid, 750000)
    assert.equal(final.overpayment, 94000)
    assert.equal(final.balance, 0)
    await confirmPayment(jid, finalInput, actor)
    balance = await readCustomerBalance(jid)
    assert.equal(balance.balance, 94000)
    assert.lengthOf(balance.entries, 3)
    assert.equal((await readCustomerBalance('10000000667789@lid')).balance, 0)
    await cancelOrder(jid, order.id)
    assert.equal((await readCustomerBalance(jid)).balance, 94000)
    const context = await buildTurnContext(jid, [])
    assert.include(JSON.stringify(context), 'customerBalance')
    assert.include(JSON.stringify(context), '94000')
  })

  test('new excess settles oldest DP first, skips cancelled and other customers, and retains every debit', async ({
    assert,
  }) => {
    async function dp(amount: number) {
      let cart = await prepared()
      cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
      cart = await reportPayment(jid, cart.version)
      const input = await paymentInput(cart.version, amount)
      return { order: await confirmPayment(jid, input, actor), input }
    }
    const cancelled = await dp(100000)
    await cancelOrder(jid, cancelled.order.id)
    const oldest = await dp(700000) // 13,000 remaining
    const newer = await dp(600000) // 113,000 remaining
    const excess = await dp(770000) // 57,000 credit
    const orders = await listOrders(jid)
    assert.equal(orders.find((order) => order.id === oldest.order.id)!.balance, 0)
    const remaining = orders.find((order) => order.id === newer.order.id)!
    assert.equal(remaining.balance, 69000)
    assert.equal(remaining.balanceApplied, 44000)
    assert.equal(remaining.cashPaid, 600000)
    assert.equal(orders.find((order) => order.id === cancelled.order.id)!.balance, 613000)
    let ledger = await readCustomerBalance(jid)
    assert.equal(ledger.balance, 0)
    assert.deepEqual(
      ledger.entries.map((entry) => entry.amount),
      [-44000, -13000, 57000]
    )
    assert.isNull(ledger.entries[0].paymentId)
    assert.equal(ledger.entries[0].orderNumber, newer.order.number)
    await confirmPayment(jid, excess.input, actor)
    assert.deepEqual(await applyCustomerBalance(jid), [])
    assert.lengthOf((await readCustomerBalance(jid)).entries, 3)
    assert.equal((await readCustomerBalance('10000000667789@lid')).balance, 0)
    await cancelOrder(jid, newer.order.id)
    ledger = await readCustomerBalance(jid)
    assert.equal(ledger.balance, 0) // Cancellation is not a refund.
    assert.equal(
      (await listOrders(jid)).find((order) => order.id === newer.order.id)!.balanceApplied,
      44000
    )
  })

  test('existing balance reconciliation rolls back on failure and is safe to repeat', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await reportPayment(jid, cart.version)
    const source = await confirmPayment(jid, await paymentInput(cart.version, 770000), actor)
    // An existing DP from before automatic balance allocation was enabled.
    const [id] = await db.table('whatsapp_orders').insert({
      jid,
      snapshot_json: JSON.stringify(source.cart),
      total: 713000,
      paid: 700000,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await assert.rejects(() => applyCustomerBalance(jid, 'x'.repeat(191)))
    assert.equal((await readCustomerBalance(jid)).balance, 57000)
    assert.equal((await listOrders(jid)).find((order) => order.id === id)!.paid, 700000)
    const allocations = await applyCustomerBalance(jid, actor)
    assert.deepEqual(allocations, [
      { orderNumber: `WA-${String(id).padStart(6, '0')}`, amount: 13000 },
    ])
    assert.equal((await readCustomerBalance(jid)).balance, 44000)
    assert.deepEqual(await applyCustomerBalance(jid, actor), [])
    assert.lengthOf((await readCustomerBalance(jid)).entries, 2)
  })

  test('cancel empties only this cart, records cancellation, and prevents stale checkout', async ({
    assert,
  }) => {
    const cart = await prepared()
    const cleared = await cancelCart(jid, cart.version)
    assert.lengthOf(cleared.items, 0)
    assert.equal(cleared.paymentStatus, 'none')
    assert.lengthOf(await listOrders(jid), 0)
    const input = await paymentInput(cart.version)
    await assert.rejects(() => confirmPayment(jid, input, actor), /Cart berubah/)
    assert.equal(
      (await db.from('whatsapp_cart_events').where('jid', jid).orderBy('id', 'desc').first())
        .action,
      'cancelled'
    )
  })

  test('cart routes require account authentication and CSRF', async ({ client, assert }) => {
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'CS',
        username: 'cs',
      },
    }
    const anonymous = await client.get(`/api/cart?jid=${jid}`).redirects(0)
    anonymous.assertStatus(302)
    const denied = await client
      .post('/api/cart/cancel')
      .header('accept', 'application/json')
      .withSession(session)
      .json({ jid, version: 'x' })
      .redirects(0)
    denied.assertStatus(302)
    assert.isNull(await db.from('whatsapp_cart_events').where('jid', jid).first())
    const authorized = await client.get(`/api/cart?jid=${jid}`).withSession(session)
    authorized.assertStatus(200)
    const dashboard = await client.get('/').withSession(session)
    dashboard.assertStatus(200)
    dashboard.assertTextIncludes('id="cartOpen"')
    dashboard.assertTextIncludes('Diisi AI')
    assert.notInclude(dashboard.text(), 'id="cartItemForm"')
    assert.notInclude(dashboard.text(), 'name="image"')
  })

  test('AI fills confirmed products and address, resolves the catalog image and never approves custom or funds', async ({
    assert,
  }) => {
    const confirmationMessageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: confirmationMessageId,
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Basic Black custom, panjang jas 67 tangan 59. REG. Alamat uji lengkap.',
      status: 'received',
      created_at: new Date(Date.now() - 2000),
    })
    const initial = await readCart(jid)
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId,
      items: [
        {
          ...item,
          id: '',
          image: '',
          measurements: Object.entries(item.measurements).map(([name, value]) => ({ name, value })),
        },
      ],
      ...details,
      removeItemIds: [],
    }
    const evidence = {
      products: [
        {
          id: item.productId,
          name: item.name,
          imageUrls: [item.image],
          sizes: [{ size_name: 'custom', price: 705000 }],
        },
      ],
      shipping: [{ service: 'REG', cost: 8000 }],
    }
    const parsed = parseDecision(JSON.stringify({ decision: 'silent', cartIntent: intent }))
    assert.deepEqual(parsed.cartIntent, intent)
    const cart = await applyAiCartIntent(jid, initial.version, parsed.cartIntent!, evidence)
    assert.equal(cart.items[0].image, item.image)
    assert.equal(cart.items[0].approval, 'pending')
    assert.equal(cart.recipient.address, details.recipient.address)
    assert.lengthOf(await listOrders(jid), 0)
    const context = await buildTurnContext(jid, [confirmationMessageId])
    assert.equal(context.cartVersion, cart.version)
    assert.include(context.prompt, confirmationMessageId)
    assert.include(context.prompt, 'Panjang jas')
    const report = await applyAiCartIntent(
      jid,
      cart.version,
      { ...intent, action: 'report_payment' },
      evidence
    )
    assert.equal(report.paymentStatus, 'reported')
    assert.lengthOf(await listOrders(jid), 0)
    await applyAiCartIntent(jid, report.version, { ...intent, action: 'cancel' }, evidence)
    const empty = await readCart(jid)
    await assert.rejects(
      () => applyAiCartIntent(jid, empty.version, intent, evidence),
      /dibatalkan atau dibayar/
    )
  })

  test('saves a displayed YES selection with its MCP code and weight, and rechecks changed quantities', async ({
    assert,
  }) => {
    const confirmationMessageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: confirmationMessageId,
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Pakai YES',
      status: 'received',
      created_at: new Date(),
    })
    let cart = await prepared()
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId,
      removeItemIds: [],
      ...details,
      shipping: { service: 'YES', cost: 9000 },
      items: [
        { ...item, id: cart.items[0].id, measurements: [{ name: 'Panjang jas', value: 67 }] },
      ],
    }
    const shipping = shippingEvidence([
      {
        tool: 'check_shipping_rates',
        arguments: { destination_code: 'DEST', weight_kg: 1.2 },
        result: {
          structured_content: {
            rates: { prices: [{ service: 'YES23', name: 'YES', price: 9000 }] },
          },
        },
      },
    ])
    cart = await applyAiCartIntent(jid, cart.version, intent, { products: [], shipping })
    assert.equal(cart.shipping.service, 'YES')
    assert.equal(cart.shipping.serviceCode, 'YES23')
    assert.equal(cart.shipping.cost, 9000)
    assert.equal(cart.shipping.weightKg, 1.2)
    assert.equal(cart.shipping.destinationCode, 'DEST')
    const products = [
      {
        id: item.productId,
        name: item.name,
        imageUrls: [item.image],
        sizes: [{ size_name: 'custom', price: 705000 }],
      },
    ]
    const increased = { ...intent, items: [{ ...intent.items[0], quantity: 2 }] }
    await assert.rejects(
      () => applyAiCartIntent(jid, cart.version, increased, { products, shipping: [] }),
      /Periksa ulang tarif melalui MCP/
    )
    const freshShipping = shippingEvidence([
      {
        tool: 'check_shipping_rates',
        arguments: { destination_code: 'DEST', weight_kg: 2.4 },
        result: {
          structured_content: {
            rates: { prices: [{ service: 'YES23', name: 'YES', price: 18000 }] },
          },
        },
      },
    ])
    cart = await applyAiCartIntent(
      jid,
      cart.version,
      { ...increased, shipping: { service: 'YES', cost: 18000 } },
      { products, shipping: freshShipping }
    )
    assert.equal(cart.items[0].quantity, 2)
    assert.equal(cart.shipping.weightKg, 2.4)
    assert.equal(cart.shipping.cost, 18000)
    const context = await buildTurnContext(jid, [confirmationMessageId])
    assert.include(context.prompt, '2.4')
    assert.include(context.prompt, 'YES23')
    const emptied = await applyAiCartIntent(
      jid,
      cart.version,
      {
        ...increased,
        action: 'remove',
        removeItemIds: [cart.items[0].id],
      },
      { products: [], shipping: [] }
    )
    assert.lengthOf(emptied.items, 0)
    assert.isNull(emptied.shipping.cost)
    assert.isUndefined(emptied.shipping.weightKg)
  })

  test('AI rejects invented price, shipping, confirmation, duplicate measurements and stale snapshots', async ({
    assert,
  }) => {
    const confirmationMessageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: confirmationMessageId,
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Pesan custom',
      status: 'received',
      created_at: new Date(),
    })
    const cart = await readCart(jid)
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId,
      items: [{ ...item, id: '', measurements: [{ name: 'Panjang jas', value: 67 }] }],
      ...details,
      removeItemIds: [],
    }
    const evidence = {
      products: [
        {
          id: item.productId,
          name: item.name,
          imageUrls: [item.image],
          sizes: [{ size_name: 'custom', price: 705000 }],
        },
      ],
      shipping: [{ service: 'REG', cost: 8000 }],
    }
    await assert.rejects(() => applyAiCartIntent(jid, 'stale', intent, evidence), /Cart berubah/)
    await assert.rejects(
      () =>
        applyAiCartIntent(
          jid,
          cart.version,
          { ...intent, confirmationMessageId: 'invented' },
          evidence
        ),
      /Konfirmasi pelanggan/
    )
    await assert.rejects(
      () =>
        applyAiCartIntent(
          jid,
          cart.version,
          { ...intent, items: [{ ...intent.items[0], unitPrice: 1 }] },
          evidence
        ),
      /harga/
    )
    await assert.rejects(
      () =>
        applyAiCartIntent(
          jid,
          cart.version,
          { ...intent, shipping: { service: 'REG', cost: 1 } },
          evidence
        ),
      /Ongkir/
    )
    assert.throws(
      () =>
        parseCartIntent({
          ...intent,
          items: [
            {
              ...intent.items[0],
              measurements: [
                { name: 'Panjang jas', value: 67 },
                { name: 'Panjang jas', value: 68 },
              ],
            },
          ],
        }),
      /Format cart/
    )
    assert.throws(() => parseCartIntent({ action: 'confirm-payment' }), /Format cart/)
    assert.lengthOf((await readCart(jid)).items, 0)
  })

  test('noncatalog models need their own approval and price even after dimensions are approved', async ({
    assert,
  }) => {
    const reference = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: reference,
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Buat model ini, peak lapel enam kancing, ukuran custom jas 67 tangan 59',
      media_type: 'image',
      media_url: '/alogaritm--app/whatsapp/media/fixture.jpg',
      status: 'received',
      created_at: new Date(),
    })
    const initial = await readCart(jid)
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId: reference,
      items: [
        {
          ...item,
          id: '',
          modelType: 'custom',
          referenceMessageId: reference,
          name: 'Jas peak lapel enam kancing',
          unitPrice: 1,
          measurements: [
            { name: 'Panjang jas', value: 67 },
            { name: 'Panjang tangan', value: 59 },
          ],
        },
      ],
      ...details,
      removeItemIds: [],
    }
    let cart = await applyAiCartIntent(jid, initial.version, intent, {
      products: [],
      shipping: [{ service: 'REG', cost: 8000 }],
    })
    assert.equal(cart.items[0].modelApproval, 'pending')
    assert.equal(cart.items[0].approval, 'pending')
    assert.isNull(cart.items[0].unitPrice)
    assert.isFalse(cart.totalComplete)
    assert.equal(cart.items[0].image, '/alogaritm--app/whatsapp/media/fixture.jpg')
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], modelApproval: 'approved' }],
    })
    assert.equal(cart.items[0].modelApproval, 'pending')
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await reportPayment(jid, cart.version, reference)
    const input = await paymentInput(cart.version, 908000)
    await assert.rejects(() => confirmPayment(jid, input, actor), /Model di luar katalog/)
    cart = await approveModel(jid, cart.version, cart.items[0].id, true, '', actor)
    await assert.rejects(
      () => confirmPayment(jid, { ...input, version: cart.version }, actor),
      /Harga model/
    )
    const priceMessageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: priceMessageId,
      jid,
      direction: 'out',
      sender_type: 'cs',
      body: 'Jas, celana, rompi 880.000 bos',
      status: 'sent',
      created_at: new Date(),
    })
    cart = await applyAiCartIntent(
      jid,
      cart.version,
      {
        ...intent,
        items: [{ ...intent.items[0], id: cart.items[0].id, unitPrice: 880000, priceMessageId }],
      },
      { products: [], shipping: [] }
    )
    assert.equal(cart.items[0].modelApproval, 'pending')
    assert.equal(cart.items[0].unitPrice, 880000)
    assert.equal(cart.items[0].priceMessageId, priceMessageId)
    cart = await approveModel(jid, cart.version, cart.items[0].id, true, '', actor)
    assert.equal(cart.items[0].modelApproval, 'approved')
    assert.equal(cart.items[0].approval, 'approved')
    assert.equal(cart.total, 888000)
    const approvedVersion = cart.version
    const itemId = cart.items[0].id
    await assert.rejects(
      () =>
        saveCart(jid, cart.version, {
          ...cart,
          items: [{ ...cart.items[0], modelType: 'catalog' }],
        }),
      /melewati persetujuan/
    )
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], note: 'Ganti lapel shawl' }],
    })
    assert.equal(cart.items[0].modelApproval, 'pending')
    await assert.rejects(
      () => approveModel(jid, approvedVersion, itemId, true, '', actor),
      /Cart berubah/
    )
    await assert.rejects(
      () =>
        applyAiCartIntent(
          jid,
          cart.version,
          {
            ...intent,
            items: [{ ...intent.items[0], id: itemId, referenceMessageId: 'other-room-photo' }],
          },
          { products: [], shipping: [] }
        ),
      /Foto referensi/
    )
  })

  test('unverified quotes preserve a pending draft but never create an approved price', async ({
    assert,
  }) => {
    const reference = randomUUID()
    await db.table('whatsapp_messages').insert({
      message_id: reference,
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Pesan model ini',
      media_type: 'image',
      media_url: '/alogaritm--app/whatsapp/media/test.jpg',
      status: 'received',
      created_at: new Date(),
    })
    for (const source of [
      { jid, direction: 'out', sender_type: 'cs', status: 'sent', body: 'Jas 705.000 bos' },
      { jid, direction: 'out', sender_type: 'ai', status: 'sent', body: 'Jas 880.000 bos' },
      {
        jid,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        body: 'Jas 880.000 bos',
      },
      {
        jid: '10000000999999@lid',
        direction: 'out',
        sender_type: 'cs',
        status: 'sent',
        body: 'Jas 880.000 bos',
      },
      { jid, direction: 'out', sender_type: 'cs', status: 'queued', body: 'Jas 880.000 bos' },
    ]) {
      const priceMessageId = randomUUID()
      await db
        .table('whatsapp_messages')
        .insert({ ...source, message_id: priceMessageId, created_at: new Date() })
      const previous = await readCart(jid)
      const cart = await applyAiCartIntent(
        jid,
        previous.version,
        {
          action: 'sync',
          confirmationMessageId: reference,
          removeItemIds: [],
          ...details,
          items: [
            {
              ...item,
              id: previous.items[0]?.id || '',
              modelType: 'custom',
              referenceMessageId: reference,
              unitPrice: 880000,
              priceMessageId,
              measurements: [],
            },
          ],
        },
        { products: [], shipping: [{ service: 'REG', cost: 8000 }] }
      )
      assert.lengthOf(cart.items, 1)
      assert.lengthOf(cart.issues!, 1)
      assert.isNull(cart.items[0].unitPrice)
      assert.equal(cart.items[0].modelApproval, 'pending')
      assert.isFalse(cart.totalComplete)
      assert.lengthOf(await listOrders(jid), 0)
      await assert.rejects(
        () => approveCustom(jid, cart.version, cart.items[0].id, true, '', actor),
        /detail ukuran custom/
      )
    }
  })

  test('custom drafts can await measurements, but cannot be approved or checked out before filling them', async ({
    assert,
  }) => {
    let cart = await prepared()
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], measurements: {}, approval: 'approved' }],
    })
    assert.lengthOf(cart.items, 1)
    assert.deepEqual(cart.items[0].measurements, {})
    assert.equal(cart.items[0].approval, 'pending')
    await assert.rejects(
      () => approveCustom(jid, cart.version, cart.items[0].id, true, '', actor),
      /detail ukuran custom/
    )
    cart = await reportPayment(jid, cart.version)
    const input = await paymentInput(cart.version)
    await assert.rejects(() => confirmPayment(jid, input, actor), /Ukuran custom belum disetujui/)
    assert.lengthOf(await listOrders(jid), 0)
    cart = await saveCart(jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], measurements: { 'Panjang jas': 67 } }],
    })
    assert.equal(cart.items[0].approval, 'pending')
    cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', actor)
    assert.equal(cart.items[0].approval, 'approved')
  })
})
