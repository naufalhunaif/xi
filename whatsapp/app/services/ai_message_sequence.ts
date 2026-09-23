import type { AiDecision } from '#services/ai_service'
import type { OutgoingImage } from '#services/outgoing_image_service'

/** Semantic fields, never paragraph/phrase splitting. Each callback is one WhatsApp bubble. */
export async function sendAiMessageSequence(
  decision: AiDecision,
  scheduled: boolean,
  canSend: () => Promise<boolean>,
  send: (body: string, kind: 'answer' | 'initiative', image?: OutgoingImage) => Promise<boolean>,
  images: OutgoingImage[] = []
) {
  if (decision.decision !== 'reply') return true
  const parts: Array<{ body: string; kind: 'answer' | 'initiative'; image?: OutgoingImage }> = []
  if (decision.message.trim()) parts.push({ body: decision.message.trim(), kind: 'answer' })
  for (const image of images.filter((item) => item.kind === 'answer'))
    parts.push({ body: image.caption, kind: 'answer', image })
  if (
    !scheduled &&
    decision.initiative?.trim() &&
    decision.initiative.trim() !== decision.message.trim()
  )
    parts.push({ body: decision.initiative.trim(), kind: 'initiative' })
  if (!scheduled)
    for (const image of images.filter((item) => item.kind === 'initiative'))
      parts.push({ body: image.caption, kind: 'initiative', image })
  if (!parts.length) throw new Error('Tidak ada pesan pelanggan yang valid.')
  for (const part of parts) {
    if (!(await canSend()) || !(await send(part.body, part.kind, part.image))) return false
  }
  return true
}
