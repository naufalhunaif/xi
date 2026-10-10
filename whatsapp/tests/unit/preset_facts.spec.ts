import { test } from '@japa/runner'
import { activePromos, mentionPromoPrices, normalizePromos } from '#beta3/promos'
import { allColorPhotos, relevantFacts } from '#beta3/reply_check'
import type { LeanCatalogRow } from '#beta3/catalog_service'

// v3.6.139 — fakta pasti dipasang sebelum pemeriksa (data contoh).
const row = (product: string, color: string, price: number, category = 'Suits', extra: Partial<LeanCatalogRow> = {}): LeanCatalogRow => ({
  id: Math.random(), product, color, category, price, sizesReady: 'S M L', sizesAll: '', photoUrl: null, materialAvailable: true,
  features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '', ...extra,
})
const catalog = [
  row('Tuxedo', 'Black', 485000, 'Suits', { photoUrl: 'a.jpg' }),
  row('Tuxedo', 'Maroon', 485000, 'Suits', { photoUrl: 'b.jpg' }),
  row('Tuxedo', 'Signature Broken White FW', 485000, 'Suits', { photoUrl: 'c.jpg' }),
  row('Tuxedo', 'Gray', 485000),
  row('Peak Suit', 'Black', 485000, 'Suits', { featuresAi: 'kerah peak lancip, kerah satin mengkilap' }),
  row('Pants', 'Black', 220000, 'Pants'),
]
const promos = activePromos(
  normalizePromos({ items: [{ name: '10.10', scope: 'category', category: 'Suits', discount_type: 'percentage', discount_value: 7, starts_at: '2000-01-01 00:00:00', ends_at: '2999-12-31 23:59:59' }] }),
  new Date('2026-10-10T05:00:00Z')
)

test.group('Fakta pasti sebelum pemeriksa', () => {
  test('harga normal yang kena promo diberi harga promonya', ({ assert }) => {
    const out = mentionPromoPrices(['Tuxedo maroon 485.000 bos, celananya 220.000'], catalog, promos)
    assert.deepEqual(out.added, [485000])
    assert.include(out.pesan[0], '485.000 (promo 10.10 jadi 451.050)')
    // Celana tidak kena promo kategori Suits → tidak diubah.
    assert.include(out.pesan[0], 'celananya 220.000')
  })

  test('sudah menyebut harga promo / total / selisih → tidak diubah', ({ assert }) => {
    assert.lengthOf(mentionPromoPrices(['485.000, lagi promo jadi 451.050 bos'], catalog, promos).added, 0)
    assert.lengthOf(mentionPromoPrices(['Totalnya 485.000 + ongkir 9.000'], catalog, promos).added, 0)
    assert.lengthOf(mentionPromoPrices(['Beda 485.000 bos'], catalog, promos).added, 0)
    assert.lengthOf(mentionPromoPrices(['Tuxedo 485.000 bos'], catalog, []).added, 0)
    const named = activePromos(normalizePromos({ items: [{ name: 'Promo 10.10', scope: 'all', discount_type: 'percentage', discount_value: 7, starts_at: '2000-01-01 00:00:00', ends_at: '2999-12-31 23:59:59' }] }))
    assert.include(mentionPromoPrices(['Tuxedo 485.000 bos'], catalog, named).pesan[0], '(promo 10.10 jadi 451.050)')
  })

  test('minta semua warna → semua varian berfoto ikut', ({ assert }) => {
    const extra = allColorPhotos('pengen liat smua warna tuxedo dong', ['Tuxedo - Black', 'Tuxedo - Maroon'], catalog)
    assert.deepEqual(extra, ['Tuxedo - Signature Broken White FW'])
    assert.deepEqual(allColorPhotos('pengen liat smua warna tuxedo dong', [], catalog).length, 3)
    assert.lengthOf(allColorPhotos('tuxedo black ada?', ['Tuxedo - Black'], catalog), 0)
  })

  test('ciri model ikut fakta pemeriksa', ({ assert }) => {
    const facts = relevantFacts(catalog, ['bedanya peak suit sama basic apa'])
    assert.isTrue(facts.some((line) => line.includes('ciri: kerah peak lancip, kerah satin mengkilap')))
  })
})
