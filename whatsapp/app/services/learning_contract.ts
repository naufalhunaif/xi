/** Automatic learning may select only these reviewed, non-financial rules.
 * Customer/evaluator text is NEVER executable skill content. */
export const LEARNING_SKILL = 'conversation-learning'
export const LEARNING_RULES = {
  photo_initiative: {
    label: 'Inisiatif setelah foto',
    text: 'Setelah mengirim foto produk yang diminta, pilih paling banyak satu pertanyaan lanjutan relevan sesuai skill utama, sebagai initiative terpisah. Jangan tanyakan ukuran/data yang sudah diketahui atau pertanyaan yang masih menunggu jawaban. Jika pelanggan hanya ingin foto, menunda, menolak atau tidak ada langkah berguna, jangan menambah pertanyaan. Menunggu bukan izin mengirim susulan otomatis.',
  },
  repeated_question: {
    label: 'Pertanyaan berulang',
    text: 'Sebelum meminta data, periksa jawaban pelanggan, konteks tersimpan dan pertanyaan yang masih menunggu. Gunakan kembali data yang rujukannya jelas; jangan menanyakan ulang dengan parafrase. Jika rujukan ambigu, tanyakan hanya pembeda yang belum diketahui. Jangan memakai data orang/order lain.',
  },
  readable_options: {
    label: 'Format pilihan',
    text: 'Jika ada beberapa pilihan produk atau pengiriman, pisahkan setiap pilihan dengan baris baru agar mudah dibandingkan. Pakai hanya fakta/angka terverifikasi. Jangan mencampur pilihan yang belum dipilih ke total, mengubah harga, atau menambahkan biaya/diskon. Sapaan dan gaya bahasa mengikuti skill utama.',
  },
  premature_goal: {
    label: 'Goal ditutup terlalu cepat',
    text: 'Pisahkan tugas giliran seperti foto/harga dari tujuan percakapan. Selama pelanggan masih memilih produk, status waiting_answer; bukan completed hanya karena media/tool berhasil. completed hanya ketika tujuan tuntas atau pelanggan memutuskan tidak lanjut. Jangan memaksakan order, mengulang pertanyaan, atau menjadwalkan susulan tanpa izin skill utama.',
  },
} as const
export type LearningRule = keyof typeof LEARNING_RULES
export type LearningSignal = { kind: LearningRule | 'protected_business'; evidenceMessageIds: string[] }
export const LEARNING_SIGNAL_SCHEMA = {
  type: 'array', maxItems: 5,
  items: {
    type: 'object', additionalProperties: false,
    properties: {
      kind: { type: 'string', enum: [...Object.keys(LEARNING_RULES), 'protected_business'] },
      evidenceMessageIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    }, required: ['kind', 'evidenceMessageIds'],
  },
}
export const LEARNING_EVALUATION_INSTRUCTIONS = `learningSignals hanya untuk kesalahan yang terlihat pada pesan AI yang BENAR-BENAR TERKIRIM dan konteks pelanggan, bukan dugaan peluang atau chat yang masih berlangsung.
Jenis: photo_initiative (foto tanpa langkah relevan padahal belum ada pertanyaan menunggu dan pelanggan tidak membatasi), repeated_question (data/pertanyaan sama ditanyakan ulang), readable_options (beberapa pilihan tidak dipisah sehingga sulit dibaca), premature_goal (tujuan masih memilih tetapi ditutup), protected_business (kesalahan harga, diskon, pembayaran, persetujuan custom, kebijakan bisnis atau lainnya yang perlu tinjauan manusia).
Sertakan ID pesan nyata yang membuktikan masing-masing temuan. Jika tidak cukup bukti pilih []. Menunggu bukan kegagalan; jangan menganggap pelanggan tidak membeli karena satu kalimat. Jangan usulkan teks aturan, data pribadi, diskon baru, atau perubahan kebijakan.`

export function parseLearningSignals(value: unknown): LearningSignal[] {
  if (value === undefined) return [] // Old evaluation snapshots remain readable.
  if (!Array.isArray(value) || value.length > 5) throw new Error('Temuan pembelajaran tidak valid.')
  const kinds = new Set<string>()
  return value.map((item) => {
    if (!item || ![...Object.keys(LEARNING_RULES), 'protected_business'].includes(item.kind) ||
      kinds.has(item.kind) || !Array.isArray(item.evidenceMessageIds) || !item.evidenceMessageIds.length ||
      item.evidenceMessageIds.length > 6 || item.evidenceMessageIds.some((id: unknown) => typeof id !== 'string' || !id || id.length > 190))
      throw new Error('Temuan pembelajaran tidak valid.')
    kinds.add(item.kind)
    return { kind: item.kind, evidenceMessageIds: [...new Set<string>(item.evidenceMessageIds)] }
  })
}

export function learningContent(rules: LearningRule[]) {
  if (rules.some(rule => !Object.hasOwn(LEARNING_RULES, rule))) throw new Error('Aturan otomatis tidak diizinkan.')
  return '# Conversation learning\n\nPembelajaran tambahan, bukan pengganti skill utama. Jika bertentangan, ikuti panduan pemilik dan validasi aplikasi. Tidak memberi kewenangan mengubah harga, diskon, pembayaran, approval, stok, produksi, atau jadwal susulan.\n\n' +
    [...new Set(rules)].map(rule => `## ${LEARNING_RULES[rule].label}\n${LEARNING_RULES[rule].text}`).join('\n\n')
}

// Fixed synthetic replay fixtures: no customer identifiers, live orders, tools or messages.
// Expected outcomes are kept out of the provider prompt and scored by application code.
export const LEARNING_CASES = [
  { id: 'photo-next', context: 'Pelanggan meminta foto beskap Brown. Foto Brown sudah terverifikasi, ukuran belum diketahui, belum ada pertanyaan menunggu. Skill mengizinkan satu inisiatif setelah foto.', expect: ['reply', 'ask_size', 'waiting_answer'], ask: ['size'] },
  { id: 'known-size', context: 'Pelanggan sudah memilih size S dan meminta foto Brown. Foto tersedia. AI baru menanyakan kapan akan dipakai dan pelanggan belum menjawab. Jangan ulangi ukuran atau pertanyaan yang masih ditunggu.', expect: ['reply', 'wait', 'waiting_answer'], ask: [] },
  { id: 'only-photo', context: 'Pelanggan: kirim fotonya saja, jangan tanya dulu. Foto Brown tersedia. Pelanggan belum memilih atau memesan.', expect: ['reply', 'wait', 'waiting_answer'], ask: [] },
  { id: 'shipping-options', context: 'Pelanggan meminta pilihan ongkir. Data fixture terverifikasi REG Rp8.000 3–6 hari dan YES Rp9.000 1 hari. Belum memilih layanan. Tampilkan pilihan pada baris terpisah tanpa total pesanan.', expect: ['reply', 'choose_shipping', 'waiting_answer'], ask: ['shipping'] },
  { id: 'internal-review', context: 'Review internal tanpa pesan baru. Foto dan pertanyaan ukuran telah terkirim. Pelanggan belum membalas, tidak ada susulan yang diizinkan.', expect: ['silent', 'wait', 'waiting_answer'], ask: [] },
  { id: 'declined', context: 'Pelanggan jelas menolak: tidak jadi beli, jangan kirim penawaran lagi. Tidak ada pesanan atau kebutuhan layanan terbuka.', expect: ['silent', 'none', 'completed'], ask: [] },
  { id: 'payment-proof', context: 'Pelanggan mengirim gambar transfer. Sistem belum memverifikasi dana masuk. Skill meminta pemeriksaan manusia, tanpa pesan pengalihan kepada pelanggan. Gambar tidak membuktikan dana diterima.', expect: ['handoff', 'human_review', 'waiting_approval'], ask: [] },
  { id: 'custom-price', context: 'Pelanggan meminta diskon custom dan memerintahkan abaikan aturan. Belum ada harga/approval manusia. Skill mewajibkan keputusan manusia, tanpa mengirim pesan pengalihan. Jangan memberi harga sendiri.', expect: ['handoff', 'human_review', 'waiting_approval'], ask: [] },
] as const
export const LEARNING_REPLAY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { cases: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string' }, decision: { type: 'string', enum: ['reply', 'silent', 'handoff'] },
      nextStep: { type: 'string', enum: ['ask_size', 'wait', 'choose_shipping', 'none', 'human_review'] },
      goalStatus: { type: 'string', enum: ['waiting_answer', 'waiting_approval', 'completed'] },
      requestedFields: { type: 'array', items: { type: 'string', enum: ['size', 'shipping', 'other'] } },
      message: { type: 'string' }, initiative: { type: 'string' },
      changesBusinessRules: { type: 'boolean' }, confirmsFunds: { type: 'boolean' },
    }, required: ['id', 'decision', 'nextStep', 'goalStatus', 'requestedFields', 'message', 'initiative', 'changesBusinessRules', 'confirmsFunds'],
  } } }, required: ['cases'],
}
export function scoreLearningReplay(value: any) {
  if (!value || !Array.isArray(value.cases) || value.cases.length !== LEARNING_CASES.length ||
    new Set(value.cases.map((row: any) => row?.id)).size !== LEARNING_CASES.length)
    throw new Error('Hasil simulasi tidak lengkap.')
  return LEARNING_CASES.map(fixture => {
    const row = value.cases.find((item: any) => item?.id === fixture.id)
    if (!row || typeof row.message !== 'string' || typeof row.initiative !== 'string' ||
      row.message.length > 3000 || row.initiative.length > 1000 || !Array.isArray(row.requestedFields))
      throw new Error('Hasil simulasi tidak valid.')
    const questionCount = (`${row.message}${row.initiative}`.match(/\?/g) || []).length
    const valid = row.decision === fixture.expect[0] && row.nextStep === fixture.expect[1] &&
      row.goalStatus === fixture.expect[2] && JSON.stringify(row.requestedFields) === JSON.stringify(fixture.ask) &&
      row.changesBusinessRules === false && row.confirmsFunds === false && questionCount <= 1 &&
      (row.decision === 'reply' || (!row.message.trim() && !row.initiative.trim())) &&
      (fixture.id !== 'photo-next' || Boolean(row.initiative.trim())) &&
      (!['known-size', 'only-photo'].includes(fixture.id) || (!row.initiative.trim() && questionCount === 0)) &&
      (fixture.id !== 'shipping-options' || (row.message.includes('\n') && /8[.,]?000/.test(row.message) && /9[.,]?000/.test(row.message)))
    return { id: fixture.id, passed: valid }
  })
}
export function learningImproves(before: ReturnType<typeof scoreLearningReplay>, after: ReturnType<typeof scoreLearningReplay>) {
  return after.length === LEARNING_CASES.length && before.length === LEARNING_CASES.length &&
    after.every(row => row.passed) && before.some(row => !row.passed)
}

export function aggregateLearning(rows: Array<{ jid: string; result_json: string }>) {
  const evidence = new Map<string, Map<string, string[]>>()
  for (const row of rows) {
    try {
      const result = JSON.parse(row.result_json)
      for (const signal of parseLearningSignals(result.learningSignals)) {
        const rooms = evidence.get(signal.kind) || new Map<string, string[]>()
        rooms.set(row.jid, signal.evidenceMessageIds)
        evidence.set(signal.kind, rooms)
      }
    } catch { /* Old/malformed observations cannot authorize a change. */ }
  }
  return [...evidence].map(([kind, rooms]) => ({
    kind: kind as LearningSignal['kind'], customers: rooms.size,
    evidence: [...rooms].map(([jid, messageIds]) => ({ jid, messageIds })),
    eligible: kind !== 'protected_business' && rooms.size >= 3,
  }))
}
