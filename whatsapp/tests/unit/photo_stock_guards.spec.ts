import { test } from '@japa/runner'
import { alignPhotos, offColorPhotos, readyOfferIssues } from '#beta3/reply_check'
import { completePhotos, withoutNoPhotoClauses } from '#beta3/reply_polish'
import type { LeanCatalogRow } from '#beta3/catalog_service'

// v3.6.131 — foto & stok dari uji simulasi (data katalog contoh).
const row = (product: string, color: string, sizesReady: string, photo = true): LeanCatalogRow => ({
  id: 0, product, color, category: 'Suits', price: 485000, sizesReady, sizesAll: '', photoUrl: photo ? `https://x/${product}-${color}.jpg` : null,
  materialAvailable: true, features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
const rows = [
  row('Basic Suit', 'Black 2.0', 'S M L XL'), row('Basic Suit', 'Army', 'M L'), row('Basic Suit Signature', 'Black', '', false),
  row('Peak Suit', 'Black', 'S M L XL'), row('Tuxedo', 'Black', 'S M XL'), row('Tuxedo', 'Army', 'S M L XL'), row('Tuxedo', 'Navy', 'S M'),
  row('Tuxedo', 'Choco', '', false), row('Tuxedo', 'Gray', '', false),
]

test.group('Foto & stok dari uji simulasi', () => {
  test('"belum ada fotonya" bukan janji foto', ({ assert }) => {
    const pesan = ['Untuk Basic Suit Signature Black saat ini belum ada fotonya bos, kalau mau bisa di buatkan ya.']
    assert.notInclude(withoutNoPhotoClauses(pesan[0]), 'Signature')
    assert.deepEqual(completePhotos(pesan, [], 'yg kedua dr terakhir itu fotonya dong', rows), [])
    assert.deepEqual(alignPhotos(pesan, [], rows).added, [])
  })

  test('minta lihat semua warna: foto tidak dibuang karena warna tanpa foto disebut', ({ assert }) => {
    const foto = ['Tuxedo - Black', 'Tuxedo - Army', 'Tuxedo - Navy']
    const pesan = ['Ini warna Tuxedo yang ada fotonya bos.', 'Untuk Choco dan Gray belum ada fotonya, kalau mau bisa dibuatkan ya']
    assert.deepEqual(offColorPhotos(foto, ['pengen liat smua warna tuxedo dong', ...pesan], rows), [])
    // Tanpa permintaan "semua": warna tanpa foto juga tidak membuat foto lain dibuang.
    assert.deepEqual(offColorPhotos(foto, ['tuxedo ada warna apa', ...pesan], rows), [])
  })

  test('produk yang ditawarkan sebagai ready dicek ke size ready warnanya', ({ assert }) => {
    const issues = readyOfferIssues(['Ada bos, size L masih ready', 'Mau model yang mana ya, ada Basic Suit, Peak Suit, sama Tuxedo warna hitam'], 'mas, jas sing ireng ukuran L isih ono ra?', rows)
    assert.lengthOf(issues, 1)
    assert.include(issues[0].detail, 'Tuxedo - Black size L TIDAK ready')
    assert.lengthOf(readyOfferIssues(['Ada bos, size L ready Basic Suit dan Peak Suit hitam'], 'jas hitam ukuran L ada?', rows), 0)
    assert.lengthOf(readyOfferIssues(['Tuxedo hitam size L kosong bos, bisa pre order'], 'tuxedo hitam ukuran L ada?', rows), 0)
  })
})
