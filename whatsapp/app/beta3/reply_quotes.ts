// Beta 3 — v3.6.158 Balasan mengutip (reply) pesan pelanggan yang dijawabnya, seperti CS manusia saat pelanggan
// mengirim beberapa pertanyaan sekaligus: tiap bubble dipasangkan ke pesan pelanggan yang paling cocok isinya,
// sehingga jelas "jawab yang mana". Satu pesan pelanggan saja → tanpa kutipan (chat biasa).

export type TurnMessage = { id: string; text: string; image?: boolean }

const STOP = new Set(
  'yang dan atau untuk dengan dari ada aja saja itu ini nya mau bisa kalau kalo saya aku kamu min kak kakak bos boss gan mas mbak pak bu sis bro apakah apa berapa brp gimana bagaimana ya yaa yah dong kah sih nih deh tuh juga sama lagi udah sudah belum masih tidak gak ga nggak engga enggak iya oke ok siap pakai pake buat bikin jadi biar boleh tolong mohon halo hallo pagi siang sore malam selamat'.split(
    /\s+/
  )
)
const SIZE = /^(xs|s|m|l|xl|xxl|[2-6]xl|\d{2,3})$/i

function words(text: string) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((word) => word && !STOP.has(word) && (word.length >= 3 || SIZE.test(word)))
  )
}

const OPENER_ONLY = /^(?:wa'?alaikum\s*salam\S*|siap|oke|ok|baik|sama-?sama|terima\s*kasih|makasih)\b[^.?!]{0,12}$/i

/**
 * Pesan pelanggan (id) yang dikutip tiap bubble, atau null. Mengutip hanya bila pelanggan mengirim ≥ 2 pesan
 * di giliran ini dan bubble jelas menjawab salah satunya (kata kunci sama, pemenang tunggal). Bubble yang
 * menjawab pesan TERAKHIR tidak dikutip kecuali bubble lain mengutip pesan sebelumnya (biar pasangannya lengkap).
 */
export function assignQuotes(bubbles: string[], messages: TurnMessage[]): Array<string | null> {
  const none = bubbles.map(() => null as string | null)
  if (messages.length < 2 || !bubbles.length) return none
  const keys = messages.map((message) => words(message.text))
  const picked = bubbles.map((bubble) => {
    if (OPENER_ONLY.test(bubble.trim())) return -1
    const mine = words(bubble)
    const scores = keys.map((key) => [...mine].filter((word) => key.has(word)).length)
    const best = Math.max(...scores)
    if (best < 1) return -1
    const winners = scores.map((score, index) => (score === best ? index : -1)).filter((index) => index >= 0)
    return winners.length === 1 ? winners[0] : -1
  })
  const last = messages.length - 1
  const quotesEarlier = picked.some((index) => index >= 0 && index !== last)
  if (!quotesEarlier) return none
  return picked.map((index) => (index >= 0 ? messages[index].id : null))
}
