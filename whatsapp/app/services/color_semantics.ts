/** Language aliases are not permission to merge neighbouring catalog shades. */
const COLORS = [
  ['broken white', ['broken white', 'bw'], ['putih gading', 'ivory', 'off white']],
  ['putih gading', ['putih gading', 'ivory'], ['broken white', 'bw', 'off white']],
  ['off white', ['off white', 'offwhite'], ['broken white', 'bw', 'ivory']],
  ['navy', ['navy blue', 'biru navy', 'biru dongker', 'navy', 'dongker', 'nevi', 'biru tua'], []],
  ['royal blue', ['royal blue', 'biru royal'], []],
  ['sage', ['sage green', 'hijau sage', 'sage'], []],
  ['army', ['army green', 'hijau army', 'army'], ['olive']],
  ['olive', ['olive green', 'hijau zaitun', 'olive', 'zaitun'], ['army']],
  ['marun', ['maroon', 'merah marun', 'marun', 'mrun', 'merah ati'], ['burgundy']],
  ['burgundy', ['burgundy', 'burgundi'], ['marun']],
  ['abu abu', ['abu abu', 'abu', 'abu2', 'grey', 'gray'], []],
  ['krem', ['cream', 'krem', 'krim'], ['beige', 'ivory']],
  ['beige', ['beige'], ['cream']],
  ['cokelat', ['cokelat', 'coklat', 'brown'], ['choco']],
  ['choco', ['choco', 'chocolate'], ['cokelat']],
  // v3.6.79: sebutan sehari-hari (uji: "item polos" tidak dikenali → baris Black terpotong dari katalog).
  ['hitam', ['black', 'hitam', 'item', 'hitem', 'ireng', 'hideung'], []],
  ['putih', ['white', 'putih', 'pth', 'bodas'], []],
  ['merah', ['red', 'merah'], []],
  ['biru', ['blue', 'biru'], []],
  ['hijau', ['green', 'hijau', 'ijo'], []],
  ['pink', ['pink', 'merah muda'], []],
  ['ungu', ['purple', 'ungu'], []],
  ['kuning', ['yellow', 'kuning'], []],
] as const

const words = (value: unknown) =>
  String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
const aliases = COLORS.flatMap(([canonical, names]) =>
  names.map((alias) => ({ canonical, alias }))
).sort((a, b) => b.alias.length - a.alias.length)
// One pass, longest phrase first: "broken white" must never become "broken putih".
const matcher = new RegExp(`\\b(?:${aliases.map((entry) => entry.alias).join('|')})\\b`, 'g')

/** Index terms only. Typo/fuzzy/nearby matches must not approve a design or select a SKU. */
export function catalogColorSearchHints(names: string[]) {
  const found = new Set<string>()
  for (const name of names)
    for (const match of words(name).matchAll(matcher))
      found.add(aliases.find((row) => row.alias === match[0])!.canonical)
  return COLORS.filter(([canonical]) => found.has(canonical)).map(
    ([catalogColor, searchAliases, nearbyCandidates]) => ({
      catalogColor,
      searchAliases,
      ...(nearbyCandidates.length ? { nearbyCandidates } : {}),
    })
  )
}

/** Used for internal price grouping only; the original identity is always preserved. */
export function catalogModelFamily(name: string) {
  return words(name).replace(matcher, ' ').replace(/\s+/g, ' ').trim()
}

export const COLOR_INTENT_INSTRUCTIONS = `PADANAN WARNA: pahami bahasa, singkatan, font dan typo dalam konteks, bukan hanya pencarian teks persis. BW=Broken White, ivory=putih gading, navy blue/biru dongker=navy, grey/gray=abu-abu, cream=krem. Putih gading juga membuka pencarian BW/Broken White/off-white, tetapi warna berdekatan bukan otomatis identik: pertahankan varian jika katalog membedakannya (cream/beige/ivory/BW, sage/army/olive, navy/royal blue). Cari istilah katalog yang relevan dan bandingkan bukti, jangan scan semua warna. Singkatan ambigu/typo hanya petunjuk pencarian; jangan mengubah persetujuan karena kemiripan. Foto memberi warna tampak, bukan nama shade pasti; beda pencahayaan atau label bahasa saja bukan bukti model berbeda. Pertahankan gelap/terang/dusty, warna per bagian, negasi dan koreksi; jangan tukar badan dengan lapel. ID/nama katalog asli dan detail tersimpan tetap, jangan sync hanya untuk mengganti bahasa. Klarifikasi satu pembeda hanya bila pilihan masih ambigu setelah sumber diperiksa.`
