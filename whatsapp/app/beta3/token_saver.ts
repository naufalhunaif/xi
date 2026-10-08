// Beta 3.5 — hemat token: pesan sederhana dijawab tanpa AI, dan bagian prompt yang tidak
// dibutuhkan giliran ini tidak dikirim. Ragu → bagian tetap dikirim (akurasi didahulukan).
import type { LeanHistoryRow } from '#beta3/prompt'
import type { LeanCatalogRow } from '#beta3/catalog_service'
import { catalogColorSearchHints } from '#services/color_semantics'
import { seriesOf } from '#beta3/price_pattern'

const OPENER_WORD =
  /^(?:halo+|hallo+|hai+|hay|hi|hei|p+|ping|permisi|punten|pagi|siang|sore|malam|met\s+(?:pagi|siang|sore|malam)|selamat\s+(?:pagi|siang|sore|malam)|ass?alamu'?\s*alaikum(?:\s+wr\.?\s*wb\.?)?|assalamualaikum|salam|kak|kakak|bos|boss|min|admin|gan|om|mas|mbak|sis)$/i
const THANKS =
  /^(?:(?:oke?|ok|siap|sip)\s+)?(?:makasih|makasi|terima\s*kasih|terimakasih|trims|thanks|thank\s+you|thx|tq|tengkyu)(?:\s+(?:ya+|kak|bos|min|banyak|gan|om|mas|mbak))*[\s!.\p{Extended_Pictographic}\uFE0F\u200D]*$/iu
/** Hanya tanda setuju/ragu tanpa isi ("ya", "oke 😁", "hmm 🤔"). */
export const ACK = /^(?:(?:y+a*|i+y+a+|o+k+e*y*|o+k+a+y+|sip+|siap|baik|noted|hm+|wkwk+|he+h?e*|i\s*s+e+|makasi+h?|terima\s*kasih|terimakasih|thanks?|thx|tq|bos+|kak|ka|min|mas|mbak|gan|bang|pak|bu|om)[\s!.,~?]*|[\p{Extended_Pictographic}\uFE0F\u200D]\s*)+$/iu
const PITCH = [
  /perkenalkan,?\s+(?:saya|kami)/i,
  /\bsaya\s+\w+\s+dari\s+(?:pt\b|cv\b|\w+\s+(?:agency|consult|digital|marketing|media|indonesia))/i,
  /business\s+consultant|marketing\s+agency|digital\s+agency|\bagency\b/i,
  /kerja\s*sama|kolaborasi|partnership|endorse|penawaran|proposal/i,
  /kami\s+membantu|solusi\s+(?:untuk|bisnis|ai)|benefit|credentials|meningkatkan\s+(?:penjualan|pelayanan|efisiensi|engagement)/i,
  /available\s+untuk\s+berdiskusi|boleh\s+saya\s+(?:langsung\s+)?kirim|jadwalkan\s+(?:meeting|diskusi|demo)/i,
]
/** Tawaran jasa/kerja sama dari bisnis lain (bukan pelanggan) — v3.6.85. */
export function isBusinessPitch(text: string) {
  const value = String(text || '')
  if (value.length < 220) return false
  return PITCH.filter((pattern) => pattern.test(value)).length >= 3
}
/** Balasan otomatis bot bisnis lain ("ketik 1 untuk pricelist …"). */
export function isOtherBot(text: string) {
  return /terima\s*kasih\s+telah\s+menghubungi[\s\S]{0,200}\bketik\s+\d/i.test(String(text || ''))
}
const FORM_LIKE = /nama\s*:|alamat|kecamatan|kabupaten|kode\s*pos|no\.?\s*(?:hp|telp|wa)/i
/** Tahap tanpa urusan terbuka: sapaan boleh dijawab tanpa AI. */
const OPEN_STAGES = ['', 'lain', 'selesai']

function openerOnly(text: string) {
  const words = text
    .toLowerCase()
    .replace(/[!?.,~]+/g, ' ')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (!words.length) return false
  return words.every((line) => {
    // "halo kak", "pagi bos", "assalamualaikum kak" → tiap potongan harus kata sapaan.
    const parts = line.match(/selamat\s+\w+|met\s+\w+|ass?alamu'?\s*alaikum(?:\s+wr\s*wb)?|\S+/g) || []
    return parts.length <= 4 && parts.every((part) => OPENER_WORD.test(part))
  })
}

/**
 * Balasan tanpa memanggil model untuk pesan yang jawabannya selalu sama.
 * null = tetap pakai AI; [] = diam (tidak perlu dibalas).
 */
export function quickReply(input: {
  text: string
  imageCount: number
  note?: string
  stage: string
  rows: LeanHistoryRow[]
}): string[] | null {
  const text = input.text.trim()
  if (!text || input.imageCount || input.note) return null
  const previous = input.rows.filter((row) => !row.current)
  const last = previous[previous.length - 1]
  // Masih ada pesan pelanggan yang belum dijawab, atau form order belum diproses → AI.
  if (last && last.direction === 'in') return null
  if (previous.slice(-10).some((row) => row.direction === 'in' && FORM_LIKE.test(String(row.body || ''))))
    return null
  const lastOut = String(last?.body || '')
  if (THANKS.test(text)) {
    if (!last) return null
    return /sama[\s-]*sama/i.test(lastOut) ? [] : ['Siap sama sama bos']
  }
  // v3.6.85 — "Yaa 🤔" sesudah "ada yang bisa kami bantu": pelanggan belum bilang maksudnya → persilakan.
  if (ACK.test(text) && /ada yang bisa (?:kami|saya|aku) bantu/i.test(lastOut)) return ['Silakan bos, mau tanya apa?']
  if (!openerOnly(text) || !OPEN_STAGES.includes(input.stage)) return null
  if (/ada yang bisa kami bantu/i.test(lastOut)) return ['Iya bos, ada yang bisa kami bantu']
  const lower = text.toLowerCase()
  if (/salam|alaikum/.test(lower)) return ['Waalaikumsalam bos, ada yang bisa kami bantu']
  const time = lower.match(/\b(pagi|siang|sore|malam)\b/)?.[1]
  if (time) return [`${time[0].toUpperCase()}${time.slice(1)} bos, ada yang bisa kami bantu`]
  return ['Halo bos, ada yang bisa kami bantu']
}

const LATE = ['tunggu_bayar', 'bukti_dikirim', 'selesai']
const EARLY = ['', 'lain', 'tanya_model', 'tanya_size', 'tawar_celana']
const PRODUCT =
  /\b(jas|tuxedo|beskap|suit|setelan|celana|rompi|model|warna|harga|berapa|foto|gambar|stok|ready|size|ukuran|bahan|custom|order lagi|pesan lagi|tambah|katalog|produk)/i
const SIZE =
  /\b(size|ukuran|tinggi|berat|lingkar|dada|pinggang|panjang|lengan|bahu|cm|kg|celana|nomor|no\.?\s*\d+|muat|pas|kebesaran|kekecilan|ngepress|sempit|longgar|xs|s|m|l|xl|xxl|[2-4]xl)\b|\b\d{2,3}\b/i
const COLOR =
  /\b(warna|bahan|kain|custom|buatkan|dibuatkan|seri|motif|putih|hitam|navy|maroon|abu|grey|gray|cream|krem|coklat|choco|brown|hijau|biru|merah|broken|white|black|gold|silver|olive|mocca|khaki|beige)/i

/** Bagian prompt yang perlu dikirim giliran ini. Tidak yakin → dikirim. */
export function promptNeeds(input: {
  stage: string
  text: string
  imageCount: number
  rows: LeanHistoryRow[]
  intent?: string
  hasFit: boolean
  /** Topik dari Jev (yakin); menggantikan pola kata bila ada. */
  topics?: Partial<Record<'ongkir' | 'ukuran' | 'bayar' | 'custom' | 'warna', boolean>>
}) {
  const topics = input.topics || {}
  const recentOut = input.rows
    .filter((row) => !row.current && row.direction === 'out')
    .slice(-2)
    .map((row) => String(row.body || ''))
    .join('\n')
  const text = input.text
  const images = input.imageCount > 0
  const late = LATE.includes(input.stage)
  return {
    catalog: !late || images || PRODUCT.test(text) || input.intent === 'produk' || input.intent === 'harga',
    sizeCharts:
      images ||
      input.hasFit ||
      // Topik Jev hanya MENAMBAH bagian; pola kata tetap berlaku (Jev salah → bagian tidak hilang).
      topics.ukuran === true ||
      SIZE.test(text) ||
      SIZE.test(recentOut) ||
      input.intent === 'ukuran',
    fabrics: images || topics.warna === true || EARLY.includes(input.stage) || COLOR.test(text) || input.intent === 'produk',
  }
}

const SKILL_RULES: Array<[RegExp, (need: SkillContext) => boolean]> = [
  [/^Size dari tinggi/i, (need) => need.size],
  [/^Spesifikasi pesanan/i, (need) => need.spec],
  [/^Warna, foto, stok/i, (need) => need.catalog],
  [/^Ongkir/i, (need) => need.shipping],
  [/^Setelah bayar/i, (need) => need.paid],
  [/^Pelanggan mengirim foto/i, (need) => need.photo],
  [/^Komentar di postingan Instagram/i, (need) => need.instagram],
]

export type SkillContext = {
  size: boolean
  spec: boolean
  catalog: boolean
  shipping: boolean
  paid: boolean
  photo: boolean
  instagram: boolean
}

const SHIPPING =
  /\b(ongkir|ongkos|kirim|dikirim|pengiriman|alamat|kec|kecamatan|kab|kabupaten|kota|ekspedisi|jne|j&t|jnt|sicepat|lion|kurir|sampai|nyampe|tiba|cepat|besok|tgl|tanggal|reg|yes|jtr)/i
const PAID =
  /\b(tf|transfer|bayar|dibayar|lunas|dp|resi|sudah jadi|udah jadi|progres|proses|dikirim|ganti alamat|tukar|refund)/i
const SPEC =
  /\b(custom|kustom|costum|cust[a-z]?m|kerah|saku|kancing|lis|list|bahan|detail|ukuran|lingkar|panjang|lengan|bahu|celana|rompi|setelan|warna|model|order|pesan)/i

/** Konteks bagian skill yang dibutuhkan giliran ini (ragu → bagian ikut). */
export function skillContext(input: {
  stage: string
  text: string
  imageCount: number
  rows: LeanHistoryRow[]
  spec: string
  needs: { catalog: boolean; sizeCharts: boolean }
  shippingNotes: boolean
  hasOrder: boolean
  topics?: Partial<Record<'ongkir' | 'ukuran' | 'bayar' | 'custom' | 'warna', boolean>>
}): SkillContext {
  const topics = input.topics || {}
  const recent = input.rows
    .slice(-4)
    .map((row) => String(row.body || ''))
    .join('\n')
  const text = input.text
  const instagram = /\[Komentar di postingan Instagram/i.test(text)
  return {
    size: input.needs.sizeCharts || ['tanya_size', 'tawar_celana'].includes(input.stage),
    spec:
      topics.custom === true ||
      Boolean(input.spec.trim()) ||
      !['', 'lain', 'tanya_model'].includes(input.stage) ||
      input.imageCount > 0 ||
      SPEC.test(text),
    catalog: input.needs.catalog,
    shipping:
      input.shippingNotes ||
      ['minta_alamat', 'kirim_form', 'tunggu_form', 'tunggu_cs', 'tunggu_bayar'].includes(input.stage) ||
      topics.ongkir === true ||
      SHIPPING.test(text) ||
      SHIPPING.test(recent),
    paid: LATE.includes(input.stage) || topics.bayar === true || input.hasOrder || PAID.test(text),
    photo:
      input.imageCount > 0 ||
      instagram ||
      input.rows.slice(-4).some((row) => row.direction === 'in' && /image|photo|gambar/i.test(String(row.mediaType || ''))),
    instagram,
  }
}

/**
 * Skill tanpa bagian yang tidak dibutuhkan giliran ini. Bagian inti (cara bicara, urutan tahap,
 * batas wewenang, catatan chat) dan bagian yang tidak dikenal (suntingan pemilik) selalu ikut.
 */
export function trimSkill(skill: string, need: SkillContext) {
  const parts = skill.split(/^(?=## )/m)
  const kept: string[] = []
  const skipped: string[] = []
  for (const part of parts) {
    const heading = part.startsWith('## ') ? part.slice(3).split('\n')[0].trim() : ''
    const rule = heading ? SKILL_RULES.find(([pattern]) => pattern.test(heading)) : undefined
    if (rule && !rule[1](need)) skipped.push(heading.split(/[(—]/)[0].trim())
    else kept.push(part)
  }
  return { text: kept.join('').trim(), skipped }
}

const COLOR_WORDS = ['black', 'hitam', 'white', 'putih', 'navy', 'maroon', 'marun', 'cream', 'krem', 'brown', 'coklat', 'cokelat', 'choco', 'gray', 'grey', 'army', 'denim', 'coast', 'gold', 'blue', 'biru', 'sage', 'green', 'hijau', 'emerald', 'olive']
const editDistance = (a: string, b: string) => {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1))
      previous = current
    }
  }
  return row[b.length]
}
/** Kata yang mirip nama warna (beda ≤1 huruf; ≥6 huruf ≤2) → nama warnanya. */
export function fuzzyColorWords(text: string) {
  const out = new Set<string>()
  for (const word of fold(text).split(' ')) {
    if (word.length < 4 || COLOR_WORDS.includes(word)) continue
    for (const color of COLOR_WORDS) {
      if (Math.abs(color.length - word.length) > 2) continue
      if (editDistance(word, color) <= (color.length >= 6 ? 2 : 1)) out.add(color)
    }
  }
  return [...out]
}

const GENERIC = new Set(['setelan', 'jas', 'premium', 'signature', 'se', 'double', 'breasted', 'set', 'new', 'the', 'and'])
const fold = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const colorKeys = (value: string) => {
  const keys = new Set<string>()
  for (const hint of catalogColorSearchHints([value])) {
    keys.add(hint.catalogColor)
    for (const near of (hint as { nearbyCandidates?: readonly string[] }).nearbyCandidates || [])
      for (const nearHint of catalogColorSearchHints([near])) keys.add(nearHint.catalogColor)
  }
  return keys
}

/**
 * Katalog yang dikirim ke AI: hanya produk/warna yang sedang dibahas (dari pesan, 6 pesan terakhir,
 * spesifikasi, dan catatan) + satu baris nama produk lain. Tidak ada yang cocok, ada gambar,
 * komentar IG, atau hasilnya hampir seluruh katalog → null (katalog lengkap).
 */
export function focusCatalog(
  rows: LeanCatalogRow[],
  input: { text: string; history: LeanHistoryRow[]; spec: string; chatNote: string; imageCount: number }
) {
  if (input.imageCount > 0 || /\[Komentar di postingan Instagram/i.test(input.text)) return null
  const active = rows.filter((row) => row.active)
  if (active.length < 20) return null
  const context = [
    input.text,
    ...input.history.slice(-6).map((row) => String(row.body || '')),
    input.spec,
    input.chatNote,
  ].join('\n')
  const words = new Set(fold(context).split(' '))
  // Sebutan pelanggan → nama di katalog.
  for (const [said, catalog] of [['celana', 'pants'], ['rompi', 'vest'], ['beskap', 'bescap'], ['jas', 'suit']] as const)
    if ([...words].some((word) => word.startsWith(said))) words.add(catalog)
  // Seri yang dibahas (premium/signature): semua barangnya ikut (jas, celana, setelan, rompi).
  const series = new Set(
    (['premium', 'signature'] as const).filter((name) => [...words].some((word) => word.startsWith(name)))
  )
  // Produk disebut: kata khas pertama nama produk ("tuxedo", "basic", "peak", "beskap").
  const keyOf = (product: string) => fold(product).split(' ').find((word) => word.length >= 3 && !GENERIC.has(word)) || ''
  const products = new Set(active.map((row) => keyOf(row.product)).filter((key) => key && words.has(key)))
  // v3.6.80: salah ketik warna ("bllue", "nevy") tetap membuka baris warnanya (petunjuk pencarian saja).
  const colors = colorKeys(`${context}\n${fuzzyColorWords(context).join(' ')}`)
  const picked = active.filter((row) => {
    if (products.has(keyOf(row.product))) return true
    if (series.size && series.has(seriesOf(row) as 'premium' | 'signature')) return true
    if (!colors.size) return false
    for (const key of colorKeys(row.color)) if (colors.has(key)) return true
    return false
  })
  if (!picked.length || picked.length > active.length * 0.6) return null
  const shown = new Set(picked.map((row) => row.product))
  const others = new Map<string, number | null>()
  for (const row of active) {
    if (shown.has(row.product)) continue
    const price = others.get(row.product)
    if (price === undefined || (row.price !== null && (price === null || row.price < price))) others.set(row.product, row.price)
  }
  const otherLine = others.size
    ? `PRODUK LAIN (tidak dirinci di giliran ini; harga mulai): ${[...others].map(([name, price]) => `${name}${price ? ` ${price.toLocaleString('id-ID')}` : ''}`).join(', ')}. Warna/stok produk lain tidak dirinci di sini: jangan bilang "belum ada" — sebut nama & harga mulai, lalu tanyakan model/warna yang dimaksud.`
    : ''
  return { rows: picked, otherLine, products: [...products], colors: [...colors] }
}
