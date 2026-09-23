import { test } from '@japa/runner'
import { normalizeColorLanguage, catalogColorSearchHints } from '#services/color_semantics'
import {
  catalogAssignments,
  catalogRequestMatches,
  catalogNotesMatch,
} from '#services/catalog_design_evidence'

test.group('Color language without shade or consent substitution', () => {
  for (const [customer, catalog] of [
    ['BW', 'Broken White'],
    ['ｂｗ', 'Broken-White'],
    ['𝐁𝐖', 'broken white'],
    ['putih gading', 'ivory'],
    ['off-white', 'offwhite'],
    ['biru dongker', 'navy blue'],
    ['abu-abu', 'grey'],
    ['gray', 'abu abu'],
    ['cream', 'krem'],
    ['coklat', 'brown'],
    ['hijau sage', 'sage green'],
    ['merah marun', 'maroon'],
  ])
    test(`${customer} means ${catalog} in an explicit color assignment`, ({ assert }) => {
      const design = catalogAssignments({ color: catalog, lapel: 'black' })
      assert.equal(normalizeColorLanguage(customer), normalizeColorLanguage(catalog))
      assert.isTrue(catalogRequestMatches(`Badan ${customer}, kerah hitam`, design))
      assert.isTrue(catalogNotesMatch(`Warna badan ${customer}; lapel hitam`, design))
      assert.isFalse(catalogRequestMatches(`Badan bukan ${customer}, kerah hitam`, design))
      assert.isFalse(catalogRequestMatches(`Badan hitam, kerah ${customer}`, design))
    })

  for (const [a, b] of [
    ['white', 'broken white'],
    ['putih gading', 'bw'],
    ['cream', 'ivory'],
    ['sage', 'army'],
    ['army', 'olive'],
    ['navy', 'royal blue'],
    ['brown', 'choco'],
    ['maroon', 'burgundy'],
    ['navy', 'navy muda'],
    ['dusty pink', 'pink'],
  ])
    test(`${a} and ${b} must not become the same approved shade`, ({ assert }) => {
      assert.notEqual(normalizeColorLanguage(a), normalizeColorLanguage(b))
      assert.isFalse(
        catalogRequestMatches(
          `Badan ${a}, lapel hitam`,
          catalogAssignments({ color: b, lapel: 'hitam' })
        )
      )
    })

  test('search expands BW/gading candidates once without collapsing white or product identity', ({
    assert,
  }) => {
    const index = catalogColorSearchHints(['Basic Suit - BW', 'Premium BW', 'Pants - Ivory'])
    assert.lengthOf(index, 2)
    assert.deepEqual(index[0].searchAliases, ['broken white', 'bw'])
    assert.include(index[0].nearbyCandidates!, 'putih gading')
    assert.isFalse(index.some((entry) => entry.catalogColor === 'putih'))
    assert.isEmpty(catalogColorSearchHints(['Snowboard', 'Blueprint', 'Unknown Shade']))
  })
})
