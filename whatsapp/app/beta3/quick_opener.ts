// Beta 3 — v3.6.158 Pembuka cepat: bubble pertama yang bebas fakta ("Siap bos, tinggi 170 berat 96 dicatat ya")
// dikirim begitu pesan dipahami, sebelum model berat selesai berpikir — seperti CS manusia yang membalas
// "siap, dicatat" dulu lalu melanjutkan isinya. Isi lanjutan dikirim sesudahnya tanpa mengulang pembuka.
import { extractBodyMeasure } from '#beta3/mcp'

export type QuickOpenerInput = {
  text: string
  address?: string
  /** Pelanggan mengirim gambar di giliran ini. */
  hasImage?: boolean
  /** Pesanan sedang menunggu pembayaran (gambar = kemungkinan bukti transfer). */
  awaitingPayment?: boolean
  /** Jev: pelanggan menyatakan sudah transfer. */
  paidClaim?: boolean
  /** Format order / data pengiriman lengkap terbaca sistem. */
  formReceived?: boolean
  /** Pesan toko sebelumnya (untuk tidak mengulang pembuka yang sama). */
  recentStore?: string[]
}

const SALAM = /\b(ass?alamu'?\s*alaikum\S*|assalamualaikum\S*|asslm\S*|askum)\b/i
const BODY_PART = /\b(lingkar\s+)?(dada|pinggang|pinggul|panggul|paha|bahu|lengan|leher)\b\D{0,12}(\d{2,3}(?:[.,]\d)?)/gi

/** Ukuran badan yang disebut pelanggan, apa adanya ("tinggi 170, berat 96, dada 120"). */
export function measurementsIn(text: string) {
  const items: string[] = []
  const measure = extractBodyMeasure(text)
  if (measure) items.push(`tinggi ${measure.height}`, `berat ${measure.weight}`)
  for (const hit of String(text || '').matchAll(BODY_PART)) {
    const part = hit[2].toLowerCase()
    if (items.some((item) => item.startsWith(part))) continue
    items.push(`${part === 'pinggul' ? 'panggul' : part} ${hit[3].replace(',', '.')}`)
    if (items.length >= 4) break
  }
  return items
}

/**
 * Pembuka cepat, atau '' bila tidak ada yang aman diucapkan tanpa berpikir. Hanya kalimat bebas fakta
 * (jawab salam, catat data, bukti diterima); harga/stok/size tidak pernah ada di sini.
 */
export function quickOpener(input: QuickOpenerInput) {
  const address = input.address || 'bos'
  const text = String(input.text || '')
  const salam = SALAM.test(text) ? `Waalaikumsalam ${address}` : ''
  let body = ''
  const items = measurementsIn(text)
  if (items.length) body = `${items.slice(0, 3).join(', ')} dicatat ya`
  else if (input.hasImage && input.awaitingPayment) body = 'bukti transfernya kami cek dulu ya'
  else if (input.paidClaim) body = 'kami cek dulu ya'
  else if (input.formReceived) body = 'datanya sudah masuk ya'
  if (!salam && !body) return ''
  const opener = salam ? (body ? `${salam}, ${body}` : salam) : `Siap ${address}, ${body}`
  // Toko baru saja mengatakan hal yang sama (mis. data dicatat di giliran sebelumnya) → tidak diulang.
  const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if ((input.recentStore || []).slice(-3).some((prev) => norm(prev).includes(norm(body || salam)))) return ''
  return opener
}

/** Bubble balasan model yang mengulang pembuka (sudah terkirim) dibuang; salam di awal bubble pertama dilepas. */
export function dropOpenerRepeat(pesan: string[], opener: string) {
  if (!opener) return pesan
  const FILLER = new Set(['dan', 'sudah', 'udah', 'saya', 'aku', 'kami', 'yang', 'untuk', 'nya', 'juga', 'ini', 'itu', 'tadi'])
  const words = (value: string) =>
    new Set(
      (value.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
        .map((word) => word.replace(/^(?:di|me|ter)(?=[a-z]{3,})/, '').replace(/(?:nya|kan)$/, ''))
        .filter((word) => word.length >= 3 && !FILLER.has(word))
    )
  const mine = words(opener)
  // v3.6.171 (uji alur #59 real-28): "Tinggi 175 berat 77 masuk XL bos" dibuang karena 4 dari 6 katanya sama dengan
  // pembuka "Siap bos, tinggi 175, berat 77 dicatat ya" → jawaban size hilang, pelanggan hanya dapat "dicatat".
  // Kalimat yang membawa info BARU (size, angka, kata isi yang tidak ada di pembuka) tidak dianggap ulangan.
  const informative = (w: Set<string>) =>
    [...w].some((word) => !mine.has(word) && (/^(?:xs|xxs|xxl|xl|[2-5]xl|\d+)$/.test(word) || word.length >= 5))
  const repeats = (w: Set<string>) => w.size > 0 && [...w].filter((word) => mine.has(word)).length / w.size >= 0.6 && !informative(w)
  const SIZE_TOKEN = /\b(?:xs|s|m|l|xl|xxl|[2-5]xl)\b/i
  const out: string[] = []
  for (let bubble of pesan) {
    let text = bubble.trim()
    if (/^waalaikumsalam/i.test(opener)) text = text.replace(/^wa'?alaikum\s*salam\S*\s*(?:bos|kak|pak|bu|gan)?[,.!\s]*/i, '').trim()
    if (!text) continue
    const theirs = words(text)
    if (repeats(theirs) && !SIZE_TOKEN.test(text)) continue
    // Pembuka "Siap bos, tinggi 170 berat 96 dicatat" + bubble "Siap bos, dicatat ya. Dada 120 …" → sisakan isinya.
    const sentences = text.split(/(?<=[.!?])\s+/)
    const kept = sentences.filter((sentence) => !(repeats(words(sentence)) && !SIZE_TOKEN.test(sentence)))
    text = kept.join(' ').trim()
    if (text) {
      bubble = text[0].toUpperCase() + text.slice(1)
      out.push(bubble)
    }
  }
  return out
}
