// Satu jalur perapian balasan (dipakai reply_service DAN tes ulasan chat), supaya perbaikan
// yang saling bersinggungan selalu diuji bersama: daftar, gaya, harga sesuai seri, pembuka,
// urutan foto, dan pengantar foto.
import { tidyLists } from '#beta3/list_tidy'
import { tidyReply } from '#beta3/reply_tidy'
import { questionAfterPhotos } from '#beta3/reply_guards'
import { fixContextPrices, type PricePattern, type PriceSeries } from '#beta3/price_pattern'

const WH_QUESTION = /\b(apa aja|apa saja|apa ajah|seperti apa|kayak apa|kaya apa|kek apa|gimana|bagaimana|berapa|brp|yang mana)\b/i

/**
 * "Ada bos," hanya untuk menjawab "ada X?" (stok/model tertentu). Pertanyaan "apa aja / seperti apa /
 * berapa" langsung dijawab: pembuka itu dibuang.
 */
export function dropWrongOpener(pesan: string[], customerText: string) {
  if (!pesan.length || !WH_QUESTION.test(customerText)) return pesan
  const [first, ...rest] = pesan
  const stripped = first.replace(/^\s*ada\s+(?:bos|kak)\s*[,.!]?\s*/i, '')
  if (stripped === first || !stripped) return pesan
  return [stripped[0].toUpperCase() + stripped.slice(1), ...rest]
}

const SEE_REQUEST = /\b(seperti apa|kayak apa|kaya apa|kek apa|modelnya gimana|gimana modelnya|liat|lihat|foto|fotonya|gambar)\b/i
const ASKS_DETAIL = /\b(beda|bedanya|perbedaan|kerah|kancing|bahan|detail|size|ukuran|ready|stok)\b/i
const SIZE_INFO = /\b(size|ready|stok|xs|s|m|l|xl|xxl|[2-4]xl)\b/i

/**
 * Pelanggan minta lihat ("seperti apa?") dan foto dikirim: nama produk & warna sudah ada di caption
 * foto, jadi pengantar cukup "Ini fotonya bos" (+ harga bila disebut), bukan deskripsi panjang.
 */
export function compactPhotoIntro(
  pesan: string[],
  photos: Array<{ caption: string }>,
  customerText: string,
  address = 'bos'
) {
  if (!photos.length || !pesan.length) return pesan
  if (!SEE_REQUEST.test(customerText) || ASKS_DETAIL.test(customerText)) return pesan
  const first = pesan[0]
  if (SIZE_INFO.test(first)) return pesan
  const names = new Set(
    photos.flatMap((photo) =>
      photo.caption
        .split(' - ')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part.length >= 3)
    )
  )
  const mentioned = [...names].filter((name) => first.toLowerCase().includes(name)).length
  if (mentioned < 2 && first.length <= 90) return pesan
  const prices = [...new Set(first.match(/\d{1,3}(?:\.\d{3})+/g) || [])]
  // Harga berbeda-beda (daftar model) = informasi; tidak diringkas.
  if (prices.length > 1) return pesan
  const intro = `Ini fotonya ${address}${prices.length === 1 ? `, harganya ${prices[0]}` : ''}`
  return [intro, ...pesan.slice(1)]
}

const PROMISES_PHOTO = /\b(foto|fotonya|gambar|gambarnya|contohnya)\b/i

type PhotoRow = { product: string; color: string; photoUrl: string | null; active?: boolean }

/**
 * Balasan bilang "ini fotonya" (atau pelanggan minta lihat) dan menyebut beberapa model, tapi field
 * `foto` tidak memuat semuanya → produk yang disebut tapi belum ada fotonya ditambahkan (warna yang
 * disebut di balasan bila ada, selain itu varian pertama yang punya foto). Mengembalikan label tambahan.
 */
export function completePhotos(pesan: string[], foto: string[], customerText: string, rows: PhotoRow[], max = 6) {
  const text = pesan.join('\n')
  if (!PROMISES_PHOTO.test(text) && !SEE_REQUEST.test(customerText)) return []
  const withPhoto = rows.filter((row) => row.photoUrl && row.active !== false)
  const names = [...new Set(withPhoto.map((row) => row.product))]
    .filter((name) => name.trim().length >= 4)
    .sort((a, b) => b.length - a.length)
  let blanked = text.toLowerCase()
  const mentioned: Array<{ at: number; name: string }> = []
  for (const name of names) {
    const at = blanked.indexOf(name.toLowerCase())
    if (at < 0) continue
    mentioned.push({ at, name })
    // "Premium Basic Suit" tidak ikut terhitung sebagai "Basic Suit".
    blanked = blanked.split(name.toLowerCase()).join(' '.repeat(name.length))
  }
  if (!mentioned.length) return []
  const covered = new Set(
    foto.map((label) => {
      const lower = label.toLowerCase()
      const hit = names.find((name) => lower.startsWith(name.toLowerCase()))
      return hit || label
    })
  )
  const extra: string[] = []
  for (const { name } of mentioned.sort((a, b) => a.at - b.at)) {
    if (covered.has(name) || foto.length + extra.length >= max) continue
    const variants = withPhoto.filter((row) => row.product === name)
    const row = variants.find((item) => item.color && text.toLowerCase().includes(item.color.toLowerCase())) || variants[0]
    if (!row) continue
    extra.push(row.color ? `${row.product} - ${row.color}` : row.product)
    covered.add(name)
  }
  return extra
}

export type PolishContext = {
  customerText: string
  address?: string
  verbatim?: string[]
  prices: PricePattern
  series: PriceSeries | null
  /** Nama produk katalog (huruf kecil) → harga sah (S–XL & besar). */
  productPrices?: Map<string, Set<number>>
}

/** Perapian teks (sebelum pemeriksa harga katalog). */
export function polishText(pesan: string[], context: PolishContext) {
  let out = pesan.map(tidyLists)
  out = tidyReply(out, { address: context.address || 'bos', verbatim: context.verbatim || [] })
  const priceFix = fixContextPrices(out, context.prices, context.series, context.productPrices)
  out = dropWrongOpener(priceFix.pesan, context.customerText)
  return { pesan: out, priceChanges: priceFix.changes }
}

/** Perapian yang butuh daftar foto (di akhir): pengantar foto & urutan jawaban → foto → pertanyaan. */
export function polishWithPhotos(
  pesan: string[],
  photos: Array<{ caption: string }>,
  customerText: string,
  address = 'bos'
) {
  return compactPhotoIntro(questionAfterPhotos(pesan, photos.length), photos, customerText, address)
}
