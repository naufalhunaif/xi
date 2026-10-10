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
/** Kata saran/alasan: bubble seperti ini adalah jawaban, bukan sekadar daftar nama di caption foto. */
const ADVICE =
  /\b(untuk|buat|cocok|biasanya|karena|soalnya|lebih|kalau|kalo|rekomendasi|saran\w*|pilih|gaya|acara|style|slim\w*|regular|nyaman|kesan|elegan|formal|santai|simpel|simple)\b/i

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
  // v3.6.58: jawaban yang berisi saran/alasan ("untuk gaya gen z biasanya pilih slimfit …") tetap
  // utuh — dulu ikut diringkas jadi "Ini fotonya bos" sehingga pertanyaan pelanggan tidak terjawab.
  if (ADVICE.test(first)) return pesan
  const mentioned = [...names].filter((name) => first.toLowerCase().includes(name)).length
  if (mentioned < 2 && first.length <= 90) return pesan
  const prices = [...new Set(first.match(/\d{1,3}(?:\.\d{3})+/g) || [])]
  // Harga berbeda-beda (daftar model) = informasi; tidak diringkas.
  if (prices.length > 1) return pesan
  const intro = `Ini fotonya ${address}${prices.length === 1 ? `, harganya ${prices[0]}` : ''}`
  return [intro, ...pesan.slice(1)]
}

const PROMISES_PHOTO = /\b(foto|fotonya|gambar|gambarnya|contohnya)\b/i

/**
 * v3.6.131 — Kalimat "… belum ada fotonya" bukan janji foto: dibuang sebelum foto dilengkapi/diselaraskan
 * (uji: "Basic Suit Signature Black belum ada fotonya" malah dikirimi foto Basic Suit Black 2.0, dan warna
 * tanpa foto yang disebut membuat semua foto Tuxedo dibuang).
 */
const NO_PHOTO = /\b(?:belum|tidak|tdk|gak|ga|nggak|blm)\s+(?:ada\s+)?(?:foto|gambar)\w*|\btanpa\s+foto\b|\bbelum\s+difoto\b/i
export function withoutNoPhotoClauses(text: string) {
  return String(text || '')
    .split(/(?<=[.!?\n])|,\s*(?=(?:kalau|kalo|tapi|untuk|yang)\b)/i)
    .filter((part) => !NO_PHOTO.test(part))
    .join(' ')
}

type PhotoRow = { product: string; color: string; photoUrl: string | null; active?: boolean }

/**
 * Balasan bilang "ini fotonya" (atau pelanggan minta lihat) dan menyebut beberapa model, tapi field
 * `foto` tidak memuat semuanya → produk yang disebut tapi belum ada fotonya ditambahkan (warna yang
 * disebut di balasan bila ada, selain itu varian pertama yang punya foto). Mengembalikan label tambahan.
 */
export function completePhotos(pesan: string[], foto: string[], customerText: string, rows: PhotoRow[], max = 6) {
  const text = withoutNoPhotoClauses(pesan.join('\n'))
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
  out = answerSalam(out, context.customerText, context.address || 'bos')
  return { pesan: out, priceChanges: priceFix.changes }
}

const SALAM_IN = /\b(?:ass?alamu'?\s*alaikum\w*|assalamualaikum\w*|asslm\w*|ass?alamu\s*'?a?laikum\w*)\b/i
const SALAM_OUT = /\b(?:wa'?\s*alaikum\w*|waalaikum\w*|walaikum\w*|wa'?alaikumsalam\w*)\b/i
const ACK_OPENER = /^\s*(?:siap|oke|ok|okay|baik|iya|ya)\s+(?:bos\w*|kak\w*|gan|sis|mas|mbak|pak|bu)\b\s*[,.!]?\s*/i
const COMMON_START =
  /^(?:siap|bisa|ada|untuk|buat|harga\w*|iya|ya|oke|baik|boleh|mohon|silakan|terima|maaf|kalau|kalo|yang|ini|itu|sudah|udah|belum|saya|kami|kita|mulai|lokasi|toko|jam|bahan\w*|ukuran\w*|size\w*|ongkir\w*|total\w*|estimasi|pengerjaan\w*|panjang\w*|lebar\w*|untuk|nanti|sekarang|semua|warna\w*|model\w*|stok\w*|ready)\b/i
const SAPA_OUT =
  /^\s*(?:halo|hai|hallo|selamat\s+(?:pagi|siang|sore|malam)|pagi|siang|sore|malam)\b(?:\s+(?:bos\w*|kak\w*|gan|sis|mas|mbak|pak|bu|juga))*\s*[,.!]\s*/i

/**
 * v3.6.99 — pelanggan memberi salam → balasan dibuka "Waalaikumsalam bos," seperti CS manusia
 * (uji: "Assalamualaikum, ankle pants panjangnya berapa" dijawab tanpa membalas salam).
 */
export function answerSalam(pesan: string[], customerText: string, address = 'bos') {
  if (!pesan.length || !SALAM_IN.test(customerText || '')) return pesan
  if (pesan.some((bubble) => SALAM_OUT.test(bubble))) return pesan
  const [first, ...rest] = pesan
  const body = first.replace(SAPA_OUT, '').replace(ACK_OPENER, '').trim()
  if (!body) return [`Waalaikumsalam ${address}`, ...rest]
  const lower = COMMON_START.test(body) ? body[0].toLowerCase() + body.slice(1) : body
  return [`Waalaikumsalam ${address}, ${lower}`, ...rest]
}

/** Kalimat tawaran "mau lihat modelnya?" / "mau saya kirim fotonya?" (bukan "model lainnya"). */
const PHOTO_OFFER =
  /[^.!?\n]*\b(?:mau|boleh|perlu|ingin|pengen)\b[^.!?\n]{0,20}\b(?:lihat|liat|kirim\w*|tunjuk\w*)\b[^.!?\n]{0,15}\b(?:foto|gambar|model|contoh)\w*\b(?![^.!?\n]*\blain)[^.!?\n]*\?/gi

/**
 * v3.6.58 — foto sudah ikut dikirim, jadi tawaran "Mau lihat modelnya bos?" dibuang (kasus Nofita:
 * foto terkirim lalu ditanya "mau lihat?", pelanggan jawab "Boleh" → foto yang sama dikirim lagi).
 */
export function dropPhotoOffers(pesan: string[], photoCount: number) {
  if (!photoCount) return pesan
  const kept = pesan
    .map((bubble) => (bubble.match(PHOTO_OFFER) ? bubble.replace(PHOTO_OFFER, '').replace(/^[\s,.!]+/, '').replace(/[ \t]{2,}/g, ' ').trim() : bubble))
    .filter(Boolean)
  return kept
}

const NORM = (value: string) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()
/** Pelanggan minta foto dikirim ulang / foto tidak muncul. */
const ASKS_AGAIN =
  /\b(?:kirim\w*|foto\w*|gambar\w*)\s+(?:lagi|ulang)\b|\bulang\w*\s+(?:foto|gambar)|\b(?:gak|ga|gk|nggak|ngga|tidak|belum|blm)\s+(?:muncul|masuk|keliatan|kelihatan|terlihat|kebuka|kebuka)\b/i

type SentRow = { direction: string; body?: unknown; current?: boolean; createdAt?: unknown }

/**
 * v3.6.58 — foto yang sama baru saja dikirim (caption ada di pesan keluar terakhir: WA = caption
 * gambar, IG = teks caption sesudah gambar) tidak dikirim lagi, kecuali pelanggan minta ulang.
 */
export function skipSentPhotos<P extends { caption: string }>(
  photos: P[],
  rows: SentRow[],
  customerText: string,
  options: { now?: number; window?: number; maxAgeMs?: number } = {}
) {
  if (!photos.length || ASKS_AGAIN.test(customerText || '')) return { photos, repeated: [] as string[] }
  const now = options.now ?? Date.now()
  const maxAge = options.maxAgeMs ?? 6 * 60 * 60_000
  const sent = new Set(
    rows
      .filter((row) => row.direction !== 'in' && !row.current)
      .slice(-(options.window ?? 12))
      .filter((row) => {
        const at = row.createdAt ? new Date(row.createdAt as any).getTime() : NaN
        return !Number.isFinite(at) || now - at <= maxAge
      })
      .map((row) => NORM(String(row.body || '')))
      .filter(Boolean)
  )
  const repeated = photos.filter((photo) => sent.has(NORM(photo.caption))).map((photo) => photo.caption)
  return { photos: photos.filter((photo) => !sent.has(NORM(photo.caption))), repeated }
}

/** Semua foto sudah dikirim sebelumnya: "Ini fotonya bos" → "Fotonya sudah saya kirim di atas bos". */
export function pointToSentPhotos(pesan: string[]) {
  const intro = /\b(?:ini|berikut)\s+(?:(?:contoh|untuk)\s+)?(?:foto|gambar)(?:nya)?\b/i
  // v3.6.80: pengantar pendek tanpa kata "foto" ("Ini bos") juga — dulu terkirim tanpa fotonya.
  const bare = /^\s*(?:ini|berikut|nih)(?:\s+(?:ya|nih|dia))?(?:\s+(?:bos|kak|gan|min|mas|mbak|sis))?\s*[.!]*\s*$/i
  let done = false
  return pesan.map((bubble) => {
    if (!done && bare.test(bubble)) {
      done = true
      return `Fotonya sudah saya kirim di atas ${bubble.match(/\b(bos|kak|gan|min|mas|mbak|sis)\b/i)?.[1] || 'bos'}`
    }
    if (done || !intro.test(bubble)) return bubble
    done = true
    return bubble.replace(intro, (_match, offset: number) => (offset === 0 ? 'Fotonya sudah saya kirim di atas' : 'fotonya sudah saya kirim di atas'))
  })
}

/** Perapian yang butuh daftar foto (di akhir): pengantar foto & urutan jawaban → foto → pertanyaan. */
export function polishWithPhotos(
  pesan: string[],
  photos: Array<{ caption: string }>,
  customerText: string,
  address = 'bos'
) {
  let ordered = dropPhotoOffers(questionAfterPhotos(pesan, photos.length), photos.length)
  // Hanya bila foto benar-benar dikirim dan isinya habis karena tawaran dibuang (v3.6.67: dulu AI
  // yang sengaja diam — "Oke" — malah mengirim "Ini fotonya bos" tanpa foto).
  if (!ordered.length && photos.length && pesan.length) ordered = [`Ini fotonya ${address}`]
  return compactPhotoIntro(ordered, photos, customerText, address)
}
