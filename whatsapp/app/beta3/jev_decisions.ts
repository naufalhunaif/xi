// Beta 3.5 — pertanyaan Jev untuk alur Beta 3. Setiap fungsi mengembalikan undefined bila
// Jev tidak dipakai (mati, gagal, atau ragu) supaya pemanggil memakai cara lama.
import {
  askJev,
  confident,
  jevOn,
  logDecision,
  maskPii,
  scoreLevel,
  type JevAnswer,
  type JevQuestion,
} from '#beta3/jev'

type Line = { direction: string; body?: string | null; mediaType?: string | null }

/** Percakapan terakhir sebagai baris "Pelanggan: …" / "Toko: …", disamarkan. */
export function conversationLines(rows: Line[], limit = 10, chars = 500) {
  return rows
    .slice(-limit)
    .map((row) => {
      const text = String(row.body || '').trim() || (row.mediaType ? `[${row.mediaType}]` : '')
      return text
        ? `${row.direction === 'in' ? 'Pelanggan' : 'Toko'}: ${maskPii(text).slice(0, chars)}`
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
  /** Pesan singkat ("oke", "siap"): terima = cukup tanda terima (tidak perlu dibalas). */
  reaction?: 'terima' | 'setuju' | 'jawab' | 'tanya' | 'lain'
  /** Topik yang dibahas pesan ini (untuk memilih bagian prompt). */
  topics?: Partial<Record<TurnTopic, boolean>>
  /** 1 = sederhana, 2 = biasa, 3 = rumit (untuk memilih model). */
  difficulty?: number
  /** Pelanggan menyatakan sudah transfer/bayar. */
  paidClaim?: boolean
  /** v3.6.83: pelanggan meminta nomor rekening / tujuan transfer. */
  asksAccount?: boolean
  /** Lanjut, menunda (nanti/pikir-pikir), atau membatalkan. */
  follow?: 'lanjut' | 'tunda' | 'batal'
  /** 1–5: seberapa penting/mendesak chat ini untuk ditangani toko. */
  urgency?: number
  /** Seri bahan yang sedang dibahas (untuk pola harga). */
  series?: 'reguler' | 'signature' | 'premium'
  /** Barang yang ditanya harganya di pesan ini. */
  item?: 'jas' | 'celana' | 'setelan' | 'rompi'
  /** v3.6.62 Hati CS: bentuk kalimat, rasa, dan momen pelanggan (hanya yang yakin). */
  heart?: Heart
}

export type Heart = { form?: string; feeling?: string; moment?: string }

/** v3.6.62 — pertanyaan Hati CS ke Jev: bentuk kalimat, rasa, momen. */
export const HEART_QUESTIONS: Record<'bentuk' | 'rasa' | 'momen', JevQuestion> = {
  bentuk: {
    type: 'choice',
    instructions: 'Bentuk pesan_terbaru pelanggan (lihat percakapan)?',
    criteria: {
      bertanya: 'Bertanya / minta kepastian, termasuk kalimat pendek berakhiran "ya/kah/kan" ("kancing 1 ..ya")',
      meminta: 'Meminta sesuatu dibuat/dicatat/dikirim (mau, pakai, tolong, minta)',
      mengeluh: 'Mengeluh atau kecewa',
      basa_basi: 'Salam, terima kasih, oke, atau basa-basi',
      lain: 'Selain itu (menjawab pertanyaan toko, mengirim data)',
    },
  },
  rasa: {
    type: 'choice',
    instructions: 'Perasaan pelanggan di pesan_terbaru (pahami apa adanya, jangan menafsir terlalu jauh)?',
    criteria: {
      netral: 'Biasa saja / tidak terlihat',
      senang: 'Senang, memuji, antusias',
      ragu: 'Ragu atau cemas (takut tidak pas, takut kebesaran/kekecilan, ragu bahan/kualitas)',
      buru_buru: 'Buru-buru / butuh cepat (acara dekat, minta segera)',
      kesal: 'Kesal, kecewa, marah, atau tidak sabar',
      keberatan_harga: 'Merasa harga mahal / budget kurang (masih bertanya)',
      pamit: 'Pamit atau mundur: nanti dulu, lihat-lihat dulu, gak jadi karena harga',
    },
  },
  momen: {
    type: 'choice',
    instructions: 'Apakah pelanggan menyebut momen penting MILIKNYA SENDIRI yang menjadi alasan membeli? Datang ke acara orang lain (tamu nikahan, kondangan, "for wedding" tanpa bilang dia yang menikah) = acara_lain.',
    criteria: {
      tidak_ada: 'Tidak menyebut momen',
      nikah: 'Pelanggan SENDIRI menikah, lamaran, tunangan (mis. "saya mau nikah", "buat nikahan saya")',
      wisuda: 'Wisuda, sidang, kelulusan pelanggan sendiri',
      kerja: 'Kerja baru, interview, pelantikan, kantor',
      acara_lain: 'Acara lain atau acara orang lain (pesta, kondangan, tamu nikahan, foto, lomba)',
    },
  },
}

export type TurnTopic = 'ongkir' | 'ukuran' | 'bayar' | 'custom' | 'warna'
const TOPICS: Record<TurnTopic, string> = {
  ongkir: 'ongkir, alamat/tujuan pengiriman, ekspedisi, atau kapan sampai',
  ukuran: 'size, ukuran badan, tinggi/berat, atau nomor celana',
  bayar: 'pembayaran, DP, rekening, bukti transfer, atau status pesanan yang sudah dibayar',
  custom: 'permintaan custom (ukuran sendiri, kerah, saku, kancing, detail model)',
  warna: 'warna, bahan/kain, atau foto produk',
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
  /** Ada order menunggu pembayaran (pertanyaan "sudah transfer?" relevan). */
  awaitingPayment?: boolean
}): Promise<TurnUnderstanding> {
  const short = input.text.trim().length <= 30
  const on = {
    maksud: await jevOn('maksud'),
    form: await jevOn('form'),
    serah_cs: await jevOn('serah_cs'),
    setuju: input.offerPending && (await jevOn('setuju')),
    layanan: input.services.length > 1 && (await jevOn('layanan')),
    tanggapan: short && (await jevOn('tanggapan')),
    topik: await jevOn('topik'),
    kesulitan: await jevOn('kesulitan'),
    sudah_tf: Boolean(input.awaitingPayment) && (await jevOn('sudah_tf')),
    minta_rekening: await jevOn('minta_rekening'),
    lanjut: await jevOn('lanjut'),
    urgensi: await jevOn('urgensi'),
    hati: await jevOn('hati'),
    harga_konteks:
      /harga|berapa|brp|\bset\b|setel|celana|rompi|vest|premium|signature|bahan|sekalian/i.test(input.text) &&
      (await jevOn('harga_konteks')),
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
  if (on.tanggapan)
    questions.tanggapan = {
      type: 'choice',
      instructions: 'Pesan_terbaru pelanggan singkat. Apa fungsinya terhadap pesan toko terakhir di percakapan?',
      criteria: {
        terima: 'Hanya tanda terima/oke atas info toko; tidak menyetujui tawaran, tidak memilih, tidak bertanya — tidak perlu dibalas',
        setuju: 'Menyetujui tawaran, total, atau langkah yang ditawarkan toko',
        jawab: 'Menjawab pertanyaan toko (memilih opsi, menyebut size/warna/jumlah)',
        tanya: 'Bertanya atau meminta sesuatu',
        lain: 'Selain itu',
      },
    }
  if (on.topik)
    for (const [key, description] of Object.entries(TOPICS))
      questions[`topik_${key}`] = {
        type: 'noul',
        instructions: `Apakah pesan_terbaru membahas ${description}?`,
      }
  if (on.kesulitan)
    questions.kesulitan = {
      type: 'score',
      instructions: 'Seberapa sulit membalas pesan_terbaru dengan benar?',
      criteria: [
        'Sederhana: salam, terima kasih, oke/ya/tidak, atau satu pertanyaan stok/foto/harga satu produk yang jawabannya langsung ada di katalog',
        'Biasa: beberapa pertanyaan, membandingkan model/seri, saran size, ongkir, langkah order, atau perlu melihat percakapan sebelumnya',
        'Rumit: komplain, custom, negosiasi, banyak syarat, pembayaran bermasalah, atau perlu menimbang riwayat panjang',
      ],
    }
  if (on.minta_rekening)
    questions.minta_rekening = {
      type: 'noul',
      instructions: 'Apakah pesan_terbaru pelanggan meminta nomor rekening atau menanyakan transfer ke mana?',
    }
  if (on.sudah_tf)
    questions.sudah_tf = {
      type: 'noul',
      instructions: 'Apakah pesan_terbaru menyatakan pelanggan SUDAH transfer/membayar (bukan bertanya rekening atau berjanji nanti)?',
    }
  if (on.lanjut)
    questions.lanjut = {
      type: 'choice',
      instructions: 'Apakah pesan_terbaru menunda atau membatalkan rencana membeli?',
      criteria: {
        lanjut: 'Masih lanjut / tidak menyinggung penundaan',
        tunda: 'Menunda: nanti dulu, pikir-pikir, kabari lagi, belum gajian, kemahalan/budget belum cukup, lihat-lihat dulu',
        batal: 'Membatalkan: tidak jadi, cancel, cari di tempat lain',
      },
    }
  if (on.urgensi)
    questions.urgensi = {
      type: 'score',
      instructions: 'Seberapa penting/mendesak pesan_terbaru untuk segera ditangani toko?',
      criteria: [
        'Biasa: tanya-tanya, basa-basi',
        'Calon pembeli serius: tanya size/ongkir/cara order',
        'Siap bayar atau sudah bayar, menunggu konfirmasi',
        'Mendesak: butuh cepat (acara dekat), pesanan terlambat, belum ada kabar',
        'Komplain, marah, barang rusak/salah, minta refund',
      ],
    }
  if (on.harga_konteks) {
    questions.seri = {
      type: 'choice',
      instructions: 'Seri bahan produk yang sedang dibahas pelanggan dan toko di percakapan (yang terakhir dibahas)?',
      criteria: {
        reguler: 'Seri biasa/reguler (bahan Maximotion, Aldo Moretti; harga jas mulai 485 ribu)',
        signature: 'Seri Signature (bahan Scuro)',
        premium: 'Seri Premium (bahan Black Label, Portofino; produk bernama "Premium")',
        belum: 'Belum jelas seri mana',
      },
    }
    questions.barang = {
      type: 'choice',
      instructions: 'Barang apa yang ditanyakan harganya di pesan_terbaru (lihat juga percakapan)?',
      criteria: {
        jas: 'Jas/blazer saja',
        celana: 'Celana saja',
        setelan: 'Setelan / set / jas sekalian celana',
        rompi: 'Rompi/vest',
        belum: 'Tidak menanyakan harga barang',
      },
    }
  }
  if (on.hati) for (const [key, question] of Object.entries(HEART_QUESTIONS)) questions[`hati_${key}`] = question
  if (!Object.keys(questions).length) return {}
  const answers = await askJev(
    'pahami',
    // Konteks penuh (10 baris × 500 huruf): dipotong lebih pendek membuat Jev lebih sering ragu
    // soal seri harga, setuju, dan kesulitan — hematnya kecil, akibatnya model murah terpilih lagi.
    {
      pesan_terbaru: maskPii(input.text).slice(0, 2000),
      percakapan: conversationLines(input.history),
      layanan_tersedia: input.services,
      pesan_toko_terakhir: maskPii(
        String([...input.history].reverse().find((row) => row.direction === 'out')?.body || '')
      ).slice(0, 600),
    },
    questions,
    { jid: input.jid }
  )
  if (!answers) return {}
  const result: TurnUnderstanding = {}
  const take = async (
    key: 'maksud' | 'form' | 'serah_cs' | 'setuju' | 'layanan' | 'sudah_tf' | 'lanjut' | 'minta_rekening',
    apply: () => void
  ) => {
    const answer = answers[key]
    if (!answer) return
    const sure = confident(key, answer)
    if (sure) apply()
    await logDecision({ jid: input.jid, decision: key, answer, used: sure, input: input.text })
  }
  await take('maksud', () => (result.intent = choiceOf(answers.maksud)))
  await take('form', () => (result.hasShippingData = yes(answers.form)))
  await take('serah_cs', () => (result.csReason = choiceOf(answers.serah_cs)))
  await take('setuju', () => (result.agreed = choiceOf(answers.setuju) === 'setuju'))
  await take('layanan', () => {
    const chosen = choiceOf(answers.layanan)
    result.service = chosen === 'belum' ? null : chosen
  })
  if (answers.tanggapan) {
    const sure = confident('tanggapan', answers.tanggapan)
    if (sure) result.reaction = choiceOf(answers.tanggapan) as TurnUnderstanding['reaction']
    await logDecision({ jid: input.jid, decision: 'tanggapan', answer: answers.tanggapan, used: sure, detail: input.text, input: input.text })
  }
  const topics: Partial<Record<TurnTopic, boolean>> = {}
  for (const key of Object.keys(TOPICS) as TurnTopic[]) {
    const answer = answers[`topik_${key}`]
    if (!answer) continue
    const sure = confident('topik', answer)
    if (sure) topics[key] = yes(answer)
    await logDecision({ jid: input.jid, decision: 'topik', answer, used: sure, detail: key, input: input.text })
  }
  if (Object.keys(topics).length) result.topics = topics
  if (answers.kesulitan && answers.kesulitan.type === 'score') {
    const sure = confident('kesulitan', answers.kesulitan)
    if (sure) result.difficulty = scoreLevel(answers.kesulitan, 3)
    await logDecision({ jid: input.jid, decision: 'kesulitan', answer: answers.kesulitan, used: sure, input: input.text })
  }
  await take('sudah_tf', () => (result.paidClaim = yes(answers.sudah_tf)))
  await take('minta_rekening', () => (result.asksAccount = yes(answers.minta_rekening)))
  await take('lanjut', () => (result.follow = choiceOf(answers.lanjut) as TurnUnderstanding['follow']))
  for (const key of ['seri', 'barang'] as const) {
    const answer = answers[key]
    if (!answer) continue
    const sure = confident('harga_konteks', answer)
    const choice = choiceOf(answer)
    if (sure && choice !== 'belum') {
      if (key === 'seri') result.series = choice as TurnUnderstanding['series']
      else result.item = choice as TurnUnderstanding['item']
    }
    await logDecision({ jid: input.jid, decision: 'harga_konteks', answer, used: sure, detail: key, input: input.text })
  }
  if (answers.urgensi && answers.urgensi.type === 'score') {
    const sure = confident('urgensi', answers.urgensi)
    if (sure) result.urgency = scoreLevel(answers.urgensi, 5)
    await logDecision({ jid: input.jid, decision: 'urgensi', answer: answers.urgensi, used: sure, input: input.text })
  }
  const heart: Heart = {}
  const field = { bentuk: 'form', rasa: 'feeling', momen: 'moment' } as const
  for (const key of Object.keys(HEART_QUESTIONS) as Array<keyof typeof field>) {
    const answer = answers[`hati_${key}`]
    if (!answer) continue
    const sure = confident('hati', answer)
    if (sure && choiceOf(answer)) heart[field[key]] = choiceOf(answer)
    await logDecision({ jid: input.jid, decision: 'hati', answer, used: sure, detail: key, input: input.text })
  }
  if (Object.keys(heart).length) result.heart = heart
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
    input: bubbles.join('\n'),
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
    input: recent.join('\n—\n'),
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
  await logDecision({ jid, decision: 'terjawab', answer, used: sure, input: `Pelanggan: ${customer.join(' / ')}\nToko: ${store.join(' / ')}` })
  return sure ? scoreLevel(answer, 3) === 3 : undefined
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
  await logDecision({ jid, decision: 'varian', answer, used: sure, detail: product, input: conversationLines(chat, 4, 200).join('\n') })
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
    input: comment,
  })
  if (!sure) return undefined
  return ['calon_pembeli', 'pertanyaan'].includes(answer.choice)
}

/**
 * Warna katalog untuk produk di gambar pelanggan. Jev menimbang hasil ukur piksel (selisih ke
 * tiap warna katalog) dan kata-kata pelanggan. null = bukan warna katalog; undefined = tidak tahu.
 */
export async function chooseImageColor(input: {
  jid: string
  image: number
  measured: string
  candidates: Array<{ color: string; distance: number; products: string[] }>
  text: string
  history: Line[]
}) {
  if (input.candidates.length < 2 || !(await jevOn('warna_gambar'))) return undefined
  const criteria: Record<string, string> = {}
  for (const candidate of input.candidates)
    criteria[candidate.color] = `Produk di gambar berwarna ${candidate.color} (selisih ukur ${candidate.distance}; contoh: ${candidate.products.join(', ')})`
  criteria.lain = 'Bukan foto pakaian, atau warnanya tidak cocok dengan pilihan mana pun'
  const answers = await askJev(
    'warna-gambar',
    {
      hasil_ukur_piksel: `Gambar ${input.image}: ${input.measured}`,
      kandidat: input.candidates.map((c) => `${c.color} — selisih ${c.distance} (makin kecil makin mirip)`),
      pesan_pelanggan: maskPii(input.text).slice(0, 600),
      percakapan: conversationLines(input.history, 8),
      catatan:
        'Selisih ukur dihitung dari warna badan pakaian di foto vs foto katalog; selisih < 5 hampir sama. Putih bersih ≠ broken white (kekuningan tipis) ≠ krem. Kata pelanggan ("putih tulang", "gading") ikut menentukan.',
    },
    {
      warna_gambar: {
        type: 'choice',
        instructions: 'Warna katalog mana yang paling tepat untuk produk di gambar pelanggan?',
        criteria,
      },
    }
  )
  const answer = answers?.warna_gambar
  if (!answer || answer.type !== 'choice') return undefined
  const sure = confident('warna_gambar', answer)
  await logDecision({ jid: input.jid, decision: 'warna_gambar', answer, used: sure, detail: input.measured, input: `${input.text ? `Pesan: ${input.text}\n` : ''}Hasil ukur: ${input.measured}` })
  if (!sure) return undefined
  return answer.choice === 'lain' ? null : answer.choice
}

/** Pesan lanjutan obrolan ongkir menyebut tujuan pengiriman BARU? undefined = tidak tahu. */
export async function isNewDestination(jid: string, text: string, place: string, lastPlace: string) {
  if (!(await jevOn('tujuan_baru'))) return undefined
  const answers = await askJev(
    'tujuan-baru',
    { pesan_pelanggan: maskPii(text).slice(0, 300), kata_yang_dikira_tempat: place, tujuan_sebelumnya: lastPlace },
    {
      tujuan_baru: {
        type: 'noul',
        instructions:
          'Apakah pesan_pelanggan menyebut nama tempat/tujuan pengiriman BARU (kecamatan, kota, daerah)? Memilih layanan (REG/YES), menjawab oke, atau menyebut produk/size BUKAN tujuan baru.',
      },
    }
  )
  const answer = answers?.tujuan_baru
  if (!answer) return undefined
  const sure = confident('tujuan_baru', answer)
  await logDecision({ jid, decision: 'tujuan_baru', answer, used: sure, detail: `${text} → ${place}`, input: `${text}\n(dikira tempat: ${place}; tujuan sebelumnya: ${lastPlace})` })
  return sure ? yes(answer) : undefined
}

/** Pesan toko (CS) menyatakan dana sudah masuk/diterima? undefined = tidak tahu. */
export async function storeConfirmedPayment(jid: string, storeMessages: string[]) {
  const recent = storeMessages.filter((body) => body.trim()).slice(-5)
  if (!recent.length || !(await jevOn('dana_masuk'))) return undefined
  const answers = await askJev(
    'dana-masuk',
    { pesan_toko: recent.map((body) => maskPii(body).slice(0, 400)) },
    {
      dana_masuk: {
        type: 'noul',
        instructions:
          'Apakah salah satu pesan_toko MENYATAKAN dana/pembayaran pelanggan sudah masuk atau diterima (mis. "sudah masuk ya", "dana diterima", "terimakasih, prosess ya" setelah transfer)? Mengirim rekening, total, atau "kami cek dulu" BUKAN.',
      },
    }
  )
  const answer = answers?.dana_masuk
  if (!answer) return undefined
  const sure = confident('dana_masuk', answer)
  await logDecision({ jid, decision: 'dana_masuk', answer, used: sure, detail: recent.join(' | ').slice(0, 300), input: recent.join('\n—\n') })
  return sure ? yes(answer) : undefined
}

/**
 * v3.6.30 — gambar pelanggan = bukti pembayaran? Dinilai dari ISI gambar (keterangan hasil AI
 * melihat gambar) + teks pelanggan, bukan dari urutan "setelah rekening pasti bukti".
 * true/false bila yakin; undefined bila Jev mati/ragu (pemanggil memakai jenis dari AI).
 */
export async function imageIsPaymentProof(input: { jid: string; kind: string; note: string; customerText: string; awaitingPayment: boolean }) {
  if (!(await jevOn('bukti_transfer'))) return undefined
  const answers = await askJev(
    'bukti-transfer',
    {
      jenis_menurut_ai: input.kind,
      keterangan_gambar: maskPii(input.note).slice(0, 300),
      teks_pelanggan: maskPii(input.customerText).slice(0, 300),
      toko_menunggu_pembayaran: input.awaitingPayment,
    },
    {
      bukti_transfer: {
        type: 'noul',
        instructions:
          'Apakah gambar ini BUKTI PEMBAYARAN ke toko (struk/screenshot transfer, m-banking, e-wallet, QRIS, nominal & tujuan)? Foto/screenshot jas, celana, model, tabel ukuran, katalog, atau tangkapan layar chat BUKAN bukti pembayaran, walaupun toko sedang menunggu pembayaran.',
      },
    },
    { jid: input.jid }
  )
  const answer = answers?.bukti_transfer
  if (!answer) return undefined
  const sure = confident('bukti_transfer', answer)
  await logDecision({ jid: input.jid, decision: 'bukti_transfer', answer, used: sure, detail: `${input.kind}: ${input.note}`.slice(0, 300), input: `Isi gambar (dilihat AI): ${input.note || '-'}${input.customerText ? `\nTeks pelanggan: ${input.customerText}` : ''}` })
  return sure ? yes(answer) : undefined
}

/**
 * v3.6.31 — pesan toko menyatakan pesanan DIANTAR SENDIRI oleh tim / diambil pelanggan (tanpa
 * ekspedisi & resi)? Dipakai pemindai pengiriman setelah pola kata cocok; true/false bila yakin.
 */
export async function storeDeliversItself(jid: string, storeMessage: string) {
  if (!(await jevOn('kirim_sendiri'))) return undefined
  const answers = await askJev(
    'kirim-sendiri',
    { pesan_toko: maskPii(storeMessage).slice(0, 400) },
    {
      kirim_sendiri: {
        type: 'noul',
        instructions:
          'Apakah pesan_toko menyatakan pesanan SUDAH/SEDANG dikirim atau diantar langsung oleh tim toko sendiri (kurir toko, COD, diantar ke alamat), atau diambil pelanggan di toko — tanpa ekspedisi dan tanpa nomor resi? Pesan yang menyebut resi/ekspedisi, atau hanya janji/perkiraan jadi, BUKAN.',
      },
    },
    { jid }
  )
  const answer = answers?.kirim_sendiri
  if (!answer) return undefined
  const sure = confident('kirim_sendiri', answer)
  await logDecision({ jid, decision: 'kirim_sendiri', answer, used: sure, detail: storeMessage.slice(0, 300), input: storeMessage })
  return sure ? yes(answer) : undefined
}

/**
 * v3.6.31 — peran lawan chat: pelanggan toko, atau VENDOR/supplier tempat toko membeli bahan
 * (kain, kancing, benang, jasa bordir, ekspedisi, dsb.), atau lainnya (internal/tim/pribadi).
 * Dari ISI percakapan dua arah — toko yang bertanya harga/stok/pesan bahan = vendor.
 */
export async function contactRole(jid: string, chat: Line[]) {
  if (!(await jevOn('peran_kontak'))) return undefined
  const lines = conversationLines(chat, 12, 600)
  if (!lines.length) return undefined
  const answers = await askJev(
    'peran-kontak',
    { percakapan: lines },
    {
      peran_kontak: {
        type: 'choice',
        instructions:
          'Siapa lawan chat ini bagi toko jas? pelanggan = orang yang bertanya/memesan/membayar jas ke toko, termasuk yang pesanannya DIANTAR tim toko, diambil di toko, menanyakan alamat/pengantaran, atau bilang "sudah diterima". vendor = pihak yang MENJUAL ke toko atau menyediakan jasa (kain, bahan, kancing, benang, bordir, konveksi, iklan) — toko yang bertanya harga/stok bahan, memesan bahan, atau membayar ke mereka. lainnya = tim internal, keluarga, pribadi, grup, spam. Ragu antara pelanggan dan vendor → pelanggan.',
        criteria: {
          pelanggan: 'Lawan chat membeli/bertanya produk toko',
          vendor: 'Toko membeli bahan/jasa dari lawan chat',
          lainnya: 'Bukan jual beli dengan toko (internal, pribadi, spam)',
        },
      },
    },
    { jid }
  )
  const answer = answers?.peran_kontak
  if (!answer) return undefined
  const sure = confident('peran_kontak', answer)
  await logDecision({ jid, decision: 'peran_kontak', answer, used: sure, detail: lines.slice(-4).join(' | ').slice(0, 300), input: lines.slice(-8).join('\n') })
  const choice = answer.type === 'choice' ? String(answer.choice || '') : ''
  return sure && ['pelanggan', 'vendor', 'lainnya'].includes(choice) ? (choice as 'pelanggan' | 'vendor' | 'lainnya') : undefined
}
