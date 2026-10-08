// Gaya balasan seragam untuk semua model (ChatGPT, Claude, Gemini): profil gaya diambil
// dari balasan CS asli toko, dipasang di prompt, lalu keluaran AI dirapikan oleh kode.
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import type { LeanExample } from '#beta3/examples_service'

export type StyleProfile = {
  /** Sapaan dominan toko (mis. "bos", "kak"); null bila tidak jelas. */
  address: string | null
  /** Toko memakai emoji di balasan. */
  emoji: boolean
  /** Panjang umum satu bubble (median huruf). */
  length: number
  samples: number
}

const ADDRESS_WORDS = ['bos', 'kak', 'kakak', 'gan', 'sis', 'bro', 'mas', 'mbak', 'om', 'min']
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u
const cache = new Map<string, { at: number; profile: StyleProfile }>()

/** Profil gaya dari contoh CS + pesan CS manusia terbaru. Disimpan 30 menit. */
export async function storeStyle(examples: LeanExample[] = []): Promise<StyleProfile> {
  const key = workspaceScope().prefix
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.profile
  const human = (await db
    .from('whatsapp_messages')
    .where('direction', 'out')
    .whereIn('sender_type', ['cs', 'owner'])
    .whereNotNull('body')
    .whereNot('jid', 'like', '%@g.us')
    .orderBy('id', 'desc')
    .limit(300)
    .select('body')
    .catch(() => [])) as Array<{ body: string }>
  const texts = [...examples.map((e) => e.csText), ...human.map((m) => String(m.body || ''))]
    .map((text) => text.trim())
    .filter((text) => text.length >= 3 && text.length <= 400)
  const counts = new Map<string, number>()
  for (const text of texts)
    for (const word of text.toLowerCase().match(/[a-z]+/g) || [])
      if (ADDRESS_WORDS.includes(word)) counts.set(word === 'kakak' ? 'kak' : word, (counts.get(word === 'kakak' ? 'kak' : word) || 0) + 1)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0]
  const lengths = texts.map((text) => text.length).sort((a, b) => a - b)
  const profile: StyleProfile = {
    address: top && topCount >= 5 && topCount / total >= 0.6 ? top : null,
    emoji: texts.length ? texts.filter((text) => EMOJI.test(text)).length / texts.length >= 0.15 : true,
    length: lengths.length ? lengths[Math.floor(lengths.length / 2)] : 80,
    samples: texts.length,
  }
  cache.set(key, { at: Date.now(), profile })
  return profile
}

/**
 * v3.6.84 — Sapaan per chat: jawaban CS manusia di chat ini adalah acuan. Bila CS di room ini
 * memanggil pelanggan dengan sapaan lain (mis. "mbak", "kak") secara konsisten, AI ikut sapaan itu.
 */
export function chatAddress(
  rows: Array<{ direction: string; senderType?: string | null; body?: string | null }>,
  fallback: string | null
) {
  const counts = new Map<string, number>()
  const human = rows.filter((row) => row.direction === 'out' && ['cs', 'owner'].includes(String(row.senderType || ''))).slice(-20)
  for (const row of human)
    for (const word of String(row.body || '').toLowerCase().match(/[a-z]+/g) || []) {
      if (!ADDRESS_WORDS.includes(word) || word === 'min') continue
      const key = word === 'kakak' ? 'kak' : word
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [null, 0]
  if (top && top !== fallback && topCount >= 2 && topCount / total >= 0.6) return top
  return fallback
}

/** Profil gaya untuk satu chat: sapaan mengikuti CS manusia di chat itu. */
export function styleForChat<T extends StyleProfile | null>(
  profile: T,
  rows: Array<{ direction: string; senderType?: string | null; body?: string | null }>
): T {
  if (!profile) return profile
  const address = chatAddress(rows, profile.address)
  return address === profile.address ? profile : ({ ...profile, address } as T)
}

/** Bagian prompt: aturan gaya yang sama persis untuk model apa pun. */
export function styleGuide(profile: StyleProfile) {
  const lines = [
    'GAYA BALASAN TOKO (ikuti skill & contoh CS; ini hanya penyeragam format):',
    profile.address ? `- Sapa pelanggan dengan "${profile.address}" (jangan kak/kakak/anda/sapaan lain).` : '',
    profile.emoji ? '- Emoji boleh secukupnya, maksimal satu per bubble.' : '- Tanpa emoji.',
    // Sengaja tanpa batas jumlah huruf: batas panjang membuat jawaban terpotong dan
    // kurang informatif (harga/detail hilang). Panjang mengikuti skill & contoh CS.
    '- Bahasa santai sehari-hari seperti contoh CS; tanpa format markdown (**tebal**, #judul, tabel).',
    '- Rapi seperti CS: daftar 3 item atau lebih (harga, pilihan model/warna, ongkir, rincian total, data pesanan) ditulis satu item per baris setelah kalimat pembuka, lalu pertanyaan di baris terpisah. Jangan dideretkan dengan koma dalam satu kalimat.',
    '- Jangan membuka dengan salam panjang atau menutup dengan kalimat basa-basi yang sama tiap kali.',
  ]
  return lines.filter(Boolean).join('\n')
}

const capitalize = (word: string, like: string) =>
  like[0] === like[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word

/** Rapikan keluaran AI agar formatnya sama apa pun modelnya. */
export function normalizeStyle(bubbles: string[], profile: StyleProfile, verbatim: string[] = []) {
  // Teks resmi toko (mis. kebijakan tukar size) dikirim apa adanya, tanpa diubah sapaan/emoji.
  const squash = (value: string) =>
    String(value || '')
      .toLowerCase()
      .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\uFE0F\u200D]/gu, '')
      .replace(/\s+/g, ' ')
      .trim()
  const fixed = verbatim.map(squash).filter((value) => value.length >= 40)
  const clean = bubbles
    .map((text) => {
      if (fixed.length && fixed.some((value) => squash(text).includes(value))) return String(text || '').trim()
      let out = String(text || '')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '_$1_')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
        .replace(/!{2,}/g, '!')
        .replace(/\?{2,}/g, '?')
      if (!profile.emoji) out = out.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, '')
      // AI adalah CS-nya: jangan menyebut CS/admin sebagai orang lain ("nanti CS konfirmasi" → "nanti saya konfirmasi").
      out = out
        .replace(/\b(?:tim\s+)?(?:cs|admin)(?:\s+kami)?(\s+(?:akan\s+)?(?:konfirmasi|konfirmasikan|kabari|kabarin|cek|info|infokan|hubungi|bantu|hitung|kirim|kirimkan|jawab|balas)\b)/gi, (_match, rest: string, offset: number, whole: string) =>
          `${offset === 0 || /[.!?\n]\s*$/.test(whole.slice(0, offset)) ? 'Saya' : 'saya'}${rest}`
        )
        .replace(/\b(?:di)?tunggu\s+(?:tim\s+)?(?:cs|admin)(?:\s+kami)?\b/gi, (match: string) => (/^[TD]/.test(match) ? 'Ditunggu sebentar' : 'ditunggu sebentar'))
      if (profile.address && profile.samples >= 8) {
        const others = ADDRESS_WORDS.filter((word) => word !== profile.address && !(profile.address === 'kak' && word === 'kakak'))
        const pattern = new RegExp(`\\b(${[...others, 'anda'].join('|')})\\b`, 'gi')
        out = out.replace(pattern, (match: string, _word: string, offset: number, whole: string) =>
          // Huruf besar hanya di awal kalimat; "Anda" di tengah kalimat jadi huruf kecil.
          offset === 0 || /[.!?\n]\s*$/.test(whole.slice(0, offset)) || match.toLowerCase() !== 'anda'
            ? capitalize(profile.address!, match)
            : profile.address!
        )
      }
      return out
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.!?])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    })
    .filter(Boolean)
  // Pembuka sama berturut-turut ("siap bos…" lalu "Siap sama sama bos") terasa robot: buang yang kedua.
  const opener = (text: string) => text.match(/^(siap|oke|okey|ok|baik|sip)\b[\s,!.]*/i)
  for (let i = clean.length - 1; i > 0; i--) {
    const now = opener(clean[i])
    const before = opener(clean[i - 1])
    if (!now || !before) continue
    const rest = clean[i].slice(now[0].length).trim()
    if (!rest || /^(bos|kak|gan|sis|mas|mbak|min)[.!]?$/i.test(rest)) clean.splice(i, 1)
    else clean[i] = rest[0].toUpperCase() + rest.slice(1)
  }
  // Maksimal 3 bubble; sisanya digabung ke bubble terakhir.
  if (clean.length > 3) clean.splice(2, clean.length - 2, clean.slice(2).join('\n'))
  return clean
}
