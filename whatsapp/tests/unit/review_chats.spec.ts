// Ulasan chat dari pemilik, diputar ulang lewat JALUR PERAPIAN YANG SAMA dengan balasan asli
// (reply_polish, quick reply, penjaga custom, tahap & susulan). Setiap ulasan baru → tambah kasus
// di sini, supaya perbaikan yang saling bersinggungan tidak merusak ulasan sebelumnya.
import { test } from '@japa/runner'
import { completePhotos, polishText, polishWithPhotos } from '#beta3/reply_polish'
import { pricePattern, productPriceMap, seriesMentioned } from '#beta3/price_pattern'
import { quickReply } from '#beta3/token_saver'
import { keepCustomInChat, CUSTOM_REPLY, dropRepeatedWait } from '#beta3/reply_guards'
import { partsMissingFromItems, orderPartsOf, parseCsTotalMessage } from '#beta3/order_service'
import { normalizeStage, type LeanDecision } from '#beta3/prompt'
import { goalStatus } from '#beta3/reply_service'
import { extractShippingQuery, etdText } from '#beta3/mcp'
import { chooseReplyTier } from '#beta3/model_tier'
import { scoreLevel } from '#beta3/jev'
import type { LeanCatalogRow } from '#beta3/catalog_service'

let id = 0
const row = (product: string, category: string, price: number, big: number, material: string, color = 'Black'): LeanCatalogRow => ({
  id: ++id,
  product,
  color,
  category,
  price,
  sizesReady: 'S M L XL',
  sizesAll: 'S M L XL XXL 3XL',
  photoUrl: `https://cdn.test/${id}.jpg`,
  materialAvailable: true,
  features: '',
  featuresAi: '',
  material,
  sizeGroup: '',
  fit: '',
  note: `XXL-3XL ${big.toLocaleString('id-ID')}`,
  active: true,
  updatedAt: new Date().toISOString(),
})
const catalog = [
  row('Basic Suit', 'Suits', 485000, 585000, 'Maximotion', 'Black 2.0'),
  row('Tuxedo', 'Suits', 485000, 585000, 'Maximotion'),
  row('Peak Suit', 'Suits', 485000, 585000, 'Maximotion'),
  row('Bescap Cross Placket', 'Suits', 485000, 585000, 'Maximotion'),
  row('Pants', 'Pants', 220000, 270000, 'Maximotion'),
  row('Setelan Basic Suit', 'Setelan', 705000, 855000, 'Maximotion'),
  row('Premium Basic Suit', 'Suits', 685000, 785000, 'Black Label', 'Green Emerald'),
  row('Premium Lo Suit', 'Suits', 685000, 785000, 'Portofino', 'Blue'),
  row('Pants Premium', 'Pants', 270000, 320000, 'Black Label', 'Gray'),
  row('Setelan Premium Basic Suit', 'Setelan', 955000, 1105000, 'Black Label', 'Gray'),
]
const prices = pricePattern(catalog)
const productPrices = productPriceMap(catalog)
const at = new Date()

/** Jalur lengkap seperti di reply_service: teks → (pemeriksa katalog) → foto. */
function polish(raw: string[], customerText: string, history: string[] = [], photos: string[] = []) {
  const series = seriesMentioned([...history, customerText])
  const text = polishText(raw, { customerText, prices, series, productPrices })
  return polishWithPhotos(text.pesan, photos.map((caption) => ({ caption })), customerText)
}

test.group('Ulasan chat pemilik (diputar ulang)', () => {
  test('#7 jas hitam: "seperti apa?" → foto dengan pengantar singkat, pertanyaan sesudah foto', ({ assert }) => {
    assert.deepEqual(
      polish(
        ['Ini pilihan jas hitamnya bos, Basic Suit, Tuxedo, dan Peak Suit masing-masing 485.000. Yang cocok yang mana bos?'],
        'Seperti apa ya?',
        ['Ada bos, jas hitam mulai 485.000. Mau model Basic Suit, Tuxedo, atau Peak Suit?'],
        ['Basic Suit - Black 2.0', 'Tuxedo - Black', 'Peak Suit - Black']
      ),
      ['Ini fotonya bos, harganya 485.000', 'Yang cocok yang mana?']
    )
  })

  test('#7 sapaan tanpa AI; "mau custom bisa" tidak diserahkan ke CS', ({ assert }) => {
    assert.deepEqual(
      quickReply({ text: 'Halo', imageCount: 0, stage: '', rows: [{ direction: 'in', body: 'Halo', createdAt: at, current: true }] }),
      ['Halo bos, ada yang bisa kami bantu']
    )
    assert.deepEqual(
      keepCustomInChat({ serah_cs: true, alasan: 'Pelanggan meminta custom tanpa detail', pesan: [] }, 'Mau custkm bisa'),
      { pesan: CUSTOM_REPLY }
    )
  })

  test('#8 ongkir: "reg aja" bukan tempat, estimasi "1 hari"', ({ assert }) => {
    assert.isNull(extractShippingQuery('Reg aja', true))
    assert.equal(etdText('1-1 day'), '1 hari')
  })

  test('#10/#11 premium: daftar model tanpa "Ada bos", harga daftar tidak diubah', ({ assert }) => {
    const [bubble] = polish(
      ['Ada bos, model jas yang tersedia: Basic Suit mulai 485.000, Tuxedo mulai 485.000, Bescap Cross Placket 485.000, Peak Suit 485.000, Premium Basic Suit 685.000'],
      'Ada model apa aja'
    )
    assert.match(bubble, /^Model jas yang tersedia:/)
    assert.include(bubble, '- Basic Suit mulai 485.000')
    assert.include(bubble, '- Premium Basic Suit 685.000')
    // Sama bila model sudah menulis daftar berbaris.
    const [lined] = polish(['Ada bos, model jas yang tersedia:\n- Basic Suit mulai 485.000\n- Premium Basic Suit 685.000'], 'Ada model apa aja')
    assert.equal(lined, 'Model jas yang tersedia:\n- Basic Suit mulai 485.000\n- Premium Basic Suit 685.000')
    // "ada X?" tetap boleh dijawab "Ada bos".
    assert.deepEqual(polish(['Ada bos, jas hitam mulai 485.000'], 'Jas hitam ada?'), ['Ada bos, jas hitam mulai 485.000'])
  })

  test('#11 "yang premium seperti apa" → "Ini fotonya bos, harganya 685.000" + foto + pertanyaan', ({ assert }) => {
    assert.deepEqual(
      polish(
        [
          'Premium ada Premium Basic Suit warna Green Emerald/Sage Green dengan kerah notch satu kancing, dan Premium Lo Suit warna Blue dengan kerah hitam kontras. Harganya 685.000 bos',
          'Mau yang warna mana bos?',
        ],
        'Yang premium seperti apa',
        ['Model jas yang tersedia: Premium Basic Suit 685.000'],
        ['Premium Basic Suit - Green Emerald', 'Premium Basic Suit - Sage Green', 'Premium Lo Suit - Blue']
      ),
      ['Ini fotonya bos, harganya 685.000', 'Mau yang warna mana bos?']
    )
  })

  test('#10 setelan & celana premium dibetulkan; daftar reguler di konteks premium tidak diubah', ({ assert }) => {
    const history = ['Premium Basic Suit - Green Emerald']
    assert.deepEqual(polish(['Untuk setelan premium harganya 685.000 bos'], 'Set berapa ya', history), [
      'Untuk setelan premium harganya 955.000 bos',
    ])
    assert.deepEqual(
      polish(['685.000 itu jasnya saja bos, belum termasuk celana. Kalau sekalian celana mulai 220.000 ya'], 'Itu jas saja atau sama celana', history),
      ['685.000 itu jasnya saja bos, belum termasuk celana. Kalau sekalian celana mulai 270.000 ya']
    )
    assert.deepEqual(polish(['Kalau yang biasa Basic Suit 485.000 bos'], 'kalau yang biasa?', history), [
      'Kalau yang biasa Basic Suit 485.000 bos',
    ])
    assert.deepEqual(polish(['Setelannya 955.000 bos untuk size S-XL'], 'Kalo set berapa', history), [
      'Setelannya 955.000 bos untuk size S-XL',
    ])
  })

  test('#11 susulan tetap terjadwal walau tahap "lain"; tahap mirip dipetakan', ({ assert }) => {
    const decision = (tahap: string, susulan: string) =>
      ({ serah_cs: false, tahap: normalizeStage(tahap), susulan }) as Pick<LeanDecision, 'serah_cs' | 'tahap' | 'susulan'>
    assert.equal(normalizeStage('tanya_harga'), 'tanya_model')
    assert.equal(normalizeStage('tunggu_pembayaran'), 'tunggu_bayar')
    assert.equal(normalizeStage('aneh'), 'lain')
    assert.equal(goalStatus(decision('lain', 'Mau sekalian dengan celananya bos?')), 'waiting')
    assert.equal(goalStatus(decision('lain', '')), 'completed')
    assert.equal(goalStatus(decision('selesai', 'ada lagi?')), 'completed')
    assert.equal(goalStatus({ ...decision('tanya_model', 'x'), serah_cs: true }), 'paused')
  })

  test('#12/#14 tingkat model: dasar pola kata v3.5.7, Jev hanya menaikkan (skor Jev mulai 0)', ({ assert }) => {
    const tier = (score: number, base: 'light' | 'standard' | 'heavy' = 'standard') =>
      chooseReplyTier({ difficulty: scoreLevel({ score }, 3) }, base).tier
    // "Biasa" (skor 1) dulu terbaca tingkat 1 → model murah; kini tidak pernah di bawah dasar.
    assert.equal(tier(1), 'standard')
    assert.equal(tier(0.2), 'standard')
    assert.equal(tier(2), 'heavy')
    // Dasar berat (ongkir, ukuran, custom, catatan sistem) tidak diturunkan walau Jev bilang sederhana.
    assert.equal(tier(0, 'heavy'), 'heavy')
    // Salam (dasar ringan) tetap ringan; Jev "biasa" menaikkan ke standar; komplain → berat.
    assert.equal(chooseReplyTier({}, 'light').tier, 'light')
    assert.equal(tier(1, 'light'), 'standard')
    assert.equal(chooseReplyTier({ csReason: 'komplain', difficulty: 1 }, 'light').tier, 'heavy')
    assert.match(chooseReplyTier({ difficulty: 3 }, 'standard').reason, /dinaikkan dari standar/)
  })

  test('#13 daftar model dengan harga berbeda tidak diringkas jadi "Ini fotonya" (informasi dipertahankan)', ({ assert }) => {
    const raw = [
      'Model jas yang tersedia:\n- Basic Suit mulai 485.000\n- Tuxedo mulai 485.000\n- Bescap Cross Placket 485.000\n- Peak Suit 485.000\n- Premium Basic Suit 685.000',
      'Mau pilih yang mana bos?',
    ]
    const out = polish(raw, 'Seperti apa', ['Harga jas mulai 485.000 bos'], ['Basic Suit - Black 2.0', 'Tuxedo - Black'])
    assert.include(out[0], '- Premium Basic Suit 685.000')
    assert.equal(out[1], 'Mau pilih yang mana bos?')
    // Satu harga (semua model sama) → pengantar singkat tetap seperti #7.
    assert.deepEqual(
      polish(['Ini Basic Suit, Tuxedo, dan Peak Suit bos, semuanya 485.000. Yang cocok yang mana bos?'], 'Seperti apa', [], ['Basic Suit - Black 2.0', 'Tuxedo - Black', 'Peak Suit - Black']),
      ['Ini fotonya bos, harganya 485.000', 'Yang cocok yang mana?']
    )
  })

  test('#16 "bedanya apa" + "ini contoh fotonya" → semua model yang disebut dikirim fotonya', ({ assert }) => {
    const pesan = [
      'Bedanya Basic Suit kerah notch, Tuxedo kerah shawl, Bescap Cross Placket kerah shanghai dengan kancing menyilang, Peak Suit kerah lancip, sedangkan Premium Basic Suit bahannya Black Label bos',
      'Ini contoh fotonya',
    ]
    // AI hanya mengisi 2 foto → 3 model lain dilengkapi sistem, urut sesuai sebutan.
    assert.deepEqual(completePhotos(pesan, ['Basic Suit - Black 2.0', 'Tuxedo - Black'], 'Pengen liat dulu, bedanya apa ya', catalog), [
      'Bescap Cross Placket - Black',
      'Peak Suit - Black',
      'Premium Basic Suit - Green Emerald',
    ])
    // Tanpa field foto sama sekali → semua lima.
    assert.lengthOf(completePhotos(pesan, [], 'Pengen liat dulu, bedanya apa ya', catalog), 5)
    // "Basic Suit" sudah ada → "Premium Basic Suit" tetap dihitung model lain, dan sebaliknya.
    assert.deepEqual(completePhotos(['Premium Basic Suit bahannya Black Label bos, ini fotonya'], [], 'ok', catalog), ['Premium Basic Suit - Green Emerald'])
    // Tidak janji foto & pelanggan tidak minta lihat → tidak ditambah.
    assert.deepEqual(completePhotos(['Basic Suit 485.000, Tuxedo 485.000 bos'], [], 'Harga berapa', catalog), [])
    // Warna yang disebut di balasan dipilih.
    assert.deepEqual(completePhotos(['Ini fotonya Pants Premium warna Gray bos'], [], 'liat celananya', catalog), ['Pants Premium - Gray'])
  })

  // #17 Retno (Okt 2026): pesan jas+celana+rompi, total hanya jas; ongkir tidak dihitung ulang;
  // janji "saya hitung dulu" diulang.
  test('#17 spesifikasi/chat menyebut celana & rompi, rincian hanya jas → total ditahan sampai dikonfirmasi', ({ assert }) => {
    const spec = 'Basic Suit - Cream, size L\nCelana: menyesuaikan, karet kanan kiri\nDetail custom seperti referensi'
    assert.deepEqual(partsMissingFromItems(spec, 'Basic Suit - Cream size L 485.000', ['Sama ini ada rompinya ga sii']), ['celana', 'rompi'])
    // Celana ada di rincian, rompi ditanyakan pelanggan → tinggal rompi.
    assert.deepEqual(partsMissingFromItems(spec, 'Basic Suit - Cream size L 485.000\nCelana - Cream 220.000', ['Sama ini ada rompinya ga sii']), ['rompi'])
    // Produk "Setelan …" sudah mencakup celana.
    assert.deepEqual(partsMissingFromItems(spec, 'Setelan Basic Suit - Cream size L 705.000', []), [])
    // Pelanggan menolak rompi → tidak dihitung kurang.
    assert.deepEqual(partsMissingFromItems(spec, 'Setelan Basic Suit - Cream size L 705.000', ['rompinya gak usah mas']), [])
    assert.deepEqual(partsMissingFromItems(spec, 'Setelan Basic Suit - Cream size L 705.000', ['gak usah pakai rompi']), [])
    // Jas saja memang jas saja.
    assert.deepEqual(partsMissingFromItems('Basic Suit - Cream, size L\nJas saja', 'Basic Suit - Cream size L 485.000', []), [])
    // Perubahan item setelah total terkirim terdeteksi dari bagian pesanan.
    assert.notEqual(orderPartsOf('Basic Suit - Cream\nJas, Celana').join(), orderPartsOf('Basic Suit - Cream\nJas, Celana, Rompi').join())
    assert.equal(orderPartsOf('Basic Suit - Cream\nJas, Celana').join(), orderPartsOf('Basic Suit - Cream size L\nJas, Celana\nkaret kanan kiri').join())
  })

  test('#17 janji "totalnya saya hitung dulu" tidak diulang saat pelanggan hanya mengiyakan', ({ assert }) => {
    const last = 'Siap bos, celananya menyesuaikan dan dikasih karet kanan kiri ya., totalnya saya hitung dulu ya bos'
    const again = dropRepeatedWait(['siap, totalnya saya hitung dulu ya bos'], last, 'Iyaa mas')
    assert.deepEqual(again.pesan, [])
    assert.isTrue(again.changed)
    // Pesan baru yang bukan sekadar mengiyakan tetap dibalas.
    assert.isFalse(dropRepeatedWait(['siap, totalnya saya hitung dulu ya bos'], last, 'jadi berapa totalnya?').changed)
    // Janji pertama (pesan sebelumnya bukan janji) tetap boleh.
    assert.isFalse(dropRepeatedWait(['totalnya saya hitung dulu ya bos'], 'Siap bos, dicatat pakai size L ya.', 'Oke').changed)
  })

  test('#17 total yang diketik CS di chat terbaca: item, ongkir, total (format baris & satu baris)', ({ assert }) => {
    assert.deepEqual(parseCsTotalMessage('Jas, Celana, Rompi 880.000\nongkir 2kg, 2 x 18.000 =36.000 \n\ntotal 880.000 + 36.000 =916.000 bos'), {
      items: 'Jas, Celana, Rompi 880.000',
      subtotal: 880000,
      shippingCost: 36000,
      total: 916000,
    })
    assert.deepEqual(parseCsTotalMessage('Beskap, Celana 705.000, ongkir 95.000, Total 705.000 + 95.000 = 800.000 bos'), {
      items: 'Beskap, Celana 705.000',
      subtotal: 705000,
      shippingCost: 95000,
      total: 800000,
    })
    assert.equal(parseCsTotalMessage('Basic Suit - Cream size L 485.000\nOngkir REG 18.000\n\nTotal 485.000 + 18.000 = 503.000 bos')?.items, 'Basic Suit - Cream size L 485.000')
    assert.isNull(parseCsTotalMessage('Untuk pembayaran tf ke rek BRI 1112223334445 An Toko agar pesanan langsung kami proses'))
    assert.isNull(parseCsTotalMessage('siap bos, totalnya saya hitung dulu ya'))
  })
})
