import { test } from '@japa/runner'
import { findRejectedWeightAttempt } from '#services/orion_rejection_evidence'
import { awbNumber, prepareOrionShipment } from '#services/orion_shipping_contract'
const cart = {
  recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture' },
  shipping: { destinationCode: 'FIXTURE', weightKg: 1.1, service: 'REG', cost: 8000 },
  items: [{ name: 'Fixture', quantity: 1 }],
}
const rejection = {
  id: 'AUDIT1',
  tool_name: 'create_awb',
  status: 'failed',
  result_json: null,
  error_message: 'Weight must be greater than zero.',
  completed_at: '2026-09-15 10:00:00',
  arguments_json: JSON.stringify({
    data: { order_id: 'REF1', phone: cart.recipient.phone, code: 'FIXTURE', weight: 1.1 },
  }),
}
const response = (records: any[]) => ({ structuredContent: { records, has_more: false } })
test.group('Orion observed response and rejection contracts', () => {
  test('reads the nested AWB object returned by Orion', ({ assert }) => {
    assert.equal(
      awbNumber({ id: 'row-id', awb: { order_id: 'REF1', awb: 'FIXTURE123456' } }),
      'FIXTURE123456'
    )
  })
  test('rate lookup stays in kilograms while create payload uses grams', async ({ assert }) => {
    const calls: any[] = []
    const payload = await prepareOrionShipment(
      async (name, args) => {
        calls.push({ name, args })
        return {
          structuredContent:
            name === 'get_orion_data'
              ? { code: 'FIXTURE', zip_code: '53264', full_address: cart.recipient.address }
              : { rates: [{ service_code: 'REG', price: 8000 }] },
        }
      },
      cart,
      'REF1'
    )
    assert.equal(payload.weight, 1100)
    assert.equal(calls.find((call) => call.name === 'check_shipping_rates').args.weight_kg, 1.1)
  })
  test('accepts exact, unconsumed validation evidence only', async ({ assert }) => {
    assert.equal(
      await findRejectedWeightAttempt(async () => response([rejection]), ['REF1'], cart, []),
      'AUDIT1'
    )
    assert.isNull(
      await findRejectedWeightAttempt(async () => response([rejection]), ['REF1'], cart, ['AUDIT1'])
    )
  })
  test('timeout, other orders, successes, mismatched recipient and ambiguous failures cannot reset a create', async ({
    assert,
  }) => {
    for (const rows of [
      [],
      [{ ...rejection, error_message: 'Failed to create AWB.' }],
      [{ ...rejection, status: 'success' }],
      [{ ...rejection, result_json: '{}' }],
      [{ ...rejection, arguments_json: '{"data":{"order_id":"OTHER"}}' }],
      [{ ...rejection, arguments_json: '{"data":{"order_id":"REF1","phone":"OTHER"}}' }],
      [rejection, { ...rejection, id: 'AUDIT2' }],
      [rejection, { ...rejection, status: 'pending', id: 'AUDIT2' }],
    ]) {
      assert.isNull(await findRejectedWeightAttempt(async () => response(rows), ['REF1'], cart, []))
    }
  })
})
