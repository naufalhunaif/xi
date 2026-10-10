import { test } from '@japa/runner'
import { colorBase, colorVariantsIn, type LeanCatalogRow } from '#beta3/catalog_service'
import { shoppingHints } from '#beta3/context_service'
import { colorVariantIssues } from '#beta3/reply_check'

// v3.6.136 — satu warna bisa beberapa varian di katalog (data contoh).
const row = (product: string, color: string, category: string, active = true): LeanCatalogRow => ({
  id: Math.random(), product, color, category, price: 485000, sizesReady: 'S M L', sizesAll: '', photoUrl: null, materialAvailable: true,
  features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active, updatedAt: '',
})
const catalog = [
  row('Basic Suit', 'Navy', 'Suits'), row('Setelan Basic Suit', 'Navy 2.0', 'Setelan'), row('Basic Suit', 'Signature Navy', 'Suits'),
  row('Tuxedo', 'Navy', 'Suits'), row('Basic Suit', 'Maroon', 'Suits'), row('Jahit Jas', 'Maroon 2.0', 'Jahit', false),
]

test.group('Varian warna', () => {
  test('dasar warna tanpa seri/versi', ({ assert }) => {
    assert.equal(colorBase('Signature Navy'), 'navy')
    assert.equal(colorBase('Navy 2.0'), 'navy')
    assert.equal(colorBase('Signature Dark Olive'), 'dark olive')
  })

  test('hanya warna yang disebut dan punya >1 varian aktif', ({ assert }) => {
    const groups = colorVariantsIn('jas navy ada yg lebih gelap?', catalog)
    assert.lengthOf(groups, 1)
    assert.include(groups[0].text, 'Navy 2.0')
    assert.include(groups[0].text, 'Signature Navy')
    assert.lengthOf(colorVariantsIn('jas maroon beda ga', catalog), 0)
  })

  test('petunjuk saat pelanggan tanya gelap/terang', ({ assert }) => {
    const hint = shoppingHints('Mas kalo jas navy ada yang warnanya gimana aja, takut lebih gelap atau cerah', catalog).join(' ')
    assert.include(hint, 'Navy 2.0')
    assert.notInclude(shoppingHints('jas navy berapa', catalog).join(' '), 'beberapa varian')
  })

  test('klaim "cuma satu warna" ditandai', ({ assert }) => {
    const issues = colorVariantIssues(
      ['Untuk navy paling satu warna navy bos, bukan pilihan navy muda atau navy tua terpisah.'],
      'Mas kalo jas navy ada yang warnanya gimana aja',
      catalog
    )
    assert.lengthOf(issues, 1)
    assert.include(issues[0].detail, 'Signature Navy')
    assert.lengthOf(colorVariantIssues(['Navy ada tiga varian: Navy, Navy 2.0, Signature Navy.'], 'jas navy', catalog), 0)
  })
})
