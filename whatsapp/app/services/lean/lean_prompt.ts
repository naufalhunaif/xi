import { promptBreakdown } from '#services/prompt_size_service'
import type { LeanExample } from '#services/lean/lean_examples_service'
import { renderExamples } from '#services/lean/lean_examples_service'

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
        'Lembar spesifikasi pesanan, ditulis ulang LENGKAP tiap giliran (bukan hanya perubahan): satu blok per item — produk, warna, size atau ukuran badan, jas saja/setelan, lalu setiap detail custom yang pelanggan sebut (kerah, saku, list/kombinasi, kancing, bahan, warna bagian) apa adanya. Kosong bila pelanggan belum memilih apa pun.',
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

export type LeanDecision = {
  order?: LeanOrderDraft
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
      row.direction === 'in' ? 'Pelanggan' : row.senderType === 'cs' ? 'CS (manusia)' : 'AI'
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
      `SEKARANG: ${stamp(input.now || new Date())} WIB${input.imageCount ? `\nPelanggan melampirkan ${input.imageCount} gambar (lihat lampiran).` : ''}\nPESAN PELANGGAN SEKARANG:\n${input.message || '(hanya media, tanpa teks)'}`,
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
}) {
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
    lines.push(`${label[kind] || kind}: ${range} ${unit} sampai siap kirim, dihitung ${start}`)
  }
  if (!lines.length)
    return 'ESTIMASI PRODUKSI: belum diatur pemilik. Kalau ditanya lama pengerjaan: "nanti saya konfirmasi ke bagian produksi ya bos", jangan menyebut angka.'
  return `ESTIMASI PRODUKSI (dari pengaturan pemilik; sebut sebagai perkiraan, bukan janji tanggal):\n${lines.join('\n')}`
}
