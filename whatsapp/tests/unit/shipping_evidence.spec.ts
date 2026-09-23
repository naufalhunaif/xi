import { test } from '@japa/runner'
import {
  shippingEvidence,
  matchShippingQuote,
  shippingContentsChanged,
} from '#services/shipping_evidence_service'

const data = {
  destination_code: 'DEST',
  weight_kg: 2.4,
  rates: {
    weight_kg: 0.01,
    prices: [
      { service: 'REG23', name: 'REG', price: 8000 },
      { service: 'YES23', name: 'YES', price: 9000 },
    ],
  },
}

test('matches real service aliases and exact prices, preserves total quote weight', ({
  assert,
}) => {
  for (const result of [
    { structured_content: data },
    { structuredContent: data },
    { content: [{ type: 'text', text: JSON.stringify(data) }] },
    {
      content: [
        { type: 'text', text: 'Shipping rates returned.\n\nData:\n' + JSON.stringify(data) },
      ],
    },
  ]) {
    const rows = shippingEvidence([
      {
        server: 'business_fixture',
        tool: 'check_shipping_rates',
        arguments: { destination_code: 'DEST', weight_kg: 2.4 },
        result,
      },
    ])
    assert.lengthOf(rows, 2)
    for (const service of ['YES', 'YES23', ' yes ']) {
      const quote = matchShippingQuote(rows, service, 9000)
      assert.equal(quote?.service, 'YES23')
      assert.equal(quote?.quote.weightKg, 2.4)
      assert.equal(quote?.quote.destinationCode, 'DEST')
    }
    assert.isUndefined(matchShippingQuote(rows, 'YES', 8000))
    assert.isUndefined(matchShippingQuote(rows, 'YES99', 9000))
    assert.isUndefined(matchShippingQuote(rows, 'JNE YES', 9000))
    assert.isUndefined(matchShippingQuote(rows, 'YES', -1))
    assert.isUndefined(matchShippingQuote(rows, '', 9000))
  }
  assert.lengthOf(
    shippingEvidence([
      { tool: 'check_shipping_rates', result: { isError: true, structured_content: data } },
    ]),
    0
  )
  assert.lengthOf(
    shippingEvidence([{ tool: 'get_product', result: { structured_content: data } }]),
    0
  )
  assert.lengthOf(
    shippingEvidence([
      {
        tool: 'check_shipping_rates',
        result: { content: [{ type: 'text', text: 'invalid json' }] },
      },
    ]),
    0
  )
})

test('detects shipping composition and destination changes without re-quoting a human price decision', ({
  assert,
}) => {
  const initial = {
    items: [
      {
        productId: 'custom:photo',
        name: 'Jas + celana',
        modelType: 'custom',
        size: 'M',
        quantity: 1,
        note: '',
        unitPrice: null,
      },
    ],
    recipient: { address: 'Alamat uji' },
  }
  assert.isFalse(
    shippingContentsChanged(initial, {
      ...initial,
      items: [{ ...initial.items[0], unitPrice: 880000 }],
    })
  )
  assert.isTrue(
    shippingContentsChanged(initial, { ...initial, items: [{ ...initial.items[0], quantity: 2 }] })
  )
  assert.isTrue(
    shippingContentsChanged(initial, {
      ...initial,
      items: [{ ...initial.items[0], name: 'Jas + celana + rompi' }],
    })
  )
  assert.isTrue(
    shippingContentsChanged(initial, { ...initial, recipient: { address: 'Alamat lain' } })
  )
})

test('uses the latest MCP quote when a recalculated weight falls in the same tariff band', ({
  assert,
}) => {
  const rows = shippingEvidence(
    [1, 1.15].map((weight_kg) => ({
      tool: 'check_shipping_rates',
      arguments: { weight_kg },
      result: { structured_content: data },
    }))
  )
  assert.equal(matchShippingQuote(rows, 'YES', 9000)?.quote.weightKg, 1.15)
})

test('custom physical changes invalidate shipping while color and evidence bookkeeping preserve it', ({
  assert,
}) => {
  const details = {
    heightCm: 167,
    weightKg: 56,
    fit: '',
    color: 'navy',
    material: 'wool',
    lapel: 'peak',
    buttons: 'one',
    measurements: [{ name: 'Panjang lengan', value: 60, basis: 'garment' as const }],
    notes: '',
    pending: [],
    sourceMessageIds: ['original'],
  }
  const before = {
    items: [
      {
        id: 'jacket',
        productId: 'peak',
        name: 'Peak',
        size: 'custom',
        quantity: 1,
        measurements: { Dada: 96 },
        productionDetails: details,
      },
    ],
    recipient: { address: 'Alamat uji' },
  }
  const withDetails = (change: Record<string, unknown>) => ({
    ...before,
    items: [{ ...before.items[0], productionDetails: { ...details, ...change } }],
  })
  for (const change of [
    { material: 'linen' },
    { lapel: 'notch' },
    { buttons: 'two' },
    { fit: 'loose' },
    { measurements: [{ name: 'Panjang lengan', value: 65, basis: 'garment' }] },
    { measurements: [{ name: 'Panjang lengan', value: 60, basis: 'body' }] },
  ])
    assert.isTrue(shippingContentsChanged(before, withDetails(change)))
  for (const change of [
    { color: 'hitam' },
    { sourceMessageIds: ['new'] },
    { pending: ['approval CS'] },
    { measurements: [{ name: ' ＰＡＮＪＡＮＧ  LENGAN ', value: 60, basis: 'garment' }] },
  ])
    assert.isFalse(shippingContentsChanged(before, withDetails(change)))
  assert.isTrue(
    shippingContentsChanged(before, {
      ...before,
      items: [{ ...before.items[0], measurements: { Dada: 110 } }],
    })
  )
  assert.isFalse(
    shippingContentsChanged(before, {
      ...before,
      items: [
        {
          ...before.items[0],
          measurements: [{ name: ' DADA ', value: 96 }],
          productionDetails: null,
        },
      ],
    })
  )
  assert.equal(details.color, 'navy')
  assert.deepEqual(details.pending, [])
  assert.deepEqual(details.sourceMessageIds, ['original'])
})
