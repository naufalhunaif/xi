// Pengumpul konteks: disusun KODE (bukan AI) sebelum model mana pun menjawab.
// Hasilnya fakta ringkas yang sama untuk ChatGPT, Claude, maupun Gemini, sehingga
// model ringan pun tidak perlu menebak produk, harga, atau data yang sudah diberikan.
import { colorVariantsIn, findCatalogVariant, rupiah, type LeanCatalogRow } from '#beta3/catalog_service'
import { extractBodyMeasure } from '#beta3/mcp'
import type { LeanHistoryRow } from '#beta3/prompt'

const fold = (text: string) =>
  String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const label = (row: LeanCatalogRow) => `${row.product} - ${row.color}`
const priceOf = (row: LeanCatalogRow) => (row.price ? `Rp${rupiah(row.price)}` : 'harga belum ada')
const describe = (row: LeanCatalogRow) =>
  `${label(row)}: ${priceOf(row)}${row.sizesReady ? `, ready size ${row.sizesReady}` : ''}`

const INTENTS: Array<[RegExp, string]> = [
  [/\b(harga|hrg|berapa|brp|brapa|berapaan|price|pricelist)\b/, 'harga'],
  [/\b(ready|stok|stock|ada gak|ada ga|masih ada|tersedia)\b/, 'ketersediaan/stok'],
  [/\b(size|ukuran|muat|pas|cocok)\b/, 'ukuran'],
  [/\b(ongkir|kirim|pengiriman|ekspedisi|jne|jnt|sicepat)\b/, 'ongkir/pengiriman'],
  [/\b(bahan|kain|material)\b/, 'bahan'],
  [/\b(berapa lama|kapan jadi|estimasi|proses|jadi kapan)\b/, 'lama pengerjaan'],
  [/\b(transfer|rekening|bayar|dp|pembayaran)\b/, 'pembayaran'],
  [/\b(lihat|liat|foto|gambar|contoh|katalog)\b/, 'minta foto'],
]

/** Produk katalog yang namanya disebut di teks (nama produk utuh, warna opsional). */
function mentioned(text: string, catalog: LeanCatalogRow[]) {
  const source = ` ${fold(text)} `
  const hits: LeanCatalogRow[] = []
  for (const row of catalog) {
    const product = fold(row.product)
    if (!product || !source.includes(` ${product} `)) continue
    const color = fold(row.color)
    if (!color || source.includes(` ${color} `)) hits.push(row)
  }
  return hits
}

export function collectContext(input: {
  history: LeanHistoryRow[]
  catalog: LeanCatalogRow[]
  text: string
}) {
  const catalog = input.catalog.filter((row) => row.active)
  if (!catalog.length && !input.history.length) return ''
  const rows = input.history
  const lines: string[] = []
  const unique = (list: LeanCatalogRow[]) => [...new Map(list.map((row) => [row.id, row])).values()]

  // 1. Produk yang dikutip pelanggan pada pesan sekarang: paling pasti.
  const quoted = unique(
    rows
      .filter((row) => row.current && row.replyTo)
      .map((row) => findCatalogVariant(catalog, String(row.replyTo)))
      .filter(Boolean) as LeanCatalogRow[]
  )
  // 2. Foto produk terakhir yang dikirim ke pelanggan (satu rombongan).
  let lastPhotos: LeanCatalogRow[] = []
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]
    if (row.direction === 'in' && !row.current) break
    if (row.direction === 'out' && row.mediaType && row.body) {
      const found = findCatalogVariant(catalog, row.body)
      if (found) lastPhotos.unshift(found)
    }
  }
  lastPhotos = unique(lastPhotos)
  // 3. Produk yang disebut di percakapan (terbaru dulu).
  const talked = unique(
    rows
      .slice(-12)
      .reverse()
      .flatMap((row) => mentioned(row.body || '', catalog))
  ).slice(0, 4)

  if (quoted.length) {
    lines.push(`Produk yang dimaksud pelanggan (dikutip): ${quoted.map(describe).join('; ')}.`)
  } else if (lastPhotos.length) {
    lines.push(`Foto terakhir yang dikirim: ${lastPhotos.map(describe).join('; ')}.`)
    if (lastPhotos.length > 1)
      lines.push(
        'Bila pelanggan bilang "yang ini" tanpa mengutip, sebutkan singkat harga semua foto di atas, jangan balik bertanya.'
      )
  }
  const shown = new Set([...quoted, ...lastPhotos].map((row) => row.id))
  const others = talked.filter((row) => !shown.has(row.id))
  if (others.length && !quoted.length)
    lines.push(`Produk lain yang sedang dibahas: ${others.map(describe).join('; ')}.`)

  // Kisaran harga per kata kunci umum ("harga jas berapa") bila produk belum jelas.
  const now = fold(input.text)
  if (!quoted.length && !lastPhotos.length && !talked.length && /harga|berapa|brp|hrg/.test(now)) {
    const words = now.split(' ').filter((word) => word.length >= 3)
    const pool = catalog.filter(
      (row) =>
        row.price &&
        words.some((word) => fold(`${row.category} ${row.product}`).split(' ').includes(word))
    )
    if (pool.length) {
      const prices = pool.map((row) => Number(row.price))
      const min = Math.min(...prices)
      const max = Math.max(...prices)
      lines.push(
        `Kisaran harga yang cocok dengan pertanyaan: Rp${rupiah(min)}${max > min ? `–Rp${rupiah(max)}` : ''} (${[...new Set(pool.map((row) => row.product))].slice(0, 6).join(', ')}).`
      )
    }
  }

  lines.push(...shoppingHints(input.text, catalog))
  const ready = readySizeHint(input.text, rows, catalog)
  if (ready) lines.push(ready)

  // Maksud pesan sekarang.
  const intents = INTENTS.filter(([pattern]) => pattern.test(` ${now} `)).map(([, name]) => name)
  if (intents.length) lines.push(`Pelanggan sekarang menanyakan: ${intents.join(', ')}.`)

  // Data yang sudah diberikan pelanggan: jangan ditanya ulang.
  const said = rows
    .filter((row) => row.direction === 'in')
    .map((row) => row.body || '')
    .join('\n')
  const known: string[] = []
  const measure = measureFromHistory(rows) || extractBodyMeasure(said)
  if (measure) known.push(`tinggi ${measure.height} cm, berat ${measure.weight} kg`)
  const size = said.match(/\b(?:size|ukuran)\s*(xxxl|3xl|xxl|xl|l|m|s|\d{2})\b/i)
  if (size) known.push(`size ${size[1].toUpperCase()}`)
  const colors = [...new Set(catalog.map((row) => fold(row.color)).filter(Boolean))]
  const wantedColor = colors.find((color) => ` ${fold(said)} `.includes(` ${color} `))
  if (wantedColor) known.push(`warna ${wantedColor}`)
  if (known.length) lines.push(`Sudah disebut pelanggan (jangan ditanya lagi): ${known.join(', ')}.`)

  // Pertanyaan terakhir AI: jangan diulang dengan kata lain.
  const lastOut = [...rows].reverse().find((row) => row.direction === 'out' && row.body && !row.mediaType)
  const asked = String(lastOut?.body || '')
    .split(/(?<=[?])\s*/)
    .filter((part) => part.trim().endsWith('?'))
    .pop()
  if (asked) lines.push(`Pertanyaan terakhir ke pelanggan: "${asked.trim()}" — jangan ditanyakan ulang.`)

  if (!lines.length) return ''
  return `KONTEKS TERKUMPUL (disusun sistem dari riwayat & katalog; anggap fakta):\n- ${lines.join('\n- ')}`
}

/**
 * Tinggi & berat yang dikirim terpisah ("Tinggi 167" lalu "54" setelah ditanya berat),
 * dirangkai dari riwayat pelanggan. Angka tunggal dipakai sesuai pertanyaan AI/CS sebelumnya.
 */
export function measureFromHistory(rows: LeanHistoryRow[]) {
  let height = 0
  let weight = 0
  let asked = ''
  for (const row of rows.slice(-20)) {
    const text = String(row.body || '').toLowerCase()
    if (row.direction === 'out') {
      asked = /berat/.test(text) ? 'berat' : /tinggi/.test(text) ? 'tinggi' : asked
      continue
    }
    const both = extractBodyMeasure(text)
    if (both) {
      height = both.height
      weight = both.weight
      continue
    }
    const h = text.match(/(?:tinggi|tb)\D{0,6}(\d{3})/) || text.match(/\b(1\d{2})\s*cm\b/)
    const w = text.match(/(?:berat|bb)\D{0,6}(\d{2,3})/) || text.match(/\b(\d{2,3})\s*kg\b/)
    if (h) height = Number(h[1])
    if (w) weight = Number(w[1])
    const bare = text.trim().match(/^(?:sekitar\s*|kurang lebih\s*|±\s*)?(\d{2,3})(?:\s*(?:an|kg|cm))?$/)
    if (bare && !h && !w) {
      const value = Number(bare[1])
      if (asked === 'berat' && value >= 30 && value <= 200) weight = value
      else if (asked === 'tinggi' && value >= 120 && value <= 230) height = value
    }
  }
  if (height < 120 || height > 230 || weight < 30 || weight > 200) return null
  return { height, weight }
}

/** Label size chart (Indonesia/Inggris) → nama bagian badan yang dipakai pelanggan. */
const MEASURE_ALIAS: Record<string, string> = {
  waist: 'pinggang',
  'pinggang': 'pinggang',
  chest: 'dada',
  bust: 'dada',
  hip: 'panggul',
  hips: 'panggul',
  pinggul: 'panggul',
  shoulder: 'bahu',
  'lebar bahu': 'bahu',
  sleeve: 'lengan',
  'panjang lengan': 'lengan',
  thigh: 'paha',
  stomach: 'perut',
  belly: 'perut',
  'chest width': 'half:dada',
  'lebar dada': 'half:dada',
  'body width': 'half:dada',
  'lebar badan': 'half:dada',
  'waist width': 'half:pinggang',
  'lebar pinggang': 'half:pinggang',
}

type ChartRow = { size: string; values: Map<string, number> }
type ChartGroup = { name: string; rows: ChartRow[] }

/** "  Celana (cm): 30 pinggang 78 panggul 98; 31 pinggang 81 ..." → grup & baris. */
export function parseSizeCharts(text: string): ChartGroup[] {
  const groups: ChartGroup[] = []
  for (const line of String(text || '').split('\n')) {
    const match = line.match(/^\s*(.+?)\s*\([^)]*\):\s*(.+)$/)
    if (!match) continue
    const rows: ChartRow[] = []
    for (const part of match[2].split(';')) {
      const tokens = part.trim().match(/^(\S+)\s+(.*)$/)
      if (!tokens) continue
      const values = new Map<string, number>()
      for (const pair of tokens[2].matchAll(/([a-z][a-z ]*?)\s+(\d+(?:[.,]\d+)?)/gi)) {
        const raw = pair[1].trim().toLowerCase()
        const number = Number(pair[2].replace(',', '.'))
        const key = MEASURE_ALIAS[raw] || MEASURE_ALIAS[raw.replace(/^lingkar\s+/, '')] || raw.replace(/^lingkar\s+/, '')
        // Lebar (setengah lingkar, diukur rata) → lingkar agar setara ukuran badan.
        if (key.startsWith('half:')) values.set(key.slice(5), number * 2)
        else if (!values.has(key)) values.set(key, number)
      }
      if (values.size) rows.push({ size: tokens[1], values })
    }
    if (rows.length) groups.push({ name: match[1].trim(), rows })
  }
  return groups
}

const BODY_PARTS = ['pinggang', 'dada', 'panggul', 'pinggul', 'bahu', 'lengan', 'paha', 'perut']

/**
 * Ukuran badan yang disebut pelanggan ("lingkar pinggang 79", atau "79" setelah ditanya
 * pinggang) dibandingkan dengan SIZE CHART oleh kode, jadi model tidak menebak.
 */
export function compareWithSizeChart(rows: LeanHistoryRow[], chartText: string) {
  const groups = parseSizeCharts(chartText)
  if (!groups.length) return ''
  const body = new Map<string, number>()
  let asked = ''
  for (const row of rows.slice(-20)) {
    const text = String(row.body || '').toLowerCase()
    if (row.direction === 'out') {
      asked = BODY_PARTS.find((part) => text.includes(part)) || (/berat|tinggi/.test(text) ? '' : asked)
      continue
    }
    let found = false
    for (const part of BODY_PARTS) {
      const hit = text.match(new RegExp(`${part}\\D{0,12}(\\d{2,3}(?:[.,]\\d)?)`))
      if (hit) {
        body.set(part === 'pinggul' ? 'panggul' : part, Number(hit[1].replace(',', '.')))
        found = true
      }
    }
    const bare = text.trim().match(/^(?:sekitar\s*|kurang lebih\s*)?(\d{2,3})(?:\s*(?:an|cm))?(?:\s*sih)?$/)
    if (!found && bare && asked) body.set(asked === 'pinggul' ? 'panggul' : asked, Number(bare[1]))
  }
  if (!body.size) return ''
  const lines: string[] = []
  for (const [part, value] of body) {
    // Pinggang/panggul/paha → celana (size angka); dada/bahu/lengan → atasan (size huruf).
    const lower = ['pinggang', 'panggul', 'paha'].includes(part)
    for (const group of groups) {
      const numeric = group.rows.every((row) => /^\d+$/.test(row.size))
      if (lower !== numeric) continue
      const sized = group.rows.filter((row) => row.values.has(part))
      if (!sized.length) continue
      // v3.6.128: "pinggang 34" = NOMOR size celana (label 28–40), bukan 34 cm (dulu → "paling dekat 28").
      const label = lower && value < 50 ? group.rows.find((row) => row.size === String(value)) : undefined
      if (label) {
        lines.push(
          `${group.name}: pelanggan menyebut ${part} ${value} = nomor size celana ${value} (bukan cm; ukuran jadinya ${label.values.get(part) ?? '-'} cm). Pakai size ${value} langsung, cek ready-nya di KATALOG.`
        )
        continue
      }
      // Ukuran jadi yang PALING DEKAT dengan ukuran badan; bila sama dekat, pilih yang lebih besar.
      const sorted = [...sized].sort((a, b) => a.values.get(part)! - b.values.get(part)!)
      const largest = sorted[sorted.length - 1].values.get(part)!
      const fit =
        value > largest + 2
          ? undefined
          : sorted.reduce((best, row) => {
              const diff = Math.abs(row.values.get(part)! - value)
              const bestDiff = Math.abs(best.values.get(part)! - value)
              return diff < bestDiff || (diff === bestDiff && row.values.get(part)! > best.values.get(part)!) ? row : best
            }, sorted[0])
      const index = fit ? sorted.indexOf(fit) : sorted.length - 1
      const around = sorted.slice(Math.max(0, index - 1), index + 2)
      lines.push(
        `${group.name}: ${part} badan ${value} cm → ${around.map((row) => `${row.size} = ${row.values.get(part)} cm`).join(', ')}. ` +
          (fit
            ? `Paling dekat: ${fit.size} (${fit.values.get(part)} cm, selisih ${Math.abs(Math.round((fit.values.get(part)! - value) * 10) / 10)} cm). Sebut nomor ini (toko memakai angka chart langsung); jangan naikkan nomor dengan alasan longgar/ngepress.`
            : 'Lebih besar dari size terbesar: sarankan custom/tanya CS.')
      )
    }
  }
  // v3.6.84 — "lebar dada / panjang badan" biasanya ukuran BAJU yang dibentangkan, bukan lingkar badan
  // (uji chat nyata: lebar dada 105 dari TB 154/BB 45 dibaca lingkar dada → size XL, bertentangan).
  const garment = rows
    .slice(-20)
    .some((row) => row.direction === 'in' && /\blebar\s+dada\b|\bpanjang\s+badan\b/i.test(String(row.body || '')))
  const caution = garment
    ? '\nPelanggan menulis "lebar dada/panjang badan" (biasanya ukuran baju dibentangkan, bukan lingkar badan): jangan langsung tentukan size dari angka ini; tanya singkat itu ukuran badan atau ukuran baju yang biasa dipakai.'
    : ''
  return lines.length
    ? `PERBANDINGAN SIZE CHART (dihitung sistem dari ukuran badan pelanggan; ukuran jadi ±1-2 cm):\n- ${lines.join('\n- ')}\nPakai hasil ini; bila berbeda dengan Fit Advisor, sebutkan keduanya singkat dan utamakan ukuran badan yang diukur. Pelanggan sudah menyebut size biasanya dan Fit Advisor sama → pakai size itu; satu ukuran saja (mis. bahu) tidak cukup untuk menaikkan size.${caution}`
    : ''
}

/** v3.6.133 — kata warna sehari-hari → warna katalog yang termasuk (uji: "biru" tanpa Navy, "coklat" tanpa Choco). */
const COLOR_FAMILY: Array<[RegExp, string[]]> = [
  // v3.6.140 — hitam dulu (uji 3 putaran: "item polos tanpa garis putih" dijawab jas putih).
  [/\b(hitam|item|hitem|ireng|black)\b/, ['black']],
  [/\b(biru|blue|dongker|benhur)\b/, ['navy', 'blue', 'denim']],
  [/\b(coklat|cokelat|cokat|brown|kopi|mocca|moka)\b/, ['brown', 'choco', 'mahogany']],
  [/\b(abu|abu2|abu abu|grey|gray)\b/, ['gray']],
  [/\b(hijau|ijo|green|army|olive|sage)\b/, ['army', 'green', 'sage', 'olive']],
  [/\b(merah|marun|maroon|burgundy|wine)\b/, ['maroon', 'burgundy', 'red']],
  [/\b(putih|white|broken white)\b/, ['white', 'putih']],
  [/\b(krem|cream|beige|khaki)\b/, ['cream', 'khaki', 'beige']],
]

const SIZE_WORD = /(?:^|\s)(?:size|ukuran|uk|pakai|pake)?\s*(xs|s|m|l|xl|xxl|3xl|4xl)(?=\s|$|[.,!?])/i
/**
 * v3.6.140 — "yang ready stok yang mana aja?" dengan size yang sudah disebut → daftar produk ready size itu
 * (uji chat asli: AI hanya menyebut satu model, padahal banyak model ready size M).
 */
export function readySizeHint(text: string, history: LeanHistoryRow[], catalog: LeanCatalogRow[]) {
  const now = ` ${fold(text)} `
  if (!/\b(ready|redy|stok|stock|ada)\b/.test(now) || !/\b(mana|mna|apa|ap)\s*(aja|saja|aj|ajah)\b|\b(?:yang|yg) (?:mana|mna)\b|\bmodel apa\b/.test(now)) return ''
  const said = [text, ...history.filter((row) => row.direction === 'in' && !row.current).slice(-6).reverse().map((row) => String(row.body || ''))]
  const size = said.map((body) => ` ${fold(body)} `.match(SIZE_WORD)?.[1]).find(Boolean)?.toUpperCase()
  if (!size) return ''
  const has = (row: LeanCatalogRow) => String(row.sizesReady || '').toUpperCase().split(/[\s,/]+/).includes(size)
  const groups = new Map<string, string[]>()
  for (const row of catalog)
    if (row.price && has(row) && /suits|jas|setelan/i.test(`${row.category} ${row.product}`) && !/^setelan\b/i.test(row.product))
      groups.set(row.product, [...(groups.get(row.product) || []), row.color])
  if (!groups.size) return `READY SIZE ${size}: tidak ada jas ready size ${size} di KATALOG — tawarkan pre-order atau size lain yang ready.`
  const list = [...groups.entries()].slice(0, 8).map(([product, colors]) => `${product} (${colors.slice(0, 5).join(', ')})`)
  return `READY SIZE ${size} di KATALOG (sebut beberapa pilihan per model, bukan satu saja): ${list.join('; ')}.`
}

/** "sejuta", "1jt", "700k", "700rb", "1,5 juta" → rupiah. */
export function budgetOf(text: string) {
  const t = fold(text).replace(/(\d) (\d)/g, '$1.$2')
  if (/\bsejuta(an)?\b/.test(t)) return 1_000_000
  if (/\bsetengah juta\b/.test(t)) return 500_000
  const m = String(text || '').toLowerCase().match(/(\d+(?:[.,]\d+)?)\s*(jt|juta|k|rb|ribu)\b/)
  if (!m) return 0
  const value = Number(m[1].replace(',', '.'))
  return Math.round(value * (/^(jt|juta)$/.test(m[2]) ? 1_000_000 : 1_000))
}

/**
 * v3.6.133 — Petunjuk kelengkapan dari KODE (uji: penilai menandai jawaban kurang lengkap): warna sekeluarga,
 * pilihan sesuai budget per seri, harga ukuran besar, rasa aman pelanggan, dan produk yang tidak dijual.
 */
export function shoppingHints(text: string, catalog: LeanCatalogRow[]) {
  const now = ` ${fold(text)} `
  const hints: string[] = []
  const priced = catalog.filter((row) => row.price)
  const wantsSuit = /\b(setelan|stel|set|satu stel|suit|jas celana)\b/.test(now)
  const wantsPants = /\b(celana|pants)\b/.test(now) && !wantsSuit
  const pool = priced.filter((row) =>
    wantsPants ? /pants|celana/i.test(`${row.category} ${row.product}`) : wantsSuit ? /setelan/i.test(`${row.category} ${row.product}`) : /suits|jas/i.test(String(row.category || ''))
  )
  // Warna sekeluarga yang ada (ready dulu). Warna yang DITOLAK ("tanpa garis putih", "bukan hitam") tidak dihitung.
  const wanted = now.replace(/\b(?:tanpa|bukan|selain|jangan)\s+(?:ada\s+)?(?:garis|list|les|aksen|kombinasi|warna)?\s*\w+/g, ' ')
  const plain = /\b(?:tanpa\s+(?:garis|list|les)|polos)\b/.test(now)
  for (const [pattern, keys] of COLOR_FAMILY) {
    if (!pattern.test(wanted)) continue
    const hits = (pool.length ? pool : priced).filter(
      (row) => keys.some((key) => fold(row.color).includes(key)) && !(plain && /\blist\b/i.test(row.product))
    )
    if (!hits.length) continue
    const ready = hits.filter((row) => row.sizesReady)
    const names = [...new Set((ready.length ? ready : hits).map((row) => `${row.product} - ${row.color}${row.sizesReady ? ` (${row.sizesReady})` : ''}`))].slice(0, 8)
    hints.push(`Warna yang termasuk permintaan pelanggan di KATALOG (sebut semua pilihannya, bukan satu saja): ${names.join('; ')}.`)
    break
  }
  // v3.6.136 — Tanya nuansa/varian satu warna → semua varian katalognya.
  if (/\b(gelap|terang|cerah|muda|tua|warnanya|varian|beda|macam|jenis)\b/.test(now))
    for (const group of colorVariantsIn(text, catalog))
      hints.push(`Warna ${group.base} di KATALOG ada beberapa varian: ${group.text}. Jangan bilang cuma satu warna; sebut variannya dan tawarkan foto agar pelanggan bisa membandingkan gelap-terangnya.`)
  // Budget → pilihan per seri yang masuk.
  const budget = budgetOf(text)
  if (budget >= 100_000 && pool.length) {
    // Satu baris per harga (seri): produk sama bisa beda seri (reguler 705.000 / Signature 725.000).
    const byPrice = new Map<number, string>()
    for (const row of [...pool].sort((a, b) => Number(a.price) - Number(b.price))) {
      const price = Number(row.price)
      if (price > budget * 1.05 || byPrice.has(price)) continue
      byPrice.set(price, `${row.product}${/^signature\b/i.test(row.color) ? ' Signature' : ''} ${rupiah(price)}`)
    }
    const options = [...byPrice.entries()].sort((a, b) => a[0] - b[0])
    if (options.length) {
      const series = options.map(([, text]) => text).slice(0, 6)
      hints.push(`Budget pelanggan ±Rp${rupiah(budget)} — pilihan yang masuk dari tiap harga/seri: ${series.join('; ')}. Sebut beberapa pilihan (termurah sampai yang paling mendekati budget), jangan hanya yang termahal.`)
    }
  }
  // Size besar → harga di kurung.
  if (/\b(xxl|xxxl|3xl|4xl|2xl)\b/.test(now))
    hints.push('Size XXL ke atas memakai harga ukuran besar (angka di kurung KATALOG, mis. "XXL-3XL 585.000") — sebut bila menyebut harga/total untuk size itu.')
  // Takut tertipu → fakta toko.
  if (/\b(takut|khawatir|ragu)\b.{0,30}\b(tipu|ketipu|ditipu|penipu\w*|scam|bohong)\b|\b(amanah|terpercaya|real|asli ga|aman ga|aman gak)\b/.test(now))
    hints.push('Pelanggan khawatir tertipu: tenangkan dengan fakta toko — alamat toko fisik (lihat TOKO), boleh datang langsung, rekening atas nama pemilik toko, dan pesanan bisa dicek. Jangan klaim "resmi" tanpa data.')
  // Produk yang tidak dijual → kategori yang ada.
  if (/\b(batik|kebaya|gamis|sarung|sepatu|blangkon|kaos|hoodie|jaket|koko)\b/.test(now)) {
    const categories = [...new Set(priced.map((row) => String(row.category || '')).filter(Boolean))]
    const shirts = priced.filter((row) => /shirt|kemeja/i.test(`${row.category} ${row.product}`))
    hints.push(
      `Produk itu tidak dijual. Kategori yang ada: ${categories.join(', ')}.${shirts.length ? ` Ditanya kemeja → tawarkan ${[...new Set(shirts.map((row) => `${row.product} - ${row.color} ${rupiah(Number(row.price))}`))].slice(0, 4).join(', ')}.` : ''}`
    )
  }
  return hints
}
