// Beta 3.5 — hemat token: pesan sederhana dijawab tanpa AI, dan bagian prompt yang tidak
// dibutuhkan giliran ini tidak dikirim. Ragu → bagian tetap dikirim (akurasi didahulukan).
import type { LeanHistoryRow } from '#beta3/prompt'

const OPENER_WORD =
  /^(?:halo+|hallo+|hai+|hay|hi|hei|p+|ping|permisi|punten|pagi|siang|sore|malam|met\s+(?:pagi|siang|sore|malam)|selamat\s+(?:pagi|siang|sore|malam)|ass?alamu'?\s*alaikum(?:\s+wr\.?\s*wb\.?)?|assalamualaikum|salam|kak|kakak|bos|boss|min|admin|gan|om|mas|mbak|sis)$/i
const THANKS =
  /^(?:(?:oke?|ok|siap|sip)\s+)?(?:makasih|makasi|terima\s*kasih|terimakasih|trims|thanks|thank\s+you|thx|tq|tengkyu)(?:\s+(?:ya+|kak|bos|min|banyak|gan|om|mas|mbak))*[\s!.]*$/i
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
  /\b(jas|tuxedo|beskap|suit|setelan|celana|rompi|model|warna|harga|berapa|foto|gambar|stok|ready|size|ukuran|bahan|custom|order lagi|pesan lagi|tambah|katalog|produk)\b/i
const SIZE =
  /\b(size|ukuran|tinggi|berat|lingkar|dada|pinggang|panjang|lengan|bahu|cm|kg|celana|nomor|no\.?\s*\d+|muat|pas|kebesaran|kekecilan|ngepress|sempit|longgar|xs|s|m|l|xl|xxl|[2-4]xl)\b|\b\d{2,3}\b/i
const COLOR =
  /\b(warna|bahan|kain|custom|buatkan|dibuatkan|seri|motif|putih|hitam|navy|maroon|abu|grey|gray|cream|krem|coklat|choco|brown|hijau|biru|merah|broken|white|black|gold|silver|olive|mocca|khaki|beige)\b/i

/** Bagian prompt yang perlu dikirim giliran ini. Tidak yakin → dikirim. */
export function promptNeeds(input: {
  stage: string
  text: string
  imageCount: number
  rows: LeanHistoryRow[]
  intent?: string
  hasFit: boolean
}) {
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
      images || SIZE.test(text) || SIZE.test(recentOut) || input.intent === 'ukuran' || input.hasFit,
    fabrics: images || EARLY.includes(input.stage) || COLOR.test(text) || input.intent === 'produk',
  }
}
