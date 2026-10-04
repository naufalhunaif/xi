// Beta 3.5 — tingkat model balasan (ringan / standar / berat). Dasar = aturan pola kata v3.5.7
// (`autoTier`: ada gambar, catatan sistem, ongkir, ukuran, custom, pembayaran, komplain → berat).
// Jev hanya boleh MENAIKKAN tingkat (rumit/komplain → berat), tidak pernah menurunkan.
import type { AutoTier } from '#beta3/provider'
import type { TurnUnderstanding } from '#beta3/jev_decisions'

export const TIER_LABEL: Record<AutoTier, string> = { light: 'ringan', standard: 'standar', heavy: 'berat' }
const RANK: Record<AutoTier, number> = { light: 0, standard: 1, heavy: 2 }
const DIFFICULTY_LABEL = ['', 'sederhana', 'biasa', 'rumit']

export type TierChoice = { tier: AutoTier; reason: string }

export function chooseReplyTier(
  understanding: Pick<TurnUnderstanding, 'difficulty' | 'urgency' | 'csReason'>,
  base: AutoTier
): TierChoice {
  let raised: AutoTier | null = null
  let why = ''
  if (understanding.csReason === 'komplain' || (understanding.urgency || 0) >= 5) {
    raised = 'heavy'
    why = 'Jev: komplain/mendesak'
  } else if (understanding.difficulty) {
    raised = understanding.difficulty >= 3 ? 'heavy' : 'standard'
    why = `Jev: ${DIFFICULTY_LABEL[understanding.difficulty]}`
  }
  if (raised && RANK[raised] > RANK[base]) return { tier: raised, reason: `${why} (dinaikkan dari ${TIER_LABEL[base]})` }
  return { tier: base, reason: `pola kata${why ? ` · ${why}` : ''}` }
}
