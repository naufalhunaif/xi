import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import { randomUUID } from 'node:crypto'
import { orderNumber } from '#services/order_number'
import { createShippingNotice } from '#services/ai_service'
import { readSettings } from '#services/settings_service'
import type { WaitNoticeSend } from '#services/payment_wait_notice_service'

export async function dueShippingNotices() {
  const stale = new Date(Date.now() - 10 * 60000)
  // Preparing is safe to repeat; sending is not. Reconcile a known outgoing echo.
  await db
    .from('whatsapp_shipping_notices')
    .where('status', 'preparing')
    .where('updated_at', '<', stale)
    .update({ status: 'pending', claim_token: null, updated_at: new Date() })
  const sending = await db
    .from('whatsapp_shipping_notices')
    .whereIn('status', ['sending', 'uncertain'])
    .where('updated_at', '<', stale)
    .limit(30)
  for (const notice of sending) {
    const sent = await db
      .from('whatsapp_messages')
      .where('message_id', notice.message_id)
      .where('jid', notice.jid)
      .where('direction', 'out')
      .whereIn('status', ['sent', 'delivered', 'read'])
      .first()
    await db
      .from('whatsapp_shipping_notices')
      .where('order_id', notice.order_id)
      .whereIn('status', ['sending', 'uncertain'])
      .update({ status: sent ? 'sent' : 'uncertain', updated_at: new Date() })
  }
  const due = await db
    .from('whatsapp_shipping_notices')
    .where('status', 'pending')
    .where('next_attempt_at', '<=', new Date())
    .orderBy('next_attempt_at', 'asc')
    .limit(10)
  const eligible = []
  for (const notice of due) {
    if (await eligibility(notice)) eligible.push(notice)
    else
      await db
        .from('whatsapp_shipping_notices')
        .where('order_id', notice.order_id)
        .where('status', 'pending')
        .update({ next_attempt_at: new Date(Date.now() + 60000) })
  }
  return eligible
}

async function eligibility(notice: any) {
  const [order, op, contact, settings] = await Promise.all([
    db.from('whatsapp_orders').where('id', notice.order_id).first(),
    db.from('whatsapp_order_operations').where('order_id', notice.order_id).first(),
    db.from('whatsapp_contacts').where('jid', notice.jid).first(),
    db.from('whatsapp_settings').where('id', 1).first(),
  ])
  const operations = op ? JSON.parse(op.data_json) : {}
  if (
    order?.status !== 'active' ||
    !['shipped', 'completed'].includes(operations.stage) ||
    operations.trackingNumber !== notice.tracking_number
  )
    return null
  if (!isAiWorking(settings) || contact?.ai_excluded || contact?.handling_mode === 'cs') return null
  return {
    orderNumber: orderNumber(order),
    awb: notice.tracking_number,
    carrier: operations.carrier || '',
  }
}

/** One reserved transport attempt per order. AI/connection failures before reserve retry safely. */
export async function deliverShippingNotice(
  id: string | number,
  send: WaitNoticeSend,
  ready: () => boolean,
  compose = async (facts: { orderNumber: string; awb: string; carrier: string }) => {
    const settings = await readSettings(true)
    if (!settings.hasSkill) throw new Error('Skill belum tersedia.')
    return createShippingNotice(settings, facts)
  }
) {
  if (!ready()) return false
  const notice = await db.from('whatsapp_shipping_notices').where('order_id', id).first()
  if (!notice || !(await eligibility(notice))) return false
  const claimToken = randomUUID()
  const count = await db
    .from('whatsapp_shipping_notices')
    .where('order_id', id)
    .where('status', 'pending')
    .where('next_attempt_at', '<=', new Date())
    .update({
      status: 'preparing',
      claim_token: claimToken,
      updated_at: new Date(),
      attempts: Number(notice.attempts) + 1,
    })
  if (!Number(count)) return false
  let attempted = false
  let reservedId: string | null = null
  const canSend = async () =>
    ready() &&
    Boolean(await eligibility(notice)) &&
    Boolean(
      await db
        .from('whatsapp_shipping_notices')
        .where('order_id', id)
        .where('claim_token', claimToken)
        .where('status', 'preparing')
        .first()
    )
  const update = (status: string, extra: Record<string, unknown> = {}) =>
    db
      .from('whatsapp_shipping_notices')
      .where('order_id', id)
      .where('claim_token', claimToken)
      .update({ status, updated_at: new Date(), ...extra })
  try {
    const facts = await eligibility(notice)
    if (!facts) {
      await update('pending')
      return false
    }
    const text = notice.body || (await compose(facts))
    const anchor = await db
      .from('whatsapp_messages')
      .where('jid', notice.jid)
      .where('direction', 'in')
      .orderBy('id', 'desc')
      .first()
    const messageId = await send(
      { jid: notice.jid, text, anchorId: Number(anchor?.id || 0) },
      canSend,
      async (id) => {
        if (!(await canSend())) return false
        const saved = await db
          .from('whatsapp_shipping_notices')
          .where('order_id', notice.order_id)
          .where('claim_token', claimToken)
          .where('status', 'preparing')
          .update({ status: 'sending', body: text, message_id: id, updated_at: new Date() })
        attempted = Number(saved) > 0
        if (attempted) reservedId = id
        return attempted
      }
    )
    if (messageId && attempted && messageId === reservedId) {
      await update('sent')
      return true
    }
    await update(attempted ? 'uncertain' : 'pending', {
      next_attempt_at: new Date(Date.now() + 60000),
    })
  } catch {
    await update(attempted ? 'uncertain' : 'pending', {
      next_attempt_at: new Date(Date.now() + 60000),
    })
  }
  return false
}
