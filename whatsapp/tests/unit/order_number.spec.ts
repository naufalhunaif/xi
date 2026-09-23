import { test } from '@japa/runner'
import { newOrderNumber, orderNumber, insertNumberedOrder } from '#services/order_number'

test('INV date uses WIB at midnight regardless of the server timezone', ({ assert }) => {
  assert.match(newOrderNumber(new Date('2026-09-13T16:59:59.999Z')), /^INV-20260913-[a-f0-9]{7}$/)
  assert.match(newOrderNumber(new Date('2026-09-13T17:00:00.000Z')), /^INV-20260914-[a-f0-9]{7}$/)
  assert.match(newOrderNumber(new Date('2026-12-31T17:00:00.000Z')), /^INV-20270101-[a-f0-9]{7}$/)
  assert.throws(() => newOrderNumber(new Date('invalid')))
})

test('persisted INV is stable while legacy orders retain their original WA number', ({
  assert,
}) => {
  assert.equal(orderNumber({ id: 747 }), 'WA-000747')
  assert.equal(orderNumber({ id: '1000000', order_number: null }), 'WA-1000000')
  const row = { id: 747, order_number: 'INV-20260914-789f38f' }
  assert.equal(orderNumber(row), row.order_number)
  assert.equal(orderNumber({ ...row, id: 5000 }), row.order_number)
})

test('new number is passed to storage once and returned without being regenerated', async ({
  assert,
}) => {
  let stored = ''
  let writes = 0
  const result = await insertNumberedOrder(new Date('2026-09-14T01:00:00Z'), async (number) => {
    stored = number
    writes++
    return [747]
  })
  assert.equal(writes, 1)
  assert.equal(result.number, stored)
  assert.deepEqual(result.result, [747])
  assert.equal(orderNumber({ id: 747, order_number: stored }), stored)
})

test('unique-index collisions retry the insert without repeating payment side effects', async ({
  assert,
}) => {
  let writes = 0
  const result = await insertNumberedOrder(new Date('2026-09-14T01:00:00Z'), async (number) => {
    writes++
    if (writes < 3)
      throw {
        code: 'ER_DUP_ENTRY',
        sqlMessage: "Duplicate entry for key 'w2_whatsapp_orders_number_unique'",
      }
    return number
  })
  assert.equal(writes, 3)
  assert.equal(result.number, result.result)
  assert.match(result.number, /^INV-20260914-[a-f0-9]{7}$/)
})

test('collisions are bounded and unrelated database failures are never retried', async ({
  assert,
}) => {
  let writes = 0
  await assert.rejects(() =>
    insertNumberedOrder(new Date(), async () => {
      writes++
      throw Object.assign(new Error('whatsapp_orders_number_unique'), { code: 'ER_DUP_ENTRY' })
    })
  )
  assert.equal(writes, 8)
  for (const failure of [
    Object.assign(new Error('PRIMARY'), { code: 'ER_DUP_ENTRY' }),
    Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }),
  ]) {
    writes = 0
    await assert.rejects(() =>
      insertNumberedOrder(new Date(), async () => {
        writes++
        throw failure
      })
    )
    assert.equal(writes, 1)
  }
})
