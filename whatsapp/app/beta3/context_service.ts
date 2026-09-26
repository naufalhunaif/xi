// Pengumpul konteks: disusun KODE (bukan AI) sebelum model mana pun menjawab.
// Hasilnya fakta ringkas yang sama untuk ChatGPT, Claude, maupun Gemini, sehingga
// model ringan pun tidak perlu menebak produk, harga, atau data yang sudah diberikan.
import { findCatalogVariant, rupiah, type LeanCatalogRow } from '#beta3/catalog_service'
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
      for (const pair of tokens[2].matchAll(/([a-z][a-z ]*?)\s+(\d+(?:[.,]\d+)?)/gi))
        values.set(pair[1].trim().toLowerCase().replace(/^lingkar\s+/, ''), Number(pair[2].replace(',', '.')))
      if (values.size) rows.push({ size: tokens[1], values })
    }
    if (rows.length) groups.push({ name: match[1].trim(), rows })
  }
  return groups
}

const BODY_PARTS = ['pinggang', 'dada', 'panggul', 'pinggul', 'bahu', 'lengan', 'paha']

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
      // Ukuran jadi harus ≥ ukuran badan (toleransi 1 cm); ambil yang paling kecil yang muat.
      const sorted = [...sized].sort((a, b) => a.values.get(part)! - b.values.get(part)!)
      const fit = sorted.find((row) => row.values.get(part)! >= value - 1)
      const index = fit ? sorted.indexOf(fit) : sorted.length - 1
      const around = sorted.slice(Math.max(0, index - 1), index + 2)
      lines.push(
        `${group.name}: ${part} badan ${value} cm → ${around.map((row) => `${row.size} = ${row.values.get(part)} cm`).join(', ')}. ` +
          (fit
            ? `Paling pas: ${fit.size} (${fit.values.get(part)} cm, selisih ${Math.round((fit.values.get(part)! - value) * 10) / 10} cm).`
            : 'Lebih besar dari size terbesar: sarankan custom/tanya CS.')
      )
    }
  }
  return lines.length
    ? `PERBANDINGAN SIZE CHART (dihitung sistem dari ukuran badan pelanggan; ukuran jadi ±1-2 cm):\n- ${lines.join('\n- ')}\nPakai hasil ini; bila berbeda dengan Fit Advisor, sebutkan keduanya singkat dan utamakan ukuran badan yang diukur.`
    : ''
}
