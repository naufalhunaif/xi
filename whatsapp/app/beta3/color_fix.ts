// Beta 3 — warna di lembar spesifikasi selalu nama warna KATALOG (mis. "Choco", bukan "Brown").

/** Sebutan warna yang sama; dipetakan ke nama di KATALOG bila produk hanya punya satu yang cocok. */
const COLOR_GROUPS = [
  ['choco', 'chocolate', 'coklat', 'cokelat', 'brown', 'mocca', 'mocha'],
  ['black', 'hitam'],
  ['white', 'putih', 'broken white', 'off white'],
  ['navy', 'navy blue', 'dongker', 'biru dongker'],
  ['grey', 'gray', 'abu', 'abu abu', 'abu-abu'],
  ['cream', 'krem', 'beige'],
  ['maroon', 'marun'],
]

const norm = (value: string) =>
  String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Pelanggan menyebut warna ini di pesannya: namanya, atau sebutan sekelompok yang tidak
 * juga berarti warna lain produk itu ("hitam" = Black; "coklat" ambigu bila ada Brown & Choco).
 */
function customerNamed(
  chat: Array<{ direction: string; body?: string | null }>,
  color: string,
  others: string[]
) {
  const groupOf = (name: string) => COLOR_GROUPS.find((names) => names.includes(norm(name))) || []
  const taken = new Set(
    others
      .filter((other) => norm(other) !== norm(color))
      .flatMap((other) => [norm(other), ...groupOf(other)])
  )
  const words = [norm(color), ...groupOf(color).filter((word) => !taken.has(word))]
  const text = ` ${chat
    .filter((row) => row.direction === 'in')
    .map((row) => norm(String(row.body || '')))
    .join(' ')} `
  return words.some((word) =>
    new RegExp(`(^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(text)
  )
}

/**
 * Baris "Produk - Warna" yang warnanya tidak ada untuk produk itu di KATALOG diganti
 * dengan nama warna KATALOG yang sekelompok. `swaps` = pasangan [salah, benar] untuk
 * merapikan kalimat balasan di giliran yang sama.
 */
export function fixCatalogColors(
  text: string,
  catalog: Array<{ product: string; color: string }>,
  chat: Array<{ direction: string; body?: string | null; mediaType?: string | null }> = []
) {
  const colorsOf = new Map<string, string[]>()
  for (const row of catalog) {
    const key = norm(row.product)
    if (!key || !row.color) continue
    const list = colorsOf.get(key) || []
    if (!list.includes(row.color)) list.push(row.color)
    colorsOf.set(key, list)
  }
  const swaps: Array<[string, string]> = []
  const lines = String(text || '')
    .split('\n')
    .map((line) => {
      const match = line.match(/^(\s*)(.+?)\s+-\s+(.+?)\s*$/)
      if (!match) return line
      const colors = colorsOf.get(norm(match[2]))
      if (!colors?.length) return line
      let color = match[3]
      if (!colors.some((known) => norm(known) === norm(color))) {
        const group = COLOR_GROUPS.find((names) => names.includes(norm(color)))
        const hits = group ? colors.filter((known) => group.includes(norm(known))) : []
        if (hits.length === 1) color = hits[0]
      }
      // Warna yang ditunjukkan di chat: foto katalog produk ini yang dikirim toko (mis. setelah
      // pelanggan kirim gambar "yang seperti ini"). Warna lain yang tidak pernah disebut
      // pelanggan dan tidak pernah difotokan → pakai foto terakhir produk itu.
      const shown = chat
        .filter((row) => row.direction !== 'in' && row.mediaType === 'image')
        .map((row) =>
          String(row.body || '')
            .trim()
            .match(/^(.+?)\s+-\s+(.+)$/)
        )
        .filter(
          (found): found is RegExpMatchArray => Boolean(found) && norm(found![1]) === norm(match[2])
        )
        .map((found) => colors.find((known) => norm(known) === norm(found[2])))
        .filter((known): known is string => Boolean(known))
      if (
        shown.length &&
        !shown.some((known) => norm(known) === norm(color)) &&
        !customerNamed(chat, color, colors)
      )
        color = shown[shown.length - 1]
      if (color === match[3]) return line
      swaps.push([match[3], color])
      return `${match[1]}${match[2]} - ${color}`
    })
  return { text: lines.join('\n'), swaps }
}

/** Ganti sebutan warna yang salah di kalimat balasan (hanya pasangan dari `fixCatalogColors`). */
export function swapColorWords(bubbles: string[], swaps: Array<[string, string]>) {
  if (!swaps.length) return bubbles
  return bubbles.map((bubble) =>
    swaps.reduce((current, [wrong, right]) => {
      const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      return current.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), (found) =>
        found[0] === found[0].toUpperCase() ? right : right.toLowerCase()
      )
    }, bubble)
  )
}
