import { test } from '@japa/runner'
import {
  normalizeProductionDetails,
  hasCustomMeasurements,
  productionFingerprint,
} from '#services/order_item_details'
import { groupOrderSnapshot, groupOrderParts } from '#services/order_operations_service'

export const detailsFixture = () => ({
  heightCm: 168,
  weightKg: 84,
  fit: 'regular',
  color: 'Black',
  material: 'Wool',
  lapel: 'peak',
  buttons: '2 buttons',
  measurements: [
    { name: 'Lingkar pinggang', value: 96, basis: 'body' as const },
    { name: 'Lingkar pinggang', value: 100, basis: 'garment' as const },
  ],
  notes: 'Tanpa belahan belakang',
  pending: [],
  sourceMessageIds: ['source-1'],
})

test.group('Order item production facts', () => {
  test('separates body and finished garment measurements and keeps units explicit', ({
    assert,
  }) => {
    const details = normalizeProductionDetails(detailsFixture())!
    assert.equal(details.heightCm, 168)
    assert.equal(details.weightKg, 84)
    assert.lengthOf(details.measurements, 2)
    assert.isTrue(hasCustomMeasurements({ measurements: {}, productionDetails: details }))
    assert.isFalse(
      hasCustomMeasurements({
        measurements: {},
        productionDetails: { ...details, measurements: [] },
      })
    )
    assert.isTrue(hasCustomMeasurements({ measurements: { waist: 80 } }))
  })
  test('legacy/missing facts stay unknown and invalid numbers or unclassified new measurements are rejected', ({
    assert,
  }) => {
    assert.isNull(normalizeProductionDetails(undefined))
    for (const patch of [
      { heightCm: '168' },
      { weightKg: -1 },
      { weightKg: Infinity },
      { measurements: [{ name: 'Waist', value: 38, basis: 'unknown' }] },
    ])
      assert.throws(() => normalizeProductionDetails({ ...detailsFixture(), ...patch }))
    assert.throws(
      () =>
        normalizeProductionDetails({
          ...detailsFixture(),
          measurements: [detailsFixture().measurements[0], detailsFixture().measurements[0]],
        }),
      /duplikat/
    )
  })
  test('approval fingerprint changes with facts but not source-only additions', ({ assert }) => {
    const original = normalizeProductionDetails(detailsFixture())!
    assert.deepEqual(
      productionFingerprint(original),
      productionFingerprint({ ...original, sourceMessageIds: ['source-1', 'source-2'] })
    )
    assert.notDeepEqual(
      productionFingerprint(original),
      productionFingerprint({ ...original, lapel: 'notch' })
    )
  })
  test('production group includes wearer and garment facts but redacts recipient contact data and excludes source IDs', ({
    assert,
  }) => {
    const details = {
      ...detailsFixture(),
      notes: 'Tanpa belahan belakang. Jl. Private 99 6281234567890',
      pending: ['Panjang lengan'],
    }
    const snapshot = groupOrderSnapshot({
      id: 47,
      order_number: 'INV-TEST',
      paid: 100,
      total: 100,
      snapshot_json: JSON.stringify({
        recipient: { name: 'Fixture', address: 'Jl. Private 99', phone: '6281234567890' },
        items: [
          {
            name: 'Custom peak jas',
            size: 'custom',
            quantity: 1,
            image: '/fixture.jpg',
            measurements: {},
            approval: 'approved',
            productionDetails: details,
          },
        ],
      }),
    })
    const body = groupOrderParts(snapshot)
      .map((part) => part.text)
      .join('\n')
    for (const expected of [
      '168 cm',
      '84 kg',
      'Lapel: peak',
      'Kancing: 2 buttons',
      'Badan · Lingkar pinggang: 96 cm',
      'Pakaian jadi · Lingkar pinggang: 100 cm',
      'Perlu dilengkapi: Panjang lengan',
      'Persetujuan ukuran: approved',
    ])
      assert.include(body, expected)
    for (const secret of ['Jl. Private', '6281234567890', 'source-1'])
      assert.notInclude(JSON.stringify(snapshot), secret)
    assert.equal(groupOrderParts(snapshot).at(-1)?.image, '/fixture.jpg')
  })
})
