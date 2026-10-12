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
  /** v3.6.152 — ritme balasan CS manusia dari riwayat chat (per giliran: kata, pertanyaan, pembuka khas). */
  rhythm?: CsRhythm | null
}

export type CsRhythm = { turns: number; words: number; wordsP75: number; questionRate: number; openers: string[] }

type RhythmRow = { jid: string; direction: string; sender_type: string | null; body: string | null }
/** Balasan sistem/template (format order, rincian total, rekening, salam otomatis) tidak dihitung. */
export const REPLY_TEMPLATE = /^(?:nama\s*:|bisa di ?bantu isi order|format|total|rincian|rekening|no\.?\s*rek|untuk pembayaran tf|terima kasih telah menghubungi|maaf atas keterlambatan)/i

/**
 * v3.6.152 — Pelajari ritme CS manusia: satu giliran = pesan CS berturut sesudah pesan pelanggan. Dari riwayat nyata
 * (500 chat): CS rata-rata 8 kata per giliran, 75% ≤ 14 kata, hanya 20% bertanya; AI dulu 16 kata & 42% bertanya.
 */
export function csRhythm(rows: RhythmRow[]): CsRhythm | null {
  const byJid = new Map<string, RhythmRow[]>()
  for (const row of rows) {
    const list = byJid.get(row.jid) || []
    list.push(row)
    byJid.set(row.jid, list)
  }
  const turns: string[][] = []
  for (const list of byJid.values()) {
    let turn: string[] | null = null
    let skip = false
    let human = true
    const flush = () => {
      if (turn?.length && !skip && human) turns.push(turn)
    }
    for (const row of list) {
      if (row.direction === 'in') {
        flush()
        turn = []
        skip = false
        human = true
        continue
      }
      if (!turn || !row.body) continue
      if (!['cs', 'owner'].includes(String(row.sender_type || ''))) {
        human = false
        continue
      }
      const body = String(row.body).trim()
      if (REPLY_TEMPLATE.test(body) || body.length > 400) skip = true
      turn.push(body)
    }
    flush()
  }
  if (turns.length < 30) return null
  const words = turns.map((turn) => turn.join(' ').split(/\s+/).filter(Boolean).length).sort((a, b) => a - b)
  const openers = new Map<string, number>()
  for (const turn of turns) {
    const head = turn[0]
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(' ')
    if (head.split(' ').length === 2 && !/^(halo|pagi|siang|sore|malam|jas|untuk|pesanan|proses)\b/.test(head)) openers.set(head, (openers.get(head) || 0) + 1)
  }
  return {
    turns: turns.length,
    words: words[Math.floor(words.length / 2)],
    wordsP75: words[Math.floor(words.length * 0.75)],
    questionRate: Math.round((100 * turns.filter((turn) => /\?/.test(turn.join(' '))).length) / turns.length),
    openers: [...openers.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([text]) => text),
  }
}

const ADDRESS_WORDS = ['bos', 'kak', 'kakak', 'gan', 'sis', 'bro', 'mas', 'mbak', 'om', 'min', 'bu', 'ibu', 'pak', 'bapak']
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
  const recent = (await db
    .from('whatsapp_messages')
    .whereNot('jid', 'like', '%@g.us')
    .where('created_at', '>', new Date(Date.now() - 365 * 86_400_000))
    .orderBy('id', 'desc')
    .limit(12_000)
    .select('jid', 'direction', 'sender_type', 'body')
    .catch(() => [])) as RhythmRow[]
  const rhythm = csRhythm(recent.reverse())
  const profile: StyleProfile = {
    rhythm,
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
    '- Rapi seperti CS: rincian berangka (ongkir, rincian total, data pesanan, harga yang diminta per model) satu item per baris. Pilihan tanpa angka cukup satu kalimat ("mau A, B, atau C bos?"). Ditanya harga/price list umum → "mulai dari X" lalu tanya model.',
    '- Singkat & tepat seperti contoh CS di riwayat: 1 bubble per maksud, maks 3; satu pertanyaan saja, jangan menanyakan lagi yang sudah ditanyakan; tanpa salam panjang atau basa-basi penutup.',
    profile.rhythm
      ? `- Ritme CS asli (${profile.rhythm.turns} balasan): biasanya ${profile.rhythm.words} kata, 75% ≤ ${profile.rhythm.wordsP75} kata; hanya ${profile.rhythm.questionRate}% balasan bertanya. Jawab langsung sependek itu ("iya bisa bos", "ready bos", "tambahan 100rb bos"); bertanya balik hanya bila langkah berikutnya butuh. Pembuka khas: ${profile.rhythm.openers.map((text) => `"${text}"`).join(', ')}.`
      : '',
    '- Seperti CS terbaik: jawab pertanyaan terakhir langsung, singkat ("harga 485.000 bos"); jangan ditunda dengan pertanyaan lain. Jawab dari data (bahan, lama jadi, lokasi); tanya balik hanya bila jawabannya beda per model. Minta sharelok → kirim alamat lengkap toko. Ditanya warna lain → sebut 3–5 yang ready/terdekat, bukan semua.',
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
  // Maksimal 3 bubble per maksud (v3.7.0, pemilik 13 Okt); sisanya digabung ke bubble terakhir.
  if (clean.length > 3) clean.splice(2, clean.length - 2, clean.slice(2).join('\n'))
  return clean
}
