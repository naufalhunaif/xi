import { randomUUID } from 'node:crypto'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'

export async function shippingStatesForOrders(ids: number[]) {
  if (!ids.length) return new Map<number, any>()
  const worker = await db
    .from('whatsapp_connection')
    .where('id', 1)
    .select('worker_heartbeat_at')
    .first()
  const heartbeatAge = worker?.worker_heartbeat_at
    ? Date.now() - new Date(worker.worker_heartbeat_at).getTime()
    : Infinity
  const workerActive = heartbeatAge >= -5000 && heartbeatAge < 20000
  const rows = await db
    .from('whatsapp_order_shipping_jobs as j')
    .leftJoin('whatsapp_shipping_notices as n', 'n.order_id', 'j.order_id')
    .whereIn('j.order_id', ids)
    .select(
      'j.order_id',
      'j.status',
      'j.progress_phase',
      'j.agent_state_json',
      'j.attempts',
      'j.next_attempt_at',
      'j.updated_at',
      'j.lease_until',
      'j.last_error_code',
      'j.tracking_number',
      'n.status as notice_status'
    )
  return new Map(
    rows.map((row) => [
      Number(row.order_id),
      {
        status: row.status,
        workerActive,
        phase: row.progress_phase || null,
        assessment: row.agent_state_json ? JSON.parse(row.agent_state_json) : null,
        attempts: Number(row.attempts || 0),
        nextAttemptAt: row.next_attempt_at,
        updatedAt: row.updated_at,
        leaseUntil: row.lease_until,
        errorCode: row.last_error_code || null,
        trackingNumber: row.tracking_number || '',
        noticeStatus: row.notice_status || null,
      },
    ])
  )
}

/** Caller must lock the order first, then its operations, in the same transaction.
 * This is a durable intent only: no shipment or customer message is created here.
 */
export async function queueOrderShipment(
  order: { id: number; status: string },
  operations: { stage: string; trackingNumber?: string; externalId?: string },
  trx: TransactionClientContract
) {
  if (order.status !== 'active' || !['ready', 'shipped'].includes(operations.stage)) return
  if (operations.stage === 'shipped' && !operations.trackingNumber) return
  const existing = await trx
    .from('whatsapp_order_shipping_jobs')
    .where('order_id', order.id)
    .first()
  // Never reset an existing attempt, tracking reference or uncertain outcome on restart.
  if (existing) return
  const now = new Date()
  await trx.table('whatsapp_order_shipping_jobs').insert({
    order_id: order.id,
    request_key: randomUUID(),
    status: operations.trackingNumber || operations.externalId ? 'reconciling' : 'queued',
    tracking_number: operations.trackingNumber || null,
    external_id: operations.externalId || null,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
  })
}

/** Backfill ready orders from older builds. Bounded and repeatable, including
 * when WhatsApp is temporarily offline. Always recheck under the same order lock
 * used by status changes/cancellation; two workers cannot enqueue twice.
 */
export async function recoverOrderShippingQueue() {
  await initializeDatabase()
  const candidates = await db
    .from('whatsapp_orders as o')
    .join('whatsapp_order_operations as p', 'p.order_id', 'o.id')
    .leftJoin('whatsapp_order_shipping_jobs as j', 'j.order_id', 'o.id')
    .where('o.status', 'active')
    .whereNull('j.order_id')
    .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(p.data_json, '$.stage')) IN (?, ?)", ['ready', 'shipped'])
    .select('o.id')
    .orderBy('o.id', 'asc')
    .limit(100)
  for (const candidate of candidates) {
    await db.transaction(async (trx) => {
      const order = await trx.from('whatsapp_orders').where('id', candidate.id).forUpdate().first()
      if (!order || order.status !== 'active') return
      const operations = await trx
        .from('whatsapp_order_operations')
        .where('order_id', order.id)
        .forUpdate()
        .first()
      if (operations) await queueOrderShipment(order, JSON.parse(operations.data_json), trx)
    })
  }
}
