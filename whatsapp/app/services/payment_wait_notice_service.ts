import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { readWaitNoticePolicy } from '#services/wait_notice_skill'

const EXPIRY_MS = 15 * 60_000

/** Called once per new pending payment episode, in the same cart transaction. */
export async function schedulePaymentWaitNotice(
  trx: TransactionClientContract,
  jid: string,
  proof: string | null,
  now = new Date()
) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.payment.enabled) return
  const anchor = await trx
    .from('whatsapp_messages')
    .where('jid', jid)
    .where('direction', 'in')
    .orderBy('id', 'desc')
    .first()
  if (!anchor || now.getTime() - new Date(anchor.created_at).getTime() > 5 * 60_000) return
  await trx
    .from('whatsapp_payment_wait_notices')
    .where('jid', jid)
    .where('status', 'pending')
    .update({ status: 'cancelled', updated_at: now })
  await trx.table('whatsapp_payment_wait_notices').insert({
    id: randomUUID(),
    jid,
    anchor_id: anchor.id,
    proof_message_id: proof,
    status: 'pending',
    due_at: new Date(now.getTime() + policy.delay_seconds * 1000),
    created_at: now,
    updated_at: now,
  })
}

export async function duePaymentWaitNotices(now = new Date()) {
  // Interrupted sends are never retried automatically: their outcome may be unknown.
  await db
    .from('whatsapp_payment_wait_notices')
    .whereIn('status', ['preparing', 'sending'])
    .where('updated_at', '<', new Date(now.getTime() - 5 * 60_000))
    .update({ status: 'uncertain', updated_at: now })
  return db
    .from('whatsapp_payment_wait_notices')
    .where('status', 'pending')
    .where('due_at', '<=', now)
    .orderBy('due_at', 'asc')
    .limit(10)
}

async function stillNeeded(notice: any, now = new Date()) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.payment.enabled) return false
  if (now.getTime() - new Date(notice.due_at).getTime() > EXPIRY_MS) return false
  const [cart, contact, settings, newer, review] = await Promise.all([
    db.from('whatsapp_carts').where('jid', notice.jid).first(),
    db.from('whatsapp_contacts').where('jid', notice.jid).first(),
    db.from('whatsapp_settings').where('id', 1).first(),
    db
      .from('whatsapp_messages')
      .where('jid', notice.jid)
      .where((query) =>
        query
          .where('id', '>', notice.anchor_id)
          .orWhere((queued) => queued.where('direction', 'out').where('status', 'queued'))
      )
      .whereNot('status', 'failed')
      .first(),
    db
      .from('whatsapp_payment_reviews')
      .where('jid', notice.jid)
      .where('created_at', '>=', notice.created_at)
      .first(),
  ])
  return Boolean(
    isAiWorking(settings) &&
    !contact?.ai_excluded &&
    contact?.handling_mode === 'cs' &&
    cart?.payment_status === 'reported' &&
    (cart.proof_message_id || null) === (notice.proof_message_id || null) &&
    !newer &&
    !review
  )
}

export type WaitNoticeSend = (
  notice: { jid: string; text: string; anchorId: number },
  canSend: () => Promise<boolean>,
  reserveAttempt: (messageId: string) => Promise<boolean>
) => Promise<string | null>

/** One transport attempt maximum, durable across workers/restarts. This never changes handling mode or verifies money. */
export async function deliverPaymentWaitNotice(
  id: string,
  send: WaitNoticeSend,
  ready: () => boolean = () => true,
  now = new Date()
) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.payment.enabled) {
    await db
      .from('whatsapp_payment_wait_notices')
      .where('id', id)
      .where('status', 'pending')
      .update({ status: 'cancelled', updated_at: new Date() })
    return false
  }
  return deliverWaitNotice(id, send, ready, now, {
    table: 'whatsapp_payment_wait_notices',
    needed: stillNeeded,
    text: () => policy.payment.text,
  })
}

/** Shared durable at-most-once delivery; callers provide their own eligibility rules. */
export async function deliverWaitNotice(
  id: string,
  send: WaitNoticeSend,
  ready: () => boolean,
  now: Date,
  kind: {
    table: 'whatsapp_payment_wait_notices' | 'whatsapp_approval_wait_episodes'
    needed: (notice: any) => Promise<boolean>
    text: (notice: any) => string
  }
) {
  if (!ready()) return false
  const claimed = await db
    .from(kind.table)
    .where('id', id)
    .where('status', 'pending')
    .where('due_at', '<=', now)
    .update({ status: 'preparing', updated_at: now })
  if (!Number(claimed)) return false
  const notice = await db.from(kind.table).where('id', id).firstOrFail()
  const update = (status: string) =>
    db.from(kind.table).where('id', id).update({ status, updated_at: new Date() })
  const canSend = async () => ready() && (await kind.needed(notice))
  let attempted = false
  try {
    if (!(await canSend())) {
      await update('cancelled')
      return false
    }
    const messageId = await send(
      { jid: notice.jid, text: kind.text(notice), anchorId: Number(notice.anchor_id) },
      canSend,
      async (outgoingId) => {
        if (!(await canSend())) return false
        const changed = await db
          .from(kind.table)
          .where('id', id)
          .where('status', 'preparing')
          .update({ status: 'sending', message_id: outgoingId, updated_at: new Date() })
        attempted = Number(changed) > 0
        return attempted
      }
    )
    await update(messageId && attempted ? 'sent' : attempted ? 'uncertain' : 'cancelled')
    return Boolean(messageId && attempted)
  } catch {
    await update(attempted ? 'uncertain' : 'cancelled')
    return false
  }
}
