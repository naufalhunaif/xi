// Beta 3 — berat pesanan untuk cek ongkir. Sistem yang menghitung, bukan AI:
// AI cukup menulis item & bagiannya ("Jas, Celana") di spesifikasi.
import { readLeanState, writeLeanState } from '#beta3/tables'

export const DEFAULT_ITEM_GRAMS = 1000

/** Berat per jenis barang (gram), diatur pemilik di Pengaturan → Berat & ongkir. */
export const ITEM_TYPES = [
  { key: 'jas', label: 'Jas / Tuxedo', grams: 800, pattern: /\b(jas|tuxedo|blazer|suit|coat)\b/ },
  { key: 'celana', label: 'Celana', grams: 400, pattern: /\b(celana|pants|trousers?)\b/ },
  { key: 'rompi', label: 'Rompi', grams: 250, pattern: /\b(rompi|vest|waistcoat)\b/ },
  { key: 'kemeja', label: 'Kemeja', grams: 250, pattern: /\b(kemeja|shirt)\b/ },
  { key: 'beskap', label: 'Beskap', grams: 700, pattern: /\bbeskap\b/ },
  { key: 'lainnya', label: 'Lainnya / belum jelas', grams: DEFAULT_ITEM_GRAMS, pattern: /$^/ },
] as const

export type ItemWeights = Record<string, number>

export async function readItemWeights(): Promise<ItemWeights> {
  let saved: ItemWeights = {}
  try {
    saved = JSON.parse(String((await readLeanState('item_weights')) || '{}')) || {}
  } catch {}
  return Object.fromEntries(
    ITEM_TYPES.map((type) => {
      const value = Math.round(Number(saved[type.key]))
      return [type.key, value > 0 ? value : type.grams]
    })
  )
}

export async function saveItemWeights(input: Record<string, unknown>) {
  const current = await readItemWeights()
  for (const type of ITEM_TYPES) {
    const value = Math.round(Number(input[type.key]))
    if (Number.isFinite(value) && value > 0 && value <= 50_000) current[type.key] = value
  }
  await writeLeanState('item_weights', JSON.stringify(current))
  return current
}

const key = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Baris bagian yang dibuat: "Jas, Celana", "Jas saja", "Celana + Rompi". */
const PIECES_LINE =
  /^(jas|tuxedo|blazer|celana|rompi|vest|kemeja|beskap)(\s*(,|&|\+|\bdan\b)\s*(jas|tuxedo|blazer|celana|rompi|vest|kemeja|beskap))*(\s+saja|\s+aja)?$/i

function piecesGrams(text: string, weights: ItemWeights) {
  const lower = key(text)
  let grams = 0
  for (const type of ITEM_TYPES) if (type.pattern.test(lower)) grams += weights[type.key] || type.grams
  return grams
}

/**
 * Berat pesanan (gram) dari lembar spesifikasi. Per blok item:
 * 1) bagian ditulis ("Jas, Celana") → jumlah berat per jenis dari pengaturan;
 * 2) tanpa baris bagian, produk katalog punya berat → berat katalog;
 * 3) jenis dari nama item ("Celana Bahan - Hitam") → berat jenis;
 * 4) selain itu berat "Lainnya". Dikali jumlah (pcs/set). Spesifikasi kosong = 1 kg.
 */
export function estimateOrderGrams(spec: string, catalog: Record<string, number>, weights: ItemWeights) {
  const text = String(spec || '').trim()
  const other = weights.lainnya || DEFAULT_ITEM_GRAMS
  if (!text) return DEFAULT_ITEM_GRAMS
  const byProduct = new Map<string, number[]>()
  for (const [name, grams] of Object.entries(catalog)) {
    const product = name.split('|')[0]
    byProduct.set(product, [...(byProduct.get(product) || []), grams])
  }
  const products = [...byProduct.keys()].filter((name) => name.length >= 3).sort((a, b) => b.length - a.length)
  let total = 0
  let items = 0
  // v3.6.68: blok lanjutan tanpa nama produk yang hanya mengulang bagian item sebelumnya
  // ("Celana / Size 32 / panjang 92" sesudah "Jas, Celana") adalah detail, bukan barang baru
  // (kasus Alkhoiri 8 Okt: celana terhitung dua kali → 1,4 kg → ongkir 150.000, seharusnya 75.000).
  let previousParts = new Set<string>()
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block
      .split('\n')
      .map((line) => line.replace(/^\s*\d+[.)]\s*/, '').trim())
      .filter(Boolean)
    const head = lines.find((line) => /\s[-–—]\s/.test(line)) || lines[0] || ''
    const piecesLine = lines.find((line) => PIECES_LINE.test(line))
    const [left, ...rest] = head.split(/\s+[-–—]\s+/)
    const name = key(left)
    const product = products.find((candidate) => ` ${name} `.includes(` ${candidate} `))
    const parts = new Set(ITEM_TYPES.filter((type) => piecesLine && type.pattern.test(key(piecesLine))).map((type) => type.key))
    const hasHead = lines.some((line) => /\s[-–—]\s/.test(line))
    const qtyHere = /(\d{1,3})\s*(pcs|potong|set|stel|setel|buah|orang|pasang)\b|\b(?:qty|jumlah)\s*:?\s*\d/i.test(block)
    if (!hasHead && !product && !qtyHere && parts.size && [...parts].every((part) => previousParts.has(part))) continue
    if (parts.size) previousParts = parts
    let grams = piecesLine ? piecesGrams(piecesLine, weights) : 0
    if (!grams && product) {
      const color = key(rest.join(' ').split(/,|\bsize\b|\bukuran\b|\bno\b|\(/i)[0])
      const list = byProduct.get(product) || []
      grams = catalog[`${product}|${color}`] || (list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : 0)
    }
    if (!grams) grams = piecesGrams(head, weights)
    if (!grams) {
      // Blok catatan (mis. "Ukuran badan: …") bukan item.
      if (!product && !/setelan|set\b|pcs|potong/i.test(block)) continue
      grams = other
    }
    const qty =
      block.match(/(\d{1,3})\s*(pcs|potong|set|stel|setel|buah|orang|pasang)\b/i) ||
      block.match(/\b(?:qty|jumlah)\s*:?\s*(\d{1,3})\b/i)
    total += grams * Math.max(1, Number(qty?.[1]) || 1)
    items++
  }
  return items ? total : DEFAULT_ITEM_GRAMS
}

/** Berat pesanan dengan data tersimpan (berat katalog + pengaturan). */
export async function orderWeightGrams(spec: string) {
  let catalog: Record<string, number> = {}
  try {
    catalog = JSON.parse(String((await readLeanState('product_weights')) || '{}')) || {}
  } catch {}
  return estimateOrderGrams(spec, catalog, await readItemWeights())
}

export const gramsToKgText = (grams: number) => `${(Math.round(grams / 100) / 10).toLocaleString('id-ID')} kg`
