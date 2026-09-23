import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import {
  readCart,
  saveCart,
  applyCartDiscount,
  reportPayment,
  confirmPayment,
  cancelCart,
  readCustomerBalance,
} from '#services/cart_service'
import { applyAiCartIntent } from '#services/ai_cart_service'

// This suite refuses to initialize or alter the application's normal database.
test.group('Isolated discount persistence', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Requires a disposable test database.')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error(
        'Run this suite with scripts/test_cart_discount_database.mjs (disposable DB only).'
      )
    await initializeDatabase()
  })

  async function fixture() {
    const jid = `${randomUUID()}@lid`
    const empty = await readCart(jid)
    const cart = await saveCart(jid, empty.version, {
      items: [
        {
          productId: 'suit',
          name: 'Suit + pants',
          image: 'https://example.com/suit.jpg',
          size: 'M',
          quantity: 1,
          unitPrice: 705000,
          measurements: {},
          note: '',
        },
      ],
      recipient: { name: 'Fixture customer', phone: '628000000001', address: 'Fixture address' },
      shipping: { service: 'YES', cost: 9000 },
      note: '',
    })
    const discount = {
      amount: 15000,
      approvalMessageId: randomUUID(),
      confirmationMessageId: randomUUID(),
    }
    const proofId = randomUUID()
    await db.table('whatsapp_messages').insert([
      {
        jid,
        message_id: discount.approvalMessageId,
        direction: 'out',
        sender_type: 'cs',
        status: 'read',
        body: 'Saya kasih diskon Rp15.000 bos.',
        created_at: new Date(Date.now() - 3000),
      },
      {
        jid,
        message_id: discount.confirmationMessageId,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        body: 'Oke, setuju bos',
        created_at: new Date(Date.now() - 2000),
      },
      {
        jid,
        message_id: proofId,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        body: 'Sudah transfer bos',
        created_at: new Date(Date.now() - 1000),
      },
    ])
    return { jid, cart, discount, proofId }
  }

  test('AI applies human approval once; payment remains unverified and checkout stores 699000', async ({
    assert,
  }) => {
    const f = await fixture()
    let cart = await applyAiCartIntent(
      f.jid,
      f.cart.version,
      {
        action: 'apply_discount',
        confirmationMessageId: f.discount.confirmationMessageId,
        discount: f.discount,
        items: [],
        recipient: f.cart.recipient,
        shipping: f.cart.shipping,
        note: '',
        removeItemIds: [],
      },
      { products: [], shipping: [] }
    )
    assert.equal(cart.discount, 15000)
    assert.equal(cart.total, 699000)
    assert.equal(cart.paymentStatus, 'none')
    const version = cart.version
    cart = await applyCartDiscount(f.jid, version, f.discount)
    assert.equal(cart.version, version)
    cart = await reportPayment(f.jid, version, f.proofId, 'ai')
    assert.equal(cart.paymentStatus, 'reported')
    const customerBalance = await readCustomerBalance(f.jid)
    assert.equal(customerBalance.balance, 0)
    await assert.rejects(
      () => confirmPayment(f.jid, { verified: false }, 'fixture-cs'),
      /dana masuk/
    )
    const [methodId] = await db.table('whatsapp_payment_methods').insert({
      name: 'Fixture bank',
      destination: '000000',
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
        amount: 699000,
        methodId,
        requestKey: randomUUID(),
        reference: randomUUID(),
      },
      'fixture-cs'
    )
    assert.equal(order.total, 699000)
    assert.equal(order.paid, 699000)
    assert.equal(order.balance, 0)
    assert.equal(order.overpayment, 0)
    assert.equal(order.cart.discount, 15000)
    const cleared = await readCart(f.jid)
    assert.equal(cleared.discount, 0)
    assert.isNull(cleared.discountApproval)
  })

  test('reporting a transfer can apply already-approved discount atomically without confirming money', async ({
    assert,
  }) => {
    const f = await fixture()
    const cart = await applyAiCartIntent(
      f.jid,
      f.cart.version,
      {
        action: 'report_payment',
        confirmationMessageId: f.proofId,
        discount: f.discount,
        items: [],
        recipient: f.cart.recipient,
        shipping: f.cart.shipping,
        note: '',
        removeItemIds: [],
      },
      { products: [], shipping: [] }
    )
    assert.equal(cart.total, 699000)
    assert.equal(cart.paymentStatus, 'reported')
    assert.equal(cart.proofMessageId, f.proofId)
    const orders = await db.from('whatsapp_orders').where('jid', f.jid)
    assert.lengthOf(orders, 0)
  })

  test('normal AI sync stores the discount separately from catalog prices', async ({ assert }) => {
    const f = await fixture()
    const cart = await applyAiCartIntent(
      f.jid,
      f.cart.version,
      {
        action: 'sync',
        confirmationMessageId: f.discount.confirmationMessageId,
        discount: f.discount,
        items: f.cart.items.map((item) => ({ ...item, measurements: [] })),
        recipient: f.cart.recipient,
        shipping: f.cart.shipping,
        note: '',
        removeItemIds: [],
      },
      {
        products: [
          {
            id: 'suit',
            name: 'Suit + pants',
            imageUrls: ['https://example.com/suit.jpg'],
            sizes: [{ size: 'M', price: 705000, stock: 10 }],
          },
        ],
        shipping: [],
      }
    )
    assert.equal(cart.items[0].unitPrice, 705000)
    assert.equal(cart.discount, 15000)
    assert.equal(cart.total, 699000)
    const persisted = await readCart(f.jid)
    assert.equal(persisted.total, 699000)
    assert.equal(persisted.discountApproval?.approvalMessageId, f.discount.approvalMessageId)
  })

  test('address changes preserve approval; product changes clear it and reject old approval replay', async ({
    assert,
  }) => {
    const f = await fixture()
    let cart = await applyCartDiscount(f.jid, f.cart.version, f.discount)
    cart = await saveCart(f.jid, cart.version, {
      ...cart,
      recipient: { ...cart.recipient, address: 'Another fixture address' },
    })
    assert.equal(cart.discount, 15000)
    cart = await saveCart(f.jid, cart.version, {
      ...cart,
      items: [{ ...cart.items[0], quantity: 2 }],
    })
    assert.equal(cart.discount, 0)
    await assert.rejects(() => applyCartDiscount(f.jid, cart.version, f.discount), /terikat/)
    const unchanged = await readCart(f.jid)
    assert.equal(unchanged.version, cart.version)
    cart = await cancelCart(f.jid, cart.version)
    cart = await saveCart(f.jid, cart.version, {
      ...f.cart,
      items: f.cart.items.map((item) => ({ ...item, id: undefined })),
    })
    await assert.rejects(() => applyCartDiscount(f.jid, cart.version, f.discount), /pesanan/)
  })
})
