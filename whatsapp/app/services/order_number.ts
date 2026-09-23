import { randomBytes } from 'node:crypto'
import { DateTime } from 'luxon'

/** Stored public reference. NULL identifies legacy orders; never renumber those on read. */
export function orderNumber(order: { id: number | string; order_number?: string | null }) {
  return order.order_number || `WA-${String(order.id).padStart(6, '0')}`
}

export function newOrderNumber(createdAt = new Date()) {
  const date = DateTime.fromJSDate(createdAt, { zone: 'Asia/Jakarta' })
  if (!date.isValid) throw new Error('Invalid order date.')
  return `INV-${date.toFormat('yyyyMMdd')}-${randomBytes(4).toString('hex').slice(0, 7)}`
}

/** The database unique index arbitrates collisions, including concurrent inserts. */
export async function insertNumberedOrder<T>(
  createdAt: Date,
  insert: (number: string) => PromiseLike<T>
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const number = newOrderNumber(createdAt)
    try {
      return { number, result: await insert(number) }
    } catch (error) {
      const failure = error as { code?: string; message?: string; sqlMessage?: string }
      if (
        failure.code !== 'ER_DUP_ENTRY' ||
        !String(failure.sqlMessage || failure.message).includes('whatsapp_orders_number_unique') ||
        attempt === 7
      )
        throw error
    }
  }
  throw new Error('Unable to allocate order number.')
}
