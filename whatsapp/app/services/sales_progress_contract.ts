/** A customer-visible next step, chosen semantically in the SAME model call.
 * This is not permission to order, charge, follow up, or invent business facts.
 */
export const SALES_PROGRESS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    step: {
      type: 'string',
      enum: [
        'selection',
        'size',
        'set_choice',
        'recipient',
        'shipping',
        'recap',
        'payment',
        'service',
        'clarification',
        'none',
      ],
    },
    delivery: { type: 'string', enum: ['initiative', 'message', 'wait', 'none'] },
    text: { type: 'string' },
    waitReason: {
      type: 'string',
      enum: [
        'none',
        'already_asked',
        'customer_paused',
        'answer_incomplete',
        'human_required',
        'scheduled',
        'finished',
        'no_relevant_step',
      ],
    },
  },
  required: ['step', 'delivery', 'text', 'waitReason'],
} as const
export type SalesProgress = {
  step: (typeof SALES_PROGRESS_SCHEMA.properties.step.enum)[number]
  delivery: (typeof SALES_PROGRESS_SCHEMA.properties.delivery.enum)[number]
  text: string
  waitReason: (typeof SALES_PROGRESS_SCHEMA.properties.waitReason.enum)[number]
}

export const SALES_PROGRESS_INSTRUCTIONS = `LANGKAH PENJUALAN (compact/lengkap):
Dalam panggilan ini, isi salesProgress: step=hambatan berikut yang relevan; delivery=initiative bila ada jawaban utama, text=SATU ucapan siap kirim dan salin ke initiative; delivery=message bila cukup langkah itu saja, text=message dan initiative kosong. Jangan hanya menyimpan langkah siap dilakukan di goal.next_action. Gunakan konteks/ucapan asli, lewati fakta yang sudah diketahui; tanpa gerbang "kalau jadi pesan" setelah pilihan disepakati.
Utamakan hambatan TERDEKAT dalam maksud pelanggan, bukan pertanyaan tambahan: jawaban pilihan seperti "yang coco bagus nih" menetapkan Choco, bukan pujian murni. Jika size terpilih kosong, periksa dulu kelayakan preorder dari keputusan/pengaturan LOKAL yang berlaku, bukan MCP; jika sah tawarkan untuk model/warna/size itu beserta estimasi dan syarat mulainya. Jika belum jelas selesaikan pemeriksaan/otorisasi yang diperlukan, jangan mengklaim bisa preorder atau melempar pertanyaan acara. Jika tidak tersedia/ditolak, bantu alternatif terdekat tanpa mengganti pilihan diam-diam. Kalau preorder sudah disetujui pelanggan, lanjut data berikut, jangan menawarkan ulang. Waktu/acara ditanyakan hanya bila diperlukan untuk menilai opsi yang tersedia, belum diketahui dan belum ditanyakan; tanggal yang sudah disebut langsung dipakai. Jangan menjanjikan restock, bertanya size ulang atau memakai urutan pertanyaan baku. Prinsip sama untuk model, custom, harga/set, ongkir, pembayaran dan layanan: tuntaskan kendala kini sebelum pindah topik. Foto/harga bukan penolakan bantuan; pelengkap mengikuti batas skill.
Jika pertanyaan konkret sudah terkirim dan BELUM dijawab: delivery=wait, waitReason=already_asked. Goal lama tidak menghalangi setelah pertanyaan dijawab. Alasan lain: customer_paused=menunda/menolak/meminta tanpa penawaran; answer_incomplete=kebutuhan utama belum selesai (selesaikan/pertanyaan penentu di message); human_required=handoff; scheduled=susulan satu message. Selesai/tiada langkah relevan: delivery=none, waitReason=finished/no_relevant_step. Untuk wait/none, text dan initiative kosong; selain itu waitReason=none. Jangan mengarang pertanyaan demi field.
Goal mengikuti ucapan terkirim: waiting_for hanya kebutuhan yang benar-benar ditanyakan, harga/foto bukan otomatis completed. salesProgress bukan izin transaksi/susulan, tidak mengubah cart/pembayaran atau menggantikan bukti dan batas skill.`

export function parseSalesProgress(value: unknown): SalesProgress | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const p = SALES_PROGRESS_SCHEMA.properties
  if (
    !p.step.enum.includes(v.step as any) ||
    !p.delivery.enum.includes(v.delivery as any) ||
    !p.waitReason.enum.includes(v.waitReason as any) ||
    typeof v.text !== 'string'
  )
    return undefined
  return {
    step: v.step as SalesProgress['step'],
    delivery: v.delivery as SalesProgress['delivery'],
    text: v.text.trim(),
    waitReason: v.waitReason as SalesProgress['waitReason'],
  }
}

/** Recover only explicit customer text the model already chose, never synthesize
 * a question from goal notes, regex intent matching or a canned sales template. */
export function applySalesProgress<
  T extends {
    decision: string
    message: string
    initiative?: string
    salesProgress?: SalesProgress
    visualMatch?: { status: string }
  },
>(decision: T): T {
  const p = decision.salesProgress
  if (
    !p ||
    decision.decision !== 'reply' ||
    p.step === 'none' ||
    p.waitReason !== 'none' ||
    !p.text ||
    (decision.visualMatch && ['uncertain', 'no_match'].includes(decision.visualMatch.status))
  )
    return decision
  if (
    p.delivery === 'initiative' &&
    !decision.initiative?.trim() &&
    !decision.message.includes(p.text)
  )
    return { ...decision, initiative: p.text }
  if (p.delivery === 'message' && !decision.message.trim()) return { ...decision, message: p.text }
  return decision
}

export function salesProgressTrace(decision: {
  decision: string
  message: string
  initiative?: string
  salesProgress?: SalesProgress
}) {
  const p = decision.salesProgress
  return {
    key: 'sales-progress',
    label: decision.initiative?.trim()
      ? 'Langkah berikut siap dikirim'
      : 'Keputusan langkah berikut',
    status: 'completed' as const,
    detail: {
      decision: decision.decision,
      step: p?.step || 'unreported',
      delivery: p?.delivery || 'unreported',
      waitReason: p?.waitReason || 'unreported',
      hasAnswer: Boolean(decision.message?.trim()),
      hasInitiative: Boolean(decision.initiative?.trim()),
      extraAiCalls: 0,
    },
  }
}
