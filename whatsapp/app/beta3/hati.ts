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
    heart.moment && MOMENT[heart.moment]
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
