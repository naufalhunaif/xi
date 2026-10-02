import { readLeanState, writeLeanState } from '#beta3/tables'

/**
 * Kebijakan tukar size resmi (Pengaturan → Data bisnis). Satu teks yang sama dipakai AI
 * dan bisa disalin CS, supaya semua jawaban tukar size seragam.
 */
export const DEFAULT_EXCHANGE_POLICY = [
  'Hai bos! Kalau ukuran ternyata kurang pas, jangan khawatir! Kamu bisa tukar size dengan syarat-syarat berikut:',
  '',
  '•  Pengembalian maksimal 3 hari setelah barang sampai',
  '•  Barang belum terkena wewangian',
  '•  Barang belum dipakai',
  '•  Label masih utuh',
  '•  Ongkir ditanggung oleh customer',
  '',
  'Catatan: Tukar size tidak berlaku untuk pesanan custom ya! 😊✨',
].join('\n')

const KEY = 'exchange_policy'
export const EXCHANGE_POLICY_MAX = 2000

/** Belum pernah disimpan → teks bawaan. Disimpan kosong → kebijakan tidak dipakai. */
export async function readExchangePolicy() {
  const raw = await readLeanState(KEY).catch(() => '')
  if (!raw) return { text: DEFAULT_EXCHANGE_POLICY, isDefault: true }
  try {
    const value = JSON.parse(raw) as { text?: unknown }
    return { text: String(value.text ?? ''), isDefault: false }
  } catch {
    return { text: DEFAULT_EXCHANGE_POLICY, isDefault: true }
  }
}

export async function saveExchangePolicy(input: unknown) {
  const text = String(input ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length > EXCHANGE_POLICY_MAX) throw new Error(`Maksimal ${EXCHANGE_POLICY_MAX} karakter.`)
  await writeLeanState(KEY, JSON.stringify({ text }))
  return { text, isDefault: false }
}

export function renderExchangePolicy(text: string) {
  if (!text.trim())
    return 'KEBIJAKAN TUKAR SIZE: belum diatur pemilik. Ditanya tukar size/retur → "saya tanyakan dulu ke tim ya bos", serah_cs = true.'
  return [
    'KEBIJAKAN TUKAR SIZE (resmi dari pemilik, satu-satunya sumber aturan tukar size/retur):',
    '<<<',
    text.trim(),
    '>>>',
    'Ditanya SEBELUM beli ("kalau kekecilan bisa tukar?", "bisa retur?") → kirim teks di atas persis sebagai satu bubble, tanpa diubah atau diringkas. ' +
      'Minta tukar size SETELAH barang diterima → sebut singkat syarat yang relevan, serah_cs = true. Jangan menjanjikan apa pun di luar syarat ini.',
  ].join('\n')
}
