import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import db from '#services/workspace_database'
import { recoverOrderShippingQueue } from '#services/order_shipping_queue'
import { withOrion } from '#services/orion_shipping_client'
import { orderNumber } from '#services/order_number'
import { conversationShippingAgent } from '#services/conversation_shipping_agent'
import type {
  ShipmentAgent,
  ShipmentAgentFactory,
  ShipmentState,
} from '#services/shipment_agent_contract'
import { AiProcessFailure } from '#services/ai_failure_service'
import { findRejectedWeightAttempt } from '#services/orion_rejection_evidence'
import {
  ShippingError,
  orionTrackingData,
  awbNumber,
  findOrionAwb,
  orionData,
  prepareOrionShipment,
  shipmentMovement,
  shipmentDelivery,
  unwrap,
  type OrionCall,
} from '#services/orion_shipping_contract'

type Adapter = <T>(action: (call: OrionCall, slug: string) => Promise<T>) => Promise<T>
const states = [
  'queued',
  'processing',
  'retry',
  'reconciling',
  'waiting_pickup',
  'waiting_ready',
  'shipped',
]
const now = () => new Date()

export async function nextShipmentConversation(jid?: string) {
  await recoverOrderShippingQueue()
  const query = db
    .from('whatsapp_order_shipping_jobs as j')
    .join('whatsapp_orders as o', 'o.id', 'j.order_id')
    .leftJoin('whatsapp_contacts as c', 'c.jid', 'o.jid')
    .whereIn('j.status', states)
    .where('j.next_attempt_at', '<=', now())
    .where((q) => q.whereNull('j.lease_until').orWhere('j.lease_until', '<', now()))
    .where((q) => q.whereNull('c.handling_mode').orWhereNot('c.handling_mode', 'cs'))
    .where((q) => q.whereNull('c.ai_excluded').orWhere('c.ai_excluded', false))
    .select('j.order_id', 'o.jid')
    .orderBy('j.next_attempt_at', 'asc')
    .orderBy('j.order_id', 'asc')
  if (jid) query.where('o.jid', jid)
  return query.first()
}

async function claim(jid?: string) {
  const candidate = await nextShipmentConversation(jid)
  if (!candidate) return null
  return db.transaction(async (trx) => {
    const order = await trx
      .from('whatsapp_orders')
      .where('id', candidate.order_id)
      .forUpdate()
      .first()
    const op = await trx
      .from('whatsapp_order_operations')
      .where('order_id', candidate.order_id)
      .forUpdate()
      .first()
    const job = await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', candidate.order_id)
      .forUpdate()
      .first()
    if (
      !job ||
      !states.includes(job.status) ||
      new Date(job.next_attempt_at) > now() ||
      (job.lease_until && new Date(job.lease_until) > now())
    )
      return null
    if (!order || order.status !== 'active') {
      await trx
        .from('whatsapp_order_shipping_jobs')
        .where('order_id', job.order_id)
        .update({ status: 'cancelled', updated_at: now() })
      return null
    }
    const operations = op ? JSON.parse(op.data_json) : {}
    if (!['ready', 'shipped'].includes(operations.stage)) {
      await trx
        .from('whatsapp_order_shipping_jobs')
        .where('order_id', job.order_id)
        .update({
          status: operations.stage === 'completed' ? 'completed' : 'waiting_ready',
          next_attempt_at: new Date(Date.now() + 60000),
          updated_at: now(),
        })
      return null
    }
    const lease = randomUUID()
    await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .update({
        lease_token: lease,
        lease_until: new Date(Date.now() + 600000),
        status: 'processing',
        progress_phase: 'connecting',
        last_error_code: null,
        attempts: Number(job.attempts) + 1,
        updated_at: now(),
      })
    return {
      ...job,
      attempts: Number(job.attempts) + 1,
      lease_token: lease,
      order,
      operations,
      version: op.version,
    }
  })
}

async function release(job: any, status: string, error: string | null = null, delay = 60000) {
  await db
    .from('whatsapp_order_shipping_jobs')
    .where('order_id', job.order_id)
    .where('lease_token', job.lease_token)
    .update({
      status,
      progress_phase: null,
      last_error_code: error,
      next_attempt_at: new Date(Date.now() + delay),
      lease_token: null,
      lease_until: null,
      updated_at: now(),
    })
}

async function reserveCreate(job: any) {
  await db.transaction(async (trx) => {
    const order = await trx
      .from('whatsapp_orders')
      .where('id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const op = await trx
      .from('whatsapp_order_operations')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const current = await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    if (
      current.lease_token !== job.lease_token ||
      new Date(current.lease_until) <= now() ||
      current.create_started_at
    )
      throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
    const operations = JSON.parse(op.data_json)
    if (
      order.status !== 'active' ||
      operations.stage !== 'ready' ||
      operations.trackingNumber ||
      order.snapshot_json !== job.order.snapshot_json ||
      op.version !== job.version
    )
      throw new ShippingError('SHIPPING_ORDER_CHANGED')
    await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .update({ create_started_at: now(), updated_at: now() })
    job.create_started_at = now()
  })
}

async function recoverRejectedCreation(job: any, auditId: string) {
  await db.transaction(async (trx) => {
    const order = await trx
      .from('whatsapp_orders')
      .where('id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const op = await trx
      .from('whatsapp_order_operations')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const current = await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const consumed: string[] = JSON.parse(current.rejected_attempt_ids_json || '[]')
    if (current.lease_token !== job.lease_token || new Date(current.lease_until) <= now())
      throw new ShippingError('SHIPPING_LEASE_LOST')
    if (
      consumed.includes(auditId) ||
      !current.create_started_at ||
      current.tracking_number ||
      current.external_id ||
      order.status !== 'active' ||
      order.snapshot_json !== job.order.snapshot_json ||
      op.version !== job.version ||
      JSON.parse(op.data_json).stage !== 'ready'
    )
      throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
    const evidence = [...consumed, auditId]
    await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .update({
        create_started_at: null,
        rejected_attempt_ids_json: JSON.stringify(evidence),
        last_error_code: null,
        updated_at: now(),
      })
    job.create_started_at = null
    job.status = 'queued'
    job.rejected_attempt_ids_json = JSON.stringify(evidence)
  })
}

async function record(
  job: any,
  awb: string,
  source: string,
  movement: ReturnType<typeof shipmentMovement> = null,
  delivery: ReturnType<typeof shipmentDelivery> = null
) {
  return db.transaction(async (trx) => {
    const order = await trx
      .from('whatsapp_orders')
      .where('id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const op = await trx
      .from('whatsapp_order_operations')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    const current = await trx
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .forUpdate()
      .firstOrFail()
    if (current.lease_token !== job.lease_token) throw new ShippingError('SHIPPING_LEASE_LOST')
    const before = JSON.parse(op.data_json)
    if (before.trackingNumber && before.trackingNumber !== awb)
      throw new ShippingError('TRACKING_ID_MISMATCH')
    const status =
      order.status !== 'active'
        ? 'cancelled'
        : before.stage === 'completed' || delivery
          ? 'completed'
          : movement || before.stage === 'shipped'
            ? 'shipped'
            : 'waiting_pickup'
    await trx.from('whatsapp_order_shipping_jobs').where('order_id', job.order_id).update({
      tracking_number: awb,
      status,
      last_error_code: null,
      updated_at: now(),
    })
    if (order.status !== 'active') return 'cancelled'
    if (before.stage === 'completed') return 'completed'
    if (!['ready', 'shipped'].includes(before.stage)) return 'waiting_ready'
    const next = {
      ...before,
      trackingNumber: awb,
      externalSource: source,
      externalId: awb,
      source: 'orion',
      ...(movement
        ? {
            stage: delivery ? 'completed' : 'shipped',
            shippedOn:
              before.shippedOn || DateTime.fromISO(movement.at).setZone('Asia/Jakarta').toISODate(),
            ...(delivery ? { deliveredAt: delivery.at } : {}),
          }
        : {}),
    }
    if (JSON.stringify(before) !== JSON.stringify(next)) {
      await trx
        .from('whatsapp_order_operations')
        .where('order_id', job.order_id)
        .update({
          data_json: JSON.stringify(next),
          version: randomUUID(),
          updated_at: now(),
        })
      await trx.table('whatsapp_order_operation_events').insert({
        order_id: job.order_id,
        actor: 'orion',
        before_json: JSON.stringify({ operations: before }),
        after_json: JSON.stringify({
          operations: next,
          ...(movement ? { movement } : {}),
          ...(delivery ? { delivery } : {}),
        }),
        created_at: now(),
      })
    }
    if (delivery) {
      // Do not send a stale "just shipped" notice after confirmed delivery.
      await trx
        .from('whatsapp_shipping_notices')
        .where('order_id', job.order_id)
        .where('status', 'pending')
        .update({ status: 'cancelled', updated_at: now() })
    } else if (movement) {
      await trx.rawQuery(
        `INSERT IGNORE INTO whatsapp_shipping_notices
        (order_id,jid,tracking_number,status,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,'pending',?,?,?)`,
        [job.order_id, order.jid, awb, now(), now(), now()]
      )
    }
    return 'ok'
  })
}

/** Worker entry point. Network work is outside SQL locks. No ambiguous create is retried:
 * after a crash/timeout only exact-reference lookup may recover the existing AWB.
 */
export async function processNextShipment(
  adapter: Adapter = withOrion,
  factory: ShipmentAgentFactory = conversationShippingAgent,
  jid?: string
) {
  const job = await claim(jid)
  if (!job) return false
  // Use the same reference shown on the WhatsApp invoice, including legacy WA numbers.
  // The request UUID remains stable so attempts from older releases can be reconciled.
  const reference = orderNumber(job.order)
  let awb = job.tracking_number || job.operations.trackingNumber || ''
  let agent: ShipmentAgent | null = null
  let checked = false
  let payload: Awaited<ReturnType<typeof prepareOrionShipment>> | null = null
  let lastError: string | null = job.last_error_code || null
  let trackingAttempted = false
  const observations: unknown[] = []
  const uncertain = () =>
    Boolean(job.create_started_at || job.status === 'reconciling' || job.external_id)
  const persistAssessment = async (value: unknown) => {
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', job.order_id)
      .where('lease_token', job.lease_token)
      .update({ agent_state_json: JSON.stringify(value), updated_at: now() })
  }
  try {
    agent = await factory(job)
    if (!agent) {
      await release(job, job.status, job.last_error_code || null, 60000)
      return false
    }
    // Every action is chosen by the conversation AI. The bridge owns verified parameters
    // and the irreversible-create fence; model output can never reset an uncertain attempt.
    for (let step = 0; step < 6; step++) {
      if (!(await agent.allowed())) throw new ShippingError('SHIPPING_CONTEXT_CHANGED')
      const owned = await db
        .from('whatsapp_order_shipping_jobs')
        .where('order_id', job.order_id)
        .where('lease_token', job.lease_token)
        .where('lease_until', '>', now())
        .update({ progress_phase: 'analysis', updated_at: now() })
      if (!Number(owned)) throw new ShippingError('SHIPPING_LEASE_LOST')
      const state: ShipmentState = {
        invoice: reference,
        awb,
        uncertain: uncertain(),
        checked,
        prepared: Boolean(payload),
        lastError,
        observations,
      }
      // Once an AWB is known, tracking is a required continuation, not another
      // optional model turn that could choose wait or consume an AI quota.
      const automaticTracking = Boolean(awb)
      const decision = automaticTracking
        ? {
            tool: 'track_awb' as const,
            reason: 'Resi tersedia; langsung memeriksa perjalanan paket.',
            waitingFor: '',
            nextAction: 'track_awb',
          }
        : await agent.decide(state)
      if (!(await agent.allowed())) throw new ShippingError('SHIPPING_CONTEXT_CHANGED')
      await persistAssessment({ ...decision, checkedAt: now().toISOString() })
      agent.emit({
        key: `shipment-decision-${step}`,
        label: automaticTracking ? 'Melanjutkan tracking resi' : 'Keputusan pengiriman AI',
        status: 'completed',
        detail: decision,
      })
      if (decision.tool === 'wait') {
        await release(
          job,
          awb ? 'waiting_pickup' : uncertain() ? 'reconciling' : 'retry',
          lastError,
          300000
        )
        await agent.finish('completed', { decision: 'silent', orderId: job.order_id, ...decision })
        return true
      }
      try {
        const done = await adapter(async (invoke, slug) => {
          const phases: Record<string, string> = {
            list_orion_data: 'lookup',
            search_destinations: 'destination',
            get_orion_data: 'destination',
            check_shipping_rates: 'rates',
            create_awb: 'creating',
            track_awb: 'tracking',
          }
          const call: OrionCall = async (name, args) => {
            if (!(await agent!.allowed())) throw new ShippingError('SHIPPING_CONTEXT_CHANGED')
            const updated = await db
              .from('whatsapp_order_shipping_jobs')
              .where('order_id', job.order_id)
              .where('lease_token', job.lease_token)
              .where('lease_until', '>', now())
              .update({
                status: 'processing',
                progress_phase: phases[name] || 'checking',
                updated_at: now(),
              })
            if (!Number(updated)) throw new ShippingError('SHIPPING_LEASE_LOST')
            const key = `shipment-tool-${step}-${name}-${Date.now()}`
            agent!.emit({
              key,
              label: `${slug} · ${name}`,
              status: 'running',
              detail: { parameters: args },
            })
            try {
              const result = await invoke(name, args)
              agent!.emit({
                key,
                label: `${slug} · ${name}`,
                status: result?.isError ? 'failed' : 'completed',
                // Do not expose audit records belonging to unrelated customers.
                detail: args.resource === 'mcp_activity' ? { auditChecked: true } : { result },
              })
              return result
            } catch (error) {
              agent!.emit({
                key,
                label: `${slug} · ${name}`,
                status: 'failed',
                detail: { code: error instanceof ShippingError ? error.code : 'ORION_UNAVAILABLE' },
              })
              throw error
            }
          }
          if (decision.tool === 'list_orion_data') {
            const existing = new Set<string>()
            for (const lookup of new Set([reference, job.request_key])) {
              const found = await findOrionAwb(call, lookup)
              if (found) existing.add(awbNumber(found))
            }
            if (existing.size > 1) throw new ShippingError('MULTIPLE_AWBS')
            if (existing.size) {
              const found = [...existing][0]
              if (awb && awb !== found) throw new ShippingError('TRACKING_ID_MISMATCH')
              awb = found
              await record(job, awb, slug)
            }
            checked = true
            observations.push({ tool: decision.tool, awb: awb || null, found: existing.size > 0 })
            if (!awb && job.create_started_at && !job.external_id) {
              const rejection = await findRejectedWeightAttempt(
                call,
                [reference, job.request_key],
                JSON.parse(job.order.snapshot_json),
                JSON.parse(job.rejected_attempt_ids_json || '[]')
              )
              if (rejection) {
                await recoverRejectedCreation(job, rejection)
                observations.push({
                  tool: decision.tool,
                  validationRejected: true,
                  rejection: 'WEIGHT_UNIT_REJECTED',
                  recovered: true,
                  next: 'prepare_awb',
                  weightUnit: 'grams',
                })
                agent!.emit({
                  key: `shipment-recovery-${step}`,
                  label: 'Penolakan berat terverifikasi · menyiapkan ulang',
                  status: 'completed',
                  detail: { auditId: rejection, code: 'WEIGHT_UNIT_REJECTED' },
                })
              }
            }
          } else if (decision.tool === 'prepare_awb') {
            if (awb || uncertain()) throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
            payload = await prepareOrionShipment(
              call,
              JSON.parse(job.order.snapshot_json),
              reference
            )
            observations.push({ tool: decision.tool, verified: true, payload })
          } else if (decision.tool === 'create_awb') {
            if (awb || uncertain()) throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
            if (!checked || !payload) throw new ShippingError('SHIPPING_PREFLIGHT_REQUIRED')
            await reserveCreate(job)
            const created = unwrap(orionData(await call('create_awb', { data: payload })))
            if (created.order_id && String(created.order_id) !== reference)
              throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
            awb = awbNumber(created)
            if (!awb) throw new ShippingError('AWB_RECONCILIATION_REQUIRED')
            observations.push({ tool: decision.tool, awb })
            await record(job, awb, slug)
          }
          if (decision.tool === 'track_awb' && !awb)
            throw new ShippingError('SHIPPING_AWB_REQUIRED')
          // Create and exact lookup both continue here in the same run.
          if (awb) {
            const ready = await record(job, awb, slug)
            if (ready !== 'ok') {
              await release(job, ready)
              return true
            }
            trackingAttempted = true
            const tracking = orionTrackingData(await call('track_awb', { awb }), awb)
            const movement = shipmentMovement(tracking, awb, new Date(job.order.created_at))
            const delivery = shipmentDelivery(tracking, awb, new Date(job.order.created_at))
            const tracked = await record(job, awb, slug, movement, delivery)
            observations.push({
              tool: 'track_awb',
              awb,
              movement,
              delivery,
              waitingFor: delivery ? '' : movement ? 'delivery' : 'shipping_update',
            })
            await persistAssessment({
              tool: 'track_awb',
              waitingFor: delivery ? '' : movement ? 'delivery' : 'shipping_update',
              nextAction: delivery ? 'completed' : 'track_awb',
              checkedAt: now().toISOString(),
            })
            await release(
              job,
              tracked !== 'ok'
                ? tracked
                : delivery
                  ? 'completed'
                  : movement
                    ? 'shipped'
                    : 'waiting_pickup',
              null,
              movement ? 30 * 60000 : 120000
            )
            return true
          }
          return false
        })
        lastError = null
        if (done) {
          await agent.finish('completed', {
            decision: 'silent',
            orderId: job.order_id,
            observations,
          })
          return true
        }
      } catch (error) {
        // Keep the known AWB and defer a failed tracking call; never hammer the
        // carrier or ask the model to recreate the shipment in this run.
        if (trackingAttempted) throw error
        if (
          error instanceof AiProcessFailure ||
          (error instanceof ShippingError &&
            ['SHIPPING_CONTEXT_CHANGED', 'SHIPPING_LEASE_LOST', 'SHIPPING_ORDER_CHANGED'].includes(
              error.code
            ))
        )
          throw error
        lastError = error instanceof ShippingError ? error.code : 'SHIPPING_UNAVAILABLE'
        observations.push({ tool: decision.tool, error: lastError })
        if (lastError === 'MULTIPLE_AWBS' || lastError === 'TRACKING_ID_MISMATCH') throw error
      }
    }
    throw new ShippingError(lastError || 'SHIPPING_AGENT_STEP_LIMIT')
  } catch (error) {
    const code =
      error instanceof ShippingError
        ? error.code
        : error instanceof AiProcessFailure
          ? error.detail.code
          : 'SHIPPING_AI_FAILED'
    await agent?.finish(code === 'SHIPPING_CONTEXT_CHANGED' ? 'cancelled' : 'failed', {
      orderId: job.order_id,
      error: code,
      ...(error instanceof AiProcessFailure ? { failure: error.detail } : {}),
    })
    await release(
      job,
      job.create_started_at && !awb ? 'reconciling' : awb ? 'waiting_pickup' : 'retry',
      code,
      Math.min(900000, 15000 * 2 ** Math.min(job.attempts - 1, 6))
    )
  }
  return true
}
