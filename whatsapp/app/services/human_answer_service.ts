import type { AiDecision } from '#services/ai_service'

/** A review of a human answer is for understanding, not another customer-facing turn. */
export function understandHumanAnswer(decision: AiDecision): AiDecision {
  const plan = decision.goal
  const status =
    plan &&
    ['waiting_answer', 'waiting_payment', 'waiting_approval', 'completed'].includes(plan.status)
      ? plan.status
      : 'waiting_answer'
  return {
    ...decision,
    decision: 'silent',
    message: '',
    initiative: '',
    handoff_category: 'none',
    reason: 'Jawaban CS dipahami; menunggu perkembangan percakapan.',
    goal: {
      objective: plan?.objective || 'Melanjutkan kebutuhan pelanggan setelah jawaban CS',
      status,
      waiting_for: status === 'completed' ? '' : plan?.waiting_for || 'Jawaban pelanggan',
      next_action:
        status === 'completed'
          ? ''
          : plan?.next_action || 'Pahami jawaban pelanggan berikutnya sesuai skill',
      // A handoff response cannot smuggle a follow-up schedule into an understanding-only pass.
      follow_up: null,
    },
  }
}
