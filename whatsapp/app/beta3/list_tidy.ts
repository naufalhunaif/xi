// Perapian daftar lintas model: deretan pilihan dalam satu kalimat jadi satu per baris.
const PRICE = /\d{1,3}(?:\.\d{3})+|\b\d+\s?(?:rb|ribu|k|jt|juta)\b/i
const ADDRESS = /^(?:ya\s+)?(?:bos|kak|kakak|gan|sis|bro|mas|mbak|om|min)[.!]?$/i

/** Deretan ≥3 pilihan dalam satu kalimat → satu pilihan per baris. */
export function tidyLists(text: string): string {
  if (!text || text.includes('\n')) return text
  const sentences = text.split(/(?<=[.!?])\s+/)
  const out: string[] = []
  for (const sentence of sentences) out.push(tidySentence(sentence))
  return out.join(' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function tidySentence(sentence: string): string {
  const end = sentence.match(/[.!?]$/)?.[0] || ''
  const body = end ? sentence.slice(0, -1) : sentence
  const parts = body.split(/,\s+(?:atau\s+|dan\s+)?|\s+(?:atau|dan)\s+(?=\S)/)
  if (parts.length < 3) return sentence
  const priced = parts.filter((part) => PRICE.test(part)).length
  // Nama (produk/warna), bukan deretan size pendek seperti "S, M, L".
  const names =
    parts.slice(1).every((part) => /^[A-Z0-9]/.test(part.trim()) && part.trim().split(/\s+/).length <= 5) &&
    parts.slice(1).every((part) => part.trim().length >= 4)
  const isPriceList = priced >= 3 && priced >= parts.length - 1
  const isNameList = !isPriceList && parts.length >= 4 && names
  if (!isPriceList && !isNameList) return sentence
  // Pisahkan pembuka dari item pertama: panjang item mengikuti item kedua.
  const wordsOf = (part: string) => part.trim().split(/\s+/)
  const second = parts[1].trim()
  const lead = isPriceList ? (second.match(new RegExp(`^(.*?)\\s*(?:Rp\\s?)?(${PRICE.source})`, 'i'))?.[1] || '') : second
  const itemWords = Math.max(1, lead ? wordsOf(lead).length : 1)
  const first = wordsOf(parts[0])
  let intro = ''
  let firstItem = parts[0].trim()
  if (isPriceList) {
    const priceAt = first.findIndex((word) => PRICE.test(word))
    const start = Math.max(0, priceAt - itemWords)
    intro = first.slice(0, start).join(' ')
    firstItem = first.slice(start).join(' ')
  } else {
    const start = Math.max(0, first.length - itemWords)
    intro = first.slice(0, start).join(' ')
    firstItem = first.slice(start).join(' ')
  }
  // Kata sapaan di ujung item terakhir ("... (6-7 hari) bos") dipindah ke pembuka.
  const items = [firstItem, ...parts.slice(1).map((p) => p.trim())]
  let tail = ''
  const lastWords = wordsOf(items[items.length - 1])
  if (lastWords.length > 1 && ADDRESS.test(lastWords[lastWords.length - 1])) {
    tail = lastWords.pop()!
    items[items.length - 1] = lastWords.join(' ')
  }
  if (!intro) return sentence
  const head = `${intro}${tail ? ` ${tail}` : ''}:`
  return `\n${head}\n${items.join('\n')}\n\n`
}
