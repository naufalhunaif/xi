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
        .replace(/^\s*[•●▪]\s*/gm, '- ')
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
      text = text
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
