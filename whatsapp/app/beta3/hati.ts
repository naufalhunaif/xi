// v3.6.62 — Hati CS: bacaan Jev (bentuk kalimat, rasa, momen) → satu catatan singkat untuk AI.
// Hanya petunjuk: tidak mengubah data, harga, atau tahap. Netral / tidak yakin → tanpa catatan.
import type { Heart } from '#beta3/jev_decisions'

const FORM: Record<string, string> = {
  bertanya: 'pelanggan BERTANYA (jawab pertanyaannya, bukan "dicatat")',
  meminta: 'pelanggan meminta sesuatu',
  mengeluh: 'pelanggan mengeluh',
}
const FEELING: Record<string, string> = {
  senang: 'senang/antusias → ikut hangat',
  ragu: 'ragu/cemas → tenangkan dari data',
  buru_buru: 'buru-buru → langsung ke jawaban, singkat',
  kesal: 'kesal/kecewa → "maaf ya bos" dulu',
  keberatan_harga: 'keberatan harga → akui tenang, satu pilihan paling pas, jangan mendesak',
  pamit: 'pamit/mundur → lepas hangat, pintu terbuka, tanpa susulan',
}
const MOMENT: Record<string, string> = {
  nikah: 'nikah/lamaran',
  wisuda: 'wisuda',
  kerja: 'kerja baru/interview',
  acara_lain: 'acara penting',
}

/** Catatan HATI untuk prompt; '' bila tidak ada yang perlu disampaikan. */
export function heartNote(heart: Heart | undefined, momentGreeted = false) {
  if (!heart) return ''
  const parts = [
    FORM[heart.form || ''],
    heart.feeling && FEELING[heart.feeling] ? `rasa: ${FEELING[heart.feeling]}` : '',
    // v3.6.79: acara orang lain (kondangan, tamu nikahan) → saran sesuai acara, tanpa ucapan selamat
    // (uji: "suit for wedding" dijawab "selamat ya buat nikahannya").
    heart.moment === 'acara_lain'
      ? 'momen: acara (bisa acara orang lain) → sesuaikan saran, tanpa ucapan selamat'
      : heart.moment && MOMENT[heart.moment]
        ? `momen: ${MOMENT[heart.moment]}${momentGreeted ? ' (ucapan selamat sudah dikirim, jangan diulang)' : ' → "wah selamat ya bos" sekali'}`
        : '',
  ].filter(Boolean)
  return parts.length ? `CATATAN HATI: ${parts.join('; ')}.` : ''
}

/** Label singkat untuk jejak chat ("Hati · bertanya · ragu · wisuda"). */
export function heartLabel(heart: Heart | undefined) {
  if (!heart) return ''
  const parts = [
    heart.form && FORM[heart.form] ? heart.form : '',
    heart.feeling && heart.feeling !== 'netral' ? heart.feeling.replace(/_/g, ' ') : '',
    heart.moment && heart.moment !== 'tidak_ada' ? heart.moment.replace(/_/g, ' ') : '',
  ].filter(Boolean)
  return parts.length ? `Hati · ${parts.join(' · ')}` : ''
}

/** Ucapan selamat momen sudah pernah dikirim toko di chat ini. */
export const GREETED = /\bselamat\b(?!\s+(?:pagi|siang|sore|malam|datang))/i

// ── v3.6.63 — penjaga Hati CS di sistem (tetap bekerja walau model AI yang membalas kurang cerdas) ──

type OutRow = { direction: string; body?: unknown; current?: boolean }

const norm = (text: string) =>
  String(text || '')
    .toLowerCase()
    .replace(/\b(bos|kak|ka|ya|yaa|nya)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
const GREETING = /^\s*(halo|hai|hallo|pagi|siang|sore|malam|selamat\s+(pagi|siang|sore|malam)|assalamu|waalaikum|wa'?alaikum)/i
const sentencesOf = (bubble: string) => bubble.split(/(?<=[.!?])\s+/)

/** Kalimat yang dijaga: cukup panjang, tanpa angka (harga/total/size), bukan salam. */
const guarded = (sentence: string) => norm(sentence).length >= 10 && !/\d/.test(sentence) && !GREETING.test(sentence)

/**
 * Kalimat yang persis sama dengan kalimat toko di 10 pesan keluar terakhir dibuang ("siap bos, dicatat
 * ya", "cocok ya bos?" berulang). Bubble berisi daftar (baris baru) tidak diubah. Bila semua isi balasan
 * adalah ulangan, balasan dibiarkan (lebih baik daripada diam).
 */
export function dropRepeatedSentences(pesan: string[], rows: OutRow[], window = 10) {
  const said = new Set(
    rows
      .filter((row) => row.direction === 'out' && !row.current && row.body)
      .slice(-window)
      .flatMap((row) => String(row.body).split('\n').flatMap(sentencesOf))
      .filter(guarded)
      .map(norm)
  )
  const removed: string[] = []
  const kept = pesan
    .map((bubble) => {
      if (bubble.includes('\n')) return bubble
      const parts = sentencesOf(bubble)
      const left = parts.filter((sentence) => {
        const repeated = guarded(sentence) && said.has(norm(sentence))
        if (repeated) removed.push(sentence.trim())
        return !repeated
      })
      return left.join(' ').trim()
    })
    .filter(Boolean)
  if (!removed.length || !kept.length) return { pesan, removed: [] as string[] }
  return { pesan: kept, removed }
}

/** Tawaran tambahan / ajakan lanjut ("sekalian celananya?", "jadi ambil yang mana?"). */
const UPSELL =
  /[^.!?\n]*\b(sekalian|tambah(?:kan)?\s+(?:celana|rompi)|jadi\s+(?:ambil|order|pesan|lanjut)|mau\s+(?:langsung\s+)?(?:order|pesan|ambil)|lanjut\s+order)\b[^.!?\n]*[.!?]?/gi

/**
 * Pelanggan kesal, pamit, atau keberatan harga (Hati CS dari Jev): tanpa susulan. Kesal/pamit juga
 * tanpa tawaran tambahan; keberatan harga tetap boleh ditawari SATU pilihan yang lebih pas (skill).
 */
export function calmForFeeling(pesan: string[], feeling?: string) {
  if (!feeling || !['kesal', 'pamit', 'keberatan_harga'].includes(feeling)) return { pesan, changed: false, stopSusulan: false }
  if (feeling === 'keberatan_harga') return { pesan, changed: false, stopSusulan: true }
  const kept = pesan
    .map((bubble) => (bubble.includes('\n') ? bubble : bubble.replace(UPSELL, '').replace(/\s{2,}/g, ' ').replace(/^[\s,.]+/, '').trim()))
    .filter(Boolean)
  const changed = kept.length > 0 && kept.join('\n') !== pesan.join('\n')
  return { pesan: changed ? kept : pesan, changed, stopSusulan: true }
}

/** Ucapan selamat (momen) sudah pernah dikirim → kalimat "selamat …" di balasan baru dibuang. */
export function dropRepeatedGreeting(pesan: string[], rows: OutRow[]) {
  const greeted = rows.some((row) => row.direction === 'out' && !row.current && GREETED.test(String(row.body || '')))
  if (!greeted) return { pesan, changed: false }
  const kept = pesan
    .map((bubble) =>
      sentencesOf(bubble)
        .filter((sentence) => !GREETED.test(sentence))
        .join(' ')
        .trim()
    )
    .filter(Boolean)
  const changed = kept.length > 0 && kept.join('\n') !== pesan.join('\n')
  return { pesan: changed ? kept : pesan, changed }
}

/** Pelanggan bertanya (Jev) tapi balasan hanya "dicatat" → ditandai di jejak untuk dicek CS. */
export function notedInsteadOfAnswer(pesan: string[], form?: string) {
  return form === 'bertanya' && /\bdicatat\b/i.test(pesan.join(' ')) && !/\b(iya|betul|benar|bisa|ada|tidak|gak|engga|belum)\b/i.test(pesan.join(' '))
}
