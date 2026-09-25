import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { parseOrderForm, parseLooseAddress, tidyLooseAddress, looseAddressForm, renderGroupOrderMessage, renderTotalMessage } from '#beta3/order_service'
import {
  findCatalogVariant,
  renderCatalogDigest,
  normalizeCatalogInput,
  type LeanCatalogRow,
} from '#beta3/catalog_service'
import { keywords, pickExamples, type LeanExample } from '#beta3/examples_service'
import { addProductionDays, buildLeanPrompt, closedDaysFromStore, parseLeanDecision, renderProductionEstimate } from '#beta3/prompt'
import { mergeCustomerNote } from '#beta3/customer_service'
import { dropRepeatedQuestions, resolvePhotos, selectLeanSkill } from '#beta3/reply_service'
import { normalizeBox } from '#beta3/refs_service'
import { matchAutoTotal } from '#beta3/order_service'
import {
  extractBodyMeasure,
  extractShippingQuery,
  groupDestinations,
  normalizeCity,
  pickArea,
  renderShippingRates,
} from '#beta3/mcp'

const row = (partial: Partial<LeanCatalogRow>): LeanCatalogRow => ({
  id: 1,
  product: 'Tuxedo',
  color: 'Black',
  category: 'Tuxedo',
  price: 485000,
  sizesReady: 'S M XL',
  sizesAll: 'S M L XL',
  photoUrl: 'https://cdn.example.test/tuxedo-black.jpg',
  materialAvailable: true,
  features: '',
  featuresAi: '',
  material: '',
  sizeGroup: '',
  fit: 'slim fit',
  note: '',
  active: true,
  updatedAt: new Date().toISOString(),
  ...partial,
})

test.group('beta3 · form order', () => {
  test('membaca form order seperti yang dikirim pelanggan', ({ assert }) => {
    const form = parseOrderForm(
      'Nama : Arif Husaini\nAlamat Lengkap ; Yayasan Nurani Kota Bogor, Jalan Setapak No. 29\nKecamatan : Tanah sereal\nKabupaten : Bogor \nKode pos : 169169\nNo telp ; 087825583828\n\nNote : Tuxedo brown ( size M, tinggi 161 cm, berat 44 kg'
    )
    assert.isNotNull(form)
    assert.equal(form!.customerName, 'Arif Husaini')
    assert.equal(form!.district, 'Tanah sereal')
    assert.equal(form!.regency, 'Bogor')
    assert.equal(form!.postalCode, '169169')
    assert.equal(form!.phone, '087825583828')
    assert.match(form!.note, /Tuxedo brown/)
  })

  test('alamat tempelan tanpa label tetap terbaca untuk ongkir', ({ assert }) => {
    const shopee = parseLooseAddress(
      'Deva Wahyu Hidayat\n085157754566\nJalan Kapt Tendean, Balong Barat (Dekost 2 ), KAB. NGAWI, NGAWI, JAWA TIMUR, ID, 63216'
    )
    assert.deepEqual(shopee, { district: 'NGAWI', regency: 'KAB. NGAWI', postalCode: '63216' })
    const inline = parseLooseAddress('Jl. Merdeka No 10 Kec. Serpong, Kota Tangerang Selatan 15310 hp 08123456789')
    assert.equal(inline!.district, 'Serpong')
    assert.equal(inline!.regency, 'Kota Tangerang Selatan')
    assert.equal(inline!.postalCode, '15310')
    assert.isNull(parseLooseAddress('size M ada bos? kalau ke kota bandung ongkirnya berapa'))
    assert.isNull(parseLooseAddress('Nama : A\nAlamat : Jl X\nKode pos : 12345'))
  })

  test('estimasi produksi menyebut tanggal siap kirim', ({ assert }) => {
    const now = new Date('2026-09-25T03:00:00Z') // Jumat
    assert.equal(addProductionDays(now, 3, true).toISOString().slice(0, 10), '2026-09-30')
    assert.equal(addProductionDays(now, 3, false).toISOString().slice(0, 10), '2026-09-28')
    const text = renderProductionEstimate(
      { rules: { preorder: { enabled: true, minDays: 3, maxDays: 7, estimateDays: null, dayType: 'working', startsAfter: 'payment' } } },
      now
    )
    assert.include(text, 'siap kirim sekitar 30 Sep–6 Okt')
    const store = 'TOKO: X.\nOrder lewat chat/website bisa 24 jam. Toko fisik buka Sen-Sab 09:00-17:00, Min tutup WIB (untuk yang mau datang/ukur langsung).'
    assert.deepEqual(closedDaysFromStore(store), [0])
    assert.equal(addProductionDays(now, 3, true, [0]).toISOString().slice(0, 10), '2026-09-29')
    assert.include(renderProductionEstimate({ rules: {} }, now, store + '\nLIBUR: x'), 'belum diatur')
  })

  test('alamat tempelan dirapikan tanpa pengulangan', ({ assert }) => {
    const text =
      'Deva Wahyu Hidayat\n085157754566\nJalan Kapt Tendean, Balong Barat (Dekost 2 ), KAB. NGAWI, NGAWI, JAWA TIMUR, ID, 63216'
    const tidy = tidyLooseAddress(text, { district: 'NGAWI', city: 'NGAWI', province: 'JAWA TIMUR' })!
    assert.equal(tidy.name, 'Deva Wahyu Hidayat')
    assert.equal(tidy.phone, '085157754566')
    assert.equal(tidy.full, 'Jl. Kapt. Tendean, Balong Barat (Dekost 2), Kec. Ngawi, Kab. Ngawi, Jawa Timur 63216')
    const inline = tidyLooseAddress('Budi\nJl. Merdeka No 10 RT 02/RW 03 Kec. Serpong, Kota Tangerang Selatan, Banten 15310 hp 08123456789')!
    assert.equal(inline.full, 'Jl. Merdeka No. 10 RT 02/RW 03, Kec. Serpong, Kota Tangerang Selatan, Banten 15310')
  })

  test('referensi gambar: kotak dinormalkan dan dibaca dari keputusan AI', ({ assert }) => {
    assert.deepEqual(normalizeBox([350, 170, 300, 280]), [350, 170, 300, 280])
    assert.deepEqual(normalizeBox([-5, 900, 50, 400]), [0, 900, 50, 100])
    assert.isNull(normalizeBox([1, 2, 3]))
    const decision = parseLeanDecision(
      JSON.stringify({ pesan: ['siap bos, dicatat ya'], foto: [], catatan: '', tahap: 'lain', serah_cs: false, alasan: '', susulan: '', spesifikasi: '',
        referensi: [{ gambar: 1, bagian: 'kerah', catatan: 'hitam mengkilap', kotak: [350, 170, 300, 280] }, { gambar: 0, bagian: 'x', catatan: '', kotak: [] }] })
    )
    assert.lengthOf(decision.referensi!, 1)
    assert.equal(decision.referensi![0].bagian, 'kerah')
  })

  test('alamat tempelan menjadi form order', ({ assert }) => {
    const form = looseAddressForm(
      'Deva Wahyu Hidayat\n085157754566\nJalan Kapt Tendean, Balong Barat (Dekost 2 ), KAB. NGAWI, NGAWI, JAWA TIMUR, ID, 63216'
    )!
    assert.equal(form.customerName, 'Deva Wahyu Hidayat')
    assert.equal(form.phone, '085157754566')
    assert.equal(form.postalCode, '63216')
    const noName = looseAddressForm('Jl. Merdeka No 10 Kec. Serpong, Kota Tangerang Selatan 15310', 'Budi', '0812')!
    assert.equal(noName.customerName, 'Budi')
    assert.isNull(looseAddressForm('size M ada bos? kalau ke kota bandung ongkirnya berapa'))
  })

  test('pertanyaan yang baru saja ditanyakan tidak diulang', ({ assert }) => {
    const rows = [
      { direction: 'out' as const, body: 'ini foto tuxedo putihnya bos, biasanya pakai size apa?', createdAt: '' },
      { direction: 'in' as const, body: 'Ini ready to wear yah?', createdAt: '', current: true },
    ]
    assert.deepEqual(
      dropRepeatedQuestions(['Iya ready bos, size S M L XL ada', 'biasanya pakai size apa bos?'], rows),
      ['Iya ready bos, size S M L XL ada']
    )
    assert.deepEqual(dropRepeatedQuestions(['biasanya pakai size apa bos?'], rows), ['biasanya pakai size apa bos?'])
    assert.deepEqual(dropRepeatedQuestions(['alamatnya di mana bos?'], rows), ['alamatnya di mana bos?'])
  })

  test('pesan biasa bukan form', ({ assert }) => {
    assert.isNull(parseOrderForm('Mau order jasnya'))
    assert.isNull(parseOrderForm('Nama saya Arif, alamatnya nanti saya kirim'))
  })

  test('pesan grup produksi tanpa alamat dan telepon', ({ assert }) => {
    const text = renderGroupOrderMessage({
      id: 12,
      order_number: 'PO-20260923-001',
      customer_name: 'oyen',
      spec: '1. Beskap Clean Look - Choco, size M, jas saja\n   kerah: shanghai hitam',
      address: 'jl lapangan bola',
      phone: '0822',
      total: 502000,
      shipping_service: 'REG',
    })
    assert.include(text, 'PESANAN BARU PO-20260923-001')
    assert.include(text, 'kerah: shanghai hitam')
    assert.include(text, 'lunas 502.000 (REG)')
    assert.notInclude(text, 'lapangan bola')
    assert.notInclude(text, '0822')
  })

  test('pesan total meniru format CS', ({ assert }) => {
    const text = renderTotalMessage({
      items: 'Tuxedo Brown 485.000',
      subtotal: 485000,
      shippingService: 'one day',
      shippingCost: 19000,
    })
    assert.include(text, 'Ongkir one day 19.000')
    assert.include(text, 'Total 485.000 + 19.000 = 504.000 bos')
  })
})

test.group('beta3 · katalog digest', () => {
  test('warna dikelompokkan per produk menurut keadaannya', ({ assert }) => {
    const text = renderCatalogDigest([
      row({}),
      row({ id: 2, color: 'Brown', sizesReady: '', photoUrl: null, note: 'tidak tampil di web' }),
      row({
        id: 3,
        color: 'Grey',
        sizesReady: '',
        photoUrl: null,
        materialAvailable: false,
        active: false,
      }),
    ])
    assert.include(text, 'Tuxedo | 485.000 | slim fit')
    assert.include(text, 'ready: Black (S M XL)')
    assert.include(text, 'tanpa foto: Brown')
    assert.notInclude(text, 'Grey')
  })

  test('katalog asli 328 varian tetap ringkas', async ({ assert }) => {
    const list = JSON.parse(
      await readFile(
        new URL('../../resources/beta3/katalog-chameleon-import.json', import.meta.url),
        'utf8'
      )
    ) as Array<Record<string, unknown>>
    const rows = list.map((item, index) => {
      const input = normalizeCatalogInput(item)
      return row({
        id: index + 1,
        product: input.product,
        color: input.color || '',
        category: input.category || '',
        price: input.price ?? null,
        sizesReady: String(input.sizesReady || ''),
        sizesAll: String(input.sizesAll || ''),
        photoUrl: input.photoUrl || null,
        materialAvailable: Boolean(input.materialAvailable),
        fit: '',
        note: input.note || '',
      })
    })
    const text = renderCatalogDigest(rows)
    const tokens = Math.round(text.length / 3.7)
    assert.isBelow(tokens, 3000)
    assert.include(text, 'Setelan Tuxedo | 705.000 (XXL-3XL 855.000)')
    assert.include(text, 'Tuxedo Double Breasted | 535.000')
  })

  test('normalisasi input JSON longgar', ({ assert }) => {
    const item = normalizeCatalogInput({
      nama: 'Basic Suit',
      warna: 'Light Gray',
      harga: 'Rp 485.000',
      ready: ['s', 'm'],
      foto: 'https://x/y.jpg',
      bahan: 1,
    })
    assert.equal(item.product, 'Basic Suit')
    assert.equal(item.price, 485000)
    assert.equal(item.sizesReady, 'S M')
    assert.isTrue(item.materialAvailable)
  })

  test('nama varian dari AI dicocokkan ke baris katalog', ({ assert }) => {
    const rows = [
      row({}),
      row({
        id: 2,
        product: 'Basic Suit',
        color: 'Light Gray',
        photoUrl: 'https://cdn.example.test/lg.jpg',
      }),
    ]
    assert.equal(findCatalogVariant(rows, 'Tuxedo - Black')?.id, 1)
    assert.equal(findCatalogVariant(rows, 'basic suit light gray')?.id, 2)
    assert.isUndefined(findCatalogVariant(rows, 'Tuxedo Navy'))
    const photos = resolvePhotos(rows, ['Tuxedo - Black', 'Tuxedo - Black', 'Bescap Navy'])
    assert.lengthOf(photos, 1)
    assert.equal(photos[0].caption, 'Tuxedo - Black')
  })
})

test.group('beta3 · contoh CS', () => {
  test('memilih contoh paling mirip dan menghormati tahap', async ({ assert }) => {
    const list = JSON.parse(
      await readFile(new URL('../../resources/beta3/cs_examples.json', import.meta.url), 'utf8')
    ) as LeanExample[]
    assert.isAtLeast(list.length, 20)
    const picked = pickExamples(list, 'Ngukur nya gimana?', 'tanya_size', 5)
    assert.equal(picked[0].customerText, 'Ngukur nya gimana?')
    assert.isAtMost(picked.length, 5)
    assert.deepEqual(keywords('Mau yang tuxedo warna grey ada?'), ['tuxedo', 'warna', 'grey'])
  })
})

test.group('beta3 · prompt dan keluaran', () => {
  test('prompt lengkap tetap di bawah 10 ribu token', async ({ assert }) => {
    const skill = await readFile(
      new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url),
      'utf8'
    )
    const list = JSON.parse(
      await readFile(new URL('../../resources/beta3/cs_examples.json', import.meta.url), 'utf8')
    ) as LeanExample[]
    const rows = Array.from({ length: 120 }, (_, index) =>
      row({ id: index + 1, product: `Model ${index % 12}`, color: `Warna ${index}` })
    )
    const history = Array.from({ length: 30 }, (_, index) => ({
      direction: index % 2 ? ('out' as const) : ('in' as const),
      senderType: index % 2 ? 'ai' : null,
      body: 'Pesan contoh yang panjangnya wajar untuk percakapan WhatsApp sehari-hari bos.',
      mediaType: null,
      createdAt: new Date(),
      current: index === 29,
    }))
    const prompt = buildLeanPrompt({
      skill,
      catalog: renderCatalogDigest(rows),
      examples: pickExamples(list, 'Tuxedo brown ada?', 'tanya_model'),
      customerNote: 'Nama: Arif\nSize: XS (TB 161 / BB 43)',
      chatNote: 'produk: Tuxedo Brown\ntahap: tanya_size',
      history,
      message: 'Tuxedo brown ada?',
      paymentMethods: [{ name: 'BRI', destination: '1234567890', accountName: 'Toko' }],
    })
    assert.isBelow(prompt.size.tokens, 10_000)
    assert.include(prompt.user, 'KATALOG')
    assert.include(prompt.user, 'CONTOH JAWABAN CS')
    assert.include(prompt.user, '>> ')
    assert.equal(prompt.system.trim(), skill.trim())
  })

  test('keluaran JSON diparse dan dibatasi', ({ assert }) => {
    const decision = parseLeanDecision(
      'teks pengantar {"pesan":["Siap bos","Mau size apa?","ketiga"],"foto":["Tuxedo - Black"],"catatan":"produk: Tuxedo\\ntahap: tanya_size","tahap":"tanya_size","serah_cs":false,"alasan":"ok","susulan":"jadi lanjut bos?"}'
    )
    assert.lengthOf(decision.pesan, 2)
    assert.equal(decision.tahap, 'tanya_size')
    assert.isFalse(decision.serah_cs)
    assert.equal(decision.susulan, 'jadi lanjut bos?')
    assert.equal(decision.spesifikasi, '')
    assert.equal(parseLeanDecision('{"pesan":"satu","tahap":"aneh"}').tahap, 'lain')
    assert.equal(parseLeanDecision('{"pesan":"satu","tahap":"aneh"}').susulan, '')
    assert.throws(() => parseLeanDecision('bukan json'))
  })

  test('skill inti dipilih, skill lain dilewati', ({ assert }) => {
    const chosen = selectLeanSkill([
      { name: 'waiting-notices', content: 'x' },
      { name: 'cs-chameleon-cloth', content: 'lama' },
      { name: 'beta3-cs-inti', content: 'inti' },
    ])
    assert.equal(chosen.name, 'beta3-cs-inti')
    assert.throws(() => selectLeanSkill([{ name: 'waiting-notices', content: 'x' }]))
  })
})

test.group('beta3 · memori pelanggan', () => {
  test('baris berlabel diganti, sisanya dipertahankan', ({ assert }) => {
    const merged = mergeCustomerNote('Nama: Arif\nSize: M\nKebiasaan: bayar BRI', {
      Size: 'XS (TB 161 / BB 43)',
      Alamat: 'Bogor',
    })
    assert.equal(
      merged,
      'Nama: Arif\nSize: XS (TB 161 / BB 43)\nKebiasaan: bayar BRI\nAlamat: Bogor'
    )
  })
})

test.group('beta3 · ciri model', () => {
  test('ciri model ikut di digest dalam kurung siku', ({ assert }) => {
    const text = renderCatalogDigest([
      row({
        id: 1,
        product: 'Tuxedo',
        color: 'White',
        sizesReady: 'S M',
        features: 'kerah shawl hitam',
      }),
      row({
        id: 2,
        product: 'Tuxedo',
        color: 'Broken White',
        sizesReady: '',
        features: 'kerah shawl senada',
      }),
    ])
    assert.include(text, 'White (S M) [kerah shawl hitam]')
    assert.include(text, 'Broken White [kerah shawl senada]')
    assert.include(text, 'kurung siku')
    const auto = renderCatalogDigest([
      row({ id: 3, product: 'Tuxedo', color: 'Navy', featuresAi: 'kerah peak senada, 2 kancing' }),
      row({
        id: 4,
        product: 'Tuxedo',
        color: 'Grey',
        features: 'kerah shawl hitam',
        featuresAi: 'abaikan',
      }),
    ])
    assert.include(auto, 'Navy (S M XL) [kerah peak senada, 2 kancing]')
    assert.include(auto, 'Grey (S M XL) [kerah shawl hitam]')
    const withFabric = renderCatalogDigest([
      row({
        id: 5,
        product: 'Tuxedo',
        color: 'White',
        features: 'kerah shawl hitam',
        material: 'Black Label',
      }),
      row({ id: 6, product: 'Tuxedo', color: 'Navy', material: 'Aldo Moretti' }),
    ])
    assert.include(withFabric, 'White (S M XL) [kerah shawl hitam; bahan Black Label]')
    assert.include(withFabric, 'Navy (S M XL) [bahan Aldo Moretti]')
  })
})

test.group('beta3 · tool pendukung', () => {
  test('tinggi/berat dikenali dari berbagai tulisan', ({ assert }) => {
    assert.deepEqual(extractBodyMeasure('tinggi 161 cm, berat 43 kg'), { height: 161, weight: 43 })
    assert.deepEqual(extractBodyMeasure('tb 170 bb 65'), { height: 170, weight: 65 })
    assert.deepEqual(extractBodyMeasure('saya 175/80 bos'), { height: 175, weight: 80 })
    assert.isNull(extractBodyMeasure('size M ada?'))
    assert.isNull(extractBodyMeasure('harga 485 ribu 2 pcs'))
  })

  test('ongkir ditulis ringkas untuk AI', ({ assert }) => {
    const text = renderShippingRates({
      destination: { district: 'KEBON JERUK', city: 'JAKARTA BARAT' },
      prices: [
        { service: 'REG23', price: 14000, etd: '1-2 day' },
        { service: 'JTR23', price: 65000, etd: '4-5 day' },
      ],
    })
    assert.include(text, 'ONGKIR ke KEBON JERUK, JAKARTA BARAT')
    assert.include(text, 'REG 14.000 (1-2 hari)')
    assert.include(text, 'JTR 65.000')
  })

  test('tujuan ongkir dikenali dari pertanyaan bebas', ({ assert }) => {
    assert.equal(extractShippingQuery('Ongkir ke cinyawang berapa ya'), 'cinyawang')
    assert.equal(extractShippingQuery('ongkirnya ke kebon jeruk brp bos?'), 'kebon jeruk')
    assert.equal(
      extractShippingQuery('kalau kirim ke tanah sereal ongkirnya berapa'),
      'tanah sereal'
    )
    assert.equal(extractShippingQuery('ongkir kec. patimuan cilacap'), 'patimuan cilacap')
    assert.isNull(extractShippingQuery('ongkirnya berapa bos'))
    assert.isNull(extractShippingQuery('jas navy ada?'))
    assert.equal(extractShippingQuery('Untuk pengiriman ke mampang berapa ya'), 'mampang')
    assert.isNull(extractShippingQuery('pengiriman ke jakarta biasanya pakai apa'))
  })

  test('tujuan dikelompokkan per kecamatan dan jawaban pilihan dikenali', ({ assert }) => {
    const rows = [
      {
        code: 'JKT10101',
        subdistrict: 'PELA MAMPANG',
        district: 'MAMPANG PRAPATAN',
        city: 'JAKARTA SELATAN',
      },
      {
        code: 'JKT10102',
        subdistrict: 'BANGKA',
        district: 'MAMPANG PRAPATAN',
        city: 'JAKARTA SELATAN',
      },
      { code: 'DPK20201', subdistrict: 'MAMPANG', district: 'PANCORAN MAS', city: 'DEPOK' },
    ]
    const areas = groupDestinations(rows)
    assert.lengthOf(areas, 2)
    assert.equal(areas[0].code, 'JKT10101')
    assert.equal(pickArea('Jakarta selatan bos', areas)?.code, 'JKT10101')
    assert.equal(pickArea('yang depok', areas)?.code, 'DPK20201')
    assert.isNull(pickArea('mampang', areas))
    assert.equal(normalizeCity('Jaksel'), 'jakarta selatan')
    assert.equal(normalizeCity('Kab. Cilacap'), 'cilacap')
  })

  test('lanjutan obrolan ongkir dikenali hanya saat followUp', ({ assert }) => {
    assert.isNull(extractShippingQuery('Kalo ke jakarta?'))
    assert.equal(extractShippingQuery('Kalo ke jakarta?', true), 'jakarta')
    assert.equal(extractShippingQuery('Mampang', true), 'mampang')
    assert.equal(extractShippingQuery('kec. kebon jeruk aja bos', true), 'kebon jeruk')
    assert.isNull(extractShippingQuery('oke', true))
    assert.isNull(extractShippingQuery('size M ada?', true))
    assert.isNull(extractShippingQuery('tinggi 170 berat 65', true))
  })
})

test.group('beta3 · total otomatis', () => {
  const catalog = [
    row({ id: 1, product: 'Peak Suit', color: 'Black', price: 485000, note: 'XXL-3XL 585.000' }),
    row({
      id: 2,
      product: 'Setelan Peak Suit',
      color: 'Black',
      price: 705000,
      note: 'XXL-3XL 855.000',
    }),
    row({ id: 3, product: 'Vest', color: 'Black', price: 175000 }),
  ]
  const prices = [
    { service: 'CTC23', price: 6000 },
    { service: 'CTCYES23', price: 8000 },
  ]
  test('rincian yang cocok katalog dan layanan yang dipilih → dikirim otomatis', ({ assert }) => {
    const result = matchAutoTotal(
      {
        rincian: 'Setelan Peak Suit - Black size S, celana no 30 705.000',
        subtotal: 705000,
        layanan: 'CTCYES',
      },
      catalog,
      prices
    )
    assert.isTrue(result.ok)
    if (result.ok) {
      assert.equal(result.shippingCost, 8000)
      assert.equal(result.shippingService, 'CTCYES')
    }
  })
  test('subtotal salah, produk tak dikenal, atau layanan kosong → menunggu CS', ({ assert }) => {
    assert.isFalse(
      matchAutoTotal(
        { rincian: 'Setelan Peak Suit - Black 700.000', subtotal: 700000, layanan: 'CTC' },
        catalog,
        prices
      ).ok
    )
    assert.isFalse(
      matchAutoTotal(
        { rincian: 'Tuxedo - Navy 485.000', subtotal: 485000, layanan: 'CTC' },
        catalog,
        prices
      ).ok
    )
    assert.isFalse(
      matchAutoTotal(
        { rincian: 'Peak Suit - Black 485.000', subtotal: 485000, layanan: '' },
        catalog,
        prices
      ).ok
    )
    const big = matchAutoTotal(
      {
        rincian: 'Peak Suit - Black size XXL 585.000\n2x Vest - Black 350.000',
        subtotal: 935000,
        layanan: 'ctc',
      },
      catalog,
      prices
    )
    assert.isTrue(big.ok)
  })
  test('harga yang disebut toko & baris detail tidak menahan total', ({ assert }) => {
    const detail = matchAutoTotal(
      { rincian: 'Peak Suit - Black size L 485.000\nfull polos, bahan doff\npre order', subtotal: 485000, layanan: 'CTC' },
      catalog,
      prices
    )
    assert.isTrue(detail.ok)
    const stated = matchAutoTotal(
      { rincian: 'Jas custom broken white size L 500.000', subtotal: 500000, layanan: 'CTC' },
      catalog,
      prices,
      [],
      [500000]
    )
    assert.isTrue(stated.ok)
    assert.isFalse(
      matchAutoTotal({ rincian: 'Peak Suit - Black 485.000\nRompi Maroon', subtotal: 485000, layanan: 'CTC' }, catalog, prices).ok
    )
  })
})
