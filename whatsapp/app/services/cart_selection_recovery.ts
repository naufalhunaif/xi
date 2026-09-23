import type { CartIntent } from '#services/cart_contract'
import type { AiDecision } from '#services/ai_service'

export class CartSelectionIncompleteError extends Error {
  readonly code = 'CART_SELECTION_INCOMPLETE'
  constructor() {
    super('Pilihan ukuran belum lengkap; cart belum diubah.')
  }
}

/** Missing selection is not made-to-measure. Keep main's persistence contract intact. */
export function incompleteCartSelection(intent: CartIntent | null | undefined) {
  return intent?.action === 'sync'
    ? intent.items
        .filter((item) => !item.size.trim())
        .map((item) => ({
          itemId: item.id,
          productId: item.productId,
          referenceMessageId: item.referenceMessageId || '',
          missing: 'size',
        }))
    : []
}

export function cartSelectionRecoveryPrompt(intent: CartIntent) {
  return `LANJUTKAN PERCAKAPAN TANPA MEMAKSA CART (satu pemeriksaan, bukan mengulang analisis awal).
Usulan sync tidak dijalankan karena ukuran belum terpilih: ${JSON.stringify(incompleteCartSelection(intent))}.
Gunakan pertanyaan terakhir, jawaban pelanggan, kutipan/foto dan fakta dalam konteks asli. Persetujuan mengecek custom hanya menyetujui pemeriksaan itu, bukan ukuran, kelayakan, harga atau checkout. Urutan data fleksibel; jawab kebutuhan sekarang, gali satu pembeda yang memang kurang atau teruskan keputusan yang sungguh memerlukan manusia sesuai skill. Jangan otomatis menanyakan ukuran dahulu, meminta data/foto ulang, mengarang size/custom atau mengatakan cart/order tersimpan. Jangan handoff hanya karena field kosong.
Untuk perbaikan ini cartIntent, checkoutContinuity, customSizeQuestion dan approvalWait harus null. Cart lama tetap utuh. Keputusan reply memuat langkah nyata di message/initiative; handoff hanya sesuai kewenangan skill dengan alasan dan sumber di note. Pertahankan referensi asli dan rincian pasti di note/memori bersumber. Goal mengikuti langkah yang benar-benar dikomunikasikan. Tidak perlu membaca ulang bukti/aturan yang sudah tersedia atau seluruh katalog. Ketidakpastian visual bukan alasan menebak identitas.`
}

/** No repaired output is allowed to sneak a transaction into this conversational turn. */
export function conversationOnlyCartRecovery(
  original: AiDecision,
  repaired: AiDecision
): AiDecision {
  if (
    repaired.cartIntent ||
    repaired.checkoutContinuity ||
    repaired.customSizeQuestion ||
    repaired.approvalWait ||
    repaired.localResolution ||
    repaired.indexReply ||
    !repaired.goal ||
    (repaired.decision !== 'handoff' &&
      (repaired.decision !== 'reply' || !(repaired.message.trim() || repaired.initiative?.trim())))
  )
    throw new CartSelectionIncompleteError()
  return { ...repaired, cartVersion: original.cartVersion }
}
