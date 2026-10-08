// Beta 3.5 — pola harga per seri bahan, dihitung sistem dari KATALOG (bukan dihafal AI):
// seri (reguler/signature/premium) × barang (jas/celana/setelan/rompi) × model (standar/double breasted).
import type { LeanCatalogRow } from '#beta3/catalog_service'

export type PriceSeries = 'reguler' | 'signature' | 'premium' | 'tradero'
export type PriceItem = 'jas' | 'celana' | 'setelan' | 'rompi'
export type PriceModel = 'standar' | 'db'
export type PriceCell = { price: number; big: number }
export type PricePattern = {
  series: Partial<Record<PriceSeries, { materials: string[]; cells: Partial<Record<`${PriceItem}:${PriceModel}`, PriceCell>> }>>
}

const SERIES_LABEL: Record<PriceSeries, string> = {
  reguler: 'Reguler',
  signature: 'Signature',
  premium: 'Premium',
  tradero: 'Tradero',
}
const ITEMS: PriceItem[] = ['jas', 'celana', 'setelan', 'rompi']

export function seriesOf(row: Pick<LeanCatalogRow, 'product' | 'color'>): PriceSeries {
  const text = `${row.product} ${row.color}`
  if (/premium/i.test(text)) return 'premium'
  if (/signature/i.test(text)) return 'signature'
  if (/tradero/i.test(text)) return 'tradero'
  return 'reguler'
}

export function itemOf(row: Pick<LeanCatalogRow, 'product' | 'category'>): PriceItem | null {
  const text = `${row.category} ${row.product}`
  if (/jahit/i.test(text)) return null
  if (/setelan/i.test(text)) return 'setelan'
  if (/\b(pants|celana)\b/i.test(text)) return 'celana'
  if (/\b(vest|rompi)\b/i.test(text)) return 'rompi'
  if (/\b(suits?|jas|tuxedo|beskap|bescap|blazer)\b/i.test(text)) return 'jas'
  return null
}

const modelOf = (row: Pick<LeanCatalogRow, 'product'>): PriceModel =>
  /double\s*breasted/i.test(row.product) ? 'db' : 'standar'

const bigOf = (row: Pick<LeanCatalogRow, 'note'>) => {
  const match = String(row.note || '').match(/XXL(?:-\d?X*L)?\s+([\d.]{5,})/i)
  return match ? Number(match[1].replace(/\./g, '')) || 0 : 0
}

const mode = (values: number[]) => {
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] || 0
}

/** Pola harga dari baris katalog aktif (harga terbanyak per seri × barang × model). */
export function pricePattern(rows: LeanCatalogRow[]): PricePattern {
  const buckets = new Map<string, { prices: number[]; bigs: number[] }>()
  const materials = new Map<PriceSeries, Set<string>>()
  for (const row of rows) {
    if (!row.active || !row.price) continue
    const item = itemOf(row)
    if (!item) continue
    const series = seriesOf(row)
    const key = `${series}|${item}:${modelOf(row)}`
    const bucket = buckets.get(key) || { prices: [], bigs: [] }
    bucket.prices.push(row.price)
    const big = bigOf(row)
    if (big) bucket.bigs.push(big)
    buckets.set(key, bucket)
    if (row.material) {
      const set = materials.get(series) || new Set<string>()
      set.add(row.material.trim())
      materials.set(series, set)
    }
  }
  const pattern: PricePattern = { series: {} }
  for (const [key, bucket] of buckets) {
    const [series, cell] = key.split('|') as [PriceSeries, `${PriceItem}:${PriceModel}`]
    const entry = (pattern.series[series] ||= { materials: [...(materials.get(series) || [])].sort(), cells: {} })
    entry.cells[cell] = { price: mode(bucket.prices), big: bucket.bigs.length ? mode(bucket.bigs) : 0 }
  }
  return pattern
}

const money = (value: number) => value.toLocaleString('id-ID')

/** Teks POLA HARGA untuk prompt & halaman katalog. Kosong bila katalog belum ada. */
export function renderPricePattern(pattern: PricePattern) {
  const lines: string[] = []
  for (const series of ['reguler', 'signature', 'premium', 'tradero'] as PriceSeries[]) {
    const entry = pattern.series[series]
    if (!entry) continue
    const part = (model: PriceModel) =>
      ITEMS.map((item) => {
        const cell = entry.cells[`${item}:${model}`]
        return cell ? `${item} ${money(cell.price)}${cell.big && cell.big !== cell.price ? ` (XXL+ ${money(cell.big)})` : ''}` : ''
      })
        .filter(Boolean)
        .join(' · ')
    const standard = part('standar')
    const db = part('db')
    if (!standard && !db) continue
    lines.push(
      `- ${SERIES_LABEL[series]}${entry.materials.length ? ` (bahan ${entry.materials.join(', ')})` : ''}: ${standard}${db ? `; Double Breasted: ${db}` : ''}`
    )
  }
  if (!lines.length) return ''
  return [
    'POLA HARGA (dihitung sistem dari KATALOG; harga S–XL, ukuran besar di kurung):',
    ...lines,
    'Setelan = jas + celana dari SERI YANG SAMA (pakai harga "setelan" seri itu, bukan harga jas). Celana untuk setelan/jas premium = celana seri premium. Jas & celana satu setelan bahannya sama. Model yang namanya beda tapi seri sama (Basic Suit, Peak Suit, Tuxedo, Beskap) harganya sama kecuali Double Breasted. Ukuran besar (XXL ke atas) = harga di kurung, juga saat custom.',
  ].join('\n')
}

const PRICE = /\d{1,3}(?:\.\d{3})+/g
const ITEM_WORDS: Array<[PriceItem, RegExp]> = [
  ['setelan', /\b(setelan|stelan|\bset\b|jas\s*(?:dan|\+|&|sama)\s*celana)/i],
  ['celana', /\b(celana|pants)/i],
  ['rompi', /\b(rompi|vest)/i],
  ['jas', /\b(jas|blazer|suit|tuxedo|beskap)/i],
]

/** Seri yang disebut paling akhir di teks (premium/signature/reguler), atau null. */
export function seriesMentioned(texts: string[]): PriceSeries | null {
  for (const text of [...texts].reverse()) {
    const hits = [...String(text || '').matchAll(/\b(premium|signature|reguler|regular|biasa|standar|standard|black label|portofino|scuro|maximotion)\b/gi)]
    const last = hits.pop()?.[1]?.toLowerCase()
    if (!last) continue
    if (/premium|black label|portofino/.test(last)) return 'premium'
    if (/signature|scuro/.test(last)) return 'signature'
    return 'reguler'
  }
  return null
}

/**
 * Pemeriksa harga sesuai konteks: kalimat yang hanya membahas satu jenis barang (mis. "setelan
 * premium 685.000") harus memakai harga barang itu di seri yang dibahas. Angka yang ada di pola
 * harga tapi milik barang/seri lain diganti angka yang benar. Kalimat campuran (jas & celana)
 * atau angka di luar pola tidak diubah.
 */
export function fixContextPrices(
  pesan: string[],
  pattern: PricePattern,
  series: PriceSeries | null,
  /** Nama produk katalog (huruf kecil) → harga sah; "Basic Suit 485.000" tidak pernah diubah. */
  productPrices?: Map<string, Set<number>>
) {
  const changes: Array<{ from: number; to: number; item: PriceItem }> = []
  if (!series || !pattern.series[series]) return { pesan, changes }
  const known = new Set<number>()
  for (const value of Object.values(pattern.series))
    for (const cell of Object.values(value?.cells || {})) {
      if (cell?.price) known.add(cell.price)
      if (cell?.big) known.add(cell.big)
    }
  const DOT = '\u2024'
  const fixed = pesan.map((bubble) =>
    // Daftar harga (≥ 2 baris berharga) = rincian katalog, bukan jawaban konteks → tidak diubah.
    bubble.split('\n').filter((line) => /\d{1,3}\.\d{3}/.test(line)).length >= 2
      ? bubble
      : bubble
      // Titik ribuan (485.000) dilindungi supaya tidak dianggap akhir kalimat.
      .replace(/(\d)\.(?=\d{3}\b)/g, `$1${DOT}`)
      .split(/(?<=[.!?\n])/)
      .map((part) => part.split(DOT).join('.'))
      .map((sentence) => {
        const prices = sentence.match(PRICE) || []
        // Satu angka per kalimat; perbandingan ("485.000, premium 685.000") tidak diubah.
        if (prices.length !== 1) return sentence
        const items = ITEM_WORDS.filter(([, pattern]) => pattern.test(sentence)).map(([item]) => item)
        // "setelan" sering ditulis bersama kata jas/celana ("setelan jas dan celana") → tetap setelan.
        const item = items.includes('setelan') ? 'setelan' : items.length === 1 ? items[0] : null
        if (!item) return sentence
        const own = seriesMentioned([sentence])
        const target = pattern.series[own || series]
        if (!target) return sentence
        const model: PriceModel = /double\s*breasted|\bdb\b/i.test(sentence) ? 'db' : 'standar'
        const cell = target.cells[`${item}:${model}`] || target.cells[`${item}:standar`]
        if (!cell) return sentence
        const big = /\b(xxl|[2-5]xl|jumbo|ukuran besar)\b/i.test(sentence)
        const lower = sentence.toLowerCase()
        return sentence.replace(PRICE, (raw) => {
          const value = Number(raw.replace(/\./g, ''))
          if (value === cell.price || value === cell.big || !known.has(value)) return raw
          // Nama produk disebut dan angkanya memang harga produk itu → benar, biarkan.
          for (const [name, valid] of productPrices || [])
            if (valid.has(value) && lower.includes(name)) return raw
          const to = big && cell.big ? cell.big : cell.price
          changes.push({ from: value, to, item })
          return money(to)
        })
      })
      .join('')
  )
  return { pesan: fixed, changes }
}

/** Nama produk katalog (huruf kecil, ≥ 4 huruf) → harga sah (S–XL & ukuran besar). */
export function productPriceMap(rows: LeanCatalogRow[]) {
  const map = new Map<string, Set<number>>()
  for (const row of rows) {
    if (!row.active || !row.price) continue
    const name = row.product.trim().toLowerCase()
    if (name.length < 4) continue
    const set = map.get(name) || new Set<number>()
    set.add(row.price)
    const big = bigOf(row)
    if (big) set.add(big)
    map.set(name, set)
  }
  return map
}
