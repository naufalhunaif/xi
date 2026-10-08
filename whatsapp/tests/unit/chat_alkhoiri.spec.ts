import { test } from '@japa/runner'
import { normalizeCatalogInput } from '#beta3/catalog_service'
import { specModelMismatch } from '#beta3/order_service'
import { estimateOrderGrams } from '#beta3/weights'

// v3.6.68 — chat Alkhoiri 8 Okt: beskap "kayak biasa" (kerah shanghai, bukaan tertutup) tercatat di
// order/keranjang sebagai "Bescap Cross Placket"; ongkir 150.000 padahal beskap + celana 1,1 kg (75.000).
const item = (over: Record<string, unknown>) => ({
  product: 'Beskap Clean Look', color: 'Navy', category: 'Suits', price: { min: 485000, max: 585000 }, sizesAll: 'S M L XL XXL 3XL 4XL',
  material: 'Maximotion', materialLinked: true, hidden: true, archived: false, note: 'tidak tampil di web', photoUrl: '', ...over,
})

test.group('chat Alkhoiri 8 Okt (v3.6.68)', () => {
  test('model yang hanya tidak tampil di web (tanpa foto, dari kain toko) masuk katalog AI; arsip & produk invoice tidak', ({ assert }) => {
    assert.isTrue(normalizeCatalogInput(item({})).active)
    assert.isTrue(normalizeCatalogInput(item({ product: 'Double Breasted', hidden: true })).active)
    assert.isFalse(normalizeCatalogInput(item({ archived: true })).active)
    // Produk khusus invoice: tanpa kain terhubung.
    assert.isFalse(normalizeCatalogInput(item({ product: 'Jas Almamater Putri', color: '', material: '', materialLinked: false })).active)
  })

  test('total ditahan bila lembar penjahit belum menyebut produk katalog / menyebut produk lain', ({ assert }) => {
    const products = ['Bescap Cross Placket', 'Beskap Clean Look', 'Pants', 'Basic Suit', 'Setelan Basic Suit', 'Premium Basic Suit']
    const items = 'Bescap Cross Placket - Navy size custom 485.000\nPants - Navy size 32 220.000'
    const spec = 'Model sesuai gambar - Navy\nJas, Celana\nKerah shanghai\nBukaan depan tertutup\n\nCelana\nSize 32'
    assert.include(specModelMismatch(spec, items, products), 'belum produk katalog')
    assert.include(specModelMismatch('Beskap Clean Look - Navy\nJas, Celana', items, products), '≠ model di total')
    assert.equal(specModelMismatch('Bescap Cross Placket - Navy\nJas, Celana', items, products), '')
    // Setelan = jas + celana: tidak dianggap beda model.
    assert.equal(specModelMismatch('Setelan Basic Suit - Black 2.0\nJas, Celana', 'Basic Suit - Black 2.0 size M\nPants - Black 2.0 size 31', products), '')
    assert.include(specModelMismatch('Premium Basic Suit - Gray\nJas', 'Basic Suit - Black 2.0 size M', products), '≠')
    // Spesifikasi kosong / rincian tanpa produk katalog → tidak ditahan oleh aturan ini.
    assert.equal(specModelMismatch('', items, products), '')
  })

  test('berat: blok detail celana tidak dihitung barang kedua (beskap + celana = 1 jas + 1 celana)', ({ assert }) => {
    const weights = { jas: 700, celana: 400, rompi: 250, kemeja: 250, beskap: 700, lainnya: 1000 }
    const spec = 'Model sesuai gambar - Navy\nJas, Celana\nUkuran badan: dada 97 cm\nKerah shanghai\n\nCelana\nSize 32\nUkuran badan: pinggang 82 cm, panjang celana 92 cm'
    assert.equal(estimateOrderGrams(spec, {}, weights), 1100)
    // Item kedua yang memang beda (ada nama produk / jumlah) tetap dihitung.
    assert.equal(estimateOrderGrams('Basic Suit - Black\nJas\n\nPants - Navy\nCelana', {}, weights), 1100)
    assert.equal(estimateOrderGrams('Basic Suit - Black\nJas, Celana\n\nCelana\n2 pcs', {}, weights), 1100 + 800)
  })
})
