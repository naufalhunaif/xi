import { test } from '@japa/runner'
import {
  cartAmounts,
  discountFingerprint,
  humanApprovedDiscount,
  validateDiscountEvidence,
  verifyCartDiscount,
} from '#services/cart_discount_service'
import { parseCartIntent } from '#services/cart_contract'

const jid = 'fixture@lid'
const items = [
  { productId: 'suit', name: 'Suit + pants', size: 'M', quantity: 1, unitPrice: 705000 },
]
const request = {
  amount: 15000,
  approvalMessageId: 'human-discount',
  confirmationMessageId: 'customer-accept',
}
const approved = { ...request, fingerprint: discountFingerprint(items) }
const human = {
  id: 10,
  jid,
  message_id: request.approvalMessageId,
  direction: 'out',
  sender_type: 'cs',
  status: 'delivered',
  body: 'Saya kasih diskon Rp15.000 bos.',
  created_at: '2026-09-14T10:00:00Z',
}
const customer = {
  id: 11,
  jid,
  message_id: request.confirmationMessageId,
  direction: 'in',
  sender_type: 'customer',
  status: 'received',
  body: 'Oke bos, setuju.',
  created_at: '2026-09-14T10:01:00Z',
}

test.group('Verified CS discount', () => {
  test('705000 - 15000 + 9000 = 699000 and persistence does not apply the discount twice', ({
    assert,
  }) => {
    const snapshot = JSON.parse(
      JSON.stringify({ items, shipping: { cost: 9000 }, discountApproval: approved })
    )
    for (let i = 0; i < 3; i++)
      assert.deepEqual(
        cartAmounts(snapshot.items, snapshot.shipping.cost, snapshot.discountApproval),
        { subtotal: 705000, discount: 15000, total: 699000 }
      )
    assert.equal(cartAmounts(items, 9000).total, 714000)
    assert.equal(cartAmounts(items, 8000, approved).total, 698000)
  })

  test('accepts explicit rupiah and thousands wording from human messages', ({ assert }) => {
    for (const text of [
      'Diskon Rp15.000 bos',
      'Saya kasih diskon 15rb ya',
      'Potongan sebesar Rp15.000',
      'Diskonnya 15 ribu',
      'Potong 15k',
      'Discount of 15,000',
    ])
      assert.isTrue(humanApprovedDiscount(text, 15000), text)
  })

  test('rejects requests, conditions, percentages, shipping-only discounts and different amounts', ({
    assert,
  }) => {
    for (const text of [
      'Boleh diskon 15rb?',
      'Tidak bisa diskon 15rb',
      'Belum disetujui diskon 15rb',
      'Kalau beli dua diskon 15rb',
      'Diskon 15%',
      'Diskon ongkir 15rb',
      'Diskon 20rb',
      'Minta diskon 15rb',
      'Diskon 15rb atau diskon 20rb',
      'Harga 690.000',
    ])
      assert.isFalse(humanApprovedDiscount(text, 15000), text)
  })

  test('accepts delivered CS or own-device human agreement followed by customer acceptance', ({
    assert,
  }) => {
    for (const senderType of ['cs', 'owner'])
      assert.doesNotThrow(() =>
        validateDiscountEvidence(request, jid, { ...human, sender_type: senderType }, customer)
      )
  })

  test('AI notes, customer claims, failed sends and other rooms cannot approve a discount', ({
    assert,
  }) => {
    for (const change of [
      { sender_type: 'ai' },
      { direction: 'in' },
      { jid: 'another@lid' },
      { status: 'failed' },
      { status: 'queued' },
      { message_id: 'wrong' },
    ])
      assert.throws(() => validateDiscountEvidence(request, jid, { ...human, ...change }, customer))
    assert.throws(() =>
      validateDiscountEvidence(request, jid, human, { ...customer, jid: 'another@lid' })
    )
    assert.throws(() => validateDiscountEvidence(request, jid, undefined, customer))
  })

  test('does not treat customer rejection or a counteroffer as acceptance', ({ assert }) => {
    for (const body of [
      'Tidak jadi',
      'Oke tapi maunya 20rb',
      'Boleh diskon 20rb?',
      'Iya diskon 20rb',
      'Besok aja',
      'Oke kalau diskon 20rb',
    ])
      assert.throws(
        () => validateDiscountEvidence(request, jid, human, { ...customer, body }),
        /Diskon|diskon/
      )
    assert.doesNotThrow(() =>
      validateDiscountEvidence(request, jid, human, { ...customer, body: 'Oke diskon 15rb ya' })
    )
  })

  test('requires correct message chronology and rejects approval before cancelled/paid cart boundary', ({
    assert,
  }) => {
    assert.throws(() =>
      validateDiscountEvidence(request, jid, human, {
        ...customer,
        created_at: '2026-09-14T09:00:00Z',
      })
    )
    assert.throws(() =>
      validateDiscountEvidence(request, jid, human, {
        ...customer,
        id: 9,
        created_at: human.created_at,
      })
    )
    assert.throws(() =>
      validateDiscountEvidence(request, jid, human, customer, '2026-09-14T10:00:30Z')
    )
    assert.doesNotThrow(() =>
      validateDiscountEvidence(request, jid, human, customer, '2026-09-14T09:00:00Z')
    )
  })

  test('bounds discount by subtotal and binds approval to quantities, sizes and original prices', ({
    assert,
  }) => {
    for (const amount of [0, -1, 705001, 1.5])
      assert.throws(() => cartAmounts(items, 9000, { ...approved, amount }))
    for (const change of [
      { quantity: 2 },
      { size: 'L' },
      { unitPrice: 690000 },
      { unitPrice: null },
      { productId: 'other' },
    ])
      assert.throws(() => cartAmounts([{ ...items[0], ...change }], 9000, approved))
    assert.throws(() => cartAmounts([], 9000, approved))
  })

  test('strict AI protocol supports discount-only and payment reporting without granting payment authority', ({
    assert,
  }) => {
    const intent = {
      action: 'apply_discount',
      confirmationMessageId: customer.message_id,
      items: [],
      recipient: { name: '', phone: '', address: '' },
      shipping: { service: '', cost: null },
      note: '',
      removeItemIds: [],
      discount: request,
    }
    assert.equal(parseCartIntent(intent)?.discount?.amount, 15000)
    assert.equal(parseCartIntent({ ...intent, action: 'report_payment' })?.action, 'report_payment')
    for (const discount of [
      null,
      { ...request, amount: '15000' },
      { ...request, approvalMessageId: '' },
    ])
      assert.throws(() => parseCartIntent({ ...intent, discount }))
    assert.throws(() => parseCartIntent({ ...intent, action: 'confirm_payment' }))
    assert.isNull(parseCartIntent(null))
  })

  test('transaction evidence lookup rejects replay on a different cart fingerprint', async ({
    assert,
  }) => {
    let prior: any = null
    const trx = {
      from(table: any) {
        if (typeof table !== 'string') return table
        let selected = ''
        let isPrior = false
        const query = {
          select() {
            return query
          },
          union() {
            return query
          },
          as() {
            return query
          },
          where(key: any) {
            if (typeof key === 'object') {
              assert.equal(key.jid, jid)
              selected = key.message_id
            }
            return query
          },
          whereRaw(sql: string) {
            isPrior = sql.includes('approvalMessageId')
            return query
          },
          orderBy() {
            return query
          },
          async first() {
            return table === 'whatsapp_messages'
              ? selected === human.message_id
                ? human
                : customer
              : isPrior
                ? prior
                : null
          },
        }
        return query
      },
    }
    assert.deepEqual(await verifyCartDiscount(trx, jid, items, request), approved)
    prior = { summary_json: JSON.stringify({ discountApproval: approved }) }
    assert.deepEqual(await verifyCartDiscount(trx, jid, items, request), approved)
    await assert.rejects(
      () => verifyCartDiscount(trx, jid, [{ ...items[0], quantity: 2 }], request),
      /terikat/
    )
  })
})
