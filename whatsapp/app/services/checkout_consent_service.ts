import type { Cart } from '#services/cart_service'
import { orderMessages } from '#services/order_message_evidence'
import { reviewedContinuity, type CheckoutContinuity } from '#services/checkout_continuity'
import {
  acceptsCheckout,
  balanceExplanation,
  checkoutFingerprint,
  checkoutFollowup,
  matchesCheckoutRecap,
} from '#services/balance_checkout_evidence'

const reasons = {
  MESSAGE_NOT_FOUND: 'Pesan persetujuan atau rekap tidak ditemukan di percakapan ini.',
  INVALID_RECAP_SOURCE: 'Rekap belum tercatat terkirim oleh CS atau AI.',
  NOT_AN_ACCEPTANCE: 'Pesan yang dipilih bukan persetujuan pesanan.',
  INVALID_CHRONOLOGY: 'Persetujuan mendahului rekap atau rekap sudah ditutup.',
  CART_CHANGED: 'Rincian cart berbeda dari rekap yang disetujui.',
  RECAP_MISMATCH: 'Isi rekap belum cocok dengan item, ukuran, ongkir, atau total cart.',
  NEW_DETAILS: 'Ada sumber detail produk baru setelah rekap.',
  UNRELATED_REPLY:
    'Persetujuan yang dipilih membalas topik lain, bukan rekap atau pemakaian saldo.',
  HISTORY_TOO_LONG: 'Riwayat setelah rekap terlalu panjang untuk diverifikasi sekaligus.',
  CUSTOMER_MESSAGE_NEEDS_REVIEW:
    'Ada pesan pelanggan setelah rekap yang belum dapat dipastikan bukan perubahan pesanan.',
  CS_MESSAGE_NEEDS_REVIEW:
    'Ada pesan CS setelah rekap yang perlu diperiksa terhadap rincian pesanan.',
} as const
export type CheckoutConsentIssue = {
  code: keyof typeof reasons
  message: string
  confirmationMessageId: string
  recapMessageId: string
  blockingMessageId?: string
}
export class CheckoutConsentError extends Error {
  readonly code = 'CHECKOUT_CONFIRMATION_REQUIRED'
  readonly stage = 'checkout'
  constructor(readonly issues: CheckoutConsentIssue[]) {
    super(issues[0]?.message || 'Bukti persetujuan pesanan belum ditemukan; saldo belum dipakai.')
  }
  get detail() {
    return {
      stage: this.stage,
      code: this.code,
      message: this.message,
      issues: this.issues,
      balanceSpent: false,
    }
  }
}
type Consent = { confirmationMessageId: string; recapMessageId: string; fingerprint: string }
const sent = (row: any) =>
  row.direction === 'out' &&
  ['ai', 'cs', 'owner'].includes(row.sender_type) &&
  ['sent', 'delivered', 'read'].includes(row.status)

/** Caller holds the cart row lock. Persist consent independently of the current chat turn. */
export async function resolveCheckoutConsent(
  trx: any,
  cart: Cart,
  requested?: { confirmationMessageId: string; recapMessageId: string }
): Promise<Consent | null> {
  const fingerprint = checkoutFingerprint(cart)
  const boundary = await trx
    .from('whatsapp_cart_events')
    .where('jid', cart.jid)
    .whereRaw(
      "(action = 'cancelled' OR (action = 'payment_confirmed' AND JSON_EXTRACT(summary_json, '$.cartCleared') = true))"
    )
    .orderBy('id', 'desc')
    .first()
  const events = await trx
    .from('whatsapp_cart_events')
    .where('jid', cart.jid)
    .whereIn('action', ['checkout_accepted', 'balance_recap', 'checkout_context_reviewed'])
    .orderBy('id', 'desc')
    .limit(200)
  const reviews: CheckoutContinuity[] = events
    .filter((event: any) => event.action === 'checkout_context_reviewed')
    .map((event: any) => JSON.parse(event.summary_json))
    .filter((review: CheckoutContinuity) => review.fingerprint === fingerprint)
  const bindings = events
    .filter((event: any) => event.action !== 'checkout_context_reviewed')
    .map((event: any) => ({
      ...JSON.parse(event.summary_json),
      action: event.action,
    }))
  const query = orderMessages(trx).where('jid', cart.jid).whereNotIn('status', ['failed', 'queued'])
  if (boundary) query.where('created_at', '>', boundary.created_at)
  const recent = (await query.orderBy('id', 'desc').limit(200)).reverse()
  const candidates: Array<{ confirmationMessageId: string; recapMessageId: string }> = [
    ...(requested ? [requested] : []),
    ...bindings
      .filter((b: any) => b.action === 'checkout_accepted' && b.fingerprint === fingerprint)
      .map((b: any) => ({
        confirmationMessageId: b.confirmationMessageId,
        recapMessageId: b.recapMessageId,
      })),
  ]
  for (const confirmation of [...recent].reverse()) {
    if (confirmation.direction !== 'in' || !acceptsCheckout(confirmation.body || '')) continue
    const outgoing = recent.filter((r: any) => sent(r) && Number(r.id) < Number(confirmation.id))
    const parent = confirmation.reply_to_message_id
      ? outgoing.find((r: any) => r.message_id === confirmation.reply_to_message_id)
      : outgoing.at(-1)
    if (!parent) continue
    const recap = matchesCheckoutRecap(cart, parent.body || '')
      ? parent
      : balanceExplanation(cart, parent.body || '')
        ? [...outgoing]
            .reverse()
            .find(
              (r: any) =>
                Number(r.id) < Number(parent.id) && matchesCheckoutRecap(cart, r.body || '')
            )
        : null
    if (recap)
      candidates.push({
        confirmationMessageId: confirmation.message_id,
        recapMessageId: recap.message_id,
      })
  }
  const issues: CheckoutConsentIssue[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const key = `${candidate.confirmationMessageId}:${candidate.recapMessageId}`
    if (seen.has(key)) continue
    seen.add(key)
    const reject = (code: keyof typeof reasons, blockingMessageId?: string) => {
      if (issues.length < 20)
        issues.push({
          ...candidate,
          code,
          message: reasons[code],
          ...(blockingMessageId ? { blockingMessageId } : {}),
        })
    }
    const confirmation = await orderMessages(trx)
      .where({ jid: cart.jid, message_id: candidate.confirmationMessageId, direction: 'in' })
      .first()
    const recap = await orderMessages(trx)
      .where({ jid: cart.jid, message_id: candidate.recapMessageId })
      .first()
    if (!confirmation || !recap) {
      reject('MESSAGE_NOT_FOUND')
      continue
    }
    if (!sent(recap)) {
      reject('INVALID_RECAP_SOURCE')
      continue
    }
    if (!acceptsCheckout(confirmation.body || '')) {
      reject('NOT_AN_ACCEPTANCE')
      continue
    }
    if (
      Number(confirmation.id) <= Number(recap.id) ||
      (boundary && new Date(recap.created_at).getTime() <= new Date(boundary.created_at).getTime())
    ) {
      reject('INVALID_CHRONOLOGY')
      continue
    }
    const previous = bindings.find((b: any) => b.recapMessageId === candidate.recapMessageId)
    if (previous && previous.fingerprint !== fingerprint) {
      reject('CART_CHANGED')
      continue
    }
    if (!previous && !matchesCheckoutRecap(cart, recap.body || '')) {
      reject('RECAP_MISMATCH')
      continue
    }
    const accepted = bindings.find(
      (b: any) =>
        b.action === 'checkout_accepted' &&
        b.confirmationMessageId === candidate.confirmationMessageId &&
        b.recapMessageId === candidate.recapMessageId &&
        b.fingerprint === fingerprint
    )
    if (!accepted) {
      // Proof of the model/price must predate the recap. Later acknowledgments aren't new design evidence.
      const sources = cart.items
        .flatMap((item) => [
          item.referenceMessageId,
          item.priceMessageId,
          ...(item.productionDetails?.sourceMessageIds || []),
        ])
        .filter(Boolean)
      const laterSources = sources.length
        ? await orderMessages(trx)
            .where('jid', cart.jid)
            .whereIn('message_id', sources)
            .where('id', '>', recap.id)
        : []
      const newDetail = laterSources.find((r: any) => !acceptsCheckout(r.body || ''))
      if (newDetail) {
        reject('NEW_DETAILS', newDetail.message_id)
        continue
      }
      const priorOutgoing = await orderMessages(trx)
        .where({ jid: cart.jid, direction: 'out' })
        .where('id', '<', confirmation.id)
        .whereNotIn('status', ['failed', 'queued'])
        .orderBy('id', 'desc')
        .first()
      const parent = confirmation.reply_to_message_id
        ? await orderMessages(trx)
            .where({ jid: cart.jid, message_id: confirmation.reply_to_message_id })
            .first()
        : priorOutgoing
      if (
        !parent ||
        (parent.message_id !== recap.message_id &&
          !(sent(parent) && balanceExplanation(cart, parent.body || '')))
      ) {
        reject('UNRELATED_REPLY', parent?.message_id)
        continue
      }
    }
    // Check every intervening customer request, including cancellations not yet reflected in cart.
    const after = await orderMessages(trx)
      .where('jid', cart.jid)
      .where('id', '>', recap.id)
      .whereNotIn('status', ['failed', 'queued'])
      .orderBy('id')
      .limit(201)
    if (after.length > 200) {
      reject('HISTORY_TOO_LONG')
      continue
    }
    const blocked = after.find((r: any) => {
      if (Number(r.id) === Number(confirmation.id)) return false
      if (r.direction === 'in')
        return (
          Boolean(r.media_type) ||
          (!checkoutFollowup(r.body || '') && !reviewedContinuity(r, confirmation, recap, reviews))
        )
      if (['cs', 'owner'].includes(r.sender_type))
        return (
          !checkoutFollowup(r.body || '') &&
          !balanceExplanation(cart, r.body || '') &&
          !matchesCheckoutRecap(cart, r.body || '')
        )
      return false
    })
    if (blocked) {
      reject(
        blocked.direction === 'in' ? 'CUSTOMER_MESSAGE_NEEDS_REVIEW' : 'CS_MESSAGE_NEEDS_REVIEW',
        blocked.message_id
      )
      continue
    }
    const consent = { ...candidate, fingerprint }
    if (!accepted)
      await trx.table('whatsapp_cart_events').insert({
        jid: cart.jid,
        action: 'checkout_accepted',
        actor: 'system:customer-consent',
        summary_json: JSON.stringify(consent),
        created_at: new Date(),
      })
    return consent
  }
  if (requested) throw new CheckoutConsentError(issues)
  return null
}
