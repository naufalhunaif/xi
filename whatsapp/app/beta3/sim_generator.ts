// v3.6.79 — Pembuat skenario uji otomatis: kombinasi maksud × produk × warna × size × jumlah, lalu
// kalimatnya diacak seperti pelanggan sungguhan (singkatan, salah ketik, bahasa daerah, slang, emoji,
// warna dengan sebutan sehari-hari, angka ditulis huruf, gambar produk). Jawaban yang benar dihitung
// dari KATALOG saat ini, jadi pemeriksaan pasti (harga, foto persis, diskon grosir) tidak menebak.
import type { LeanCatalogRow } from '#beta3/catalog_service'
import { WHOLESALE_MIN_JAS } from '#beta3/wholesale'
import type { SimScenario } from '#beta3/simulator'

/** PRNG kecil (mulberry32): seed sama → skenario sama, supaya hasil bisa diulang. */
export function rng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
type Rand = ReturnType<typeof rng>
const pick = <T>(rand: Rand, list: readonly T[]) => list[Math.floor(rand() * list.length)]
const chance = (rand: Rand, p: number) => rand() < p
const rupiah = (value: number) => value.toLocaleString('id-ID')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Sebutan sehari-hari untuk warna katalog (tanpa akhiran "2.0"). */
const COLOR_WORDS: Record<string, string[]> = {
  black: ['item', 'hitam', 'hitem', 'black', 'ireng', 'hiteum'],
  navy: ['navy', 'biru dongker', 'biru tua', 'nevi', 'dongker'],
  maroon: ['maroon', 'merah marun', 'marun', 'mrun', 'merah ati'],
  cream: ['krem', 'cream', 'krim', 'kream'],
  choco: ['coklat tua', 'choco', 'coklat', 'cokelat'],
  brown: ['coklat', 'brown', 'coklat muda', 'cokelat'],
  gray: ['abu', 'abu2', 'grey', 'abu abu'],
  'light gray': ['abu muda', 'light grey', 'abu terang'],
  'dark gray': ['abu tua', 'abu gelap', 'dark grey'],
  white: ['putih', 'white', 'pth', 'puteh'],
  putih: ['putih', 'white', 'pth'],
  army: ['army', 'hijau army', 'ijo army', 'ijo tentara'],
  'blue ice': ['biru muda', 'baby blue', 'blue ice', 'biru es'],
  denim: ['denim', 'biru jeans', 'jeans'],
  coast: ['coast', 'coklat susu'],
  gold: ['gold', 'emas', 'kuning emas'],
  'sage green': ['sage', 'hijau sage', 'ijo sage'],
  'green emerald': ['ijo emerald', 'hijau botol', 'emerald'],
  'blue emerald': ['biru emerald', 'biru toska tua'],
}
const PRODUCT_WORDS: Record<string, string[]> = {
  'basic suit': ['basic suit', 'basic', 'jas basic', 'jas biasa', 'besik suit'],
  tuxedo: ['tuxedo', 'tuksedo', 'tux', 'jas tuxedo', 'tuxedo'],
  'peak suit': ['peak suit', 'jas peak', 'peak lapel', 'pik suit'],
  'bescap cross placket': ['beskap', 'bescap', 'beskap cross', 'beskap silang'],
  'double breasted': ['double breasted', 'jas dobel kancing', 'jas kancing 2 baris', 'db suit'],
  'casual suit': ['casual suit', 'jas casual', 'jas santai'],
}
const colorKey = (color: string) => color.toLowerCase().replace(/\s*\d+(?:\.\d+)?$/, '').replace(/^signature\s+/, '').trim()
const sayColor = (rand: Rand, color: string) => pick(rand, COLOR_WORDS[colorKey(color)] || [colorKey(color)])
const sayProduct = (rand: Rand, product: string) => pick(rand, PRODUCT_WORDS[product.toLowerCase()] || [product.toLowerCase()])

const GREET = ['min', 'kak', 'ka', 'bang', 'gan', 'mas', 'teh', 'bos', 'sis', 'admin', 'p', 'halo', 'misi', 'assalamualaikum']
const TAIL = ['', '', 'dong', 'ya', 'kah', 'nih', 'cuy', 'gan', '🙏', '😁', '??', '?', 'bos', 'min', 'kak']
const HOW_MUCH = ['brp', 'berapa', 'brapa', 'piro', 'sabaraha', 'brp an', 'berapa rupanya', 'brpa', 'hrgnya', 'pira']
const IS_THERE = ['ada', 'ad', 'ono', 'aya', 'ade', 'ready', 'redi', 'msh ada', 'masih ono']
const NUMBER_WORDS: Record<number, string[]> = {
  3: ['3', 'tiga', '3 biji', 'tigo'],
  4: ['4', 'empat', '4 pcs', 'papat'],
  5: ['5', 'lima', '5 stel', 'limo'],
  6: ['6', 'enam', 'setengah lusin', '6 biji', 'nem'],
  8: ['8', 'delapan', '8 pcs', 'wolu'],
  10: ['10', 'sepuluh', '10 stel', 'sapuluh'],
  12: ['12', 'selusin', 'dua belas', '1 lusin'],
  20: ['20', 'dua puluh', '20an', 'rong puluh'],
}
const ABBREVIATE: Array<[RegExp, string[]]> = [
  [/\byang\b/g, ['yg', 'yng']],
  [/\bsama\b/g, ['sm', 'ama']],
  [/\bharga\b/g, ['hrg', 'hrga']],
  [/\bukuran\b/g, ['ukrn', 'uk']],
  [/\bwarna\b/g, ['wrn', 'warnah']],
  [/\bmasih\b/g, ['msh', 'masi']],
  [/\bbisa\b/g, ['bs', 'bsa']],
  [/\bdengan\b/g, ['dgn', 'dg']],
  [/\bgimana\b/g, ['gmn', 'gmna']],
  [/\bkalau\b/g, ['klo', 'kalo', 'kl']],
  [/\bfotonya\b/g, ['fotony', 'pic nya', 'gambarnya']],
  [/\bsudah\b/g, ['udh', 'udah']],
  [/\bterus\b/g, ['trs', 'trus']],
]

/** Salah ketik acak pada satu kata (huruf hilang, tertukar, dobel, vokal dibuang). */
export function typo(rand: Rand, word: string) {
  if (word.length < 4 || /\d/.test(word)) return word
  const at = 1 + Math.floor(rand() * (word.length - 2))
  switch (Math.floor(rand() * 4)) {
    case 0:
      return word.slice(0, at) + word.slice(at + 1)
    case 1:
      return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2)
    case 2:
      return word.slice(0, at) + word[at] + word.slice(at)
    default:
      return word[0] + word.slice(1).replace(/[aiueo]/g, '') || word
  }
}

/** Campur bahasa: sebagian kata diganti Inggris / Jawa / Sunda / Medan. */
const CODE_MIX: Array<[RegExp, string[]]> = [
  [/\b(?:berapa|brp)\b/g, ['how much', 'piro', 'sabaraha', 'berapa rupanya', 'brp sih']],
  [/\b(?:ada|ready)\b/g, ['available', 'ono', 'aya', 'ready gak', 'ada gak']],
  [/\bukuran\b/g, ['size', 'ukurane', 'ukuranna']],
  [/\bharga\b/g, ['price', 'regane', 'hargina']],
  [/\bmau\b/g, ['pengen', 'arep', 'hoyong', 'want']],
  [/\bkirim\b/g, ['ship', 'kirimke', 'kirimkeun']],
]

/** Acak cara bicara: sapaan, singkatan, salah ketik, campur bahasa, huruf dipanjangkan, emoji. */
export function roughen(rand: Rand, text: string) {
  let out = text
  for (const [pattern, options] of CODE_MIX) if (chance(rand, 0.25)) out = out.replace(pattern, () => pick(rand, options))
  for (const [pattern, options] of ABBREVIATE) if (chance(rand, 0.6)) out = out.replace(pattern, () => pick(rand, options))
  out = out
    .split(' ')
    .map((word) => (chance(rand, 0.12) ? typo(rand, word) : word))
    .join(' ')
  if (chance(rand, 0.45)) out = `${pick(rand, GREET)}${chance(rand, 0.5) ? ',' : ''} ${out}`
  const tail = pick(rand, TAIL)
  if (tail) out = `${out} ${tail}`
  // Huruf dipanjangkan ("brpppp", "dongg") dan emoji di tengah.
  if (chance(rand, 0.2)) out = out.replace(/\b(\w*?)([aiueopg])\b/, (_, head, letter) => `${head}${letter.repeat(2 + Math.floor(rand() * 3))}`)
  if (chance(rand, 0.15)) out = `${out} ${pick(rand, ['😅', '🙏🙏', '👍', '🤔', '😭', 'wkwk', 'hehe'])}`
  if (chance(rand, 0.08)) out = out.toUpperCase()
  if (chance(rand, 0.3)) out = out.replace(/[?.!,]/g, '')
  return out.replace(/\s+/g, ' ').trim()
}

type Pools = {
  rows: LeanCatalogRow[]
  /** Produk jas reguler yang punya foto & harga (dipakai untuk harga/foto/gambar). */
  suits: LeanCatalogRow[]
}

function pools(rows: LeanCatalogRow[]): Pools {
  const active = rows.filter((row) => row.active && row.price)
  const suits = active.filter(
    (row) =>
      /suits?/i.test(row.category) &&
      row.photoUrl &&
      !/tidak tampil di web/i.test(row.note || '') &&
      Object.keys(PRODUCT_WORDS).includes(row.product.toLowerCase()) &&
      !/signature/i.test(row.color)
  )
  return { rows: active, suits }
}

const caption = (row: LeanCatalogRow) => (row.color ? `${row.product} - ${row.color}` : row.product)

type Maker = (rand: Rand, data: Pools, n: number) => SimScenario | null

const MAKERS: Record<string, Maker> = {
  harga(rand, data, n) {
    const row = pick(rand, data.suits)
    if (!row) return null
    const price = Number(row.price)
    const p = sayProduct(rand, row.product)
    const c = sayColor(rand, row.color)
    const text = pick(rand, [
      `${p} ${c} ${pick(rand, HOW_MUCH)}`,
      `${pick(rand, HOW_MUCH)} harga ${p} yang warna ${c}`,
      `${c} yang ${p} harganya ${pick(rand, HOW_MUCH)}`,
      `mau nanya ${p} ${c} itu ${pick(rand, HOW_MUCH)} ya`,
    ])
    return {
      id: `gen-harga-${n}`,
      judul: `Harga · ${caption(row)}`,
      maksud: `Pelanggan menanyakan harga ${caption(row)} (sebutan warna: "${c}"). Benar: ${rupiah(price)} untuk jas S–XL (ukuran besar lebih mahal sesuai katalog).`,
      giliran: [roughen(rand, text)],
      harap: { serah_cs: false, sebut: [escape(rupiah(price))] },
    }
  },
  foto(rand, data, n) {
    const product = pick(rand, [...new Set(data.suits.map((row) => row.product))])
    const variants = data.suits.filter((row) => row.product === product)
    if (!variants.length) return null
    const count = variants.length > 1 && chance(rand, 0.5) ? 2 : 1
    const chosen: LeanCatalogRow[] = []
    while (chosen.length < count) {
      const row = pick(rand, variants)
      if (!chosen.includes(row)) chosen.push(row)
    }
    // Sebutan warna harus tidak ambigu di produk itu (mis. "coklat" bisa Brown/Choco → pakai nama katalog).
    const words = chosen.map((row) => {
      const said = sayColor(rand, row.color)
      const clash = variants.some((other) => other !== row && (COLOR_WORDS[colorKey(other.color)] || []).includes(said))
      return clash ? colorKey(row.color) : said
    })
    const p = sayProduct(rand, product)
    const text = pick(rand, [
      `kirimin fotonya ${p} yang ${words.join(' sama yang ')}`,
      `liat ${p} ${words.join(' & ')} dong`,
      `ada foto ${p} warna ${words.join(' sama ')}?`,
      `pengen lihat yang ${words.join(' sm ')} ${p}`,
    ])
    return {
      id: `gen-foto-${n}`,
      judul: `Foto · ${chosen.map(caption).join(' + ')}`,
      maksud: `Pelanggan minta foto ${chosen.map(caption).join(' dan ')} (sebutan: ${words.join(', ')}). Benar: kirim tepat foto itu, tidak lebih, tidak kurang, dan teks sesuai fotonya.`,
      giliran: [roughen(rand, text)],
      harap: { serah_cs: false, foto_persis: chosen.map(caption) },
    }
  },
  stok(rand, data, n) {
    const row = pick(rand, data.suits.filter((item) => item.sizesAll))
    if (!row) return null
    const size = pick(rand, ['S', 'M', 'L', 'XL', 'XXL'])
    const ready = row.sizesReady.split(/\s+/).includes(size)
    const text = pick(rand, [
      `${sayProduct(rand, row.product)} ${sayColor(rand, row.color)} size ${size} ${pick(rand, IS_THERE)}`,
      `${pick(rand, IS_THERE)} ${sayProduct(rand, row.product)} ${sayColor(rand, row.color)} ukuran ${size.toLowerCase()}`,
      `yang ${sayColor(rand, row.color)} ${sayProduct(rand, row.product)} ${size} masih ada barangnya`,
    ])
    return {
      id: `gen-stok-${n}`,
      judul: `Stok · ${caption(row)} ${size}`,
      maksud: `Pelanggan menanyakan stok ${caption(row)} size ${size}. Benar menurut katalog: ${ready ? `size ${size} READY (ready: ${row.sizesReady})` : `size ${size} TIDAK ready (ready: ${row.sizesReady || 'tidak ada'}); boleh tawarkan dibuatkan/pre-order bila katalog mengizinkan`}.`,
      giliran: [roughen(rand, text)],
      harap: { serah_cs: false },
    }
  },
  grosir(rand, _data, n) {
    const qty = pick(rand, [3, 4, 5, 6, 8, 10, 12, 20])
    const unit = pick(rand, ['jas', 'stel', 'setel', 'pcs', 'orang', 'set'])
    const said = pick(rand, NUMBER_WORDS[qty])
    const reason = pick(rand, ['buat seragam kantor', 'buat groomsmen', 'buat acara keluarga', 'buat panitia', '', 'buat tim', 'buat paduan suara'])
    const text = pick(rand, [
      `kalo ambil ${said} ${unit} ${reason} bisa kurang ga`,
      `${reason} pesen ${said} ${unit} ada potongan ga`,
      `mau order ${said} ${unit} ${reason}, ada harga khusus?`,
      `beli banyak ${said} ${unit} dapet diskon kah ${reason}`,
    ])
    const eligible = qty >= WHOLESALE_MIN_JAS
    return {
      id: `gen-grosir-${n}`,
      judul: `Grosir · ${qty} ${unit}`,
      maksud: `Pelanggan menanyakan potongan untuk ${qty} ${unit} (ditulis "${said}"). Benar: ${eligible ? `${qty} ≥ ${WHOLESALE_MIN_JAS} → dapat DISKON GROSIR per pcs (jas 15.000, setelan 25.000, celana 10.000, rompi 5.000); AI menjawab sendiri` : `${qty} < ${WHOLESALE_MIN_JAS} → belum dapat potongan grosir, harga eceran pas; jangan memberi diskon`}.`,
      giliran: [roughen(rand, text)],
      harap: eligible
        ? { serah_cs: false, sebut: ['15\\.000|25\\.000'] }
        : { serah_cs: false, tidak_sebut: ['potongan (?:15|25)\\.000', 'diskon (?:15|25)\\.000'] },
    }
  },
  toko(rand, _data, n) {
    const kind = pick(rand, ['lokasi', 'jam', 'cod', 'shopee', 'minggu'] as const)
    const texts = {
      lokasi: ['tokonya dimana', 'alamat toko dmn', 'bisa dateng langsung ke tokonya ga', 'lokasi offline store ada?'],
      jam: ['bukanya jam brp', 'jam operasional toko', 'sabtu buka sampe jam brp'],
      cod: ['bisa cod', 'bayar ditempat bisa?', 'cod ga', 'bisa bayar pas barang dateng'],
      shopee: ['ada di shopee?', 'link shopee nya mana', 'bisa checkout di tokped'],
      minggu: ['minggu buka', 'hari minggu bisa dateng', 'ahad buka ga'],
    }[kind]
    const expect = {
      lokasi: { maksud: 'Benar: toko di Patimuan, Cilacap (Jawa Tengah); bisa datang/ukur langsung pada jam buka.', sebut: ['cilacap'] },
      jam: { maksud: 'Benar: Sen–Jum 09.00–17.00, Sab 09.00–15.00, Minggu tutup; chat/website 24 jam.', sebut: ['09|9'] },
      cod: { maksud: 'Benar: COD tidak tersedia; pembayaran transfer.', sebut: [] as string[] },
      shopee: { maksud: 'Benar: tidak tersedia di marketplace itu; order lewat chat/website.', sebut: [] as string[] },
      minggu: { maksud: 'Benar: toko fisik Minggu tutup; order chat/website tetap bisa.', sebut: ['tutup|libur'] },
    }[kind]
    return {
      id: `gen-toko-${n}`,
      judul: `Toko · ${kind}`,
      maksud: `Pelanggan bertanya soal ${kind}. ${expect.maksud}`,
      giliran: [roughen(rand, pick(rand, texts))],
      harap: { serah_cs: false, sebut: expect.sebut, ...(kind === 'cod' ? { tidak_sebut: ['(?<!belum |tidak |gak |ga |nggak )bisa cod'] } : {}) },
    }
  },
  gambar(rand, data, n) {
    const row = pick(rand, data.suits)
    if (!row) return null
    const ask = pick(rand, ['harga', 'stok'] as const)
    const size = pick(rand, ['S', 'M', 'L', 'XL'])
    const text =
      ask === 'harga'
        ? pick(rand, ['yg kayak gini brp', 'ini harganya brp', 'model ini ada? brp', 'kalo yg di foto ini berapa'])
        : pick(rand, [`yg ini size ${size} ada`, `ini ready ${size.toLowerCase()}?`, `model kaya gini ukuran ${size} msh ada`])
    const ready = row.sizesReady.split(/\s+/).includes(size)
    return {
      id: `gen-gambar-${n}`,
      judul: `Gambar · ${caption(row)} (${ask})`,
      maksud: `Pelanggan mengirim foto ${caption(row)} lalu bertanya ${ask === 'harga' ? 'harganya' : `size ${size}`}. Benar: kenali produk & warnanya dari gambar; ${ask === 'harga' ? `harga ${rupiah(Number(row.price))}` : `${size} ${ready ? 'READY' : 'tidak ready'} (ready: ${row.sizesReady || 'tidak ada'})`}.`,
      giliran: [{ teks: roughen(rand, text), gambar: caption(row) }],
      harap: { serah_cs: false, ...(ask === 'harga' ? { sebut: [escape(rupiah(Number(row.price)))] } : {}) },
    }
  },
  ukuran(rand, _data, n) {
    const height = 155 + Math.floor(rand() * 35)
    const weight = 45 + Math.floor(rand() * 50)
    const text = pick(rand, [
      `tb ${height} bb ${weight} cocoknya size apa`,
      `tinggi ${height}cm berat ${weight}kg pake ukuran apa ya`,
      `aku ${height}/${weight} muat size apa`,
      `${height} ${weight} size apa yg pas`,
    ])
    return {
      id: `gen-ukuran-${n}`,
      judul: `Ukuran · ${height}/${weight}`,
      maksud: `Pelanggan memberi tinggi ${height} cm dan berat ${weight} kg, minta saran size. Benar: rekomendasi size dari fit advisor/size chart (S–4XL) yang masuk akal untuk tinggi/berat itu, tanpa mengarang.`,
      giliran: [roughen(rand, text)],
      harap: { serah_cs: false },
    }
  },
  lanjutfoto(rand, data, n) {
    const row = pick(rand, data.suits)
    if (!row) return null
    const p = sayProduct(rand, row.product)
    const c = sayColor(rand, row.color)
    const clash = data.suits.some((other) => other.product === row.product && other !== row && (COLOR_WORDS[colorKey(other.color)] || []).includes(c))
    const color = clash ? colorKey(row.color) : c
    return {
      id: `gen-lanjut-${n}`,
      judul: `Harga lalu foto · ${caption(row)}`,
      maksud: `Pelanggan menanyakan harga ${caption(row)}, lalu minta fotonya. Benar: harga ${rupiah(Number(row.price))}; foto ${caption(row)} saja (boleh sudah dikirim di giliran 1 sebagai inisiatif; bila sudah, giliran 2 cukup bilang fotonya di atas — tidak boleh 'ini' tanpa foto).`,
      giliran: [
        roughen(rand, `${p} ${color} ${pick(rand, HOW_MUCH)}`),
        roughen(rand, pick(rand, ['fotonya dong', 'liat dong', 'ada pic nya?', 'kirim gambarnya', 'mana fotonya'])),
      ],
      harap: { serah_cs: false, sebut: [escape(rupiah(Number(row.price)))], foto_persis: [caption(row)] },
    }
  },
}

/** Dua maksud dalam satu pesan (mis. harga + grosir, foto + stok) dengan penghubung sehari-hari. */
MAKERS.gabung = (rand, data, n) => {
  const kinds = ['harga', 'foto', 'stok', 'grosir', 'toko', 'ukuran']
  const a = MAKERS[pick(rand, kinds)](rand, data, n)
  const b = MAKERS[pick(rand, kinds)](rand, data, n)
  if (!a || !b || a.id.split('-')[1] === b.id.split('-')[1]) return null
  const text = (scenario: SimScenario) => (typeof scenario.giliran[0] === 'string' ? scenario.giliran[0] : scenario.giliran[0].teks)
  const joiner = pick(rand, ['\n', ' trus ', ' oh iya ', ' sama satu lagi, ', '. btw ', ' & '])
  return {
    id: `gen-gabung-${n}`,
    judul: `Dua maksud · ${a.judul} + ${b.judul}`,
    maksud: `Pesan berisi DUA maksud, keduanya harus dijawab dalam balasan yang sama.\n1) ${a.maksud}\n2) ${b.maksud}`,
    giliran: [`${text(a)}${joiner}${text(b)}`],
    harap: {
      serah_cs: false,
      sebut: [...(a.harap?.sebut || []), ...(b.harap?.sebut || [])],
      tidak_sebut: [...(a.harap?.tidak_sebut || []), ...(b.harap?.tidak_sebut || [])],
      ...(a.harap?.foto_persis || b.harap?.foto_persis ? { foto_persis: [...(a.harap?.foto_persis || []), ...(b.harap?.foto_persis || [])] } : {}),
    },
  }
}

export const GENERATOR_KINDS = Object.keys(MAKERS)

/** Buat `count` skenario dari katalog saat ini; seed sama → skenario sama. */
export function generateScenarios(rows: LeanCatalogRow[], count: number, seed = Date.now() % 1_000_000) {
  const rand = rng(seed)
  const data = pools(rows)
  const out: SimScenario[] = []
  let guard = 0
  while (out.length < count && guard++ < count * 5) {
    const kind = GENERATOR_KINDS[out.length % GENERATOR_KINDS.length]
    const made = MAKERS[kind](rand, data, out.length + 1)
    if (made) out.push({ ...made, id: `${made.id}-s${seed}` })
  }
  return out
}
