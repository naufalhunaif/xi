import { DateTime } from 'luxon'
import type { Operations } from '#services/order_operations_service'
import type { ProductionPolicy } from '#services/production_contract'

/** Production milestones are operator actions, never inferred from elapsed time. */
export function nextProductionStage(op: Operations): Operations['stage'] | null {
  if (['unverified', 'awaiting_details'].includes(op.stage)) return 'queued'
  if (op.stage === 'queued') return op.kind === 'standard' ? 'ready' : 'production'
  if (['production', 'qc'].includes(op.stage)) return 'ready'
  // An AWB number alone must never advance an order to shipped.
  return null
}

type Order = { paid: number | string; total: number | string; snapshot_json: string }
/** The owner defines confirmed, complete orders as entering production immediately. */
export function startConfirmedProduction(
  before: Operations,
  order: Order,
  now = DateTime.now().setZone('Asia/Jakarta')
): Operations {
  if (
    !['unverified', 'awaiting_details', 'queued'].includes(before.stage) ||
    !(Number(order.paid) > 0)
  )
    return before
  const snapshot = JSON.parse(order.snapshot_json)
  if (
    !snapshot.items?.length ||
    !snapshot.recipient?.name ||
    !snapshot.recipient?.phone ||
    !snapshot.recipient?.address ||
    !snapshot.shipping?.service
  )
    return before
  if (
    before.estimate?.startsAfter === 'full_payment_details' &&
    Number(order.paid) < Number(order.total)
  )
    return before
  return {
    ...before,
    stage: 'production',
    startedOn: before.startedOn || now.toISODate(),
    source: 'verified_payment',
  }
}
export function progressProduction(
  before: Operations,
  order: Order,
  policy: ProductionPolicy,
  now = DateTime.now().setZone('Asia/Jakarta')
): Operations {
  const stage = nextProductionStage(before)
  if (!stage)
    throw new Error('Tahap berikutnya memerlukan konfirmasi pengiriman, bukan perubahan produksi.')
  const snapshot = JSON.parse(order.snapshot_json)
  if (
    !snapshot.items?.length ||
    !snapshot.recipient?.name ||
    !snapshot.recipient?.phone ||
    !snapshot.recipient?.address ||
    !snapshot.shipping?.service
  )
    throw new Error('Lengkapi detail penerima dan pengiriman terlebih dahulu.')
  if (!(Number(order.paid) > 0)) throw new Error('Pembayaran belum terverifikasi.')
  const next = { ...before, stage, source: 'operator' }
  if (!next.estimate && next.kind !== 'standard') {
    const rule = policy.rules[next.kind]
    if (rule?.enabled && rule.estimateDays) {
      next.estimate = { ...rule }
      next.policyVersion = policy.version
    }
  }
  const rule = next.estimate
  if (rule?.startsAfter === 'full_payment_details' && Number(order.paid) < Number(order.total))
    throw new Error('Produksi menunggu pelunasan sesuai pengaturan.')
  if (stage === 'production' && !next.startedOn) next.startedOn = now.toISODate()
  if (rule && !next.eligibleAt && (rule.startsAfter !== 'approval' || stage === 'production'))
    next.eligibleAt = now.toISO()
  if (rule?.dayType === 'calendar' && rule.estimateDays && next.eligibleAt && !next.expectedReadyOn)
    next.expectedReadyOn = DateTime.fromISO(next.eligibleAt, { zone: 'Asia/Jakarta' })
      .plus({ days: rule.estimateDays })
      .toISODate()
  // Working-day rules remain a duration: no invented holiday/workweek calendar.
  return next
}
