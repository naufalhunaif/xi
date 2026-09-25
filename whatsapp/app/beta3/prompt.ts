// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import { promptBreakdown } from '#services/prompt_size_service'
import type { LeanExample } from '#beta3/examples_service'
import { renderExamples } from '#beta3/examples_service'

/**
 * Prompt jalur ramping. Satu skill inti sebagai instruksi sistem (prefix yang
 * bisa di-cache), lalu bahan giliran ini: katalog, contoh, pelanggan, catatan,
 * riwayat, pesan. Tanpa tool, tanpa schema besar.
 */
export const LEAN_STAGES = [
  'tanya_model',
  'tanya_size',
  'tawar_celana',
  'minta_alamat',
  'kirim_form',
  'tunggu_form',
  'tunggu_cs',
  'tunggu_bayar',
  'bukti_dikirim',
  'selesai',
  'lain',
] as const
export type LeanStage = (typeof LEAN_STAGES)[number]

export const LEAN_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pesan: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Bubble WhatsApp yang dikirim ke pelanggan, urut. Biasanya 1, maksimal 2. Kosong = tidak membalas.',
    },
    foto: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Nama varian katalog yang fotonya dikirim setelah pesan, persis seperti di KATALOG (misal "Tuxedo - Black"). Hanya bila pelanggan minta lihat atau baru memilih model. Maksimal 3.',
    },
    catatan: {
      type: 'string',
      description:
        'Catatan chat untuk giliran berikutnya, maksimal 6 baris: produk, size (TB/BB), jas saja/setelan, alamat, tahap, menunggu apa.',
    },
    tahap: { type: 'string', enum: [...LEAN_STAGES] },
    serah_cs: {
      type: 'boolean',
      description:
        'true hanya bila kebutuhan pelanggan di luar wewenang (komplain, diskon, grosir, hal yang skill sebut tanya CS). Saat true, pesan boleh kosong.',
    },
    alasan: { type: 'string', description: 'Satu kalimat alasan keputusan untuk audit CS.' },
    spesifikasi: {
      type: 'string',
      description:
        'Catatan untuk penjahit, ditulis ulang LENGKAP tiap giliran, baris pendek tanpa harga/label/nomor: per item "Produk - Warna", "Jas, Celana" (yang dibuat), "Size M/31", "Tinggi 164/68" bila ada, lalu tiap detail custom satu baris dengan kata sehari-hari. Item dipisah baris kosong. Kosong bila pelanggan belum memilih apa pun.',
    },
    referensi: {
      type: 'array',
      description:
        'Opsional. Isi bila pelanggan mengirim gambar di giliran ini sebagai contoh bagian yang diinginkan. Gambar diteruskan ke penjahit dengan caption "Model {bagian} seperti ini".',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          gambar: { type: 'integer', description: 'Nomor lampiran gambar giliran ini (1 = gambar pertama).' },
          bagian: { type: 'string', description: 'Satu-dua kata sehari-hari: kerah, badan, saku, kancing, lengan, celana, warna.' },
        },
        required: ['gambar', 'bagian'],
      },
    },
    pembayaran: {
      type: 'object',
      additionalProperties: false,
      description:
        'Isi dari maksud chat (termasuk pesan CS manusia): total yang SUDAH dikirim toko ke pelanggan, dan pembayaran yang SUDAH dikonfirmasi toko. 0/false bila belum ada. Jangan mengarang angka.',
      properties: {
        total: { type: 'integer', description: 'Total yang sudah dikirim toko (rupiah), 0 bila belum.' },
        ongkir: { type: 'integer', description: 'Ongkir di total itu, 0 bila tidak jelas.' },
        layanan: { type: 'string', description: 'Layanan kirim di total itu (REG/YES/JTR), kosong bila tidak jelas.' },
        dibayar: { type: 'integer', description: 'Nominal yang sudah ditransfer pelanggan (DP atau lunas), 0 bila belum/tidak jelas.' },
        dikonfirmasi: { type: 'boolean', description: 'true hanya bila toko sudah menyatakan dana masuk (mis. "pembayaran sudah kami konfirmasi, prosess ya").' },
      },
      required: ['total', 'ongkir', 'layanan', 'dibayar', 'dikonfirmasi'],
    },
    susulan: {
      type: 'string',
      description:
        'Opsional. Satu kalimat pendek untuk memastikan kelanjutan (mis. "jadi lanjut yang choco bos?"). TIDAK dikirim sekarang; sistem mengirimnya hanya bila pelanggan diam beberapa menit. Kosongkan bila pesan utama sudah berisi pertanyaan atau tidak ada yang perlu dipastikan.',
    },
    order: {
      type: 'object',
      additionalProperties: false,
      description:
        'Isi HANYA pada giliran CATATAN SISTEM menyebut form order tercatat. Sistem memverifikasi tiap harga ke KATALOG dan layanan ke ONGKIR; bila cocok, total + rekening dikirim otomatis setelah pesanmu. Kosongkan/abaikan di giliran lain.',
      properties: {
        rincian: {
          type: 'string',
          description:
            'Satu baris per item, nama persis dari KATALOG + harga, mis. "Setelan Peak Suit - Black size S, celana no 30 705.000". Setelan memakai produk "Setelan …" dari KATALOG, bukan jas + celana dijumlah sendiri.',
        },
        subtotal: { type: 'integer', description: 'Jumlah harga semua item dalam rupiah.' },
        layanan: {
          type: 'string',
          description:
            'Nama layanan ongkir yang dipilih pelanggan persis seperti di ONGKIR (mis. "CTCYES"); kosong bila belum dipilih.',
        },
      },
      required: ['rincian', 'subtotal', 'layanan'],
    },
  },
  required: ['pesan', 'foto', 'catatan', 'tahap', 'serah_cs', 'alasan', 'susulan', 'spesifikasi'],
} as const

export type LeanOrderDraft = { rincian: string; subtotal: number; layanan: string }

export type LeanRefDraft = { gambar: number; bagian: string }

export type LeanPaymentInfo = { total: number; ongkir: number; layanan: string; dibayar: number; dikonfirmasi: boolean }

export type LeanDecision = {
  order?: LeanOrderDraft
  pembayaran?: LeanPaymentInfo
  referensi?: LeanRefDraft[]
  pesan: string[]
  foto: string[]
  catatan: string
  tahap: LeanStage
  serah_cs: boolean
  alasan: string
  susulan: string
  spesifikasi: string
}

export type LeanHistoryRow = {
  direction: 'in' | 'out'
  senderType?: string | null
  body?: string | null
  mediaType?: string | null
  createdAt: Date | string
  current?: boolean
}

const stamp = (value: Date | string) =>
  new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value))

export function renderHistory(rows: LeanHistoryRow[]) {
  if (!rows.length) return 'RIWAYAT: chat baru, belum ada pesan sebelumnya.'
  const lines = rows.map((row) => {
    const who =
      row.direction === 'in'
        ? 'Pelanggan'
        : row.senderType === 'cs' || row.senderType === 'owner'
          ? 'CS (manusia)'
          : 'AI'
    const media = row.mediaType ? `[${row.mediaType}] ` : ''
    const body = (row.body || '')
      .trim()
      .replace(/\s*\n\s*/g, ' / ')
      .slice(0, 600)
    return `${row.current ? '>> ' : ''}[${stamp(row.createdAt)}] ${who}: ${media}${body || '(tanpa teks)'}`
  })
  return `RIWAYAT (lama → baru; baris ">>" adalah pesan yang harus dijawab sekarang):\n${lines.join('\n')}`
}

export function buildLeanPrompt(input: {
  skill: string
  catalog: string
  examples: LeanExample[]
  customerNote: string
  chatNote: string
  spec?: string
  history: LeanHistoryRow[]
  message: string
  paymentMethods: Array<{ name: string; destination: string; accountName: string }>
  production?: string
  store?: string
  fabrics?: string
  sizeCharts?: string
  now?: Date
  imageCount?: number
}) {
  const payment = input.paymentMethods.length
    ? `REKENING RESMI (satu-satunya sumber rekening; sebut hanya saat pelanggan tanya transfer kemana atau total sudah disepakati):\n${input.paymentMethods.map((method) => `${method.name} ${method.destination}${method.accountName ? ` an ${method.accountName}` : ''}`).join('\n')}`
    : 'REKENING RESMI: belum diatur. Jangan menyebut rekening; arahkan tunggu CS.'
  const sections: Array<[string, string]> = [
    [
      'toko',
      input.store ||
        'TOKO: lokasi dan jam belum diatur pemilik. Kalau ditanya lokasi/jam: "saya tanyakan dulu ke tim ya bos" dan serah_cs = true.',
    ],
    ['katalog', input.catalog],
    ['sizechart', input.sizeCharts || ''],
    ['bahan', input.fabrics || ''],
    ['contoh', renderExamples(input.examples)],
    [
      'pelanggan',
      input.customerNote
        ? `PELANGGAN INI (dari order sebelumnya; pakai bila pelanggan menyebut "yang dulu/kemarin"):\n${input.customerNote}`
        : 'PELANGGAN INI: belum pernah order tercatat.',
    ],
    [
      'catatan',
      input.chatNote
        ? `CATATAN CHAT (giliran sebelumnya):\n${input.chatNote}`
        : 'CATATAN CHAT: belum ada.',
    ],
    [
      'spesifikasi',
      input.spec
        ? `SPESIFIKASI PESANAN SAAT INI (tulis ulang lengkap di field spesifikasi, tambahkan detail baru, jangan hilangkan yang lama kecuali pelanggan mengubahnya):\n${input.spec}`
        : 'SPESIFIKASI PESANAN: belum ada. Begitu pelanggan memilih produk/warna/size/detail, mulai isi field spesifikasi.',
    ],
    ['riwayat', renderHistory(input.history)],
    ['rekening', payment],
    ['produksi', input.production || ''],
    [
      'sekarang',
      `SEKARANG: ${stamp(input.now || new Date())} WIB${input.imageCount ? `\nPelanggan melampirkan ${input.imageCount} gambar (lihat lampiran; nomor 1–${input.imageCount} sesuai urutan, untuk field referensi).` : ''}\nPESAN PELANGGAN SEKARANG:\n${input.message || '(hanya media, tanpa teks)'}`,
    ],
    [
      'keluaran',
      'Balas sebagai JSON sesuai schema: pesan (array bubble), foto (nama varian katalog), catatan, tahap, serah_cs, alasan, susulan, spesifikasi. Jangan menulis apa pun di luar JSON.',
    ],
  ]
  const user = sections.map(([, value]) => value).join('\n\n')
  return {
    system: input.skill.trim(),
    user,
    size: promptBreakdown([['skill', input.skill], ...sections]),
  }
}

export function parseLeanDecision(text: string): LeanDecision {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('Keluaran AI bukan JSON.')
  const raw = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  const pesan = (
    Array.isArray(raw.pesan) ? raw.pesan : typeof raw.pesan === 'string' ? [raw.pesan] : []
  )
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 2)
  const foto = (Array.isArray(raw.foto) ? raw.foto : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 3)
  const tahap = LEAN_STAGES.includes(raw.tahap as LeanStage) ? (raw.tahap as LeanStage) : 'lain'
  return {
    pesan,
    foto,
    catatan: String(raw.catatan || '')
      .trim()
      .slice(0, 1500),
    tahap,
    serah_cs: raw.serah_cs === true,
    alasan: String(raw.alasan || '')
      .trim()
      .slice(0, 500),
    susulan: String(raw.susulan || '')
      .trim()
      .slice(0, 300),
    spesifikasi: String(raw.spesifikasi || '')
      .trim()
      .slice(0, 3000),
    ...(raw.pembayaran && typeof raw.pembayaran === 'object'
      ? {
          pembayaran: {
            total: Math.max(0, Math.round(Number((raw.pembayaran as Record<string, unknown>).total) || 0)),
            ongkir: Math.max(0, Math.round(Number((raw.pembayaran as Record<string, unknown>).ongkir) || 0)),
            layanan: String((raw.pembayaran as Record<string, unknown>).layanan || '').trim().slice(0, 40),
            dibayar: Math.max(0, Math.round(Number((raw.pembayaran as Record<string, unknown>).dibayar) || 0)),
            dikonfirmasi: (raw.pembayaran as Record<string, unknown>).dikonfirmasi === true,
          },
        }
      : {}),
    referensi: (Array.isArray(raw.referensi) ? raw.referensi : [])
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        gambar: Math.round(Number(item.gambar) || 0),
        bagian: String(item.bagian || '').trim().slice(0, 40),
      }))
      .filter((item) => item.gambar > 0 && item.bagian)
      .slice(0, 6),
    ...(raw.order && typeof raw.order === 'object'
      ? {
          order: {
            rincian: String((raw.order as Record<string, unknown>).rincian || '')
              .trim()
              .slice(0, 2000),
            subtotal: Math.round(Number((raw.order as Record<string, unknown>).subtotal) || 0),
            layanan: String((raw.order as Record<string, unknown>).layanan || '')
              .trim()
              .slice(0, 40),
          },
        }
      : {}),
  }
}

const DAY_INDEX: Record<string, number> = { min: 0, sen: 1, sel: 2, rab: 3, kam: 4, jum: 5, sab: 6 }

/**
 * Hari tutup dari teks TOKO (MCP): "Sen-Sab 09:00-17:00, Min tutup" → [0].
 * Tanpa data jam buka → Sabtu & Minggu dianggap libur.
 */
export function closedDaysFromStore(text: string) {
  const hours = text.match(/buka (.+?) WIB/i)?.[1] || ''
  if (!hours) return [0, 6]
  const closed: number[] = []
  for (const part of hours.split(/,\s*/)) {
    const m = part.trim().match(/^(Sen|Sel|Rab|Kam|Jum|Sab|Min)(?:-(Sen|Sel|Rab|Kam|Jum|Sab|Min))?\s+tutup$/i)
    if (!m) continue
    const from = DAY_INDEX[m[1].toLowerCase()]
    const to = DAY_INDEX[(m[2] || m[1]).toLowerCase()]
    // Urutan Sen..Min (Min = 7) supaya rentang "Sab-Min" terbaca.
    for (let d = from || 7; d <= (to || 7); d++) closed.push(d % 7)
  }
  return closed
}

/** Tanggal (WIB) setelah `days` hari; hari kerja melewati `closedDays` (0 = Minggu). */
export function addProductionDays(now: Date, days: number, working: boolean, closedDays: number[] = [0, 6]) {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(now)
    .split('-')
    .map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  let left = days
  while (left > 0) {
    date.setUTCDate(date.getUTCDate() + 1)
    const day = date.getUTCDay()
    if (working && closedDays.includes(day) && closedDays.length < 7) continue
    left--
  }
  return date
}

const shortDate = (date: Date) =>
  new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date)

/** Estimasi produksi dari Pengaturan → Produksi, ditulis satu kalimat untuk AI. */
export function renderProductionEstimate(policy: {
  rules: Record<
    string,
    {
      enabled: boolean
      minDays: number | null
      maxDays: number | null
      estimateDays: number | null
      dayType: string
      startsAfter: string
    }
  >
}, now: Date = new Date(), store = '') {
  const closedDays = closedDaysFromStore(store)
  const holiday = /^LIBUR:/m.test(store)
  const label: Record<string, string> = {
    preorder: 'pre-order (stok kosong, dibuatkan)',
    custom: 'custom (ukuran/model/detail khusus)',
  }
  const lines: string[] = []
  for (const [kind, rule] of Object.entries(policy.rules || {})) {
    if (!rule?.enabled) continue
    const range =
      rule.minDays && rule.maxDays && rule.minDays !== rule.maxDays
        ? `${rule.minDays}-${rule.maxDays}`
        : String(rule.estimateDays ?? rule.maxDays ?? rule.minDays ?? '')
    if (!range) continue
    const unit = rule.dayType === 'working' ? 'hari kerja' : 'hari'
    const start =
      rule.startsAfter === 'full_payment_details'
        ? 'setelah pelunasan & detail lengkap'
        : rule.startsAfter === 'approval'
          ? 'setelah persetujuan produksi'
          : 'setelah pembayaran/DP & detail lengkap'
    const working = rule.dayType === 'working'
    const lo = rule.minDays ?? rule.estimateDays ?? rule.maxDays
    const hi = rule.maxDays ?? rule.estimateDays ?? rule.minDays
    const from = lo ? shortDate(addProductionDays(now, lo, working, closedDays)) : ''
    const to = hi ? shortDate(addProductionDays(now, hi, working, closedDays)) : ''
    const when = from && to && from !== to ? `${from}–${to}` : to || from
    lines.push(
      `${label[kind] || kind}: ${range} ${unit} sampai siap kirim, dihitung ${start}` +
        (when ? ` → kalau dibayar hari ini, siap kirim sekitar ${when}` : '')
    )
  }
  if (!lines.length)
    return 'ESTIMASI PRODUKSI: belum diatur pemilik. Kalau ditanya lama pengerjaan: "nanti saya konfirmasi ke bagian produksi ya bos", jangan menyebut angka.'
  if (holiday) lines.push('Toko sedang LIBUR (lihat TOKO): tanggal siap kirim bisa mundur — permintaan tanggal kirim ditanyakan ke tim.')
  return `ESTIMASI PRODUKSI (dari pengaturan pemilik; sebut sebagai perkiraan, bukan janji tanggal):\n${lines.join('\n')}`
}
