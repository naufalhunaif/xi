import { test } from '@japa/runner'
import {
  findOrionAwb,
  orionData,
  orionTrackingData,
  orionDestinationAddress,
  prepareOrionShipment,
  shipmentMovement,
  shipmentDelivery,
} from '#services/orion_shipping_contract'
const response = (data: any) => ({ structuredContent: data })
const village = (name: string, code = 'CXP10022') => ({
  code,
  subdistrict_name: name,
  district_name: 'PATIMUAN',
  city_name: 'CILACAP',
  province_name: 'JAWA TENGAH',
  zip_code: '53264',
  full_address: `${name}, PATIMUAN, CILACAP, JAWA TENGAH, 53264`,
})
const destinationCart = () => ({
  recipient: {
    name: 'Fixture',
    phone: '628000000001',
    address:
      'Jl. Patimuan–Kedungreja, Cinyawang, Kecamatan Patimuan, Kabupaten Cilacap, Jawa Tengah 53264',
  },
  shipping: { destinationCode: 'CXP10022', service: 'YES23', cost: 9000, weightKg: 1 },
  items: [{ name: 'Suit', quantity: 1 }],
})
test.group('Orion shipping protocol boundaries', () => {
  test('delivery requires a matching, dated delivery event, without changing pickup time', ({
    assert,
  }) => {
    const data = {
      awb: 'FIXTURE123',
      history: [
        { status: 'picked_up', timestamp: '2026-09-13T12:00:00Z' },
        { status: 'out_for_delivery', timestamp: '2026-09-14T09:00:00Z' },
        { status: 'delivered', timestamp: '2026-09-14T12:00:00Z' },
      ],
    }
    assert.equal(shipmentMovement(data, 'FIXTURE123')?.at, '2026-09-13T12:00:00.000Z')
    assert.equal(shipmentDelivery(data, 'FIXTURE123')?.at, '2026-09-14T12:00:00.000Z')
    assert.isNull(shipmentDelivery({ ...data, history: data.history.slice(0, 2) }, 'FIXTURE123'))
    assert.isNull(shipmentDelivery(data, 'FIXTURE123', new Date('2026-09-15')))
    assert.throws(() => shipmentDelivery(data, 'OTHER123'), 'TRACKING_ID_MISMATCH')
    for (const date of ['', 'not-a-date', '2999-01-01'])
      assert.isNull(
        shipmentDelivery(
          { awb: 'FIXTURE123', history: [{ status: 'delivered', date }] },
          'FIXTURE123'
        )
      )
    assert.isNull(
      shipmentDelivery({ awb: 'FIXTURE123', status: 'delivered', history: [] }, 'FIXTURE123')
    )
    assert.equal(
      shipmentDelivery(
        {
          cnote: { cnote_no: 'FIXTURE123' },
          history: [{ desc: 'DELIVERED TO RECIPIENT', date: '14-09-2026 19:00' }],
        },
        'FIXTURE123'
      )?.status,
      'delivered'
    )
  })
  test('uses the matching destination region, not the street or first village sharing its code', async ({
    assert,
  }) => {
    const calls: string[] = []
    const cart = destinationCart()
    const payload = await prepareOrionShipment(
      async (name, args) => {
        calls.push(name)
        if (name === 'get_orion_data') return response({ record: village('BULUPAYUNG') })
        if (name === 'search_destinations') {
          assert.equal(args.query, 'cinyawang')
          return response({ records: [village('BULUPAYUNG'), village('CINYAWANG')] })
        }
        assert.equal(name, 'check_shipping_rates')
        return response({ rates: [{ service_code: 'YES23', price: 9000 }] })
      },
      cart,
      'INV-FIXTURE'
    )
    assert.equal(payload.street, cart.recipient.address)
    assert.equal(payload.address, 'CINYAWANG, PATIMUAN, CILACAP, JAWA TENGAH, 53264')
    assert.equal(payload.code, 'CXP10022')
    assert.equal(payload.zip_code, '53264')
    assert.deepEqual(calls, ['get_orion_data', 'search_destinations', 'check_shipping_rates'])
  })
  test('resolves a missing code from the matching administrative destination', async ({
    assert,
  }) => {
    const cart = destinationCart()
    cart.shipping.destinationCode = ''
    const payload = await prepareOrionShipment(
      async (name) => {
        assert.notEqual(name, 'get_orion_data')
        return name === 'search_destinations'
          ? response({ records: [village('CINYAWANG')] })
          : response({ rates: [{ service_code: 'YES23', price: 9000 }] })
      },
      cart,
      'INV-FIXTURE'
    )
    assert.equal(payload.address, village('CINYAWANG').full_address)
    assert.equal(payload.code, 'CXP10022')
  })
  test('keeps a short customer address without requiring a road, house number or RT/RW', async ({
    assert,
  }) => {
    for (const address of [
      'Cinyawang, Patimuan, Cilacap',
      'Desa Cinyawang, Kecamatan Patimuan, Kabupaten Cilacap',
    ]) {
      const cart = destinationCart()
      cart.recipient.address = address
      const calls: string[] = []
      const payload = await prepareOrionShipment(
        async (name) => {
          calls.push(name)
          if (name === 'get_orion_data') return response({ record: village('CINYAWANG') })
          assert.equal(name, 'check_shipping_rates')
          return response({ rates: [{ service_code: 'YES23', price: 9000 }] })
        },
        cart,
        'INV-FIXTURE'
      )
      assert.equal(payload.street, address)
      assert.equal(payload.address, village('CINYAWANG').full_address)
      assert.equal(payload.phone, cart.recipient.phone)
      assert.deepEqual(calls, ['get_orion_data', 'check_shipping_rates'])
    }
  })
  test('a short but ambiguous destination still requires disambiguation before rates', async ({
    assert,
  }) => {
    const cart = destinationCart()
    cart.recipient.address = 'Patimuan, Cilacap'
    let ratesCalled = false
    await assert.rejects(
      () =>
        prepareOrionShipment(
          async (name) => {
            if (name === 'get_orion_data') return response({ record: village('CINYAWANG') })
            if (name === 'search_destinations')
              return response({ records: [village('CINYAWANG'), village('BULUPAYUNG')] })
            ratesCalled = true
            throw new Error('Unexpected rate lookup')
          },
          cart,
          'INV-FIXTURE'
        ),
      'SHIPPING_DESTINATION_REQUIRED'
    )
    assert.isFalse(ratesCalled)
  })
  test('does not substitute the street when destination data is missing, conflicting or ambiguous', async ({
    assert,
  }) => {
    for (const rows of [
      [],
      [village('BULUPAYUNG')],
      [village('CINYAWANG', 'OTHER')],
      [village('CINYAWANG'), { ...village('CINYAWANG'), zip_code: '12345' }],
    ]) {
      let ratesCalled = false
      await assert.rejects(
        () =>
          prepareOrionShipment(
            async (name) => {
              if (name === 'get_orion_data')
                return response({ code: 'CXP10022', zip_code: '53264' })
              if (name === 'search_destinations') return response({ records: rows })
              ratesCalled = true
              throw new Error('Unexpected tool')
            },
            destinationCart(),
            'INV-FIXTURE'
          ),
        'SHIPPING_DESTINATION_REQUIRED'
      )
      assert.isFalse(ratesCalled)
    }
  })
  test('prefers Orion full_address and supports structured administrative fields', ({ assert }) => {
    assert.equal(
      orionDestinationAddress({
        ...village('CINYAWANG'),
        name: 'Other name',
        address: 'Other address',
      }),
      village('CINYAWANG').full_address
    )
    assert.equal(
      orionDestinationAddress({ ...village('CINYAWANG'), full_address: null }),
      village('CINYAWANG').full_address
    )
    assert.equal(orionDestinationAddress({ code: 'CXP10022', zip_code: '53264' }), '')
  })
  test('observed Cnote-not-found waits for an update without proving shipment', ({ assert }) => {
    const value = {
      awb: 'FIXTURE123',
      tracking: {
        awb: 'FIXTURE123',
        status: null,
        data: { error: 'Cnote No. Not Found.', status: false },
      },
    }
    for (const result of [
      response(value),
      {
        isError: false,
        content: [
          { type: 'text', text: `AWB tracking returned.\n\nData:\n${JSON.stringify(value)}` },
        ],
      },
    ]) {
      const tracking = orionTrackingData(result, 'FIXTURE123')
      assert.equal(tracking.trackingState, 'awaiting_update')
      assert.isNull(shipmentMovement(tracking, 'FIXTURE123'))
      // Same payload must not weaken AWB creation/lookup validation.
      assert.throws(() => orionData(result), 'ORION_RESPONSE_INVALID')
    }
  })
  test('tracking wait exception never hides auth/tool failures, mismatched IDs or corrupt data', ({
    assert,
  }) => {
    const value = {
      awb: 'FIXTURE123',
      tracking: {
        awb: 'FIXTURE123',
        status: null,
        data: { error: 'Cnote No. Not Found.', status: false },
      },
    }
    assert.throws(
      () => orionTrackingData(response({ ...value, awb: 'OTHER123' }), 'FIXTURE123'),
      'TRACKING_ID_MISMATCH'
    )
    assert.throws(
      () =>
        orionTrackingData(
          response({ ...value, tracking: { ...value.tracking, awb: 'OTHER123' } }),
          'FIXTURE123'
        ),
      'TRACKING_ID_MISMATCH'
    )
    for (const result of [
      { ...response(value), isError: true },
      response({ ...value, success: false }),
      response({
        ...value,
        tracking: { ...value.tracking, data: { error: 'Unauthorized', status: false } },
      }),
      response({
        ...value,
        tracking: {
          ...value.tracking,
          data: { ...value.tracking.data, history: [{ status: 'delivered' }] },
        },
      }),
      { content: [{ type: 'text', text: '<html>502 Bad Gateway</html>' }] },
    ])
      assert.throws(() => orionTrackingData(result, 'FIXTURE123'), 'ORION_RESPONSE_INVALID')
  })
  test('preserves the observed weight rejection code, without accepting failed tool data', ({
    assert,
  }) => {
    assert.throws(
      () =>
        orionData({
          isError: true,
          content: [{ type: 'text', text: 'Weight must be greater than zero.' }],
        }),
      'ORION_WEIGHT_REJECTED'
    )
    assert.throws(
      () => orionData(response({ success: false, error: 'Weight must be greater than zero.' })),
      'ORION_WEIGHT_REJECTED'
    )
  })
  test('a 0.15 kg parcel uses 150 grams for AWB but kilograms for rates', async ({ assert }) => {
    const calls: any[] = []
    const payload = await prepareOrionShipment(
      async (name, args) => {
        calls.push({ name, args })
        return name === 'get_orion_data'
          ? response({ code: 'FIXTURE', zip_code: '53264', full_address: 'Fixture region' })
          : response({ rates: [{ service_code: 'YES23', price: 9000 }] })
      },
      {
        recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture' },
        shipping: { destinationCode: 'FIXTURE', service: 'YES23', cost: 9000, weightKg: 0.15 },
        items: [{ name: 'Vest', quantity: 1 }],
      },
      'INV-FIXTURE'
    )
    assert.equal(payload.weight, 150)
    assert.equal(payload.street, 'Fixture')
    assert.equal(payload.address, 'Fixture region')
    assert.equal(calls.find((call) => call.name === 'check_shipping_rates').args.weight_kg, 0.15)
  })
  test('recognizes observed JNE history and parses its timestamp as WIB', ({ assert }) => {
    const data = {
      awb: 'FIXTURE123',
      tracking: {
        awb: 'FIXTURE123',
        data: {
          cnote: { cnote_no: 'FIXTURE123' },
          history: [
            {
              date: '14-09-2026 10:25',
              desc: 'SHIPMENT PICKED UP BY JNE COURIER [CILACAP]',
              code: 'PU0',
            },
            { date: '14-09-2026 10:26', desc: 'SHIPMENT RECEIVED AT [CILACAP]', code: 'RC1' },
          ],
        },
      },
    }
    assert.deepEqual(shipmentMovement(data, 'FIXTURE123'), {
      status: 'picked_up',
      at: '2026-09-14T03:25:00.000Z',
    })
    assert.isNull(shipmentMovement(data, 'FIXTURE123', new Date('2026-09-15')))
    assert.throws(
      () => shipmentMovement({ ...data, awb: 'OTHER123' }, 'FIXTURE123'),
      'TRACKING_ID_MISMATCH'
    )
    data.tracking.data.cnote.cnote_no = 'OTHER123'
    assert.throws(() => shipmentMovement(data, 'FIXTURE123'), 'TRACKING_ID_MISMATCH')
  })
  test('JNE codes require matching AWB, known description, and a valid event date', ({
    assert,
  }) => {
    for (const event of [
      { code: 'PU0', desc: 'BOOKED', date: '14-09-2026 10:25' },
      { code: 'UNKNOWN', desc: 'SHIPMENT PICKED UP BY JNE COURIER', date: '14-09-2026 10:25' },
      { code: 'PU0', desc: 'SHIPMENT PICKED UP BY JNE COURIER', date: '31-02-2026 10:25' },
      { code: 'PU0', desc: 'SHIPMENT PICKED UP BY JNE COURIER', date: '14-09-2999 10:25' },
    ])
      assert.isNull(
        shipmentMovement({ cnote: { cnote_no: 'FIXTURE123' }, history: [event] }, 'FIXTURE123')
      )
  })
  test('lookup follows pagination and matches the exact order reference', async ({ assert }) => {
    const offsets: any[] = []
    const row = await findOrionAwb(async (_name, args) => {
      offsets.push(args.offset)
      return response(
        args.offset === 0
          ? {
              records: [{ order_id: 'prefix-ref', awb: 'WRONG123' }],
              has_more: true,
              next_offset: 1,
            }
          : { records: [{ order_id: 'ref', awb: 'RIGHT123' }], has_more: false }
      )
    }, 'ref')
    assert.equal(row.awb, 'RIGHT123')
    assert.deepEqual(offsets, [0, 1])
  })
  test('duplicate references, malformed pages and tool errors fail closed', async ({ assert }) => {
    await assert.rejects(
      () =>
        findOrionAwb(
          async () =>
            response({
              records: [
                { order_id: 'ref', awb: 'AWB11111' },
                { order_id: 'ref', awb: 'AWB22222' },
              ],
              has_more: false,
            }),
          'ref'
        ),
      'MULTIPLE_AWBS'
    )
    await assert.rejects(
      () =>
        findOrionAwb(async () => response({ records: [], has_more: true, next_offset: 0 }), 'ref'),
      'ORION_RESPONSE_INVALID'
    )
    assert.throws(
      () => orionData({ isError: true, content: [{ type: 'text', text: '{"awb":"AWB11111"}' }] }),
      'ORION_RESPONSE_INVALID'
    )
    assert.throws(
      () => orionData(response({ data: { success: false, awb: 'AWB11111' } })),
      'ORION_RESPONSE_INVALID'
    )
  })
  test('AWB booking, missing history and future events cannot mark shipped', async ({ assert }) => {
    assert.isNull(
      shipmentMovement(
        { awb: 'AWB11111', history: [{ status: 'booked', timestamp: new Date().toISOString() }] },
        'AWB11111'
      )
    )
    assert.throws(
      () => shipmentMovement({ awb: 'AWB11111', status: 'delivered' }, 'AWB11111'),
      'TRACKING_DETAILS_REQUIRED'
    )
    assert.isNull(
      shipmentMovement({ history: [{ status: 'picked_up', date: '2999-01-01' }] }, 'AWB11111')
    )
    assert.throws(
      () => shipmentMovement({ awb: 'WRONG123', history: [] }, 'AWB11111'),
      'TRACKING_ID_MISMATCH'
    )
  })
  test('uses earliest verified movement, not latest delivery date or an old reused AWB', async ({
    assert,
  }) => {
    const events = {
      history: [
        { status: 'delivered', timestamp: '2026-09-14T12:00:00Z' },
        { status: 'picked_up', timestamp: '2026-09-13T12:00:00Z' },
      ],
    }
    assert.equal(shipmentMovement(events, 'AWB11111')?.at, '2026-09-13T12:00:00.000Z')
    assert.isNull(shipmentMovement(events, 'AWB11111', new Date('2026-09-15')))
  })
  test('does not confuse customer body weight with parcel weight', async ({ assert }) => {
    const cart = {
      items: [{ productionDetails: { weightKg: 84 } }],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture' },
      shipping: { service: 'REG', cost: 8000 },
    }
    await assert.rejects(
      () =>
        prepareOrionShipment(
          async () => {
            throw new Error('must not call')
          },
          cart,
          'ref'
        ),
      'SHIPPING_WEIGHT_REQUIRED'
    )
  })
})
