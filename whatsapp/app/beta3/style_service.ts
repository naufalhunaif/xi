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

/** Bagian prompt: aturan gaya yang sama persis untuk model apa pun. */
export function styleGuide(profile: StyleProfile) {
  const lines = [
    'GAYA BALASAN TOKO (ikuti skill & contoh CS; ini hanya penyeragam format):',
    profile.address ? `- Sapa pelanggan dengan "${profile.address}" (jangan kak/kakak/anda/sapaan lain).` : '',
    profile.emoji ? '- Emoji boleh secukupnya, maksimal satu per bubble.' : '- Tanpa emoji.',
    // Sengaja tanpa batas jumlah huruf: batas panjang membuat jawaban terpotong dan
    // kurang informatif (harga/detail hilang). Panjang mengikuti skill & contoh CS.
    '- Bahasa santai sehari-hari seperti contoh CS; tanpa format markdown (**tebal**, #judul, tabel). Rincian harga boleh per baris.',
    '- Jangan membuka dengan salam panjang atau menutup dengan kalimat basa-basi yang sama tiap kali.',
  ]
  return lines.filter(Boolean).join('\n')
}

const capitalize = (word: string, like: string) =>
  like[0] === like[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word

/** Rapikan keluaran AI agar formatnya sama apa pun modelnya. */
export function normalizeStyle(bubbles: string[], profile: StyleProfile) {
  const clean = bubbles
    .map((text) => {
      let out = String(text || '')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/__(.+?)__/g, '_$1_')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 $2')
        .replace(/!{2,}/g, '!')
        .replace(/\?{2,}/g, '?')
      if (!profile.emoji) out = out.replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, '')
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
  // Maksimal 3 bubble; sisanya digabung ke bubble terakhir.
  if (clean.length > 3) clean.splice(2, clean.length - 2, clean.slice(2).join('\n'))
  return clean
}
