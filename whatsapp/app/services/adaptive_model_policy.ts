import type {
  ActiveConversationState,
  IntentIndex,
  ProcessingLevel,
} from '#services/conversation_levels'

export type ModelTier = 'light' | 'standard' | 'complex'
export type AdaptiveRoute = { enabled: boolean; tier: ModelTier; reason: string }
export type ModelProfile = { model: string; reasoning: string; speed: string }

/** Context levels are retrieval hints. Only a bounded social index or unambiguous
 * catalogue context is eligible for reduced compute; all other work keeps the main model. */
export function adaptiveRoute(input: {
  enabled: boolean
  index: boolean
  level: ProcessingLevel
  indices: IntentIndex[]
  state?: ActiveConversationState
  hasVisual: boolean
}): AdaptiveRoute {
  if (!input.enabled) return { enabled: false, tier: 'complex', reason: 'disabled' }
  const state = input.state
  if (input.index) return { enabled: true, tier: 'light', reason: 'bounded_social_index' }
  const simple =
    state &&
    !input.hasVisual &&
    !state.hasMedia &&
    !state.hasQuote &&
    !state.cartItems &&
    !state.orderCount &&
    !state.pendingMemory &&
    state.currentMessageCount === 1 &&
    input.level <= 2 &&
    input.indices.includes(2) &&
    input.indices.every((id) => id === 1 || id === 2)
  return {
    enabled: true,
    tier: simple ? 'standard' : 'complex',
    reason: simple ? 'catalogue_only' : 'context_or_action_requires_primary',
  }
}

export function selectModelProfile(
  provider: 'chatgpt' | 'claude',
  route: AdaptiveRoute | undefined,
  primary: ModelProfile,
  overrides: Partial<Record<'light' | 'standard', Partial<ModelProfile>>> = {},
  forcePrimary = false
) {
  const tier = !route?.enabled || forcePrimary ? 'complex' : route.tier
  // Keep the owner's primary model and service tier. Adaptive effort only raises
  // a known model's effort; opting out preserves the original settings exactly.
  if (tier === 'complex') {
    let reasoning = primary.reasoning
    const known =
      provider === 'chatgpt'
        ? /^(gpt-6-astra|gpt-5\.6-(sol|terra|luna)|gpt-5\.[45])$/.test(primary.model)
        : /^(opus|sonnet)$/.test(primary.model)
    if (route?.enabled && known) {
      const target = route.reason === 'promoted_to_primary' ? 'xhigh' : 'high'
      const rank = ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
      if (rank.indexOf(reasoning) < rank.indexOf(target)) reasoning = target
    }
    return { ...primary, reasoning, tier, adaptive: route?.enabled === true }
  }
  const defaults =
    provider === 'chatgpt'
      ? {
          light: { model: 'gpt-5.6-luna', reasoning: 'low' },
          standard: { model: 'gpt-5.6-terra', reasoning: 'medium' },
        }
      : {
          light: { model: 'haiku', reasoning: 'auto' },
          standard: { model: 'sonnet', reasoning: 'medium' },
        }
  const selected = overrides[tier]
  return {
    tier,
    adaptive: true,
    model: selected?.model || defaults[tier].model,
    reasoning: selected?.reasoning || defaults[tier].reasoning,
    // Switching profiles never implicitly buys a premium speed tier.
    speed: 'standard',
  }
}

/** The reduced model may only return read-only catalogue replies. Model confidence
 * is not a transaction permission. A single primary retry happens before delivery. */
export function reducedOutputNeedsPrimary(output: string) {
  try {
    const v = JSON.parse(output)
    return (
      !v ||
      v.requiresDeepReasoning === true ||
      v.needsFullSkillContext === true ||
      v.decision !== 'reply' ||
      Boolean(v.cartIntent || v.approvalWait || v.customSizeQuestion || v.checkoutContinuity) ||
      v.needsVisualInspection === true ||
      Boolean(v.visualMatch) ||
      (v.handoff_category && v.handoff_category !== 'none') ||
      Boolean(v.customerMemory?.length) ||
      Boolean(v.goal?.follow_up) ||
      ['waiting_payment', 'waiting_approval'].includes(v.goal?.status)
    )
  } catch {
    return true
  }
}

export const ADAPTIVE_REASONING_INSTRUCTIONS = `PROFIL PENALARAN DINAMIS: pertahankan aturan, maksud, konteks, bukti dan inisiatif. Jika ada konflik, rujukan ambigu, kebutuhan custom/transaksi/pembayaran/keluhan/analisis visual, atau kemampuan profil saat ini tidak cukup, isi requiresDeepReasoning=true; sistem memeriksa ulang dengan model utama sebelum tindakan/pesan dikirim. Jangan mengarang jawaban agar tetap di profil ringan. Jika cukup, false. Membaca aturan tambahan tidak otomatis berarti membaca semua skill.`
