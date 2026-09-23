import { test } from '@japa/runner'
import { catalogNotesRepairInput, applyCatalogNotesRepair } from '#services/catalog_notes_repair'

const fixture = (): any => ({
  action: 'sync',
  confirmationMessageId: 'size-yes',
  note: 'order note',
  items: [
    {
      productId: 'peak',
      name: 'Peak Suit - Black',
      modelType: 'catalog',
      size: 'S',
      quantity: 1,
      unitPrice: 485000,
      modelConsent: { requestMessageId: 'design', approvalMessageId: 'cs' },
      productionDetails: {
        color: 'navy',
        lapel: 'hitam',
        material: '',
        buttons: '',
        heightCm: 167,
        weightKg: 56,
        notes: 'Peak Suit model dasar katalog akan dibuat dengan badan navy dan lapel hitam.',
        sourceMessageIds: ['design'],
      },
    },
  ],
})

test('equivalent wording changes only notes, never product, size, price or consent', ({
  assert,
}) => {
  const before = fixture()
  assert.lengthOf(catalogNotesRepairInput(before), 1)
  const result = applyCatalogNotesRepair(before, {
    items: [
      {
        index: 0,
        equivalent: true,
        notes: 'warna badan navy; lapel hitam',
        unitPrice: 0,
        size: 'XL',
      },
    ],
  })!
  assert.equal(result.items[0].size, 'S')
  assert.equal(result.items[0].unitPrice, 485000)
  assert.deepEqual(result.items[0].modelConsent, before.items[0].modelConsent)
  result.items[0].productionDetails!.notes = before.items[0].productionDetails.notes
  assert.deepEqual(result, before)
})
test('explicit conflicting facts cannot be erased even with a positive model verdict', ({
  assert,
}) => {
  for (const notes of [
    'Badan hitam dengan lapel navy',
    'Badan navy lapel hitam dengan bahan wool',
    'Badan navy lapel hitam satin',
    'Badan navy lapel hitam dengan 2 kancing',
    'Badan navy lapel hitam gratis',
  ]) {
    const intent = fixture()
    intent.items[0].productionDetails.notes = notes
    assert.isEmpty(catalogNotesRepairInput(intent), notes)
    assert.isNull(
      applyCatalogNotesRepair(intent, {
        items: [{ index: 0, equivalent: true, notes: 'warna badan navy; lapel hitam' }],
      })
    )
  }
})
test('provenance is not a second color assignment and cannot replace actual consent', ({
  assert,
}) => {
  const intent = fixture()
  intent.items[0].productionDetails.notes +=
    ' Perubahan warna disetujui CS pada 3EB0B9F76020E9A92E1AB3.'
  assert.lengthOf(catalogNotesRepairInput(intent), 1)
  const updated = applyCatalogNotesRepair(intent, {
    items: [{ index: 0, equivalent: true, notes: 'warna badan navy; lapel hitam' }],
  })!
  assert.deepEqual(updated.items[0].modelConsent, intent.items[0].modelConsent)
  intent.items[0].modelConsent = null
  assert.isEmpty(catalogNotesRepairInput(intent))
})
test('ambiguous, missing, duplicate or invalid output cannot repair the cart', ({ assert }) => {
  for (const items of [
    [],
    [{ index: 0, equivalent: false, notes: 'warna badan navy; lapel hitam' }],
    [{ index: 1, equivalent: true, notes: 'warna badan navy; lapel hitam' }],
    [{ index: 0, equivalent: true, notes: 'badan hitam; lapel navy' }],
    [{ index: 0, equivalent: true, notes: '' }],
    [
      { index: 0, equivalent: true, notes: 'warna badan navy; lapel hitam' },
      { index: 0, equivalent: true, notes: 'warna badan navy; lapel hitam' },
    ],
  ])
    assert.isNull(applyCatalogNotesRepair(fixture(), { items }))
})
test('normal catalog, photo custom and non-sync actions do not request wording repair', ({
  assert,
}) => {
  for (const variant of ['normal', 'custom', 'checkout_balance']) {
    const intent = fixture()
    if (variant === 'normal') intent.items[0].modelConsent = null
    else if (variant === 'custom') intent.items[0].modelType = 'custom'
    else intent.action = variant
    assert.isEmpty(catalogNotesRepairInput(intent))
  }
})
