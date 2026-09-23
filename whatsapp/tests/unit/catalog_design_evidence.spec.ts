import { test } from '@japa/runner'
import {
  catalogAssignments,
  catalogRequestMatches,
  catalogNotesMatch,
  modelApprovalRemainder,
} from '#services/catalog_design_evidence'

test.group('Catalog design intent and approval scope', () => {
  const design = catalogAssignments({ color: 'navy', lapel: 'hitam' })
  for (const body of [
    'Warnanya jadi navy bisa jadi kombinasi kerahnya tetep hitam',
    'Badan jas navy, kerah hitam',
    'Lapel hitam, badan navy',
    'Body navy blue, collar black',
    'Bisa gak badan biru navy, kerahnya tetap black?',
    'Navy untuk badan, hitam untuk kerah',
    'Hitam untuk lapel, navy untuk badan jas',
    'Warna badan menjadi navy dengan warna kerah tetap hitam',
    'Badan navy dan lapel hitam, badan tetap navy',
  ])
    test(`same design: ${body}`, ({ assert }) => assert.isTrue(catalogRequestMatches(body, design)))

  for (const body of [
    'Badan hitam, lapel navy',
    'Badan navy, lapel navy',
    'Badan navy atau hitam, lapel hitam',
    'Badan bukan navy, lapel hitam',
    'Badan navy, lapel tidak hitam',
    'Badan navy, lapel hitam, lapel putih',
    'Badan navy, lapel hitam, badan merah',
    'Badan navy muda, lapel hitam',
    'Badan navy, lapel hitam satin',
    'Hitam untuk badan, navy untuk lapel',
    'Pants navy dengan lapel hitam',
    'Ukuran S, celana 30, total 705.000',
    'Iya',
  ])
    test(`different or unresolved intent: ${body}`, ({ assert }) =>
      assert.isFalse(catalogRequestMatches(body, design)))

  for (const notes of [
    'Custom warna badan jas navy dengan lapel tetap hitam.',
    'Badan navy dan kerah black',
    'Navy untuk badan, hitam untuk lapel',
    'Lapel hitam; perubahan warna badan menjadi navy',
    'Custom warna navy kombinasi kerah hitam sesuai persetujuan CS',
    'Badan navy lapel hitam, sudah disetujui oleh CS',
  ])
    test(`production summary preserves roles: ${notes}`, ({ assert }) =>
      assert.isTrue(catalogNotesMatch(notes, design)))

  for (const notes of [
    'Badan hitam, lapel navy',
    'Badan navy, lapel hitam muda',
    'Badan navy, lapel hitam, bahan wool',
    'Badan navy, lapel hitam, 2 kancing',
    'Badan navy, lapel hitam, lunas',
    'Badan navy, lapel hitam, ukuran custom',
    'Badan navy, lapel hitam, sudah checkout',
    'Badan navy lapel hitam, belum disetujui CS',
  ])
    test(`summary cannot add an approval: ${notes}`, ({ assert }) =>
      assert.isFalse(catalogNotesMatch(notes, design)))

  for (const body of [
    'iya bisa bos',
    'Boleh kak.',
    'Oke, disetujui!',
    'Bisa bos, badan navy dengan kerah hitam.',
  ])
    test(`explicit CS approval: ${body}`, ({ assert }) => {
      const remainder = modelApprovalRemainder(body)
      assert.isNotNull(remainder)
      assert.isTrue(catalogNotesMatch(remainder!, design))
    })
  for (const body of [
    'Iya',
    'Gimana bos',
    'Bisa?',
    'Tidak bisa',
    'Bisa kalau produksi setuju',
    'Bisa bos, badan hitam lapel navy',
    'Bisa bos, sudah lunas',
    'Bisa bos, ukuran custom',
    'Bisa 👎',
  ])
    test(`not consent to this design: ${body}`, ({ assert }) => {
      const remainder = modelApprovalRemainder(body)
      assert.isTrue(remainder === null || !catalogNotesMatch(remainder, design))
    })
})
