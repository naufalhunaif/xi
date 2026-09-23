import type { AiDecision } from '#services/ai_service'
import { saveChatNote } from '#services/context_service'
import { setHandlingMode } from '#services/message_service'
import { beginApprovalWait } from '#services/approval_wait_service'

/** Handled decisions must return before any WhatsApp send or outgoing bubble insert. */
export async function handleInternalDecision(jid: string, decision: AiDecision) {
  if (decision.decision === 'reply') return false
  if (decision.decision === 'handoff') await setHandlingMode(jid, 'cs', decision.reason)
  if (
    decision.decision === 'handoff' &&
    decision.handoff_category === 'human_authorization' &&
    decision.approvalWait
  )
    await beginApprovalWait(jid, decision.approvalWait)
  if (decision.note) await saveChatNote(jid, decision.note)
  return true
}
