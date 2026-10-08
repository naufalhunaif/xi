// v3.6.95 — Jalur kilat: seperti CS manusia yang sudah hafal jawabannya. Pertanyaan umum yang jelas dan
// satu maksud (harga mulai, lokasi, jam buka, marketplace, lama pengerjaan, cara order, rekening) dijawab
// langsung dari data toko dalam 1–2 kalimat, tanpa memanggil AI (±0 detik, 0 kuota). Ragu → jalur pikir (AI).
import type { LeanCatalogRow } from '#beta3/catalog_service'
import type { LeanHistoryRow } from '#beta3/prompt'

export type FastIntent = 'harga_umum' | 'lokasi' | 'jam_buka' | 'marketplace' | 'lama_pengerjaan' | 'cara_order' | 'rekening'

export type FastFacts = {
  /** Teks profil toko ("TOKO: … — <alamat>.\n… buka Sen-Jum 09:00-17:00, … WIB …"). */
  store: string
  rows: LeanCatalogRow[]
  /** {preorder: '5-10 hari kerja', custom: '7-14 hari kerja'} */
  ranges: { preorder?: string; custom?: string }
  /** Kalimat rekening resmi (renderPaymentMessage); kosong bila belum diatur. */
  payment: string
  address: string
  /** Pembeda pilihan kalimat per chat (mis. jid + jumlah pesan). */
  seed?: string
  /** Kalimat toko terakhir: tidak diulang persis. */
  avoid?: string[]
}

const SALAM = /\b(ass?alamu'?\s*alaikum\S*|assalamualaikum\S*|asslm\S*|salam)\b/i
const TIME = /\b(selamat\s+|met\s+)?(pagi|siang|sore|malam)\b/i

const INTENTS: Array<[FastIntent, RegExp]> = [
  ['marketplace', /\b(shopee|shoppe|tokped|tokopedia|lazada|tiktok\s*shop|marketplace|blibli|bukalapak)\b/i],
  ['rekening', /\b(no\.?\s*rek\w*|norek\w*|nomor\s+rek\w*|rek(?:ening)?(?:nya)?\s+(?:mana|apa|berapa)|(?:tf|trf|transf\w*|bayar\w*)\s+(?:ke\s+)?(?:rek\w*\s+)?(?:mana|kemana)|ke\s+rek\w*\s+mana)\b/i],
  ['lokasi', /\b(sharelo[ck]|share\s*lo[ck]\w*|lokasi(?:nya)?(?:\s+toko)?\s*(?:di\s*mana|dmn|dimana|mana)?|alamat\s+(?:toko|store|galeri|gallery)\w*|alamat(?:nya)?\s+(?:di\s*mana|dmn|dimana)|toko(?:nya)?\s+(?:di\s*mana|dmn|dimana)|(?:di\s*mana|dimana|dmn)\s+(?:toko|lokasi|alamat)\w*)\b/i],
  ['jam_buka', /\b(jam\s+(?:berapa|brp)\s+(?:buka|tutup)|(?:buka|tutup)\s+(?:jam|sampai|sampe)\s*(?:berapa|brp)?|jam\s+(?:buka|operasional)|(?:hari\s+)?(?:minggu|sabtu|libur)\s+(?:buka|tutup)|toko(?:nya)?\s+buka)\b/i],
  ['lama_pengerjaan', /\b((?:berapa|brp)\s+lama|lama\s+(?:pengerjaan|proses|bikin|buat|jadi|pembuatan)|(?:berapa|brp)\s+hari\s+(?:jadi|selesai|proses|pengerjaan|pembuatan|bikin|buat)|estimasi\s+(?:jadi|pengerjaan|selesai|pembuatan))\b/i],
  ['cara_order', /\b(cara\s+(?:order|pesan|pesen|beli|pemesanan|ordernya|pesannya)|(?:gimana|bagaimana|gmn)\s+(?:cara\s+)?(?:order|pesan|pesen|beli)\w*)\b/i],
  ['harga_umum', /\b(price\s*list|pricelist|daftar\s+harga|harga\w*\s+(?:jas|setelan|stelan|beskap|blazer|celana|vest|rompi|kemeja)\w*|(?:jas|setelan|stelan|beskap|blazer)\w*\s+(?:harga\w*|brp|berapa)|harga(?:nya)?\s+(?:mulai|dari)\s+(?:berapa|brp))\b/i],
]

/** Kata yang menandakan pesan ini lebih dari pertanyaan umum (perlu AI): produk/warna/size/pesanan tertentu. */
const SPECIFIC =
  /\b(xs|s|m|l|xl|xxl|[2-5]xl|size\s*\w+|ukuran\s+\w+|no\.?\s*\d{2}|warna|hitam|putih|navy|abu|grey|gray|maroon|cream|krem|coklat|brown|army|olive|sage|emerald|blue|biru|merah|hijau|ini|itu|yang\s+(?:ini|itu|tadi|kemarin)|kemarin|pesanan|orderan|order\s+saya|sudah|udah|dikirim|resi|custom|kustom|costum|grosir|seragam|diskon|nego|kurang|murah|anak|cewek|wanita|perempuan|sewa|bahan\s+(?:dari|sendiri)|ongkir|kirim\s+ke|tinggi|berat|tb|bb|kg|cm)\b/i
const OTHER_QUESTION = /\b(apa|apakah|bisa|bs|ada|ready|redy|stok|stock|kapan|siapa|kenapa|mengapa|gimana|bagaimana|berapa|brp)\b/gi
const FILLER =
  /\b(ya+|yah|ka+|kak|kakak|min|admin|bos+|bosku+|gan|mas|mbak|sis|bang|om|pak|bu|dong|deh|sih|nih|kah|ok|oke|mau|tanya|nanya|boleh|izin|ijin|misi|permisi|maaf|tolong|info|infonya|untuk|utk|buat|di|ke|yg|yang|dan|sama|aja|saja|nya|itu|toko|tokonya)\b/gi

/** Satu maksud umum yang jelas, atau null (biar AI yang menjawab). */
export function fastIntent(text: string): FastIntent | null {
  const value = String(text || '').trim()
  if (!value || value.length > 140 || /https?:\/\//i.test(value) || /\d{5,}/.test(value)) return null
  const lines = value.split(/\n+/).filter((line) => line.trim())
  if (lines.length > 3) return null
  const found = INTENTS.filter(([, pattern]) => pattern.test(value)).map(([intent]) => intent)
  // Satu maksud saja ("lokasi" + "jam buka" boleh bersama: jawabannya satu kalimat).
  const distinct = [...new Set(found)].filter((intent) => !(intent === 'jam_buka' && found.includes('lokasi')))
  if (distinct.length !== 1) return null
  const intent = distinct[0]
  // harga_umum & lama_pengerjaan rawan konteks (produk tertentu, pesanan lama) → hanya bila tanpa kata spesifik.
  if (intent !== 'rekening' && intent !== 'lokasi' && intent !== 'jam_buka' && (SPECIFIC.test(value) || /\b(ready|redy|po|pre\s*order|stok|stock)\b/i.test(value))) return null
  if (intent === 'lama_pengerjaan' && /\b(sampai|sampe|nyampe|tiba|kirim|pengiriman|ekspedisi|jne)\b/i.test(value)) return null
  if (intent === 'lokasi' && /\b(alamat\s+(?:saya|aku|rumah|kirim|pengiriman)|kirim\s+ke)\b/i.test(value)) return null
  // Sisa kata sesudah frasa maksud, sapaan & kata pengisi: banyak sisa = ada maksud lain → AI.
  const rest = value
    .replace(INTENTS.find(([name]) => name === intent)![1], ' ')
    .replace(SALAM, ' ')
    .replace(TIME, ' ')
    .replace(FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2)
  const questions = (value.match(OTHER_QUESTION) || []).length
  if (rest.length > 3 || questions > 2) return null
  return intent
}

const money = (value: number) => value.toLocaleString('id-ID')
const minPrice = (rows: LeanCatalogRow[], test: (row: LeanCatalogRow) => boolean) => {
  const prices = rows.filter((row) => row.active !== false && test(row) && Number(row.price) > 0).map((row) => Number(row.price))
  return prices.length ? Math.min(...prices) : 0
}

/** Alamat & jam dari profil toko. */
export function storeParts(store: string) {
  const text = String(store || '')
  const address = (text.match(/—\s*([^\n]+?)\.?\s*(?:\n|$)/)?.[1] || '').replace(/^CHAMELEON CLOTH\s+/i, '').replace(/,\s*Central Java/i, ', Jawa Tengah').trim()
  const hours = (text.match(/buka\s+(.+?)\s+WIB/i)?.[1] || '').replace(/:/g, '.').trim()
  return { address, hours }
}

/** Kalimat salam pembuka bila pelanggan menyapa ("Waalaikumsalam bos, …"). */
function opener(text: string, address: string) {
  if (SALAM.test(text)) return `Waalaikumsalam ${address}, `
  const time = text.match(TIME)?.[2]
  return time ? `${time[0].toUpperCase()}${time.slice(1)} ${address}, ` : ''
}

/**
 * Jawaban jalur kilat dari data toko; null bila datanya tidak ada (biar AI).
 * Bukan satu template: tiap maksud punya beberapa cara bicara CS (dari gaya chat nyata), dipilih acak-tetap per
 * pesan dan tidak mengulang kalimat toko sebelumnya — seperti CS manusia yang tidak menjawab persis sama.
 */
export function fastAnswer(intent: FastIntent, text: string, facts: FastFacts): string[] | null {
  const a = facts.address || 'bos'
  const start = opener(text, a)
  const first = (sentence: string) => (start ? `${start}${sentence[0].toLowerCase()}${sentence.slice(1)}` : sentence)
  const { address, hours } = storeParts(facts.store)
  const pick = (options: string[][]) => {
    const avoid = (facts.avoid || []).map(squash)
    const base = hash(`${facts.seed || ''}|${text}`) % options.length
    for (let step = 0; step < options.length; step++) {
      const choice = options[(base + step) % options.length]
      if (!choice.some((line) => avoid.includes(squash(line)))) return [first(choice[0]), ...choice.slice(1)]
    }
    return [first(options[base][0]), ...options[base].slice(1)]
  }
  switch (intent) {
    case 'marketplace':
      return pick([
        [`Maaf ${a}, gak ada di marketplace ya. Order bisa langsung di chat ini atau lewat web chameleoncloth.com`],
        [`Belum ada di marketplace ${a}, ordernya lewat chat ini aja atau website chameleoncloth.com ya`],
        [`Kami gak jualan di marketplace ${a}, langsung order di sini atau di chameleoncloth.com bisa`],
      ])
    case 'rekening':
      return facts.payment ? [first(facts.payment)] : null
    case 'lokasi':
      if (!address) return null
      return pick(
        hours
          ? [
              [`Lokasi kami di ${address} ${a}`, `Toko buka ${hours} WIB ya`],
              [`Tokonya di ${address} ${a}`, `Buka ${hours} WIB, kalau order lewat chat bisa 24 jam`],
              [`Alamatnya ${address} ya ${a}`, `Jam buka ${hours} WIB`],
            ]
          : [[`Lokasi kami di ${address} ${a}`], [`Tokonya di ${address} ${a}`]]
      )
    case 'jam_buka':
      return hours
        ? pick([
            [`Buka ${hours} WIB ${a}, kalau order lewat chat bisa kapan aja`],
            [`Toko buka ${hours} WIB ya ${a}`],
            [`Jam bukanya ${hours} WIB ${a}, order via chat 24 jam`],
          ])
        : null
    case 'lama_pengerjaan': {
      const { preorder, custom } = facts.ranges
      if (!preorder && !custom) return null
      const made = preorder || custom
      const tail = custom && preorder && custom !== preorder ? `, custom ukuran sekitar ${custom}` : ''
      return pick([
        [`Kalau ready bisa langsung kirim ${a}, kalau dibuatkan dulu sekitar ${made}${tail}`],
        [`Yang ready langsung kirim ${a}, kalau pre-order sekitar ${made} setelah pembayaran${tail}`],
        [`Pengerjaannya sekitar ${made} ${a} kalau stoknya kosong${tail}, kalau ready bisa langsung dikirim`],
      ])
    }
    case 'cara_order':
      return pick([
        [`Bisa langsung order di chat ini ${a} atau lewat website chameleoncloth.com`, 'Tinggal pilih model sama warnanya, nanti saya bantu cek size dari tinggi & berat badan'],
        [`Order di sini aja ${a}, pilih model & warna dulu`, 'Habis itu kirim tinggi dan berat badan buat size, lalu isi data pengirimannya'],
        [`Gampang ${a}, pilih model & warna, kirim tinggi berat badan, terus isi alamat pengiriman`, 'Bisa juga lewat website chameleoncloth.com'],
      ])
    case 'harga_umum': {
      const lower = text.toLowerCase()
      const suits = (row: LeanCatalogRow) => /suit|jas/i.test(row.category) && !/^setelan/i.test(row.product)
      const sets = (row: LeanCatalogRow) => /setelan/i.test(row.category) || /^setelan/i.test(row.product)
      const single = (pattern: RegExp, name: string, ask: string[]) => {
        const price = minPrice(facts.rows, (row) => pattern.test(`${row.category} ${row.product}`))
        if (!price) return null
        return pick([
          [`Harga ${name} mulai ${money(price)} ${a}`, ask[0]],
          [`${name[0].toUpperCase()}${name.slice(1)} mulai ${money(price)} ${a}`, ask[1]],
          [`Mulai ${money(price)} ${a} untuk ${name}nya`, ask[0]],
        ])
      }
      if (/\b(celana|pants)\b/.test(lower)) return single(/pants|celana/i, 'celana', ['Biasa pakai nomor berapa?', 'Nomor celananya berapa?'])
      if (/\b(vest|rompi)\b/.test(lower)) return single(/vest|rompi/i, 'vest', ['Mau warna apa?', 'Warnanya mau apa?'])
      if (/\bkemeja\b/.test(lower)) return single(/shirt|kemeja/i, 'kemeja', ['Biasa pakai size apa?', 'Size-nya biasa apa?'])
      const beskap = /\b(beskap|bescap)\b/.test(lower)
      const jas = minPrice(facts.rows, (row) => suits(row) && (!beskap || /beskap|bescap/i.test(row.product)))
      const set = minPrice(facts.rows, (row) => sets(row) && (!beskap || /beskap|bescap/i.test(row.product)))
      if (!jas && !set) return null
      const item = beskap ? 'beskap' : 'jas'
      if (!jas || !set) return pick([[`Harga ${item} mulai ${money(jas || set)} ${a}`, 'Mau model apa?']])
      return pick([
        [`Harga ${item} mulai ${money(jas)} ${a}, setelan ${item} + celana mulai ${money(set)}`, 'Mau model apa?'],
        [`${item[0].toUpperCase()}${item.slice(1)} mulai ${money(jas)} ${a}, kalau setelan sama celana mulai ${money(set)}`, 'Mau yang model apa?'],
        [`Mulai ${money(jas)} ${a} untuk ${item}nya, setelan lengkap sama celana mulai ${money(set)}`, 'Lagi cari model apa?'],
      ])
    }
  }
  return null
}

const squash = (text: string) => String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
function hash(text: string) {
  let value = 2166136261
  for (const char of text) {
    value ^= char.charCodeAt(0)
    value = Math.imul(value, 16777619)
  }
  return value >>> 0
}

/** Pesan pelanggan ini menjawab/merujuk sesuatu yang baru dikirim (foto, kutipan) → jangan jalur kilat. */
export function needsContext(rows: LeanHistoryRow[]) {
  const current = rows.filter((row) => row.current)
  if (current.some((row) => row.replyTo || row.mediaType)) return true
  const previous = rows.filter((row) => !row.current).slice(-3)
  return previous.some((row) => row.direction === 'in' && row.mediaType === 'image')
}
