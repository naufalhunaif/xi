import { test } from '@japa/runner'
import { budgetOf, shoppingHints } from '#beta3/context_service'
import type { LeanCatalogRow } from '#beta3/catalog_service'

// v3.6.133 — petunjuk kelengkapan (katalog contoh).
const row = (product: string, color: string, category: string, price: number, sizesReady = 'S M L'): LeanCatalogRow => ({
  id: Math.random(), product, color, category, price, sizesReady, sizesAll: '', photoUrl: null, materialAvailable: true, features: '',
  featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
const catalog = [
  row('Basic Suit', 'Navy', 'Suits', 485000), row('Basic Suit', 'Blue Ice', 'Suits', 485000), row('Basic Suit', 'Black 2.0', 'Suits', 485000),
  row('Pants', 'Brown 2.0', 'Pants', 220000, '30 34'), row('Pants', 'Choco 2.0', 'Pants', 220000, '32 34'),
  row('Setelan Basic Suit', 'Black 2.0', 'Setelan', 705000), row('Setelan Basic Suit', 'Signature Brown', 'Setelan', 725000),
  row('Setelan Premium Basic Suit', 'Sage Green', 'Setelan', 955000), row('Shirt', 'White', 'Shirt', 175000),
]

test.group('Petunjuk kelengkapan jawaban', () => {
  test('warna sekeluarga disebut semua', ({ assert }) => {
    const blue = shoppingHints('teh, aya jas warna biru teu?', catalog).join(' ')
    assert.include(blue, 'Basic Suit - Navy')
    assert.include(blue, 'Basic Suit - Blue Ice')
    const brown = shoppingHints('celana yg pinggang 34 warna coklat ready?', catalog).join(' ')
    assert.include(brown, 'Pants - Brown 2.0')
    assert.include(brown, 'Pants - Choco 2.0')
  })

  test('budget → pilihan tiap seri yang masuk', ({ assert }) => {
    assert.equal(budgetOf('budget sejutaan'), 1_000_000)
    assert.equal(budgetOf('budget around 700k'), 700_000)
    const hint = shoppingHints('budget sejutaan dpt setelan yg lumayan bagus ga ya kak', catalog).join(' ')
    assert.include(hint, '705.000')
    assert.include(hint, '725.000')
    assert.include(hint, '955.000')
  })

  test('size besar, rasa aman, produk tidak dijual', ({ assert }) => {
    assert.include(shoppingHints('Set S sampai 3xl', catalog).join(' '), 'harga ukuran besar')
    assert.include(shoppingHints('bisa bayar ditempat ga, takut ketipu jujur aja', catalog).join(' '), 'alamat toko fisik')
    const batik = shoppingHints('jual kemeja batik ga kak', catalog).join(' ')
    assert.include(batik, 'tidak dijual')
    assert.include(batik, 'Shirt - White')
    assert.lengthOf(shoppingHints('size M ready?', catalog), 0)
  })
})
