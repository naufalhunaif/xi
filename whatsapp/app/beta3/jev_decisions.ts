// Beta 3.5 — pertanyaan Jev untuk alur Beta 3. Setiap fungsi mengembalikan undefined bila
// Jev tidak dipakai (mati, gagal, atau ragu) supaya pemanggil memakai cara lama.
import {
  askJev,
  confident,
  jevOn,
  logDecision,
  maskPii,
  type JevAnswer,
  type JevQuestion,
} from '#beta3/jev'

type Line = { direction: string; body?: string | null; mediaType?: string | null }

/** Percakapan terakhir sebagai baris "Pelanggan: …" / "Toko: …", disamarkan. */
export function conversationLines(rows: Line[], limit = 10) {
  return rows
    .slice(-limit)
    .map((row) => {
      const text = String(row.body || '').trim() || (row.mediaType ? `[${row.mediaType}]` : '')
      return text
        ? `${row.direction === 'in' ? 'Pelanggan' : 'Toko'}: ${maskPii(text).slice(0, 500)}`
        : ''
    })
    .filter(Boolean)
}

const choiceOf = (answer: JevAnswer | undefined) =>
  answer && answer.type === 'choice' ? answer.choice : ''
const yes = (answer: JevAnswer | undefined) =>
  Boolean(answer && answer.type === 'noul' && answer.noul >= 0.5)

export type TurnUnderstanding = {
  /** Maksud utama pesan (sapaan, produk, harga, …) bila yakin. */
  intent?: string
  /** Data pengiriman ada di pesan terbaru (true/false) bila yakin. */
  hasShippingData?: boolean
  /** Alasan perlu manusia bila yakin (tidak_perlu = tidak). */
  csReason?: string
  /** Pelanggan menyetujui total/tawaran terakhir bila yakin. */
  agreed?: boolean
  /** Layanan ongkir yang dipilih (alias huruf kecil), null = belum memilih, undefined = tidak tahu. */
  service?: string | null
}

/**
 * Satu panggilan Jev sebelum balasan ditulis: maksud pesan, data pengiriman, perlu CS,
 * setuju total, dan layanan ongkir (bila ada lebih dari satu).
 */
export async function understandTurn(input: {
  jid: string
  text: string
  history: Line[]
  services: string[]
  offerPending: boolean
}): Promise<TurnUnderstanding> {
  const on = {
    maksud: await jevOn('maksud'),
    form: await jevOn('form'),
    serah_cs: await jevOn('serah_cs'),
    setuju: input.offerPending && (await jevOn('setuju')),
    layanan: input.services.length > 1 && (await jevOn('layanan')),
  }
  const questions: Record<string, JevQuestion> = {}
  if (on.maksud)
    questions.maksud = {
      type: 'choice',
      instructions: 'Apa maksud utama pesan_terbaru pelanggan toko pakaian ini?',
      criteria: {
        sapaan: 'Hanya salam, terima kasih, oke, atau basa-basi tanpa pertanyaan',
        produk: 'Tanya model, warna, stok, foto, atau bahan',
        harga: 'Tanya harga, diskon, atau total',
        ukuran: 'Soal size, ukuran badan, tinggi/berat, atau ukuran custom',
        ongkir: 'Tanya ongkir, ekspedisi, atau lama pengiriman',
        data_pengiriman: 'Mengirim nama, alamat, atau form order',
        bayar: 'Soal pembayaran, DP, rekening, atau bukti transfer',
        status_pesanan: 'Tanya progres pesanan, kapan jadi/dikirim, atau resi',
        komplain: 'Keluhan atau masalah dengan pesanan',
        lain: 'Selain semua di atas',
      },
    }
  if (on.form)
    questions.form = {
      type: 'noul',
      instructions:
        'Apakah pesan_terbaru berisi data pengiriman pesanan (nama penerima, alamat, kecamatan/kota, atau nomor HP)?',
    }
  if (on.serah_cs)
    questions.serah_cs = {
      type: 'choice',
      instructions: 'Apakah pesan_terbaru perlu ditangani manusia, dan kenapa?',
      criteria: {
        komplain: 'Pelanggan mengeluh atau ada masalah dengan pesanan yang sudah dibayar',
        ganti_alamat: 'Pelanggan minta ganti alamat setelah membayar',
        ekspedisi_lain: 'Pelanggan minta dikirim dengan ekspedisi selain JNE',
        nego: 'Pelanggan menawar harga atau minta diskon khusus',
        tidak_perlu:
          'Tidak perlu dialihkan ke manusia (termasuk minta custom ukuran/detail model, tanya harga, foto, size, atau stok)',
      },
    }
  if (on.setuju)
    questions.setuju = {
      type: 'choice',
      instructions:
        'Bagaimana tanggapan pelanggan terhadap total atau tawaran terakhir dari toko di percakapan?',
      criteria: {
        setuju: 'Menyetujui atau mengiyakan total/tawaran terakhir',
        menolak: 'Menolak atau membatalkan',
        bertanya: 'Masih bertanya atau ragu',
        lain: 'Tidak menanggapi total/tawaran',
      },
    }
  if (on.layanan) {
    const criteria: Record<string, string> = {}
    for (const name of input.services)
      criteria[name.toLowerCase()] = `Pelanggan memilih layanan ${name.toUpperCase()}`
    criteria.belum = 'Pelanggan belum memilih layanan pengiriman'
    questions.layanan = {
      type: 'choice',
      instructions:
        'Layanan pengiriman mana yang dipilih pelanggan sendiri (bukan disarankan toko)?',
      criteria,
    }
  }
  if (!Object.keys(questions).length) return {}
  const answers = await askJev(
    'pahami',
    {
      pesan_terbaru: maskPii(input.text).slice(0, 2000),
      percakapan: conversationLines(input.history),
      layanan_tersedia: input.services,
    },
    questions
  )
  if (!answers) return {}
  const result: TurnUnderstanding = {}
  const take = async (
    key: 'maksud' | 'form' | 'serah_cs' | 'setuju' | 'layanan',
    apply: () => void
  ) => {
    const answer = answers[key]
    if (!answer) return
    const sure = confident(key, answer)
    if (sure) apply()
    await logDecision({ jid: input.jid, decision: key, answer, used: sure })
  }
  await take('maksud', () => (result.intent = choiceOf(answers.maksud)))
  await take('form', () => (result.hasShippingData = yes(answers.form)))
  await take('serah_cs', () => (result.csReason = choiceOf(answers.serah_cs)))
  await take('setuju', () => (result.agreed = choiceOf(answers.setuju) === 'setuju'))
  await take('layanan', () => {
    const chosen = choiceOf(answers.layanan)
    result.service = chosen === 'belum' ? null : chosen
  })
  return result
}

/** Balasan AI menjanjikan total/rekening akan dikirim sekarang? undefined = tidak tahu. */
export async function promisesTotal(jid: string, bubbles: string[]) {
  if (!bubbles.length || !(await jevOn('janji_total'))) return undefined
  const answers = await askJev(
    'periksa',
    { balasan_toko: bubbles.map((bubble) => maskPii(bubble)).join('\n') },
    {
      janji_total: {
        type: 'noul',
        instructions:
          'Apakah balasan_toko berjanji akan mengirim total pembayaran atau nomor rekening (mis. "ini totalnya saya kirimkan", "totalnya menyusul")?',
      },
    }
  )
  const answer = answers?.janji_total
  if (!answer) return undefined
  const sure = confident('janji_total', answer)
  await logDecision({
    jid,
    decision: 'janji_total',
    answer,
    used: sure,
    detail: bubbles.join(' | '),
  })
  return sure ? yes(answer) : undefined
}

/** Pesan toko berisi total yang harus dibayar atau rekening tujuan? undefined = tidak tahu. */
export async function storeSentTotal(jid: string, bodies: string[]) {
  const recent = bodies.filter((body) => body.trim()).slice(-4)
  if (!recent.length || !(await jevOn('total_toko'))) return undefined
  const questions: Record<string, JevQuestion> = {}
  recent.forEach((_, index) => {
    questions[`pesan_${index}`] = {
      type: 'noul',
      instructions: `Apakah pesan_toko[${index}] menyebut total yang harus dibayar pelanggan atau rekening tujuan transfer?`,
    }
  })
  const answers = await askJev(
    'total-toko',
    { pesan_toko: recent.map((body) => maskPii(body)) },
    questions
  )
  if (!answers) return undefined
  const all = Object.values(answers) as JevAnswer[]
  if (!all.length || !all.every((answer) => confident('total_toko', answer))) return undefined
  const sent = all.some((answer) => yes(answer))
  await logDecision({
    jid,
    decision: 'total_toko',
    answer: all.find((answer) => yes(answer)) || all[0],
    used: true,
    detail: recent.join(' | '),
  })
  return sent
}

/** Semua pertanyaan pelanggan sudah dijawab CS? undefined = tidak tahu. */
export async function answeredByStore(jid: string, customer: string[], store: string[]) {
  if (!customer.length || !store.length || !(await jevOn('terjawab'))) return undefined
  const answers = await askJev(
    'terjawab',
    {
      pesan_pelanggan: customer.map((text) => maskPii(text)),
      balasan_toko: store.map((text) => maskPii(text)),
    },
    {
      terjawab: {
        type: 'score',
        instructions:
          'Seberapa lengkap balasan_toko menjawab semua pertanyaan dan permintaan di pesan_pelanggan?',
        criteria: [
          'Belum ada yang dijawab',
          'Sebagian dijawab, masih ada pertanyaan atau permintaan yang terlewat',
          'Semua sudah dijawab atau ditanggapi',
        ],
      },
    }
  )
  const answer = answers?.terjawab
  if (!answer || answer.type !== 'score') return undefined
  const sure = confident('terjawab', answer)
  await logDecision({ jid, decision: 'terjawab', answer, used: sure })
  return sure ? Math.round(answer.score) >= 2 : undefined
}

/** Warna katalog yang dimaksud pelanggan untuk satu produk. null = bukan warna katalog (custom). */
export async function chooseVariant(jid: string, product: string, colors: string[], chat: Line[]) {
  if (colors.length < 2 || !(await jevOn('varian'))) return undefined
  const criteria: Record<string, string> = {}
  for (const color of colors) criteria[color] = `Pelanggan memilih ${product} warna ${color}`
  criteria.lain = 'Warna di luar daftar (custom) atau belum jelas'
  const answers = await askJev(
    'varian',
    {
      produk: product,
      percakapan: conversationLines(chat, 16),
      catatan:
        'Baris "Toko: <Produk> - <Warna>" dengan [image] adalah foto katalog yang dikirim toko; foto terakhir sesudah gambar pelanggan biasanya warna yang dicocokkan toko.',
    },
    {
      varian: {
        type: 'choice',
        instructions: `Warna ${product} mana yang dipesan pelanggan?`,
        criteria,
      },
    }
  )
  const answer = answers?.varian
  if (!answer || answer.type !== 'choice') return undefined
  const sure = confident('varian', answer)
  await logDecision({ jid, decision: 'varian', answer, used: sure, detail: product })
  if (!sure) return undefined
  return answer.choice === 'lain' ? null : answer.choice
}

/** Komentar Instagram perlu dijawab? undefined = tidak tahu. */
export async function commentNeedsReply(jid: string, comment: string, caption: string) {
  if (!comment.trim() || !(await jevOn('komentar_ig'))) return undefined
  const answers = await askJev(
    'komentar',
    {
      komentar: maskPii(comment).slice(0, 1000),
      caption_postingan: maskPii(caption).slice(0, 600),
    },
    {
      komentar_ig: {
        type: 'choice',
        instructions: 'Komentar Instagram di postingan toko pakaian ini termasuk jenis apa?',
        criteria: {
          calon_pembeli: 'Tertarik membeli: tanya harga, size, cara order, atau minta info',
          pertanyaan: 'Pertanyaan lain yang perlu dijawab toko',
          pujian: 'Pujian, emoji, atau komentar tanpa pertanyaan',
          spam: 'Spam, promosi akun lain, atau tidak relevan',
        },
      },
    }
  )
  const answer = answers?.komentar_ig
  if (!answer || answer.type !== 'choice') return undefined
  const sure = confident('komentar_ig', answer)
  await logDecision({
    jid,
    decision: 'komentar_ig',
    answer,
    used: sure,
    detail: comment.slice(0, 300),
  })
  if (!sure) return undefined
  return ['calon_pembeli', 'pertanyaan'].includes(answer.choice)
}
