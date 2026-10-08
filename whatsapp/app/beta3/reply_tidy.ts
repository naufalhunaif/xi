// Perapian jawaban oleh sistem (tanpa memanggil AI lagi): JSON yang rusak diperbaiki, teks biasa
// dipakai sebagai pesan, dan gaya bubble dirapikan sesuai aturan CS.

type JsonObject = Record<string, unknown>

function parseObject(text: string): JsonObject | null {
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
  } catch {
    return null
  }
}

/**
 * Perbaiki keluaran JSON model: pagar ```json, teks pengantar, koma berlebih, baris baru mentah di
 * dalam string, dan keluaran terpotong (kurung/tanda kutip belum ditutup). null bila tidak ada JSON.
 */
export function repairJson(text: string): JsonObject | null {
  const body = String(text || '').replace(/```(?:json)?/gi, '')
  const start = body.indexOf('{')
  if (start < 0) return null
  const tail = body.slice(start)
  const end = tail.lastIndexOf('}')
  if (end > 0) {
    const direct = parseObject(tail.slice(0, end + 1))
    if (direct) return direct
  }
  let out = ''
  let inString = false
  let escaped = false
  const stack: string[] = []
  for (const char of tail) {
    if (inString) {
      if (escaped) {
        out += char
        escaped = false
      } else if (char === '\\') {
        out += char
        escaped = true
      } else if (char === '"') {
        out += char
        inString = false
      } else if (char === '\n') out += '\\n'
      else if (char === '\t') out += '\\t'
      else if (char !== '\r') out += char
      continue
    }
    if (char === '"') {
      inString = true
      out += char
    } else if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']')
      out += char
    } else if (char === '}' || char === ']') {
      out = out.replace(/,\s*$/, '')
      stack.pop()
      out += char
      if (!stack.length) break
    } else out += char
  }
  if (inString) out += '"'
  // Terpotong di tengah pasangan "kunci": → buang pasangan itu.
  out = out.replace(/,?\s*"[^"]*"\s*:\s*$/, '').replace(/,\s*$/, '')
  while (stack.length) out = `${out.replace(/,\s*$/, '')}${stack.pop()}`
  return parseObject(out)
}

/**
 * Model menulis balasan biasa (bukan JSON): pakai sebagai pesan bila jelas ditujukan ke pelanggan.
 * Teks yang berisi analisis/format (JSON, "tahap", "pelanggan", …) tidak pernah dikirim → null.
 */
export function bubblesFromText(text: string): string[] | null {
  const clean = String(text || '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
  if (!clean || clean.length > 500 || /[{}[\]]/.test(clean)) return null
  if (/\b(json|skema|schema|serah_cs|tahap|catatan|spesifikasi|field|pelanggan|balasan|bubble)\b/i.test(clean))
    return null
  const parts = clean
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 2 ? [parts[0], parts.slice(1).join('\n')] : parts
}

const BULLET = /^\s*(?:[-*•●▪·])\s+/
const NUMBERED = /^\s*\d+[.)]\s+/
const INTRO = /(?::|\b(?:seperti ini|berikut\w*)(?:\s+(?:ya\s+)?(?:bos|kak))?[.!]?)\s*$/i

/**
 * Daftar mudah dibaca: setiap pilihan satu baris berawalan "- " (tampil sebagai daftar di WhatsApp),
 * dan satu baris kosong sesudah daftar sebelum kalimat berikutnya.
 * Daftar = minimal 2 baris pendek berurutan sesudah baris pembuka ("…:" / "seperti ini") atau yang
 * sudah berpoin. Daftar bernomor dibiarkan.
 */
export function bulletLists(text: string) {
  const lines = text.split('\n').map((line) => line.replace(/\s+$/, ''))
  const itemLike = (line: string) =>
    Boolean(line.trim()) && line.trim().length <= 80 && !line.trim().endsWith('?') && !INTRO.test(line.trim())
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const startsList =
      BULLET.test(line) || (index > 0 && INTRO.test(lines[index - 1].trim()) && !NUMBERED.test(line))
    if (startsList && itemLike(line)) {
      let end = index
      while (end + 1 < lines.length && itemLike(lines[end + 1]) && !NUMBERED.test(lines[end + 1])) end++
      const block = lines.slice(index, end + 1)
      if (block.length >= 2 || BULLET.test(line)) {
        out.push(...block.map((item) => `- ${item.replace(BULLET, '').trim()}`))
        if (end + 1 < lines.length && lines[end + 1].trim()) out.push('')
        index = end + 1
        continue
      }
    }
    out.push(line)
    index++
  }
  return out.join('\n')
}

/**
 * v3.6.86 — Pilihan pendek tanpa angka ("Mau model yang mana bos:\n- Basic Suit\n- Tuxedo") terasa seperti
 * menu bot (uji chat nyata): ditulis satu kalimat "Mau model yang mana bos, Basic Suit atau Tuxedo?".
 */
export function inlineChoices(text: string) {
  const lines = text.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const intro = lines[index]
    let end = index + 1
    while (end < lines.length && BULLET.test(lines[end])) end++
    const items = lines.slice(index + 1, end).map((line) => line.replace(BULLET, '').trim())
    const short = items.every((item) => item && !/\d/.test(item) && item.split(/\s+/).length <= 4)
    if (items.length >= 2 && items.length <= 5 && short && /\b(mau|pilih|yang mana|model apa|warna apa)\b/i.test(intro)) {
      const head = intro.trim().replace(/[:?.!\s]+$/, '')
      const list = items.length === 2 ? items.join(' atau ') : `${items.slice(0, -1).join(', ')}, atau ${items[items.length - 1]}`
      out.push(`${head}, ${list}?`)
      index = end
      if (index < lines.length && !lines[index].trim()) index++
      continue
    }
    out.push(intro)
    index++
  }
  return out.join('\n').trim()
}

const ADDRESS = /\b(?:bapak\s*\/\s*ibu|bpk\s*\/\s*ibu|kakak|kak|anda|kamu|bapak|ibu|sis|gan|mas|mbak)\b/gi
const FORMAL_OPENERS = [
  /^(?:terima\s*kasih|makasih)\s+(?:telah|sudah)\s+menghubungi[^.!?\n]*[.!?]?\s*/i,
  /^(?:halo,?\s+)?selamat\s+datang\s+di[^.!?\n]*[.!?]?\s*/i,
]
const startOfSentence = (whole: string, offset: number) => offset === 0 || /[.!?\n]\s*$/.test(whole.slice(0, offset))
const squash = (value: string) => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * Rapikan bubble sesuai aturan CS: tanpa markdown/emoji/pembuka formal, sapaan "bos" (sekali di
 * ujung kalimat per bubble), spasi rapi, bubble kembar dibuang. Huruf kecil gaya CS dibiarkan.
 * Teks resmi toko (verbatim, mis. kebijakan) dan template form tidak diubah.
 */
export function tidyReply(pesan: string[], options: { address?: string; verbatim?: string[] } = {}) {
  const address = options.address || 'bos'
  const fixed = (options.verbatim || []).map(squash).filter((value) => value.length >= 40)
  const seen = new Set<string>()
  const out: string[] = []
  for (const bubble of pesan) {
    let text = String(bubble || '').trim()
    if (!text) continue
    const keep = fixed.some((value) => squash(text).includes(value)) || /\n\s*Nama\s*:/i.test(text)
    if (!keep) {
      text = text
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}️‍]/gu, '')
      for (const pattern of FORMAL_OPENERS) text = text.replace(pattern, '')
      if (address === 'bos')
        text = text.replace(ADDRESS, (match: string, offset: number, whole: string) => {
          // Nama pemilik rekening ("an Ibu Sari") dan baris rekening tidak diubah.
          const line = whole.slice(whole.lastIndexOf('\n', offset) + 1, whole.indexOf('\n', offset) < 0 ? undefined : whole.indexOf('\n', offset))
          if (/(?:\ban|a\.n\.?|atas\s+nama)\s*$/i.test(whole.slice(0, offset)) || /\d{6,}/.test(line)) return match
          return startOfSentence(whole, offset) ? 'Bos' : 'bos'
        })
      // "bos" di ujung kalimat cukup sekali per bubble.
      let called = false
      text = text.replace(/,?\s+bos(?=\s*(?:[.!?,\n]|$))/gi, (match) => {
        if (!called) {
          called = true
          return match
        }
        return ''
      })
      text = text
        .replace(/!{2,}/g, '!')
        .replace(/\?{2,}/g, '?')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/ +([,.!?])/g, '$1')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      // "oke,siap" → "oke, siap" (bukan angka "1,5" dan bukan link).
      if (!/https?:\/\/|www\./i.test(text)) text = text.replace(/([A-Za-z]),(?=[A-Za-z])/g, '$1, ')
      text = inlineChoices(bulletLists(text))
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }
    if (!text) continue
    const key = squash(text)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(text)
  }
  return out
}
