import { test } from '@japa/runner'
import { matchAutoTotal } from '#beta3/order_service'
import { polishWithPhotos } from '#beta3/reply_polish'
import { fixCodClaim, NO_COD_REPLY } from '#beta3/reply_guards'

// v3.6.67 — ulasan room uji pemilik 8 Okt (grosir 6 jas, kancing 2, REG).
test.group('ulasan chat 8 Okt (v3.6.67)', () => {
  test('"Pake reg aja, jadi berapa" → total grosir terkirim: harga XXL/3XL dari catatan "XXL-4XL" ikut dihitung', ({ assert }) => {
    const catalog = [{ product: 'Basic Suit', color: 'Black 2.0', price: 485000, note: 'XXL-4XL 585.000', active: true, category: 'Suits' }]
    const rincian = ['S', 'M', 'L', 'XL', 'XXL', '3XL'].map((size) => `Basic Suit - Black 2.0 size ${size} ${['XXL', '3XL'].includes(size) ? '585.000' : '485.000'}`).join('\n')
    const result = matchAutoTotal({ rincian, subtotal: 3110000, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['pake reg aja'], [], undefined, { jas: 15000 })
    // Dulu: "subtotal AI 3110000 ≠ katalog 2820000" (XXL/3XL dihitung 485.000) → "totalnya saya hitung dulu".
    assert.isTrue(result.ok)
    assert.equal(result.ok && result.subtotal, 3020000)
    assert.include(result.ok ? result.items : '', 'Diskon grosir 6 jas -90.000')
    // 4XL juga harga besar.
    const big = matchAutoTotal({ rincian: 'Basic Suit - Black 2.0 size 4XL', subtotal: 0, layanan: 'CTC' }, catalog, [{ service: 'CTC', price: 45000 }], ['reg'])
    assert.equal(big.ok && big.subtotal, 585000)
  })

  test('AI sengaja diam ("Oke") tanpa foto → tidak mengirim "Ini fotonya bos"', ({ assert }) => {
    assert.deepEqual(polishWithPhotos([], [], 'Oke'), [])
    // Foto dikirim & tawaran dibuang semua → pengantar foto tetap ada.
    assert.deepEqual(polishWithPhotos(['Mau saya kirimkan fotonya bos?'], [{ caption: 'Basic Suit - Black 2.0' }], 'ok'), ['Ini fotonya bos'])
  })

  test('"Bisa cod ya" → bukan "Bisa COD bos" (COD tidak tersedia)', ({ assert }) => {
    const fixed = fixCodClaim(['Bisa COD bos, untuk 15 pcs Basic Suit Black 2.0-nya size apa saja ya?'], 'Bisa cod ya')
    assert.isTrue(fixed.changed)
    assert.include(fixed.pesan[0], NO_COD_REPLY)
    assert.notMatch(fixed.pesan[0], /bisa cod bos/i)
    // Jawaban yang benar tidak diubah; tidak ditanya COD → tidak disentuh.
    assert.isFalse(fixCodClaim(['Maaf bos, belum bisa COD ya'], 'bisa cod?').changed)
    assert.isFalse(fixCodClaim(['Bisa bos'], 'bisa custom?').changed)
  })
})
