// Penjaga kecil sebelum kirim: hal-hal yang skill sudah larang tapi kadang tetap ditulis model.

const OTHER_HANDOFF =
  /bahan|warna|ekspedisi|j&t|lion|sicepat|komplain|rusak|salah kirim|diskon|grosir|seragam|refund|batal|tukar|tanggal|tgl|telepon|telpon|video|nego|alamat|resi/i
const CUSTOM = /custom|kustom|costum|cust[a-z]?m\b|ukuran sendiri/i
const WAITING = /\b(cek|tanyakan|tanya)\b.*\b(dulu|ke)\b/i

export const CUSTOM_REPLY = [
  'Bisa bos, untuk custom nanti di sesuaikan ukuran ya',
  'Mau custom ukurannya atau ada detail model yang mau diubah bos?',
]

/**
 * Custom (ukuran atau detail model) tidak diserahkan ke CS — skill: "Detail custom tidak ditolak
 * dan tidak perlu diserahkan". Model kadang tetap serah_cs untuk "mau custom bisa?" tanpa detail.
 * Mengembalikan balasan pengganti bila handoff dibatalkan, null bila handoff dibiarkan.
 */
export function keepCustomInChat(
  decision: { serah_cs: boolean; alasan: string; pesan: string[] },
  customerText: string
) {
  if (!decision.serah_cs) return null
  if (!CUSTOM.test(`${decision.alasan} ${customerText}`)) return null
  if (OTHER_HANDOFF.test(decision.alasan) || OTHER_HANDOFF.test(customerText)) return null
  const usable = decision.pesan.length && !decision.pesan.some((bubble) => WAITING.test(bubble))
  return { pesan: usable ? decision.pesan : CUSTOM_REPLY }
}

/**
 * Ada foto yang dikirim sesudah bubble pertama: pertanyaan di ujung bubble itu dipindah ke bubble
 * sendiri supaya urutannya jawaban → foto → pertanyaan (seperti CS).
 */
export function questionAfterPhotos(pesan: string[], photoCount: number) {
  if (!photoCount || pesan.length !== 1) return pesan
  const bubble = pesan[0].trim()
  if (!bubble.endsWith('?')) return pesan
  const byLine = bubble.match(/^([\s\S]*\S)\s*\n\s*([^\n]+\?)$/)
  const bySentence = bubble.match(/^([\s\S]*[.!])\s+([^.!?\n]+\?)$/)
  const match = byLine || bySentence
  if (!match) return pesan
  const [, head, question] = match
  if (!head.trim() || question.length > 120) return pesan
  return [head.trim(), question.trim()]
}

/**
 * v3.6.29 — janji tunggu ("totalnya saya hitung dulu ya") sudah dikirim, pelanggan hanya mengiyakan
 * ("iyaa mas", "oke"): jangan mengulang janji yang sama. Bubble janji dibuang; bila tidak ada yang
 * tersisa, AI diam sampai totalnya siap (kasus Retno: janji dikirim dua kali).
 */
export const WAIT_PROMISE =
  /\b(saya|kami)\s+(cek|hitung|kabari|konfirmasi|tanyakan|tanya|pastikan)\w*\s+(dulu|ulang)\b|\btotal\w*\s+(saya|kami)\s+(cek|hitung)\w*\s+dulu/i
const BARE_ACK =
  /^\s*(iya+|iy+a+|ya+|yaa+|oke+|ok+|okay|okey|siap+|sip+|baik|yoi|boleh|oke siap|iya oke|ok siap|iya ok)\b[\s!.,]*(mas|bos|bosku|kak|bang|pak|bu|min|gan)?[\s!.🙏👍]*$/i

export function dropRepeatedWait(pesan: string[], lastOutgoing: string, customerText: string) {
  if (!BARE_ACK.test(customerText || '') || !WAIT_PROMISE.test(lastOutgoing || '')) return { pesan, changed: false }
  const kept = pesan.filter((bubble) => !WAIT_PROMISE.test(bubble))
  return { pesan: kept, changed: kept.length !== pesan.length }
}

const ORDER_WORD = /\b(pesan|pesen|pesanan|order|orderan|beli|ambil|jas|setelan|celana|rompi)\b/i
const CANCEL_WORD = /\b(batal|batalkan|cancel|(?:gak|ga|gk|nggak|ngga|enggak|tidak|ndak)\s*jadi|gajadi|gjd)\b/i
const COMMIT = /\b(total|rekening|transfer|tf|form|alamat|ongkir|order|pesanan|dp|lunas)\b/i

/**
 * v3.6.55 — "gak jadi" membatalkan PESANAN hanya bila jelas menyebut pesanan/pembelian, atau
 * menjawab langkah order dari toko (total, rekening, form, ongkir). "Cek resi …" lalu "ga jadi"
 * = pertanyaannya yang batal, pesanan & catatan tetap.
 */
export function cancelsOrder(text: string, rows: Array<{ direction: string; body?: string | null; current?: boolean }>) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  if (CANCEL_WORD.test(last) && ORDER_WORD.test(last)) return true
  // Pelanggan sendiri yang bicara terakhir (pertanyaan di giliran yang sama) → yang batal pertanyaannya.
  if (lines.length > 1) return false
  const previous = [...rows].reverse().find((row) => !row.current && row.body)
  return previous?.direction === 'out' && COMMIT.test(String(previous.body || ''))
}

/** v3.6.55 — pesan giliran yang batal ditaruh di depan antrean giliran berikutnya (tanpa dobel). */
export function prependMissing<T extends { id: string }>(queue: T[], items: T[]) {
  const known = new Set(queue.map((item) => item.id))
  queue.unshift(...items.filter((item) => !known.has(item.id)))
  return queue
}

/** v3.6.67 — COD / bayar di tempat / paylater tidak tersedia (data CS lama); AI sempat menjawab "Bisa COD bos". */
export const NO_COD_REPLY = 'Maaf bos, belum bisa COD ya, pembayarannya lewat transfer'
const ASKS_COD = /\b(cod|bayar di tempat|bayar ditempat|paylater|pay later)\b/i
const CLAIMS_COD = /[^.!?\n]*\b(?:bisa|boleh|tersedia|ada)\s+(?:pakai\s+|via\s+)?(?:cod|bayar di ?tempat|paylater)\b[^.!?\n]*[.!?]?/gi
export function fixCodClaim(pesan: string[], customerText: string) {
  if (!ASKS_COD.test(customerText || '')) return { pesan, changed: false }
  let changed = false
  const out = pesan.map((bubble) =>
    bubble.replace(CLAIMS_COD, (sentence) => {
      if (/\b(belum|tidak|gak|ga|nggak|engga)\b/i.test(sentence)) return sentence
      changed = true
      return `${NO_COD_REPLY}. `
    }).replace(/\s{2,}/g, ' ').trim()
  )
  return { pesan: changed ? out.filter(Boolean) : pesan, changed }
}
