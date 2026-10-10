// Penjaga kecil sebelum kirim: hal-hal yang skill sudah larang tapi kadang tetap ditulis model.

const OTHER_HANDOFF =
  /bahan|warna|ekspedisi|j&t|lion|sicepat|komplain|rusak|salah kirim|diskon|grosir|seragam|refund|batal|tukar|tanggal|tgl|telepon|telpon|video|nego|alamat|resi/i
const CUSTOM = /custom|kustom|costum|cust[a-z]?m\b|ukuran sendiri/i
const WAITING = /\b(cek|tanyakan|tanya)\b.*\b(dulu|ke)\b/i

// v3.6.90: satu bubble yang menjawab "bisa" sekaligus "caranya" (uji: "cara pesan custom gimana" dijawab template).
export const CUSTOM_REPLY = [
  'Bisa bos, kirim aja contoh model atau detail yang mau diubah, sama tinggi dan berat badannya ya, nanti saya bantu sesuaikan',
]

/**
 * Custom (ukuran atau detail model) tidak diserahkan ke CS — skill: "Detail custom tidak ditolak
 * dan tidak perlu diserahkan". Model kadang tetap serah_cs untuk "mau custom bisa?" tanpa detail.
 * Mengembalikan balasan pengganti bila handoff dibatalkan, null bila handoff dibiarkan.
 */
export function keepCustomInChat(
  decision: { serah_cs: boolean; alasan: string; pesan: string[] },
  customerText: string
) {
  if (!decision.serah_cs) return null
  // v3.6.86: hanya bila PELANGGAN yang menanyakan custom (dulu alasan AI ikut dicek → balasan custom
  // muncul untuk tawaran bisnis "solusi AI custom" dan pertanyaan pelunasan).
  if (!CUSTOM.test(customerText) || String(customerText || '').length > 120) return null
  // Ada pertanyaan lain di pesan yang sama (mis. "orderan saya blm dikirim?") → biar CS yang jawab semuanya.
  const parts = String(customerText).split(/\n+|\?+/).map((part) => part.trim()).filter((part) => part.length > 3)
  if (parts.some((part) => !CUSTOM.test(part) && !/^(?:(?:bisa|bs|boleh|ya|kak|ka|min|bos|gan|cuy|dong|kah)[\s!.,]*)+$/i.test(part))) return null
  if (OTHER_HANDOFF.test(decision.alasan) || OTHER_HANDOFF.test(customerText)) return null
  const usable = decision.pesan.length && !decision.pesan.some((bubble) => WAITING.test(bubble))
  return { pesan: usable ? decision.pesan : CUSTOM_REPLY }
}

const SAME_PRICE = /harga\w*\s+(?:tetap\s+)?sama/i
/**
 * v3.6.89 — "custom ukuran harganya sama" tanpa pengecualian: size XXL ke atas harganya beda (CS asli:
 * "size lebih besar dari XL harga beda ya"). Kalimatnya dilengkapi pengecualian itu.
 */
export function qualifySamePrice(pesan: string[], address = 'bos') {
  let changed = false
  const out = pesan.map((bubble) => {
    if (!SAME_PRICE.test(bubble) || !/custom|ukuran|size/i.test(bubble) || /xxl|2xl|3xl|4xl|besar dari xl|ukuran besar/i.test(bubble)) return bubble
    changed = true
    return bubble.replace(/(harga\w*\s+(?:tetap\s+)?sama)/i, `$1 (kecuali size XXL ke atas, harganya beda ya ${address})`)
  })
  return { pesan: out, changed }
}

const PROGRESS_ASK_EXTRA = /\b(?:u?d(?:ah)?|udh|sudah|sdh)\s+(?:jadi|selesai|beres|dikirim|kirim)\b|\bselesai\s+(?:atau\s+)?belum\b|\bjadi\s+belum\b/i
const PROGRESS_ASK = /\b(progres\w*|udah jadi|sudah jadi|sdh jadi|kapan jadi|kapan (?:di)?kirim|bl[mu]?m?\s*d\w*kirim|belum dikirim|sudah dikirim|udah dikirim|sampai mana|gimana pesanan|pesanan saya|orderan saya)\b/i
const TIME_CLAIM = /\b(belum selesai|masih dalam proses|baru diproses|sudah selesai|minggu depan|besok|lusa|hari (?:senin|selasa|rabu|kamis|jumat|sabtu|minggu|ini)|tanggal \d{1,2}|tgl \d{1,2}|\d+\s*hari lagi|sudah (?:jadi|dikirim)|udah (?:jadi|dikirim)|sedang (?:dikirim|finishing)|masih proses)\b/i
/**
 * v3.6.89 — Progres pesanan lama tidak diketahui AI: klaim waktu/status ("minggu depan", "masih proses")
 * yang tidak ada di data = mengarang. Dicek CS.
 */
export function inventsProgress(customerText: string, pesan: string[], known: string) {
  if (!PROGRESS_ASK.test(customerText) && !PROGRESS_ASK_EXTRA.test(customerText)) return false
  // Jawaban status langsung ("Belum bos, …" / "Sudah bos, …") tanpa data juga karangan.
  if (pesan.some((bubble) => /^\s*(belum|sudah|udah)\b/i.test(bubble)) && !/\b(status|produksi|dikirim|resi)\b/i.test(known)) return true
  return pesan.some((bubble) => {
    const claim = bubble.match(TIME_CLAIM)?.[0]
    return Boolean(claim && !known.toLowerCase().includes(claim.toLowerCase()))
  })
}

/**
 * v3.6.90 — "kurang lebih 1 minggu" dari contoh lama diganti estimasi resmi toko (ESTIMASI PRODUKSI).
 * `ranges`: {preorder: '5-10 hari kerja', custom: '7-14 hari kerja'}.
 */
export function fixWeekEstimate(pesan: string[], ranges: { preorder?: string; custom?: string }) {
  let changed = false
  const out = pesan.map((bubble) => {
    const range = /custom/i.test(bubble) ? ranges.custom || ranges.preorder : ranges.preorder || ranges.custom
    if (!range) return bubble
    const next = bubble.replace(/\b(?:kurang lebih|kurleb|sekitar|kira-kira|±)?\s*(?:1|satu|2|dua|3|tiga)\s+minggu(?:an)?\b/i, (match) => {
      changed = true
      return `${/^\s/.test(match) ? ' ' : ''}sekitar ${range}`
    })
    return next
  })
  return { pesan: out, changed }
}

/**
 * v3.6.90 — Size dari Fit Advisor tidak dinaikkan/diturunkan sendiri (uji: alat bilang XL, AI bilang XXL
 * "biar panjangnya pas"; CS asli: XL). Hanya bila balasan tidak menyebut size alat sama sekali.
 */
export function alignFitSize(pesan: string[], fitNote: string) {
  const recommended = fitNote.match(/REKOMENDASI SIZE \(Fit Advisor[^)]*\):\s*([A-Z0-9]+)/)?.[1]
  if (!recommended) return { pesan, changed: false }
  const text = pesan.join('\n')
  if (new RegExp(`\\b${recommended}\\b`, 'i').test(text)) return { pesan, changed: false }
  const pattern = /\b(rekomendasi(?:nya)?\s+(?:size\s+)?|pakai\s+size\s+|cocok(?:nya)?\s+(?:di\s+)?size\s+|pas\s+(?:di\s+)?size\s+)(XS|S|M|L|XL|XXL|[2-5]XL)\b/i
  if (!pattern.test(text)) return { pesan, changed: false }
  const wrong = text.match(pattern)![2]
  const out = pesan.map((bubble) => bubble.replace(new RegExp(`\\b${wrong}\\b`, 'g'), recommended))
  return { pesan: out, changed: true }
}

const PANTS_NUMBER = /\b(?:no\.?|nomor|nomer|size|ukuran)\s*(2[6-9]|3\d|4[0-6])\b/i
/**
 * v3.6.86 — Nomor celana yang ditebak (dari TB/BB) dibuang: fit advisor jas tidak memberi nomor celana
 * (uji: "celananya rekomendasi no 35" tanpa lingkar pinggang). Angka yang ada di `known` (pesan pelanggan,
 * data alat) tetap. Kalimat yang dibuang diganti satu pertanyaan nomor celana.
 */
export function dropGuessedPantsNumber(pesan: string[], known: string, address = 'bos') {
  let changed = false
  const out = pesan
    .map((bubble) => {
      const sentences = bubble.split(/(?<=[.!?])\s+|\n+/)
      const kept = sentences.filter((sentence) => {
        if (!/celana/i.test(sentence)) return true
        const hit = sentence.match(PANTS_NUMBER)
        if (!hit || new RegExp(`(^|\\D)${hit[1]}(\\D|$)`).test(known)) return true
        changed = true
        return false
      })
      return kept.join(' ').trim()
    })
    .filter(Boolean)
  if (changed && !out.some((bubble) => /celana[^?]*\?/i.test(bubble))) out.push(`Celananya biasa pakai nomor berapa ${address}?`)
  return { pesan: changed ? out : pesan, changed }
}

/**
 * Ada foto yang dikirim sesudah bubble pertama: pertanyaan di ujung bubble itu dipindah ke bubble
 * sendiri supaya urutannya jawaban → foto → pertanyaan (seperti CS).
 */
export function questionAfterPhotos(pesan: string[], photoCount: number) {
  if (!photoCount || pesan.length !== 1) return pesan
  const bubble = pesan[0].trim()
  if (!bubble.endsWith('?')) return pesan
  const byLine = bubble.match(/^([\s\S]*\S)\s*\n\s*([^\n]+\?)$/)
  const bySentence = bubble.match(/^([\s\S]*[.!])\s+([^.!?\n]+\?)$/)
  const match = byLine || bySentence
  if (!match) return pesan
  const [, head, question] = match
  if (!head.trim() || question.length > 120) return pesan
  return [head.trim(), question.trim()]
}

/**
 * v3.6.29 — janji tunggu ("totalnya saya hitung dulu ya") sudah dikirim, pelanggan hanya mengiyakan
 * ("iyaa mas", "oke"): jangan mengulang janji yang sama. Bubble janji dibuang; bila tidak ada yang
 * tersisa, AI diam sampai totalnya siap (kasus Retno: janji dikirim dua kali).
 */
export const WAIT_PROMISE =
  /\b(saya|kami)\s+(cek|hitung|kabari|konfirmasi|tanyakan|tanya|pastikan)\w*\s+(dulu|ulang)\b|\btotal\w*\s+(saya|kami)\s+(cek|hitung)\w*\s+dulu/i
const BARE_ACK =
  /^\s*(iya+|iy+a+|ya+|yaa+|oke+|ok+|okay|okey|siap+|sip+|baik|yoi|boleh|oke siap|iya oke|ok siap|iya ok)\b[\s!.,]*(mas|bos|bosku|kak|bang|pak|bu|min|gan)?[\s!.🙏👍]*$/i

export function dropRepeatedWait(pesan: string[], lastOutgoing: string, customerText: string) {
  if (!BARE_ACK.test(customerText || '') || !WAIT_PROMISE.test(lastOutgoing || '')) return { pesan, changed: false }
  const kept = pesan.filter((bubble) => !WAIT_PROMISE.test(bubble))
  return { pesan: kept, changed: kept.length !== pesan.length }
}

const ORDER_WORD = /\b(pesan|pesen|pesanan|order|orderan|beli|ambil|jas|setelan|celana|rompi)\b/i
const CANCEL_WORD = /\b(batal|batalkan|cancel|(?:gak|ga|gk|nggak|ngga|enggak|tidak|ndak)\s*jadi|gajadi|gjd)\b/i
const COMMIT = /\b(total|rekening|transfer|tf|form|alamat|ongkir|order|pesanan|dp|lunas)\b/i

/**
 * v3.6.55 — "gak jadi" membatalkan PESANAN hanya bila jelas menyebut pesanan/pembelian, atau
 * menjawab langkah order dari toko (total, rekening, form, ongkir). "Cek resi …" lalu "ga jadi"
 * = pertanyaannya yang batal, pesanan & catatan tetap.
 */
export function cancelsOrder(text: string, rows: Array<{ direction: string; body?: string | null; current?: boolean }>) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean)
  const last = lines[lines.length - 1] || ''
  if (CANCEL_WORD.test(last) && ORDER_WORD.test(last)) return true
  // Pelanggan sendiri yang bicara terakhir (pertanyaan di giliran yang sama) → yang batal pertanyaannya.
  if (lines.length > 1) return false
  const previous = [...rows].reverse().find((row) => !row.current && row.body)
  return previous?.direction === 'out' && COMMIT.test(String(previous.body || ''))
}

/** v3.6.55 — pesan giliran yang batal ditaruh di depan antrean giliran berikutnya (tanpa dobel). */
/**
 * v3.6.69 — pesan pelanggan yang gilirannya batal / dilewati (pesan lebih baru sudah masuk) dan
 * belum ada giliran berikutnya yang menunggu disimpan sebentar, lalu ikut giliran berikutnya
 * (kasus Alkhoiri 8 Okt: foto model kedua + "Modelnya gini bs min?" tidak pernah dijawab AI).
 */
export const STASH_TTL_MS = 15 * 60_000
export function stashTurn<T extends { id: string }>(
  stash: Map<string, { at: number; items: T[] }>,
  jid: string,
  items: T[],
  now = Date.now()
) {
  const previous = stash.get(jid)
  const kept = previous && now - previous.at <= STASH_TTL_MS ? previous.items : []
  const known = new Set(kept.map((item) => item.id))
  stash.set(jid, { at: now, items: [...kept, ...items.filter((item) => !known.has(item.id))] })
}
export function takeStashed<T extends { id: string }>(stash: Map<string, { at: number; items: T[] }>, jid: string, now = Date.now()) {
  const entry = stash.get(jid)
  stash.delete(jid)
  return entry && now - entry.at <= STASH_TTL_MS ? entry.items : []
}

export function prependMissing<T extends { id: string }>(queue: T[], items: T[]) {
  const known = new Set(queue.map((item) => item.id))
  queue.unshift(...items.filter((item) => !known.has(item.id)))
  return queue
}

/** v3.6.67 — COD / bayar di tempat / paylater tidak tersedia (data CS lama); AI sempat menjawab "Bisa COD bos". */
export const NO_COD_REPLY = 'Maaf bos, belum bisa COD ya, pembayarannya lewat transfer'
const ASKS_COD = /\b(cod|bayar di tempat|bayar ditempat|paylater|pay later)\b/i
const CLAIMS_COD = /[^.!?\n]*\b(?:bisa|boleh|tersedia|ada)\s+(?:pakai\s+|via\s+)?(?:cod|bayar di ?tempat|paylater)\b[^.!?\n]*[.!?]?/gi
export function fixCodClaim(pesan: string[], customerText: string) {
  if (!ASKS_COD.test(customerText || '')) return { pesan, changed: false }
  let changed = false
  const out = pesan.map((bubble) =>
    bubble.replace(CLAIMS_COD, (sentence) => {
      if (/\b(belum|tidak|gak|ga|nggak|engga)\b/i.test(sentence)) return sentence
      changed = true
      return `${NO_COD_REPLY}. `
    }).replace(/\s{2,}/g, ' ').trim()
  )
  return { pesan: changed ? out.filter(Boolean) : pesan, changed }
}

/**
 * v3.6.132 — "yg kedua dr terakhir itu fotonya dong": urutan dari daftar terakhir yang dikirim toko dihitung
 * kode (uji: AI salah hitung → foto Maroon padahal yang kedua dari terakhir Navy). Null bila tidak ada rujukan.
 */
const ORDINAL: Record<string, number> = { pertama: 1, satu: 1, kesatu: 1, kedua: 2, dua: 2, ketiga: 3, tiga: 3, keempat: 4, empat: 4, kelima: 5, lima: 5, keenam: 6, enam: 6 }
export function listReference(text: string, rows: Array<{ direction: string; body?: string | null; current?: boolean }>) {
  const ask = String(text || '').toLowerCase()
  if (ask.length > 80 || !/\b(?:yang|yg|itu|no|nomor|urutan)\b/.test(ask)) return null
  const fromEnd = /\b(?:dari|dr)\s+(?:yang\s+|yg\s+)?(?:belakang|terakhir|akhir)\b|\b(?:ke\w*|\d)\s+(?:terakhir|belakang)\b/.test(ask)
  const last = /\b(?:yang|yg)\s+(?:paling\s+)?(?:terakhir|belakang)\b|\bpaling\s+(?:akhir|belakang|bawah)\b/.test(ask) && !fromEnd
  const word = ask.match(/\b(pertama|kesatu|kedua|ketiga|keempat|kelima|keenam)\b/)?.[1] || ask.match(/\b(?:ke|ke-|no\.?|nomor|urutan)\s*(\d{1,2})\b/)?.[1]
  const position = word ? ORDINAL[word] || Number(word) : last ? 1 : 0
  if (!position) return null
  const store = [...rows].reverse().find((row) => row.direction === 'out' && !row.current && (String(row.body || '').match(/,/g) || []).length >= 2)
  if (!store) return null
  const body = String(store.body || '').split(/\n/).sort((a, b) => (b.match(/,/g) || []).length - (a.match(/,/g) || []).length)[0]
  const items = body
    .split(/,|\s+(?:dan|sama|&)\s+/i)
    .map((item, at) => (at === 0 ? item.replace(/^.*(?:\bada\b|:|\byaitu\b|\bwarnanya\b|\bpilihan(?:nya)?\b)\s*/i, '') : item))
    .map((item) => item.replace(/\b(?:bos|kak|ya|juga)\b|[.?!]/gi, '').replace(/^\s*(?:dan|sama)\s+/i, '').trim())
    .filter((item) => item && item.split(/\s+/).length <= 4)
  if (items.length < 3) return null
  const index = fromEnd || last ? items.length - position : position - 1
  if (index < 0 || index >= items.length) return null
  return { item: items[index], items }
}

/**
 * v3.6.132 — Format order dari skill dikirim padahal pelanggan sudah memberi sebagian data lewat obrolan:
 * baris yang sudah terjawab dibuang; Kode Pos tidak wajib (kecamatan + kota cukup) jadi tidak ditanyakan.
 */
export function trimOrderTemplate(pesan: string[], customerTexts: string[]) {
  const said = customerTexts.join('\n')
  const hasAddress = /\b(?:jl|jln|jalan|gg|gang|desa|dusun|dsn|kel|kec|kecamatan|kab|kabupaten|kota|perum|rt|rw)\b/i.test(said)
  const hasPhone = /(?:\+?62|0)8[\d\s-]{7,13}\d|\b(?:pake|pakai|pke)\s+(?:nomor|no|nmr)\s+(?:ini|wa\s+ini)\b/i.test(said)
  const hasName = /\b(?:nama|atas\s+nama|a\.?n\.?)\s*:?\s+[a-z]{2,}/i.test(said)
  let changed = false
  const out = pesan.map((bubble) => {
    if (!/\bNama\s*(?:penerima\s*)?:/i.test(bubble) || !/\bAlamat[^:\n]*:/i.test(bubble)) return bubble
    const drop = (line: string) =>
      /^\s*Kode\s*Pos\s*:/i.test(line) ||
      (hasAddress && /^\s*(?:Alamat[^:]*|Kecamatan|Kabupaten(?:\s*\/\s*Kota)?|Kota)\s*:\s*$/i.test(line)) ||
      (hasPhone && /^\s*(?:No\.?\s*(?:telp|hp|wa)\w*|Nomor\s*\w*)\s*:\s*$/i.test(line)) ||
      (hasName && /^\s*Nama[^:]*:\s*$/i.test(line))
    const lines = bubble.split('\n')
    const kept = lines.filter((line) => !drop(line))
    if (kept.length === lines.length) return bubble
    changed = true
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  })
  return { pesan: out, changed }
}
