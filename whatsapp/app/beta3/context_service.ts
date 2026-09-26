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
  const measure = extractBodyMeasure(said)
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
