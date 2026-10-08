import { test } from '@japa/runner'
import { dropPhotoOffers, pointToSentPhotos, polishWithPhotos, skipSentPhotos } from '#beta3/reply_polish'

// v3.6.58 — chat Instagram 7 Okt: jawaban AI "Untuk gaya gen z biasanya pilih model slimfit seperti
// Basic Suit atau Peak Suit bos" diringkas sistem jadi "Ini fotonya bos" (+2 foto), lalu tetap ditanya
// "Mau lihat modelnya bos?". Pelanggan jawab "Boleh" → dua foto yang sama dikirim lagi.
const photos = [{ caption: 'Basic Suit - Black 2.0' }, { caption: 'Peak Suit - Black' }]

test.group('foto: jawaban tetap utuh & tidak dikirim ulang (v3.6.58)', () => {
  test('jawaban berisi saran tidak diganti "Ini fotonya bos"; tawaran "mau lihat?" dibuang karena foto ikut dikirim', ({ assert }) => {
    const out = polishWithPhotos(
      ['Untuk gaya gen z biasanya pilih model slimfit seperti Basic Suit atau Peak Suit bos', 'Mau lihat modelnya bos?'],
      photos,
      'Kalau buat gaya gen z yang kayak apa ya kak'
    )
    assert.deepEqual(out, ['Untuk gaya gen z biasanya pilih model slimfit seperti Basic Suit atau Peak Suit bos'])
    // Tawaran di ujung bubble yang sama juga dibuang.
    assert.deepEqual(
      polishWithPhotos(['Untuk gaya gen z biasanya pilih model slimfit seperti Basic Suit atau Peak Suit bos. Mau lihat modelnya bos?'], photos, 'gaya gen z kayak apa'),
      ['Untuk gaya gen z biasanya pilih model slimfit seperti Basic Suit atau Peak Suit bos.']
    )
  })

  test('daftar nama saja tetap diringkas (caption foto sudah menyebut nama)', ({ assert }) => {
    assert.deepEqual(
      polishWithPhotos(['Ini Basic Suit dan Peak Suit bos, semuanya 485.000'], photos, 'Seperti apa'),
      ['Ini fotonya bos, harganya 485.000']
    )
  })

  test('tawaran model LAIN atau tanpa foto tidak dibuang', ({ assert }) => {
    assert.deepEqual(dropPhotoOffers(['Ini fotonya bos', 'Mau lihat model lainnya bos?'], 2), ['Ini fotonya bos', 'Mau lihat model lainnya bos?'])
    assert.deepEqual(dropPhotoOffers(['Mau saya kirim fotonya bos?'], 0), ['Mau saya kirim fotonya bos?'])
    // Balasan hanya berisi tawaran, foto ikut dikirim → cukup pengantar foto.
    assert.deepEqual(dropPhotoOffers(['Mau saya kirimkan fotonya bos?'], 1), [])
    assert.deepEqual(polishWithPhotos(['Mau saya kirimkan fotonya bos?'], photos, 'ok'), ['Ini fotonya bos'])
  })

  test('"Boleh" sesudah foto terkirim → foto yang sama tidak dikirim lagi, pengantar menunjuk foto di atas', ({ assert }) => {
    const now = Date.parse('2026-10-07T10:00:00Z')
    const rows = [
      { direction: 'in', body: 'Kalau buat gaya gen z yang kayak apa ya kak', createdAt: new Date(now - 120_000) },
      { direction: 'out', body: 'Untuk gaya gen z biasanya pilih model slimfit bos', createdAt: new Date(now - 100_000) },
      // Instagram: gambar (tanpa teks) lalu caption sebagai teks terpisah.
      { direction: 'out', body: '', createdAt: new Date(now - 99_000) },
      { direction: 'out', body: 'Basic Suit - Black 2.0', createdAt: new Date(now - 99_000) },
      { direction: 'out', body: '', createdAt: new Date(now - 98_000) },
      { direction: 'out', body: 'Peak Suit - Black', createdAt: new Date(now - 98_000) },
      { direction: 'out', body: 'Mau lihat modelnya bos?', createdAt: new Date(now - 97_000) },
      { direction: 'in', body: 'Boleh', current: true, createdAt: new Date(now) },
    ]
    const fresh = skipSentPhotos(photos, rows, 'Boleh', { now })
    assert.deepEqual(fresh.photos, [])
    assert.deepEqual(fresh.repeated, ['Basic Suit - Black 2.0', 'Peak Suit - Black'])
    assert.deepEqual(pointToSentPhotos(['Ini fotonya bos, harganya 485.000']), ['Fotonya sudah saya kirim di atas bos, harganya 485.000'])
    // Foto lain tetap dikirim.
    assert.deepEqual(skipSentPhotos([{ caption: 'Tuxedo - Black' }, ...photos], rows, 'tuxedo?', { now }).photos, [{ caption: 'Tuxedo - Black' }])
    // Minta kirim ulang / foto tidak muncul → dikirim lagi.
    assert.lengthOf(skipSentPhotos(photos, rows, 'kirim ulang fotonya kak', { now }).photos, 2)
    assert.lengthOf(skipSentPhotos(photos, rows, 'fotonya gak muncul', { now }).photos, 2)
    // Sudah lama (lebih dari 6 jam) → boleh dikirim lagi.
    assert.lengthOf(skipSentPhotos(photos, rows, 'Boleh', { now: now + 7 * 3600_000 }).photos, 2)
  })
})
