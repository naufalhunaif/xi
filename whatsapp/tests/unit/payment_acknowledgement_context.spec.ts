import { test } from '@japa/runner'
import { paymentAcknowledgementContext } from '#services/payment_acknowledgement_context'

const jid = 'payment-fixture@lid'
const order = {
  id: 6,
  jid,
  number: 'INV-20260921-fixture',
  total: 713000,
  paid: 235000,
  balance: 478000,
  status: 'active',
  operations: {
    stage: 'production',
    source: 'verified_payment',
    estimate: null,
    eligibleAt: null,
    expectedReadyOn: null,
  },
}
const event = (summary: Record<string, unknown> = {}) => ({
  id: 10,
  jid,
  action: 'payment_confirmed',
  created_at: '2026-09-21T01:00:00Z',
  summary_json: JSON.stringify({
    orderNumber: order.number,
    amount: 235000,
    cartCleared: true,
    ...summary,
  }),
})
const records = (text: string) => JSON.parse(text.split('\n')[1])

test.group('Committed payment acknowledgement context', () => {
  test('links a receipt to its exact order outside the newest five without copying unrelated fields', ({
    assert,
  }) => {
    const newer = Array.from({ length: 5 }, (_, i) => ({
      ...order,
      id: 7 + i,
      number: `OTHER-${i}`,
    }))
    const text = paymentAcknowledgementContext(
      jid,
      [event({ privateNote: 'DO_NOT_COPY', amount: 235000 })],
      [...newer, order]
    )
    const [receipt] = records(text)
    assert.equal(receipt.orderNumber, order.number)
    assert.equal(receipt.eventId, 10)
    assert.equal(receipt.received, 235000)
    assert.isTrue(receipt.orderCreated)
    assert.equal(receipt.order.total, 713000)
    assert.equal(receipt.order.balance, 478000)
    assert.deepEqual(receipt.order.operations, order.operations)
    assert.notInclude(text, 'OTHER-')
    assert.notInclude(text, 'DO_NOT_COPY')
  })
  test('later payments keep the same order and distinguish new transfer from accumulated payment', ({
    assert,
  }) => {
    const [receipt] = records(
      paymentAcknowledgementContext(
        jid,
        [event({ amount: 478000, cartCleared: false })],
        [{ ...order, paid: 713000, balance: 0 }]
      )
    )
    assert.equal(receipt.orderNumber, order.number)
    assert.equal(receipt.received, 478000)
    assert.equal(receipt.order.paid, 713000)
    assert.equal(receipt.order.balance, 0)
    assert.isFalse(receipt.orderCreated)
  })
  test('balance-only checkout is not presented as another cash transfer or inferred production', ({
    assert,
  }) => {
    const [receipt] = records(
      paymentAcknowledgementContext(
        jid,
        [event({ amount: 0, balanceApplied: 713000, orderId: order.id })],
        [{ ...order, paid: 713000, balance: 0, operations: null }]
      )
    )
    assert.equal(receipt.received, 0)
    assert.equal(receipt.balanceApplied, 713000)
    assert.isNull(receipt.order.operations)
  })
  test('payment reports and receipt-reading results cannot become committed payment notices', ({
    assert,
  }) => {
    for (const action of ['payment_reported', 'receipt_read', 'balance_applied'])
      assert.equal(paymentAcknowledgementContext(jid, [{ ...event(), action }], [order]), '')
    assert.equal(paymentAcknowledgementContext(jid, [], [order]), '')
  })
  test('missing, foreign or inconsistent order identities do not borrow another order state', ({
    assert,
  }) => {
    for (const orders of [
      [],
      [{ ...order, jid: 'another@lid' }],
      [{ ...order, number: 'OTHER' }],
    ]) {
      const [receipt] = records(paymentAcknowledgementContext(jid, [event()], orders))
      assert.isNull(receipt.order)
    }
    assert.isNull(
      records(paymentAcknowledgementContext(jid, [event({ orderId: 99 })], [order]))[0].order
    )
    assert.equal(
      paymentAcknowledgementContext(jid, [{ ...event(), jid: 'another@lid' }], [order]),
      ''
    )
  })
  test('keeps current cancelled or queued status instead of deriving progress from an old receipt', ({
    assert,
  }) => {
    const [receipt] = records(
      paymentAcknowledgementContext(
        jid,
        [event()],
        [{ ...order, status: 'cancelled', operations: { ...order.operations, stage: 'queued' } }]
      )
    )
    assert.equal(receipt.order.status, 'cancelled')
    assert.equal(receipt.order.operations.stage, 'queued')
  })
  test('malformed or invalid monetary events add no payment acknowledgement context', ({
    assert,
  }) => {
    for (const summary_json of [
      'broken',
      'null',
      '[]',
      ...[
        { amount: -1 },
        { amount: '235000' },
        { amount: 0 },
        { orderNumber: '' },
        { balanceApplied: -1 },
        { balanceApplied: '235000' },
      ].map((patch) => event(patch).summary_json),
    ])
      assert.equal(paymentAcknowledgementContext(jid, [{ ...event(), summary_json }], [order]), '')
  })
})
