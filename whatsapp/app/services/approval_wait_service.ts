import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { isAiWorking } from '#services/ai_work_schedule'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type { CartItem } from '#services/cart_service'
import { hasCustomMeasurements } from '#services/order_item_details'
import { deliverWaitNotice, type WaitNoticeSend } from '#services/payment_wait_notice_service'
import { readWaitNoticePolicy, type WaitNoticePolicy } from '#services/wait_notice_skill'

export type ApprovalWait = 'model' | 'size' | 'model_size'
export function pendingApprovalRequests(items: CartItem[]) {
  return items.flatMap((item) => [
    ...(item.modelType === 'custom' && item.modelApproval === 'pending'
      ? [{ itemId: item.id, topic: 'model' as const }]
      : []),
    ...(item.size === 'custom' && item.approval === 'pending' && hasCustomMeasurements(item)
      ? [{ itemId: item.id, topic: 'size' as const }]
      : []),
  ])
}
export function pendingApprovalKind(items: CartItem[]): ApprovalWait | null {
  const topics = new Set(pendingApprovalRequests(items).map((request) => request.topic))
  return topics.size === 2
    ? 'model_size'
    : topics.has('model')
      ? 'model'
      : topics.has('size')
        ? 'size'
        : null
}

/** Cart row must be locked first. Sending/CS replies do not close an unresolved approval. */
export async function syncApprovalWaitEpisode(
  trx: TransactionClientContract,
  jid: string,
  items: CartItem[],
  now = new Date()
) {
  const requests = pendingApprovalRequests(items)
  const open = await trx
    .from('whatsapp_approval_wait_episodes')
    .where('jid', jid)
    .where('is_open', true)
    .forUpdate()
    .first()
  if (!open) return null
  if (!requests.length) {
    const latest = await trx
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .orderBy('id', 'desc')
      .first()
    await trx
      .from('whatsapp_approval_wait_episodes')
      .where('id', open.id)
      .update({
        is_open: false,
        anchor_id: latest?.id ?? open.anchor_id,
        status: ['pending', 'preparing'].includes(open.status) ? 'cancelled' : open.status,
        updated_at: now,
      })
    return null
  }
  await trx
    .from('whatsapp_approval_wait_episodes')
    .where('id', open.id)
    .update({ requests_json: JSON.stringify(requests), updated_at: now })
  return { ...open, requests_json: JSON.stringify(requests) }
}

/** Explicit approval handoff only; price, shipping, complaints and sizing questions do not qualify. */
export async function beginApprovalWait(jid: string, requested: ApprovalWait, now = new Date()) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.approval.enabled) return null
  return db.transaction(async (trx) => {
    const cart = await trx.from('whatsapp_carts').where('jid', jid).forUpdate().first()
    if (!cart) return null
    const items = JSON.parse(cart.items_json) as CartItem[]
    const open = await syncApprovalWaitEpisode(trx, jid, items, now)
    const requests = pendingApprovalRequests(items)
    if (!requests.some((r) => requested === 'model_size' || requested === r.topic)) return null
    const anchor = await trx
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'in')
      .orderBy('id', 'desc')
      .first()
    if (!anchor || now.getTime() - new Date(anchor.created_at).getTime() > 5 * 60_000) return null
    if (open) {
      // New discussion in the same open episode never rearms a sent/cancelled notice.
      if (open.status === 'pending' && Number(anchor.id) > Number(open.anchor_id)) {
        await trx
          .from('whatsapp_approval_wait_episodes')
          .where('id', open.id)
          .update({
            anchor_id: anchor.id,
            due_at: new Date(now.getTime() + policy.delay_seconds * 1000),
          })
      }
      return open.id
    }
    const previous = await trx
      .from('whatsapp_approval_wait_episodes')
      .where('jid', jid)
      .orderBy('anchor_id', 'desc')
      .first()
    if (previous && Number(anchor.id) <= Number(previous.anchor_id)) return null
    const id = randomUUID()
    await trx.table('whatsapp_approval_wait_episodes').insert({
      id,
      jid,
      is_open: true,
      start_anchor_id: anchor.id,
      anchor_id: anchor.id,
      requests_json: JSON.stringify(requests),
      status: 'pending',
      due_at: new Date(now.getTime() + policy.delay_seconds * 1000),
      created_at: now,
      updated_at: now,
    })
    return id
  })
}

export async function dueApprovalWaitNotices(now = new Date()) {
  await db
    .from('whatsapp_approval_wait_episodes')
    .whereIn('status', ['preparing', 'sending'])
    .where('updated_at', '<', new Date(now.getTime() - 5 * 60_000))
    .update({ status: 'uncertain', updated_at: now })
  return db
    .from('whatsapp_approval_wait_episodes')
    .where('is_open', true)
    .where('status', 'pending')
    .where('due_at', '<=', now)
    .orderBy('due_at', 'asc')
    .limit(10)
}

async function stillNeeded(notice: any) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.approval.enabled) return false
  const [current, cart, contact, settings, interruption] = await Promise.all([
    db.from('whatsapp_approval_wait_episodes').where('id', notice.id).first(),
    db.from('whatsapp_carts').where('jid', notice.jid).first(),
    db.from('whatsapp_contacts').where('jid', notice.jid).first(),
    db.from('whatsapp_settings').where('id', 1).first(),
    db
      .from('whatsapp_messages')
      .where('jid', notice.jid)
      .whereNot('status', 'failed')
      .where((query) =>
        query
          .where((out) =>
            out
              .where('direction', 'out')
              .where((q) => q.where('id', '>', notice.start_anchor_id).orWhere('status', 'queued'))
          )
          .orWhere((incoming) =>
            incoming.where('direction', 'in').where('id', '>', notice.anchor_id)
          )
      )
      .first(),
  ])
  return Boolean(
    current?.is_open &&
    current.status === 'preparing' &&
    current.requests_json === notice.requests_json &&
    Date.now() - new Date(notice.due_at).getTime() <= 15 * 60_000 &&
    isAiWorking(settings) &&
    !contact?.ai_excluded &&
    contact?.handling_mode === 'cs' &&
    cart &&
    pendingApprovalRequests(JSON.parse(cart.items_json)).length &&
    !interruption
  )
}

export function approvalWaitText(notice: { requests_json: string }, policy: WaitNoticePolicy) {
  const topics = new Set(JSON.parse(notice.requests_json).map((r: any) => r.topic))
  return policy.approval[topics.size === 2 ? 'model_size' : topics.has('model') ? 'model' : 'size']
}

export async function deliverApprovalWaitNotice(
  id: string,
  send: WaitNoticeSend,
  ready: () => boolean = () => true,
  now = new Date()
) {
  const policy = await readWaitNoticePolicy()
  if (!policy?.approval.enabled) {
    await db
      .from('whatsapp_approval_wait_episodes')
      .where('id', id)
      .where('status', 'pending')
      .update({ status: 'cancelled', updated_at: new Date() })
    return false
  }
  return deliverWaitNotice(id, send, ready, now, {
    table: 'whatsapp_approval_wait_episodes',
    needed: stillNeeded,
    text: (notice) => approvalWaitText(notice, policy),
  })
}
