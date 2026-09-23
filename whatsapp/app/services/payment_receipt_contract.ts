export type ReceiptReading = {
  isReceipt: boolean
  status: 'success' | 'pending' | 'failed' | 'unknown'
  amount: number | null
  currency: string
  recipientBank: string
  recipientAccount: string
  reference: string
}

export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    isReceipt: { type: 'boolean' },
    status: { type: 'string', enum: ['success', 'pending', 'failed', 'unknown'] },
    amount: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    currency: { type: 'string' },
    recipientBank: { type: 'string' },
    recipientAccount: { type: 'string' },
    reference: { type: 'string' },
  },
  required: [
    'isReceipt',
    'status',
    'amount',
    'currency',
    'recipientBank',
    'recipientAccount',
    'reference',
  ],
}

export function parseReceipt(value: unknown): ReceiptReading {
  const row = value as ReceiptReading
  if (
    !row ||
    typeof row !== 'object' ||
    Array.isArray(row) ||
    typeof row.isReceipt !== 'boolean' ||
    !['success', 'pending', 'failed', 'unknown'].includes(row.status) ||
    !(
      row.amount === null ||
      (Number.isSafeInteger(row.amount) && row.amount > 0 && row.amount <= 1_000_000_000)
    ) ||
    !['currency', 'recipientBank', 'recipientAccount', 'reference'].every(
      (key) => typeof (row as any)[key] === 'string' && (row as any)[key].length <= 190
    )
  )
    throw new Error('Bukti transfer belum terbaca dengan jelas.')
  // A receipt need not contain a transaction reference. Never fabricate one.
  const reference = row.reference.trim()
  return {
    ...row,
    reference: /[*…]|\.{3}|\b(tidak|unknown|n\/a)\b/i.test(reference) ? '' : reference,
  }
}
