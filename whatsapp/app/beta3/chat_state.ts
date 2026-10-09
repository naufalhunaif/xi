// v3.6.101 — Keadaan chat: ringkasan pasti (tanpa AI) dari SELURUH percakapan, termasuk pesan yang lebih lama
// dari RIWAYAT. Seperti CS manusia yang ingat apa yang sudah terjadi: resi sudah dikirim, pembayaran sudah
// masuk, harga yang sudah disebut, foto yang sudah dikirim, data yang sudah diberi pelanggan. Selalu ikut ke
// AI, pemeriksa, dan perbaikan balasan supaya konteks tidak hilang walau bahan lain dipangkas.
import type { LeanHistoryRow } from '#beta3/prompt'
import { memoryFromChat } from '#beta3/customer_service'

const PRICE = /\b\d{1,3}(?:\.\d{3})+\b/
const AWB = /\b(?:resi|awb|no\.?\s*resi|nomor\s+resi)\b\D{0,25}([A-Z]{0,4}\d{10,20})\b/i
const SHIPPED =
  /\b(?:sudah|udah|telah|barusan)\s+(?:kami\s+|saya\s+)?(?:di)?(?:kirim|krm|pickup|pick\s*up|serahkan\s+ke\s+(?:jne|kurir|ekspedisi))\w*\b(?![^.!?\n]{0,25}\b(?:foto|gambar|fotonya|rekening|rek|total|form|format|link|katalog|pricelist)\b)|\bdalam\s+pengiriman\b|\bsedang\s+dikirim\b/i
const PRODUCTION =
  /\b(?:masih\s+(?:proses|dalam\s+proses|dijahit|produksi|antri\w*|dikerjakan)|sedang\s+(?:dijahit|diproses|dikerjakan|produksi)|tahap\s+finishing|finishing|sudah\s+jadi|siap\s+(?:kirim|dikirim))\b/i
const PAID =
  /\b(?:pembayaran|dana|transfer\w*|tf\w*|dp\w*|pelunasan\w*)\s+(?:nya\s+)?(?:sudah|udah)\s+(?:kami\s+)?(?:terima|diterima|masuk|kami\s+terima|dikonfirmasi|konfirmasi|kami\s+konfirmasi)\b|\b(?:sudah|udah)\s+(?:kami\s+)?(?:terima|konfirmasi)\s+(?:pembayaran|transfer\w*|dp\w*)\b|\bsudah\s+lunas\b/i
const TOTAL = /\btotal\w*\b[^\n]{0,50}?(\d{1,3}(?:\.\d{3})+)/i

const day = (value: Date | string) =>
  new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' }).format(new Date(value))
const clip = (text: string, max = 140) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
/** Kalimat dalam teks yang cocok pola (untuk kutipan singkat, bukan seluruh pesan). */
const sentenceWith = (text: string, pattern: RegExp) =>
  String(text || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .find((sentence) => pattern.test(sentence)) || ''

/**
 * Baris-baris keadaan chat; kosong bila belum ada yang perlu diingat. `rows` urut lama → baru
 * (boleh lebih panjang dari RIWAYAT); pesan giliran ini (current) tidak dihitung sebagai ucapan toko.
 */
export function chatStateLines(rows: LeanHistoryRow[]) {
  const lines: string[] = []
  const store = rows.filter((row) => row.direction === 'out' && !row.current)
  const customer = rows.filter((row) => row.direction === 'in')
  // Status pesanan (dikirim/progres) hanya dari CS manusia atau sistem, bukan kalimat AI (bisa tebakan).
  const human = store.filter((row) => row.senderType !== 'ai')
  const last = <T>(items: T[]) => items[items.length - 1]

  // Pengiriman & resi.
  const awbRow = last(store.filter((row) => AWB.test(String(row.body || ''))))
  if (awbRow) lines.push(`Resi sudah dikirim toko (${day(awbRow.createdAt)}): ${String(awbRow.body).match(AWB)![1]}`)
  const shippedRow = last(human.filter((row) => SHIPPED.test(String(row.body || ''))))
  if (shippedRow && shippedRow !== awbRow)
    lines.push(`Toko sudah menyatakan pesanan dikirim (${day(shippedRow.createdAt)}): "${clip(sentenceWith(String(shippedRow.body), SHIPPED) || String(shippedRow.body))}"`)
  // Progres produksi terakhir yang disebut toko (bila belum ada pernyataan dikirim sesudahnya).
  const productionRow = last(human.filter((row) => PRODUCTION.test(String(row.body || ''))))
  if (productionRow && (!shippedRow || new Date(productionRow.createdAt) > new Date(shippedRow.createdAt)))
    lines.push(`Progres pesanan terakhir dari toko (${day(productionRow.createdAt)}): "${clip(sentenceWith(String(productionRow.body), PRODUCTION) || String(productionRow.body))}"`)
  // Pembayaran & total.
  const paidRow = last(store.filter((row) => PAID.test(String(row.body || ''))))
  if (paidRow) lines.push(`Pembayaran sudah dikonfirmasi toko (${day(paidRow.createdAt)}): "${clip(sentenceWith(String(paidRow.body), PAID) || String(paidRow.body))}"`)
  const totalRow = last(store.filter((row) => TOTAL.test(String(row.body || ''))))
  if (totalRow) lines.push(`Total terakhir yang dikirim toko (${day(totalRow.createdAt)}): ${String(totalRow.body).match(TOTAL)![1]}`)
  // Harga yang sudah disebut toko (kalimat terakhir yang berbeda, maks 4): jawaban baru tidak boleh bertentangan.
  const quoted: string[] = []
  for (const row of [...store].reverse()) {
    if (row.mediaType) continue
    for (const sentence of String(row.body || '').split(/(?<=[.!?])\s+|\n+/).reverse()) {
      if (!PRICE.test(sentence) || TOTAL.test(sentence) || /\b(?:rek|rekening|bri|bca|bni|mandiri)\b/i.test(sentence)) continue
      const text = clip(sentence, 120)
      if (!quoted.includes(text)) quoted.push(text)
      if (quoted.length >= 4) break
    }
    if (quoted.length >= 4) break
  }
  if (quoted.length) lines.push(`Harga yang sudah disebut toko: ${quoted.reverse().map((text) => `"${text}"`).join('; ')}`)
  // Foto katalog yang sudah dikirim toko (caption).
  const photos = [...new Set(store.filter((row) => row.mediaType === 'image' && String(row.body || '').trim()).map((row) => clip(String(row.body), 60)))].slice(-6)
  if (photos.length) lines.push(`Foto yang sudah dikirim toko: ${photos.join(', ')}`)
  // Gambar dari pelanggan (keterangan singkat bila ada).
  const images = customer.filter((row) => row.mediaType === 'image' && !row.current).slice(-2)
  if (images.length)
    lines.push(`Pelanggan sudah mengirim gambar${images.some((row) => row.mediaNote) ? `: ${images.map((row) => clip(row.mediaNote || 'gambar', 80)).join('; ')}` : ''} (lihat RIWAYAT)`)
  // Data yang sudah diberi pelanggan.
  const facts = memoryFromChat(customer)
  const data = Object.entries(facts).map(([label, value]) => `${label} ${value}`)
  if (data.length) lines.push(`Data dari pelanggan: ${clip(data.join('; '), 220)}`)
  return lines.slice(0, 12)
}

export function renderChatState(rows: LeanHistoryRow[]) {
  const lines = chatStateLines(rows)
  if (!lines.length) return ''
  return `KEADAAN CHAT (diringkas sistem dari seluruh percakapan, termasuk yang lebih lama dari RIWAYAT; ini SUDAH terjadi — jangan ditanyakan ulang, jangan dibantah, jangan bilang "saya cek dulu" untuk hal yang sudah ada di sini):\n${lines.map((line) => `- ${line}`).join('\n')}`
}
