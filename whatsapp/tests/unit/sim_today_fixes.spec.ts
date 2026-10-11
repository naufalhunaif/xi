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

test.group('uji chat hari ini v3.6.147', () => {
  test('pinggang di atas size chart terbesar tidak dijanjikan custom', async ({ assert }) => {
    const { capOversizeBody } = await import('#beta3/reply_guards')
    const note =
      'PERBANDINGAN SIZE CHART (dihitung sistem):\n- Pants 28-40: pinggang badan 120 cm → 39 = 103 cm, 40 = 106 cm. Lebih besar dari size terbesar (40 = 106 cm): TIDAK bisa dibuat, juga tidak lewat custom.'
    const out = capOversizeBody(
      ['Untuk celana, pinggang 120 cm di atas size terbesar kami (no 40 pinggangnya 106 cm), jadi dibuat custom sesuai ukuran bos ya.', 'Panjang celananya berapa cm bos?'],
      note
    )
    assert.isTrue(out.changed)
    assert.match(out.pesan[0], /pinggang 120 cm belum bisa dibuatkan bos, paling besar celana no 40/)
    assert.notInclude(out.pesan.join(' '), 'custom sesuai')
    // Tanpa janji custom: tidak diubah.
    assert.isFalse(capOversizeBody(['Paling besar no 40 bos.'], note).changed)
  })

  test('harga produk yang fotonya ikut tidak diganti harga seri lain', async ({ assert }) => {
    const { fixContextPrices } = await import('#beta3/price_pattern')
    const pattern = {
      series: {
        reguler: { cells: { 'setelan:db': { price: 805000, big: 905000 }, 'setelan:standar': { price: 705000, big: 805000 } } },
        premium: { cells: { 'setelan:db': { price: 955000, big: 1055000 }, 'setelan:standar': { price: 955000, big: 1055000 } } },
      },
    } as any
    const text = ['itu model Double Breasted hitam kerah satin bos, untuk setelan ukuran besarnya 905.000, ini fotonya ya']
    assert.lengthOf(fixContextPrices(text, pattern, 'premium').changes, 1)
    assert.deepEqual(fixContextPrices(text, pattern, 'premium', undefined, new Set([805000, 905000])), { pesan: text, changes: [] })
  })
})

test.group('uji chat hari ini v3.6.149', () => {
  test('"okee kak" dibalas singkat', async ({ assert }) => {
    const { socialClosing } = await import('#beta3/reply_service')
    assert.equal(socialClosing('okee kak'), 'Siap bos 🙏')
    assert.equal(socialClosing('okesiap kak'), 'Siap bos 🙏')
    assert.equal(socialClosing('makasihh'), 'Sama-sama bos 🙏')
    assert.equal(socialClosing('mohon maaf ya'), 'Santai aja bos 🙏')
  })

  test('batas size sudah dikatakan → tidak diulang tiap giliran', async ({ assert }) => {
    const { capOversizeBody } = await import('#beta3/reply_guards')
    const note = '- Pants 28-40: pinggang badan 120 cm → 40 = 106 cm. Lebih besar dari size terbesar (40 = 106 cm): TIDAK bisa dibuat.'
    const out = capOversizeBody(['Siap bos, panjang celana 95 cm dicatat ya.', 'Celananya dibuat custom sesuai ukuran ya bos.'], note, 'bos', [
      'Untuk pinggang 120 cm belum bisa dibuatkan bos, paling besar celana no 40 (pinggang 106 cm), di atas itu tidak bisa termasuk custom.',
    ])
    assert.deepEqual(out.pesan, ['Siap bos, panjang celana 95 cm dicatat ya.'])
  })

  test('bahu di atas angka chart yang hanya sampai XL tidak dianggap di luar size terbesar', async ({ assert }) => {
    const { compareWithSizeChart } = await import('#beta3/context_service')
    const chart = 'Jas (cm): S dada 94 bahu 39; M dada 98 bahu 42; L dada 100 bahu 44; XL dada 110 bahu 46; XXL dada 116; 3XL dada 120; 4XL dada 124'
    const note = compareWithSizeChart([{ direction: 'in', body: 'lingkar dada 120cm, bahu 53 cm', createdAt: new Date() } as any], chart)
    assert.include(note, 'Paling dekat: 3XL')
    assert.include(note, 'bahu sampai XL')
    assert.notInclude(note, 'TIDAK bisa dibuat')
  })
})

test.group('uji gambar chat asli v3.6.148', () => {
  test('foto pelanggan yang dikutip ikut ke giliran uji', ({ assert }) => {
    const at = new Date()
    const rows = [
      { jid: 'x@s.whatsapp.net', message_id: 'm1', direction: 'in', sender_type: null, body: '', media_type: 'image', media_url: '/media/a.jpg', created_at: at },
      { jid: 'x@s.whatsapp.net', message_id: 'm2', reply_to_message_id: 'm1', direction: 'in', sender_type: null, body: 'yang ini ready L?', media_type: null, media_url: null, created_at: at },
      { jid: 'x@s.whatsapp.net', message_id: 'm3', direction: 'out', sender_type: 'cs', body: 'Ready bos', media_type: null, media_url: null, created_at: at },
    ]
    const segments = realSegments(rows as any)
    // Foto pertama + teks = satu giliran (foto dikirim pelanggan di giliran itu).
    assert.equal(segments[0].gambar, '/media/a.jpg')
    const later = realSegments([
      rows[0],
      { ...rows[2], message_id: 'm0' },
      rows[1],
      { ...rows[2], message_id: 'm4' },
    ] as any)
    const last = later[later.length - 1]
    assert.equal(last.fotoSebelum, '/media/a.jpg')
    assert.isTrue(last.kutipFoto)
  })
})

test.group('uji gambar chat asli v3.6.151', () => {
  test('susulan yang mengklaim pembayaran masuk tidak dikirim', async ({ assert }) => {
    const { claimsCheckedResult } = await import('#beta3/reply_check')
    assert.isTrue(claimsCheckedResult('Sudah kami cek ya bos, pembayarannya masuk'))
    assert.isTrue(claimsCheckedResult('Dananya sudah masuk bos'))
    assert.isFalse(claimsCheckedResult('Kalau sudah siap, kirim nama penerima ya bos'))
    assert.isFalse(claimsCheckedResult('Masih ada yang mau ditanyakan bos?'))
  })
})

test.group('ritme CS asli v3.6.152', () => {
  test('ritme dihitung dari giliran CS manusia; template & giliran AI tidak dihitung', async ({ assert }) => {
    const { csRhythm, styleGuide } = await import('#beta3/style_service')
    const rows: any[] = []
    for (let i = 0; i < 40; i++) {
      const jid = `${i}@s.whatsapp.net`
      rows.push({ jid, direction: 'in', sender_type: null, body: 'ready L kak?' })
      rows.push({ jid, direction: 'out', sender_type: 'cs', body: i % 5 === 0 ? 'Oke siap bos, pakai size apa ya?' : 'Iya bisa bos' })
      rows.push({ jid, direction: 'in', sender_type: null, body: 'oke' })
      rows.push({ jid, direction: 'out', sender_type: 'cs', body: 'Bisa di bantu isi order formatnya bos\nNama :' })
      rows.push({ jid, direction: 'in', sender_type: null, body: 'harga?' })
      rows.push({ jid, direction: 'out', sender_type: 'ai', body: 'Harganya mulai 485.000 bos, mau model apa dan size berapa ya?' })
    }
    const rhythm = csRhythm(rows)!
    assert.equal(rhythm.turns, 40)
    assert.equal(rhythm.words, 3)
    assert.equal(rhythm.questionRate, 20)
    assert.equal(rhythm.openers[0], 'iya bisa')
    const guide = styleGuide({ address: 'bos', emoji: false, length: 40, samples: 40, rhythm })
    assert.include(guide, 'biasanya 3 kata')
    assert.include(guide, 'hanya 20% balasan bertanya')
  })
})

test.group('uji 100 chat v3.6.154', () => {
  test('"Iya stelan" / "Oke aku mau" bukan sekadar ok', async ({ assert }) => {
    const { pureAck } = await import('#beta3/reply_service')
    assert.isTrue(pureAck('Ok..'))
    assert.isTrue(pureAck('okee kak'))
    assert.isTrue(pureAck('Siap makasih bos 🙏'))
    assert.isFalse(pureAck('Iya stelan'))
    assert.isFalse(pureAck('Oke aku mau kak'))
  })

  test('"pembayarannya sudah masuk" tanpa data → dicek dulu', async ({ assert }) => {
    const { dropPaymentClaim } = await import('#beta3/reply_guards')
    const out = dropPaymentClaim(['Bisa bos, pembayarannya sudah masuk dan pengerjaan beskap sekitar 5-10 hari kerja.'], '')
    assert.isTrue(out.changed)
    assert.equal(out.pesan[0], 'Pembayarannya kami cek dulu ya bos')
    assert.notInclude(out.pesan.join(' '), 'sudah masuk')
    assert.include(out.pesan[1], '5-10 hari kerja')
    assert.isFalse(dropPaymentClaim(['Pembayarannya sudah masuk bos'], 'status: lunas').changed)
    assert.isFalse(dropPaymentClaim(['Bukti transfernya sudah kami terima, kami cek dulu ya'], '').changed)
  })
})

test.group('uji 100 chat v3.6.155', () => {
  test('"Bisa disesuaikan bos, biar gak kekecilan" dibuang', async ({ assert }) => {
    const { dropVagueAdjust } = await import('#beta3/reply_guards')
    const out = dropVagueAdjust(['Bisa disesuaikan bos, biar gak kekecilan. Tinggi dan berat badan berapa?'])
    assert.isTrue(out.changed)
    assert.equal(out.pesan[0], 'Tinggi dan berat badan berapa?')
  })
})

test.group('bubble per konteks v3.6.157', () => {
  test('satu bubble panjang dipecah per konteks seperti CS', async ({ assert }) => {
    const { splitLongBubbles } = await import('#beta3/reply_polish')
    const out = splitLongBubbles([
      'Siap bos, tinggi 170 dan berat 96 sudah saya catat. Kalau lihat ukuran badan, dada 120 paling dekat size 3XL (3XL dadanya 120 cm), tapi bahu 53 masih di atas chart jadi tetap dibuat custom sesuai ukuran bos ya.',
    ])
    assert.isTrue(out.changed)
    assert.deepEqual(out.pesan, [
      'Siap bos, tinggi 170 dan berat 96 sudah saya catat',
      'Kalau lihat ukuran badan, dada 120 paling dekat size 3XL (3XL dadanya 120 cm), tapi bahu 53 masih di atas chart jadi tetap dibuat custom sesuai ukuran bos ya',
    ])
  })

  test('bubble pendek, rincian harga, dan format order tidak dipecah', async ({ assert }) => {
    const { splitLongBubbles } = await import('#beta3/reply_polish')
    assert.isFalse(splitLongBubbles(['Iya bisa bos. Pakai size apa ya?']).changed)
    const rincian = 'Jas 485.000 ongkir 80.000. Total 485.000 + 80.000 = 565.000 bos. Untuk pembayaran tf ke rek BRI 123 an Toko agar pesanan langsung kami proses ya bos.'
    assert.isFalse(splitLongBubbles([rincian]).changed)
    assert.isFalse(splitLongBubbles(['Bisa di bantu isi order formatnya bos\nNama :\nAlamat lengkap :']).changed)
  })

  test('kalimat penyambung tidak dipisah dari induknya; titik ribuan & "no." aman', async ({ assert }) => {
    const { splitLongBubbles } = await import('#beta3/reply_polish')
    const out = splitLongBubbles(['Untuk pinggang 107 cm paling dekat celana no. 40 bos, lingkar jadinya 106 cm. Jadi pakai no. 40 ya. Mau sekalian dengan jasnya atau celananya saja bos?'])
    assert.deepEqual(out.pesan, ['Untuk pinggang 107 cm paling dekat celana no. 40 bos, lingkar jadinya 106 cm. Jadi pakai no. 40 ya', 'Mau sekalian dengan jasnya atau celananya saja bos?'])
  })
})

test.group('uji 100 chat v3.6.159', () => {
  test('"Basic Suit Army, setelannya 705.000" tidak diganti harga premium', async ({ assert }) => {
    const { fixContextPrices } = await import('#beta3/price_pattern')
    const pattern = {
      series: {
        reguler: { cells: { 'setelan:standar': { price: 705000, big: 805000 }, 'jas:standar': { price: 485000, big: 585000 } } },
        premium: { cells: { 'setelan:standar': { price: 955000, big: 1055000 }, 'jas:standar': { price: 685000, big: 785000 } } },
      },
    } as any
    const productPrices = new Map([
      ['basic suit', new Set([485000, 585000])],
      ['setelan basic suit', new Set([705000, 805000])],
    ])
    const text = ['Yang paling bawah Basic Suit Army, setelannya 705.000 bos']
    assert.deepEqual(fixContextPrices(text, pattern, 'premium', productPrices), { pesan: text, changes: [] })
  })
})

test.group('pertanyaan gabungan nyambung v3.6.160', () => {
  test('pertanyaan tambahan dipilih yang seproduk/setopik, bukan acak', async ({ assert }) => {
    const { relatedSegment } = await import('#beta3/simulator')
    const candidates = [
      { teks: 'paket sudah sampai bos, makasih' },
      { teks: 'celana no 33 ada? warna hitam' },
      { teks: 'ongkir ke bandung berapa kalau jas 1?' },
      { teks: 'bisa bayar pakai cod?' },
    ]
    const pickedTexts = new Set<string>()
    for (let i = 0; i < 20; i++) pickedTexts.add(relatedSegment(() => i / 20, 'jas hitam size L ada? harganya berapa', candidates)?.teks || '')
    assert.isTrue(pickedTexts.has('ongkir ke bandung berapa kalau jas 1?') || pickedTexts.has('celana no 33 ada? warna hitam'))
    assert.isFalse(pickedTexts.has('paket sudah sampai bos, makasih'))
    assert.isFalse(pickedTexts.has('bisa bayar pakai cod?'))
    assert.isUndefined(relatedSegment(() => 0.5, 'halo', [{ teks: 'paket sudah sampai bos, makasih' }]))
  })
})
