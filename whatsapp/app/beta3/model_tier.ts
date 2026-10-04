// Beta 3.5 — tingkat model balasan dari keputusan Jev (ringan / standar / berat), dengan alasan
// yang tampil di trace. Jev tidak yakin → undefined (pola kata lama di provider.autoTier).
import type { AutoTier } from '#beta3/provider'
import type { TurnUnderstanding } from '#beta3/jev_decisions'

export const TIER_LABEL: Record<AutoTier, string> = { light: 'ringan', standard: 'standar', heavy: 'berat' }
const DIFFICULTY_LABEL = ['', 'sederhana', 'biasa', 'rumit']

export type TierChoice = { tier: AutoTier; reason: string } | { tier: undefined; reason: string }

export function chooseReplyTier(
  understanding: Pick<TurnUnderstanding, 'intent' | 'reaction' | 'difficulty' | 'urgency' | 'csReason'>,
  context: { imageCount: number; systemNote: string; toolNotes: number }
): TierChoice {
  if (context.imageCount) return { tier: undefined, reason: 'ada gambar → aturan lama (berat)' }
  // Komplain / sangat mendesak → model utama.
  if (understanding.csReason === 'komplain' || (understanding.urgency || 0) >= 5)
    return { tier: 'heavy', reason: 'Jev: komplain/mendesak' }
  const extra = Boolean(context.systemNote) || context.toolNotes > 0
  if (!extra && (understanding.intent === 'sapaan' || understanding.reaction === 'terima'))
    return { tier: 'light', reason: 'Jev: salam/tanda terima' }
  const level = understanding.difficulty
  if (!level) return { tier: undefined, reason: 'Jev belum yakin → pola kata' }
  const label = `Jev: ${DIFFICULTY_LABEL[level]}`
  if (level >= 3) return { tier: 'heavy', reason: label }
  // Pertanyaan pelanggan apa pun (produk, harga, size, order) minimal model standar: model termurah
  // hanya untuk salam/tanda terima — jawabannya terasa kurang tepat bila diberi pertanyaan toko.
  return { tier: 'standard', reason: level === 1 ? `${label} → standar (bukan salam)` : label }
}
