/* eslint-disable @unicorn/no-await-expression-member -- Inspect isolated transactional snapshots. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { mkdir, unlink } from 'node:fs/promises'
import { initializeDatabase } from '#services/init_model'
import { ensureDefaults } from '#services/settings_service'
import CartsController from '#controllers/carts_controller'
import {
  readCart,
  saveCart,
  reportPayment,
  confirmPayment,
  listOrders,
  readCustomerBalance,
} from '#services/cart_service'
import { preparePaymentReview, receiptAssessment } from '#services/payment_review_service'
import { parseReceipt, type ReceiptReading } from '#services/payment_receipt_contract'
import { buildTurnContext } from '#services/context_service'

const jid = '10000000008822@lid'
const reading: ReceiptReading = {
  isReceipt: true,
  status: 'success',
  amount: 300000,
  currency: 'IDR',
  recipientBank: 'Bank Uji',
  recipientAccount: '999988887777',
  reference: 'UJI-REF-300001',
}
const method = {
  id: 1,
  name: 'Bank Uji',
  destination: '999988887777',
  accountName: 'Penerima Uji',
  enabled: true,
}
let filename = ''

async function proof(messageId = randomUUID(), date = new Date()) {
  await db.table('whatsapp_messages').insert({
    jid,
    message_id: messageId,
    direction: 'in',
    body: '',
    status: 'received',
    media_type: 'image',
    media_url: `${env.get('APP_BASE_PATH')}/media/${filename}`,
    created_at: date,
  })
  return messageId
}

async function prepared() {
  await db.table('whatsapp_payment_methods').insert({
    name: method.name,
    destination: method.destination,
    account_name: method.accountName,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  })
  const cart = await readCart(jid)
  const saved = await saveCart(jid, cart.version, {
    items: [
      {
        productId: 'uji',
        name: 'Jas Uji',
        image: 'https://example.com/item.jpg',
        size: 'S',
        quantity: 1,
        unitPrice: 700000,
        measurements: {},
        note: '',
      },
    ],
    recipient: { name: 'Pelanggan Uji', phone: '08120000000', address: 'Alamat Uji' },
    shipping: { service: 'YES', cost: 9000 },
    note: '',
  })
  return reportPayment(jid, saved.version, await proof())
}

test.group('Receipt reading and human payment confirmation', (group) => {
  group.setup(async () => {
    await initializeDatabase()
    await ensureDefaults()
    await mkdir(app.makePath('public', 'media'), { recursive: true })
  })
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    filename = `test-receipt-${randomUUID()}.png`
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(app.makePath('public', 'media', filename))
    return async () => {
      await db.rollbackGlobalTransaction()
      await unlink(app.makePath('public', 'media', filename))
    }
  })

  test('payment controller rejects manual fields without a server receipt review', async ({
    assert,
  }) => {
    const cart = await prepared()
    let rejected: any
    await new CartsController().mutate({
      request: {
        all: () => ({
          jid,
          version: cart.version,
          verified: true,
          amount: 300000,
          methodId: 1,
          reference: 'MANUAL',
          requestKey: randomUUID(),
        }),
      },
      params: { action: 'confirm-payment' },
      session: { get: () => ({ sub: 'test-cs' }) },
      response: {
        unprocessableEntity: (value: any) => {
          rejected = value
        },
        json: () => assert.fail('Must reject manual payment'),
      },
    } as any)
    assert.match(rejected.error, /Baca bukti transfer/)
    assert.lengthOf(await listOrders(jid), 0)
  })

  test('requires unambiguous amount and destination but allows an absent reference', ({
    assert,
  }) => {
    assert.deepEqual(receiptAssessment(reading, [method]).issues, [])
    for (const patch of [
      { isReceipt: false },
      { status: 'pending' },
      { status: 'failed' },
      { amount: null },
      { currency: 'USD' },
      { recipientAccount: '9999****7777' },
      { recipientAccount: '123456789' },
      { recipientBank: 'Other bank' },
    ])
      assert.isNotEmpty(
        receiptAssessment({ ...reading, ...patch } as ReceiptReading, [method]).issues
      )
    assert.isNotEmpty(receiptAssessment(reading, [{ ...method, enabled: false }]).issues)
    assert.isNotEmpty(receiptAssessment(reading, [method, { ...method, id: 2 }]).issues)
    assert.throws(() => parseReceipt({ ...reading, amount: -1 }))
    assert.throws(() => parseReceipt({ ...reading, amount: '300000' }))
    assert.deepEqual(receiptAssessment({ ...reading, reference: '' }, [method]).issues, [])
    assert.equal(parseReceipt({ ...reading, reference: '123***' }).reference, '')
  })

  test('excess is a nonblocking preview and becomes customer credit only after verified confirmation', async ({
    assert,
  }) => {
    const cart = await prepared()
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => ({
      ...reading,
      amount: 770000,
    }))
    assert.isTrue(review.ready)
    assert.deepEqual(review.issues, [])
    assert.equal(review.billAmount, 709000)
    assert.equal(review.overpayment, 61000)
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    const input = {
      version: cart.version,
      reviewId: review.id,
      verified: true,
      requestKey: randomUUID(),
      amount: 1,
    }
    const order = await confirmPayment(jid, input, 'test-cs')
    assert.equal(order.paid, 770000) // Server reading wins, never the client-supplied amount.
    assert.equal(order.total, 709000)
    assert.equal(order.balance, 0)
    assert.equal(order.overpayment, 61000)
    await confirmPayment(jid, input, 'test-cs')
    const balance = await readCustomerBalance(jid)
    assert.equal(balance.balance, 61000)
    assert.lengthOf(balance.entries, 1)
  })

  test('matches BRI legal names without weakening exact destination or bank identity checks', ({
    assert,
  }) => {
    const bri = { ...method, name: 'BRI' }
    for (const recipientBank of [
      'Bank Rakyat Indonesia',
      'BANK RAKYAT INDONESIA',
      'Bank BRI',
      'BRI',
      'PT Bank Rakyat Indonesia (Persero) Tbk',
      'Bank Rakyat Indonesia (BRI)',
    ]) {
      const result = receiptAssessment({ ...reading, recipientBank }, [bri])
      assert.equal(result.method?.id, bri.id, recipientBank)
      assert.deepEqual(result.issues, [])
    }
    assert.equal(
      receiptAssessment({ ...reading, recipientBank: 'BRI' }, [
        { ...bri, name: 'Bank Rakyat Indonesia' },
      ]).method?.id,
      bri.id
    )
    for (const recipientBank of [
      'Bank Mandiri',
      'BRI Syariah',
      'Bank Rakyat Indonesia Agroniaga',
      'Bank',
      '',
    ]) {
      assert.isNull(receiptAssessment({ ...reading, recipientBank }, [bri]).method)
    }
    for (const recipientAccount of ['999988887778', '9999****7777']) {
      assert.isNull(
        receiptAssessment(
          { ...reading, recipientBank: 'Bank Rakyat Indonesia', recipientAccount },
          [bri]
        ).method
      )
    }
    assert.isNull(
      receiptAssessment({ ...reading, recipientBank: 'Bank Rakyat Indonesia' }, [
        { ...bri, enabled: false },
      ]).method
    )
    assert.isNull(
      receiptAssessment({ ...reading, recipientBank: 'Bank Rakyat Indonesia' }, [
        bri,
        { ...bri, id: 2 },
      ]).method
    )
  })

  test('reuses the original full-bank-name reading and resolves the configured BRI method', async ({
    assert,
  }) => {
    const cart = await prepared()
    await db
      .from('whatsapp_payment_methods')
      .where('destination', method.destination)
      .update({ name: 'BRI' })
    let calls = 0
    const reader = async () => {
      calls++
      return { ...reading, recipientBank: 'Bank Rakyat Indonesia' }
    }
    const review = await preparePaymentReview(jid, cart.version, undefined, reader)
    assert.isTrue(review.ready)
    assert.equal(review.methodName, 'BRI')
    const cached = await preparePaymentReview(jid, cart.version, undefined, reader)
    assert.equal(cached.id, review.id)
    assert.isTrue(cached.ready)
    assert.equal(calls, 1)
    assert.lengthOf(await listOrders(jid), 0)
  })

  test('reads once, displays DP, ignores client amounts and still requires human confirmation', async ({
    assert,
  }) => {
    const cart = await prepared()
    let calls = 0
    const reader = async () => {
      calls++
      return reading
    }
    const review = await preparePaymentReview(jid, cart.version, undefined, reader)
    assert.isTrue(review.ready)
    assert.equal(review.amount, 300000)
    assert.equal(review.methodName, 'Bank Uji')
    assert.equal((await preparePaymentReview(jid, cart.version, undefined, reader)).id, review.id)
    assert.equal(calls, 1)
    assert.lengthOf(await listOrders(jid), 0)
    const input = {
      reviewId: review.id,
      version: cart.version,
      requestKey: randomUUID(),
      verified: true,
      amount: 709000,
      reference: 'FORGED',
      methodId: 999999,
    }
    await assert.rejects(
      () => confirmPayment(jid, { ...input, verified: false }, 'human'),
      /Periksa dana/
    )
    assert.notInclude((await buildTurnContext(jid, [])).prompt, 'BUKTI PEMBAYARAN TERCATAT')
    const order = await confirmPayment(jid, input, 'human')
    assert.equal(order.paid, 300000)
    assert.equal(order.balance, 409000)
    assert.equal((await confirmPayment(jid, input, 'human')).id, order.id)
    const receipt = await db
      .from('whatsapp_order_payments')
      .where('order_id', order.id)
      .firstOrFail()
    assert.equal(receipt.reference, reading.reference)
    assert.equal(receipt.proof_message_id, cart.proofMessageId)
    assert.equal(receipt.confirmed_by, 'human')
    const firstContext = await buildTurnContext(jid, [])
    const firstNotice = JSON.parse(
      firstContext.prompt
        .split('BUKTI PEMBAYARAN TERCATAT DAN PESANAN TERKAIT (data internal):\n')[1]
        .split('\n')[0]
    )
    assert.lengthOf(firstNotice, 1) // A repeated confirm did not create a second receipt.
    assert.equal(firstNotice[0].orderNumber, order.number)
    assert.equal(firstNotice[0].received, 300000)
    assert.equal(firstNotice[0].order.balance, 409000)
    assert.include(firstContext.routing.indexContext!, 'BUKTI PEMBAYARAN TERCATAT')

    const current = await readCart(jid)
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#aabbcc' } })
      .png()
      .toFile(app.makePath('public', 'media', filename))
    await proof(randomUUID(), new Date(Date.now() + 1000))
    const settlement = await preparePaymentReview(jid, current.version, order.id, async () => ({
      ...reading,
      amount: 409000,
      reference: 'UJI-SETTLE-1',
    }))
    const settled = await confirmPayment(
      jid,
      {
        version: current.version,
        reviewId: settlement.id,
        requestKey: randomUUID(),
        verified: true,
      },
      'human'
    )
    assert.equal(settled.id, order.id)
    assert.equal(settled.balance, 0)
    assert.lengthOf(await db.from('whatsapp_order_payments').where('order_id', order.id), 2)
    const finalContext = await buildTurnContext(jid, [])
    const finalNotices = JSON.parse(
      finalContext.prompt
        .split('BUKTI PEMBAYARAN TERCATAT DAN PESANAN TERKAIT (data internal):\n')[1]
        .split('\n')[0]
    )
    assert.lengthOf(finalNotices, 2)
    assert.equal(finalNotices[0].orderNumber, order.number)
    assert.equal(finalNotices[0].received, 409000)
    assert.equal(finalNotices[0].order.paid, 709000)
    assert.equal(finalNotices[0].order.balance, 0)
    assert.isFalse(finalNotices[0].orderCreated)
  })

  test('blocks unclear receipts, other rooms, changed methods and stale carts', async ({
    assert,
  }) => {
    const cart = await prepared()
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => ({
      ...reading,
      amount: null,
    }))
    assert.isFalse(review.ready)
    const input = {
      version: cart.version,
      reviewId: review.id,
      requestKey: randomUUID(),
      verified: true,
    }
    await assert.rejects(() => confirmPayment(jid, input, 'human'), /belum cukup jelas/)
    await assert.rejects(
      () => confirmPayment('10000000008823@lid', input, 'human'),
      /tidak ditemukan/
    )
    await db.from('whatsapp_payment_reviews').where('id', review.id).delete()
    const clear = await preparePaymentReview(jid, cart.version, undefined, async () => reading)
    await db
      .from('whatsapp_payment_methods')
      .where('destination', method.destination)
      .update({ destination: '999900001111' })
    await assert.rejects(
      () => confirmPayment(jid, { ...input, reviewId: clear.id }, 'human'),
      /belum cukup jelas|berubah/
    )
    await db
      .from('whatsapp_payment_methods')
      .where('destination', '999900001111')
      .update({ destination: method.destination })
    await saveCart(jid, cart.version, { ...cart, note: 'berubah' })
    await assert.rejects(
      () => confirmPayment(jid, { ...input, reviewId: clear.id }, 'human'),
      /Pesanan berubah/
    )
    assert.lengthOf(await listOrders(jid), 0)
  })

  test('changed proof pixels and duplicate references cannot record another payment', async ({
    assert,
  }) => {
    const cart = await prepared()
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => reading)
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#000000' } })
      .png()
      .toFile(app.makePath('public', 'media', filename))
    await assert.rejects(
      () =>
        confirmPayment(
          jid,
          {
            version: cart.version,
            reviewId: review.id,
            requestKey: randomUUID(),
            verified: true,
          },
          'human'
        ),
      /Gambar bukti berubah/
    )
    const fresh = await preparePaymentReview(jid, cart.version, undefined, async () => reading)
    const order = await confirmPayment(
      jid,
      { version: cart.version, reviewId: fresh.id, requestKey: randomUUID(), verified: true },
      'human'
    )
    const current = await readCart(jid)
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#aabbcc' } })
      .png()
      .toFile(app.makePath('public', 'media', filename))
    await proof(randomUUID(), new Date(Date.now() + 1000))
    const duplicate = await preparePaymentReview(
      jid,
      current.version,
      order.id,
      async () => reading
    )
    await assert.rejects(
      () =>
        confirmPayment(
          jid,
          {
            version: current.version,
            reviewId: duplicate.id,
            requestKey: randomUUID(),
            verified: true,
          },
          'human'
        ),
      /Referensi transfer sudah/
    )
    assert.equal((await listOrders(jid))[0].paid, 300000)
  })

  test('distinct receipts without references can settle an order; replayed pixels cannot', async ({
    assert,
  }) => {
    const cart = await prepared()
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => ({
      ...reading,
      reference: '',
    }))
    assert.isTrue(review.ready)
    const input = {
      version: cart.version,
      reviewId: review.id,
      requestKey: randomUUID(),
      verified: true,
    }
    await assert.rejects(
      () => confirmPayment(jid, { ...input, verified: false }, 'human'),
      /Periksa dana/
    )
    const order = await confirmPayment(jid, input, 'human')
    await confirmPayment(jid, input, 'human')
    assert.isNull(
      (await db.from('whatsapp_order_payments').where('order_id', order.id).firstOrFail()).reference
    )
    const current = await readCart(jid)
    await proof(randomUUID(), new Date(Date.now() + 1000))
    const replay = await preparePaymentReview(jid, current.version, order.id, async () => ({
      ...reading,
      reference: '',
    }))
    await assert.rejects(
      () =>
        confirmPayment(
          jid,
          { ...input, version: current.version, reviewId: replay.id, requestKey: randomUUID() },
          'human'
        ),
      /Bukti transfer ini sudah/
    )
    await sharp({ create: { width: 80, height: 80, channels: 3, background: '#123456' } })
      .png()
      .toFile(app.makePath('public', 'media', filename))
    const settlement = await preparePaymentReview(jid, current.version, order.id, async () => ({
      ...reading,
      amount: 409000,
      reference: '',
    }))
    const settled = await confirmPayment(
      jid,
      { ...input, version: current.version, reviewId: settlement.id, requestKey: randomUUID() },
      'human'
    )
    assert.equal(settled.paid, 709000)
    assert.lengthOf(await db.from('whatsapp_order_payments').where('order_id', order.id), 2)
  })

  async function credit(amount: number) {
    await db.table('whatsapp_customer_balance_entries').insert({
      jid,
      order_id: 999999,
      payment_id: null,
      amount,
      reason: 'overpayment',
      created_at: new Date(),
    })
  }

  test('a fully covered quote asks for zero transfer and never spends credit during reads', async ({
    assert,
  }) => {
    await prepared()
    await credit(900000)
    const cart = await readCart(jid)
    assert.equal(cart.paymentQuote.balanceToUse, 709000)
    assert.equal(cart.paymentQuote.amountDue, 0)
    await readCart(jid)
    assert.equal((await readCustomerBalance(jid)).balance, 900000)
    assert.lengthOf(await listOrders(jid), 0)
  })

  test('quotes existing credit before a transfer, then applies it once at confirmation', async ({
    assert,
  }) => {
    const cart = await prepared()
    // Return to pre-transfer state to verify quoting does not depend on a receipt.
    await db.from('whatsapp_carts').where('jid', jid).update({ payment_status: 'none' })
    await credit(100000)
    const quote = await readCart(jid)
    assert.equal(quote.total, 709000)
    assert.deepEqual(quote.paymentQuote, {
      availableBalance: 100000,
      reservedForOrders: 0,
      balanceToUse: 100000,
      amountDue: 609000,
    })
    assert.equal((await readCustomerBalance(jid)).balance, 100000)
    await db.from('whatsapp_carts').where('jid', jid).update({ payment_status: 'reported' })
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => ({
      ...reading,
      amount: 609000,
      reference: '',
    }))
    assert.equal(review.paymentQuote.amountDue, 609000)
    assert.equal(review.overpayment, 0)
    assert.equal(review.remainingDue, 0)
    const input = {
      version: cart.version,
      reviewId: review.id,
      requestKey: randomUUID(),
      verified: true,
    }
    const order = await confirmPayment(jid, input, 'human')
    assert.equal(order.paid, 709000)
    assert.equal(order.cashPaid, 609000)
    assert.equal(order.balanceApplied, 100000)
    assert.equal(order.balance, 0)
    await confirmPayment(jid, input, 'human')
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    assert.lengthOf(await db.from('whatsapp_customer_balance_entries').where('amount', '<', 0), 1)
  })

  test('credit prioritizes older debt, ignores other customers and withholds incomplete totals', async ({
    assert,
  }) => {
    const cart = await prepared()
    const [olderId] = await db.table('whatsapp_orders').insert({
      jid,
      snapshot_json: JSON.stringify(cart),
      total: 100000,
      paid: 60000,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await credit(100000)
    await db.table('whatsapp_customer_balance_entries').insert({
      jid: 'other@lid',
      order_id: olderId,
      amount: 900000,
      reason: 'overpayment',
      created_at: new Date(),
    })
    const quoted = await readCart(jid)
    assert.equal(quoted.paymentQuote.reservedForOrders, 40000)
    assert.equal(quoted.paymentQuote.balanceToUse, 60000)
    assert.equal(quoted.paymentQuote.amountDue, 649000)
    const review = await preparePaymentReview(jid, cart.version, undefined, async () => ({
      ...reading,
      amount: 649000,
    }))
    const paid = await confirmPayment(
      jid,
      { version: cart.version, reviewId: review.id, requestKey: randomUUID(), verified: true },
      'human'
    )
    assert.equal(paid.balanceApplied, 60000)
    assert.equal(paid.balance, 0)
    assert.equal(
      Number((await db.from('whatsapp_orders').where('id', olderId).firstOrFail()).paid),
      100000
    )
    assert.equal((await readCustomerBalance(jid)).balance, 0)
    const empty = await readCart(jid)
    await credit(100000)
    const incomplete = await saveCart(jid, empty.version, {
      ...cart,
      items: cart.items.map(({ id, ...item }) => item),
      shipping: { service: '', cost: null },
    })
    assert.isNull(incomplete.paymentQuote.amountDue)
    assert.equal(incomplete.paymentQuote.balanceToUse, 0)
  })

  test('extra cash is credited relative to the bill after existing credit; a stale balance review is rejected', async ({
    assert,
  }) => {
    const cart = await prepared()
    await credit(100000)
    const reader = async () => ({ ...reading, amount: 709000 })
    const review = await preparePaymentReview(jid, cart.version, undefined, reader)
    assert.equal(review.overpayment, 100000)
    await credit(10000)
    const input = {
      version: cart.version,
      reviewId: review.id,
      requestKey: randomUUID(),
      verified: true,
    }
    await assert.rejects(() => confirmPayment(jid, input, 'human'), /Saldo atau tagihan berubah/)
    const refreshed = await preparePaymentReview(jid, cart.version, undefined, reader)
    assert.notEqual(refreshed.id, review.id)
    await assert.rejects(() => confirmPayment(jid, input, 'human'), /Saldo atau tagihan berubah/)
    const order = await confirmPayment(jid, { ...input, reviewId: refreshed.id }, 'human')
    assert.equal(order.balanceApplied, 110000)
    assert.equal(order.overpayment, 110000)
    assert.equal((await readCustomerBalance(jid)).balance, 110000)
  })
})
