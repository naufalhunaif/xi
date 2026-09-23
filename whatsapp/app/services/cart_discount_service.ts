import { createHash } from 'node:crypto'
import { orderMessages } from '#services/order_message_evidence'

export type DiscountRequest = {
  amount: number
  approvalMessageId: string
  confirmationMessageId: string
}
export type DiscountApproval = DiscountRequest & { fingerprint: string }
type Item = {
  productId: string
  name: string
  size: string
  requestedSize?: string
  quantity: number
  unitPrice: number | null
  modelType?: string
  referenceMessageId?: string
}

/** Shipping/address choices do not revoke a product discount; changing goods/prices does. */
export function discountFingerprint(items: Item[]) {
  return createHash('sha256')
    .update(
      JSON.stringify(
        items
          .map((item) => [
            item.productId,
            item.name,
            item.size,
            item.requestedSize || '',
            item.quantity,
            item.unitPrice,
            item.modelType || 'catalog',
            item.referenceMessageId || '',
          ])
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      )
    )
    .digest('hex')
}

export function validDiscountRequest(value: unknown): value is DiscountRequest {
  const row = value as DiscountRequest | null
  return Boolean(
    row &&
    Number.isSafeInteger(row.amount) &&
    row.amount > 0 &&
    row.amount <= 1_000_000_000 &&
    typeof row.approvalMessageId === 'string' &&
    /^[\w-]{1,190}$/.test(row.approvalMessageId) &&
    typeof row.confirmationMessageId === 'string' &&
    /^[\w-]{1,190}$/.test(row.confirmationMessageId)
  )
}

/** Require an explicit flat product/order discount, never a quoted request, percentage or shipping discount. */
export function humanApprovedDiscount(body: string, amount: number) {
  if (
    /\?|%|\b(tidak|tak|gak|nggak|ga|belum|bukan|batal|jangan|minta|kalau|jika|asal|nanti|ongkir|shipping|not|can't|cannot|if)\b/i.test(
      body
    )
  )
    return false
  const matches = [
    ...body.matchAll(
      /\b(?:diskon(?:nya)?|discount|potongan|potong)\s*(?:(?:sebesar|senilai|of)\s*)?(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(ribu|rb|k)?\b/gi
    ),
  ]
  if (matches.length !== 1) return false
  const [, number, unit] = matches[0]
  // Decimal notation is only accepted with a thousands unit. Otherwise require rupiah grouping.
  if (!unit && !/^\d+(?:[.,]\d{3})*$/.test(number)) return false
  const parsed = unit
    ? Number(number.replace(',', '.')) * 1000
    : Number(number.replace(/[.,]/g, ''))
  return Number.isSafeInteger(parsed) && parsed === amount
}

export function customerAcceptedDiscount(body: string) {
  if (
    /\?|\b(tidak|tak|gak|nggak|ga|bukan|batal|jangan|tapi|kalau|jika|asal|minta|maunya|not|no|but|if)\b/i.test(
      body
    )
  )
    return false
  return /\b(iya+|ya+|oke+|ok|okay|boleh|setuju|deal|sip+|siap+|lanjut|ambil|jadi|gas|sepakat|yes|agreed)\b|(?:sudah|udah)\s+(?:saya\s+)?(?:transfer|bayar)/i.test(
    body
  )
}

export function discountValue(items: Item[], approval?: DiscountApproval | null) {
  if (!approval) return 0
  const subtotal = items.reduce((sum, item) => sum + item.quantity * (item.unitPrice || 0), 0)
  if (
    !validDiscountRequest(approval) ||
    !items.length ||
    items.some((item) => item.unitPrice === null) ||
    approval.amount > subtotal ||
    approval.fingerprint !== discountFingerprint(items)
  )
    throw new Error('Diskon tidak cocok dengan isi pesanan saat ini.')
  return approval.amount
}

export function cartAmounts(
  items: Item[],
  shippingCost: number | null,
  approval?: DiscountApproval | null
) {
  const subtotal = items.reduce((sum, item) => sum + item.quantity * (item.unitPrice || 0), 0)
  const discount = discountValue(items, approval)
  const total = subtotal - discount + (shippingCost || 0)
  if (!Number.isSafeInteger(total) || total < 0 || total > 1_000_000_000)
    throw new Error('Total cart melewati batas.')
  return { subtotal, discount, total }
}

type EvidenceMessage = {
  id: number
  jid: string
  message_id: string
  direction: string
  sender_type: string
  status: string
  body: string
  created_at: Date | string
}
export function validateDiscountEvidence(
  input: DiscountRequest,
  jid: string,
  approval?: EvidenceMessage,
  acceptance?: EvidenceMessage,
  boundary?: Date | string
) {
  if (
    !validDiscountRequest(input) ||
    !approval ||
    !acceptance ||
    approval.jid !== jid ||
    acceptance.jid !== jid ||
    approval.message_id !== input.approvalMessageId ||
    acceptance.message_id !== input.confirmationMessageId ||
    approval.direction !== 'out' ||
    !['cs', 'owner'].includes(approval.sender_type) ||
    !['sent', 'delivered', 'read'].includes(approval.status) ||
    acceptance.direction !== 'in' ||
    ['failed', 'queued'].includes(acceptance.status) ||
    !humanApprovedDiscount(approval.body, input.amount) ||
    !customerAcceptedDiscount(acceptance.body)
  )
    throw new Error(
      'Diskon belum cocok dengan pesan persetujuan CS dan penerimaan pelanggan di room ini.'
    )
  if (
    /\b(diskon|discount|potongan|potong)\b/i.test(acceptance.body) &&
    !humanApprovedDiscount(acceptance.body, input.amount)
  )
    throw new Error('Nominal diskon pada penerimaan pelanggan belum sesuai.')
  const approvedAt = new Date(approval.created_at).getTime()
  const acceptedAt = new Date(acceptance.created_at).getTime()
  if (
    !Number.isFinite(approvedAt) ||
    !Number.isFinite(acceptedAt) ||
    acceptedAt < approvedAt ||
    (acceptedAt === approvedAt && acceptance.id <= approval.id) ||
    (boundary && approvedAt <= new Date(boundary).getTime())
  )
    throw new Error('Persetujuan diskon berasal dari giliran atau pesanan yang tidak sesuai.')
}

/** Called under the cart row lock; identity/authority comes from stored messages, never an AI note. */
export async function verifyCartDiscount(
  trx: any,
  jid: string,
  items: Item[],
  request: DiscountRequest
): Promise<DiscountApproval> {
  if (!validDiscountRequest(request)) throw new Error('Referensi diskon tidak valid.')
  const approval = await orderMessages(trx)
    .where({ jid, message_id: request.approvalMessageId })
    .first()
  const acceptance = await orderMessages(trx)
    .where({ jid, message_id: request.confirmationMessageId })
    .first()
  const boundary = await trx
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      "(action = 'cancelled' OR (action = 'payment_confirmed' AND JSON_EXTRACT(summary_json, '$.cartCleared') = true))"
    )
    .orderBy('id', 'desc')
    .first()
  validateDiscountEvidence(request, jid, approval, acceptance, boundary?.created_at)
  const result = {
    amount: request.amount,
    approvalMessageId: request.approvalMessageId,
    confirmationMessageId: request.confirmationMessageId,
    fingerprint: discountFingerprint(items),
  }
  discountValue(items, result)
  const prior = await trx
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      "JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.discountApproval.approvalMessageId')) = ?",
      [request.approvalMessageId]
    )
    .orderBy('id', 'desc')
    .first()
  if (prior) {
    const previous = JSON.parse(prior.summary_json).discountApproval
    if (previous.fingerprint !== result.fingerprint || previous.amount !== result.amount)
      throw new Error('Persetujuan diskon ini sudah terikat pada isi pesanan sebelumnya.')
  }
  return result
}
