// Beta 3.5 — tingkat model balasan dari keputusan Jev (ringan / standar / berat), dengan alasan
// yang tampil di trace. Jev tidak yakin → undefined (pola kata lama di provider.autoTier).
import type { AutoTier } from '#beta3/provider'
import type { TurnUnderstanding } from '#beta3/jev_decisions'

export const TIER_LABEL: Record<AutoTier, string> = { light: 'ringan', standard: 'standar', heavy: 'berat' }
const DIFFICULTY_LABEL = ['', 'sederhana', 'biasa', 'rumit']

export type TierChoice = { tier: AutoTier; reason: string } | { tier: undefined; reason: string }

export function chooseReplyTier(
  understanding: Pick<TurnUnderstanding, 'intent' | 'reaction' | 'difficulty' | 'topics' | 'urgency' | 'csReason'>,
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
  if (level === 2) return { tier: 'standard', reason: label }
  // Sederhana, tapi ada data sistem (ongkir, catatan) atau topik custom/bayar → jangan model termurah.
  const risky = understanding.topics?.custom || understanding.topics?.bayar
  if (extra || risky)
    return { tier: 'standard', reason: `${label}, tapi ada ${extra ? 'catatan sistem/ongkir' : 'topik custom/bayar'}` }
  return { tier: 'light', reason: label }
}
