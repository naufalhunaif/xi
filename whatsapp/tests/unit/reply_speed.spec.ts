import { test } from '@japa/runner'
import { matchAutoTotal } from '#beta3/order_service'
import { susulanNeedsTotal } from '#beta3/reply_service'

// v3.6.43 — total pre-order & susulan (berkas ini dulu berisi uji v3.6.42 yang dibatalkan).
test.group('total pre-order & susulan (v3.6.43)', () => {
  // v3.6.43 (uji 6 Okt, sesi 2): AI menyusun rincian pre-order 535.000 + 220.000 = 755.000, tapi
  // "harganya 535.000" di luar 20 pesan terakhir → total tertahan "baris tidak cocok katalog".
  test('total pre-order: rincian yang jumlahnya = total yang sudah disebut toko diterima', ({ assert }) => {
    const catalog = [
      { product: 'Tuxedo Double Breasted', color: 'Black', price: 535000, note: '', active: true },
      { product: 'Tuxedo', color: 'Maroon', price: 485000, note: '', active: true },
    ]
    const prices = [{ service: 'CTC', price: 9000 }, { service: 'CTCYES', price: 11000 }]
    const draft = {
      rincian: 'Tuxedo Double Breasted - Maroon size S 535.000\nPants - Maroon size 31 220.000',
      subtotal: 755000,
      layanan: 'CTC',
    }
    // Hanya total 755.000 yang terbaca dari chat → tetap diterima.
    const ok = matchAutoTotal(draft, catalog, prices, ['reg'], [755000])
    assert.isTrue(ok.ok)
    assert.equal(ok.ok && ok.subtotal, 755000)
    assert.equal(ok.ok && ok.shippingCost, 9000)
    // Tanpa total yang pernah disebut toko → tetap ditahan.
    assert.isFalse(matchAutoTotal(draft, catalog, prices, ['reg'], []).ok)
    // Jumlah baris tidak sama dengan subtotal → ditahan.
    assert.isFalse(matchAutoTotal({ ...draft, rincian: 'Tuxedo Double Breasted - Maroon size S 535.000' }, catalog, prices, ['reg'], [755000]).ok)
  })

  test('susulan yang menyebut total/DP/rekening dikenali (dibatalkan sebelum total terkirim)', ({ assert }) => {
    assert.isTrue(susulanNeedsTotal('Pre ordernya bisa DP dulu sekitar setengah dari total ya bos, pelunasan saat siap kirim.'))
    assert.isTrue(susulanNeedsTotal('Kalau sudah transfer kabari ya bos'))
    assert.isFalse(susulanNeedsTotal('Kalau mau ambil setelannya, saya bantu cek size-nya ya bos'))
  })
})
