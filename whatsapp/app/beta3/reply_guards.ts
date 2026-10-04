// Penjaga kecil sebelum kirim: hal-hal yang skill sudah larang tapi kadang tetap ditulis model.

const HELP_OFFER =
  /[,.!]?\s*(?:ada\s+)?(?:yang\s+)?(?:bisa|dapat)\s+(?:kami|saya|aku)?\s*(?:di\s*)?bantu(?:\s+(?:bos|kak|gan))?\s*[?.!]*\s*$/i

/**
 * "ada yang bisa kami bantu?" sebagai pembuka dilarang skill (CS langsung menjawab), dibuang.
 * Penutup "Ada lagi yang bisa di bantu bos?" tetap boleh.
 */
export function stripHelpOffer(pesan: string[]) {
  let changed = false
  const out = pesan.map((bubble) => {
    const lines = bubble.split('\n')
    const last = lines.length - 1
    if (/\blagi\s+yang\s+bisa\b/i.test(lines[last]) || !HELP_OFFER.test(lines[last])) return bubble
    changed = true
    lines[last] = lines[last].replace(HELP_OFFER, '').trim()
    return lines.join('\n').trim()
  })
  if (!changed) return pesan
  const kept = out.filter(Boolean)
  return kept.length ? kept : ['Iya bos']
}

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
