import { test } from '@japa/runner'
import { dropVagueAdjust, fixProductionKind, keepNonProgress } from '#beta3/reply_guards'
import { dropPhotoOffers } from '#beta3/reply_polish'
import { fixCatalogColors } from '#beta3/color_fix'
import { realSegments } from '#beta3/simulator'

// v3.6.147 — temuan uji 40 chat asli (seed 1422) di v3.6.146. Data pelanggan di sini fiktif.
test.group('uji chat asli v3.6.146', () => {
  test('tanggal pre-order "23-29 Apr" di estimasi custom diganti tanggal custom', ({ assert }) => {
    const out = fixProductionKind(
      ['Bisa bos, custom nanti disesuaikan ukuran ya. Pengerjaan 7-14 hari kerja, kalau dibayar hari ini siap kirim sekitar 23-29 Apr.'],
      { preorder: '5-10 hari kerja', custom: '7-14 hari kerja' },
      { preorder: '23 Apr–29 Apr', custom: '25 Apr–4 Mei' },
      'custom bisa?'
    )
    assert.isTrue(out.changed)
    assert.include(out.pesan[0], '25 Apr-4 Mei')
    assert.notInclude(out.pesan[0], '23-29')
    assert.include(out.pesan[0], '7-14 hari kerja')
  })

  test('"abu gelap" tetap Dark Gray walau foto terakhir Black 2.0', ({ assert }) => {
    const catalog = [
      { product: 'Basic Suit', color: 'Black 2.0' },
      { product: 'Basic Suit', color: 'Dark Gray' },
    ]
    const chat = [
      { direction: 'out', body: 'Basic Suit - Black 2.0', mediaType: 'image' },
      { direction: 'in', body: 'Warna abu gelap saya butuh jas vest celana ukuran L' },
    ]
    const fixed = fixCatalogColors('Basic Suit - Dark Gray', catalog, chat)
    assert.deepEqual(fixed.swaps, [])
    assert.equal(fixed.text, 'Basic Suit - Dark Gray')
  })

  test('tanya progres + maksud lain: maksud lain tetap dijawab', ({ assert }) => {
    const rest = keepNonProgress(
      'kak orderan saya blm dikirim ya? terus kalau besok mau datang buat janji custom bisa?',
      ['Pesanannya sudah dikirim kemarin bos. Untuk besok Sabtu toko buka 09.00-15.00, bisa datang langsung ya.'],
      ''
    )
    assert.lengthOf(rest, 1)
    assert.include(rest[0], 'Sabtu')
    assert.notInclude(rest[0], 'dikirim kemarin')
  })

  test('tawaran "sekalian saya kirim fotonya?" dibuang bila foto sudah ikut', ({ assert }) => {
    assert.deepEqual(
      dropPhotoOffers(['Pagi bos, ada, jas maroon ready ada Basic Suit, Tuxedo, sama Premium Li Suit', 'Mau lihat yang mana bos, atau sekalian saya kirim fotonya?'], 3),
      ['Pagi bos, ada, jas maroon ready ada Basic Suit, Tuxedo, sama Premium Li Suit']
    )
    // Tanpa foto, tawaran tetap.
    assert.lengthOf(dropPhotoOffers(['Mau lihat yang mana bos, atau sekalian saya kirim fotonya?'], 0), 1)
  })

  test('"bisa disesuaikan ukurannya biar pas" tanpa custom dibuang', ({ assert }) => {
    const out = dropVagueAdjust(['Iya bos, kalau dulu pakai M dan sekarang takut kekecilan, biasanya bisa disesuaikan ukurannya biar pas. Untuk tinggi dan berat badan sekarang berapa?'])
    assert.isTrue(out.changed)
    assert.equal(out.pesan[0], 'Iya bos, kalau dulu pakai M dan sekarang takut kekecilan. Untuk tinggi dan berat badan sekarang berapa?')
    // Custom: dibiarkan.
    assert.isFalse(dropVagueAdjust(['Bisa custom bos, nanti bisa disesuaikan ukurannya biar pas.']).changed)
  })

  test('uji chat hari ini: balasan AI ikut sebagai pembanding', ({ assert }) => {
    const rows = [
      { jid: 'x@s.whatsapp.net', direction: 'in', sender_type: null, body: 'ada jas navy?', media_type: null, media_url: null, created_at: new Date() },
      { jid: 'x@s.whatsapp.net', direction: 'out', sender_type: 'ai', body: 'Ada bos', media_type: null, media_url: null, created_at: new Date() },
    ]
    assert.lengthOf(realSegments(rows as any), 0)
    const today = realSegments(rows as any, true)
    assert.lengthOf(today, 1)
    assert.isTrue(today[0].ai)
    assert.deepEqual(today[0].jawaban, ['Ada bos'])
  })
})
