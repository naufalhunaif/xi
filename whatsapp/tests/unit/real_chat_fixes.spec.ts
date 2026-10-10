import { test } from '@japa/runner'
import { readySizeHint, shoppingHints } from '#beta3/context_service'
import { dropGuessedPantsNumber, fixProductionKind, productionWhens } from '#beta3/reply_guards'
import type { LeanCatalogRow } from '#beta3/catalog_service'
import type { LeanHistoryRow } from '#beta3/prompt'

// v3.6.140 — temuan uji chat asli (data contoh).
const row = (product: string, color: string, category: string, sizesReady: string, price = 485000): LeanCatalogRow => ({
  id: Math.random(), product, color, category, price, sizesReady, sizesAll: '', photoUrl: null, materialAvailable: true, features: '',
  featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', active: true, updatedAt: '',
})
const catalog = [
  row('Basic Suit', 'Black 2.0', 'Suits', 'S M L XL'),
  row('Basic Suit', 'Cream', 'Suits', 'S M L'),
  row('Tuxedo', 'Black', 'Suits', 'S M XL'),
  row('Premium Lo Suit', 'Blue', 'Suits', 'M L', 685000),
  row('Basic Suit List White', 'Black', 'Suits', 'S M'),
  row('Basic Suit', 'White', 'Suits', 'S M'),
  row('Setelan Basic Suit', 'Black 2.0', 'Setelan', 'S M L XL', 705000),
]
const hist = (direction: 'in' | 'out', body: string): LeanHistoryRow => ({ direction, body, createdAt: new Date().toISOString() }) as LeanHistoryRow

test.group('Perbaikan temuan chat asli', () => {
  test('ready size M yang mana aja → semua model ready M', ({ assert }) => {
    const hint = readySizeHint('Waduh yang ready stok yang mna aja?', [hist('in', 'M kk Berat 66 kg Tinggi badan 170')], catalog)
    assert.include(hint, 'READY SIZE M')
    assert.include(hint, 'Basic Suit (Black 2.0, Cream')
    assert.include(hint, 'Tuxedo (Black)')
    assert.include(hint, 'Premium Lo Suit (Blue)')
    assert.notInclude(hint, 'Setelan')
    assert.equal(readySizeHint('harganya berapa?', [], catalog), '')
  })

  test('item polos tanpa garis putih → hitam, bukan putih / List White', ({ assert }) => {
    const hint = shoppingHints('yg item polos tanpa garis putih di kerah ada?', catalog).join(' ')
    assert.include(hint, 'Basic Suit - Black 2.0')
    assert.notInclude(hint, 'White')
    // Nama warna katalog persis → tanpa daftar warna sekeluarga.
    assert.notInclude(shoppingHints('ganti black aja deh', catalog).join(' '), 'Warna yang termasuk')
  })

  test('estimasi pre-order vs custom tidak tertukar', ({ assert }) => {
    const ranges = { preorder: '5-10 hari kerja', custom: '7-14 hari kerja' }
    const whens = productionWhens(
      'ESTIMASI PRODUKSI:\npre-order (stok kosong, dibuatkan): 5-10 hari kerja sampai siap kirim → kalau dibayar hari ini, siap kirim sekitar 26 Mei–4 Jun\ncustom (ukuran di luar S–4XL): 7-14 hari kerja sampai siap kirim → kalau dibayar hari ini, siap kirim sekitar 28 Mei–8 Jun'
    )
    assert.deepEqual(whens, { preorder: '26 Mei–4 Jun', custom: '28 Mei–8 Jun' })
    const pre = fixProductionKind(['Maroon belum ada stok jadi dibuatkan (pre-order), pengerjaan sekitar 7-14 hari kerja setelah DP.'], ranges, whens)
    assert.include(pre.pesan[0], 'sekitar 5-10 hari kerja')
    const xs = fixProductionKind(['Untuk XS semuanya dibuatkan dulu jadi kena sekitar 5-10 hari kerja.'], ranges, whens)
    assert.include(xs.pesan[0], '7-14 hari kerja')
    const date = fixProductionKind(['Size XS bisa custom, 7-14 hari kerja, kalau dibayar hari ini siap kirim sekitar 27 Mei-4 Jun'], ranges, whens)
    assert.include(date.pesan[0], 'siap kirim sekitar 28 Mei-8 Jun')
    assert.isFalse(fixProductionKind(['Ready bos, bisa langsung kirim'], ranges, whens).changed)
    const ankle = fixProductionKind(['Bisa dibuatkan bos, pengerjaannya 5-10 hari kerja'], ranges, whens, 'celananya model ankle ya kak')
    assert.include(ankle.pesan[0], '7-14 hari kerja')
  })

  test('nomor celana dari angka lain di riwayat tidak dianggap diketahui', ({ assert }) => {
    const out = dropGuessedPantsNumber(['Pakai size XL cocok bos. Untuk celananya rekomendasi no 37, sesuai?'], 'pinggang biasanya 32')
    assert.isTrue(out.changed)
    assert.notInclude(out.pesan.join(' '), '37')
  })
})
