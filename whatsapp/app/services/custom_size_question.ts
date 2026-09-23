import { measurementKey } from '#services/order_item_details'

export type CustomSizeQuestion = {
  itemId: string
  productId: string
  measurementName: string
  basis: 'body' | 'garment' | 'unknown'
  kind: 'missing_value' | 'unclear_basis' | 'unclear_unit' | 'unclear_reference' | 'unclear_change'
  question: string
}

const kinds = [
  'missing_value',
  'unclear_basis',
  'unclear_unit',
  'unclear_reference',
  'unclear_change',
] as const
export const CUSTOM_SIZE_QUESTION_SCHEMA = {
  description:
    'Hasil pemahaman maksud ketika perlu satu klarifikasi ukuran custom. Bukan harga atau persetujuan. Referensikan item/productId cart dan nama ukuran terstruktur yang sama, bukan sinonim baru. question harus sama persis dengan satu pesan pertanyaan pada message atau initiative, tanpa klaim harga/stock/approval/pembayaran. Gunakan missing_value hanya bila ukuran pada basis itu belum ada; gunakan unclear_change untuk koreksi tanpa angka pasti, unclear_reference untuk item/pemakai/rujukan ambigu. Null bila tidak perlu klarifikasi ukuran. Bahasa pertanyaan mengikuti pelanggan/skill, tidak wajib kata kunci Indonesia tertentu.',
  anyOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        itemId: { type: 'string' },
        productId: { type: 'string' },
        measurementName: { type: 'string' },
        basis: { type: 'string', enum: ['body', 'garment', 'unknown'] },
        kind: { type: 'string', enum: kinds },
        question: { type: 'string' },
      },
      required: ['itemId', 'productId', 'measurementName', 'basis', 'kind', 'question'],
    },
  ],
}

export function parseCustomSizeQuestion(value: unknown): CustomSizeQuestion | null {
  if (value === null || value === undefined) return null
  const q = value as CustomSizeQuestion
  if (
    !q ||
    typeof q !== 'object' ||
    Array.isArray(q) ||
    !['itemId', 'productId', 'measurementName', 'question'].every(
      (key) => typeof (q as any)[key] === 'string'
    ) ||
    !q.productId.trim() ||
    q.productId.length > 190 ||
    q.itemId.length > 190 ||
    !q.measurementName.trim() ||
    q.measurementName.length > 80 ||
    !q.question.trim() ||
    q.question.length > 400 ||
    !['body', 'garment', 'unknown'].includes(q.basis) ||
    !kinds.includes(q.kind)
  )
    throw new Error('Klarifikasi ukuran custom tidak valid.')
  measurementKey(q.measurementName)
  return { ...q, question: q.question.trim() }
}

/** This gate validates scope and excludes claims; the model resolves language/intent. */
export function scopedCustomSizeQuestion(
  q: CustomSizeQuestion | null | undefined,
  messages: string[],
  items: Array<{
    id: string
    productId: string
    size: string
    measurements: Record<string, number>
    productionDetails?: {
      measurements: Array<{ name: string; basis: string; value: number }>
    } | null
  }>
) {
  if (!q || !messages.some((message) => message.trim() === q.question.trim())) return null
  const matches = items.filter(
    (item) => item.productId === q.productId && (!q.itemId || item.id === q.itemId)
  )
  if (matches.length !== 1 || matches[0].size !== 'custom') return null
  const item = matches[0]
  const text = q.question.normalize('NFKC').trim()
  // A clarification may refer to this item's recorded dimension, but cannot invent a number or quote.
  if (
    !/^[^?]*\?$/.test(text) ||
    /https?:|\brp\b|harga|price|total|ongkir|cost|transfer|bayar|payment|ready|stok|stock|approved|setuju|estimasi|gratis|free|diskon|discount/iu.test(
      text
    )
  )
    return null
  const key = measurementKey(q.measurementName)
  const knownValues = [
    ...Object.entries(item.measurements)
      .filter(([name]) => measurementKey(name) === key)
      .map(([, value]) => value),
    ...(item.productionDetails?.measurements || [])
      .filter(
        (row) =>
          measurementKey(row.name) === key && (q.basis === 'unknown' || row.basis === q.basis)
      )
      .map((row) => row.value),
  ]
  const numbers = text.match(/\p{N}+(?:[.,]\p{N}+)?/gu) || []
  if (
    numbers.some(
      (number) =>
        q.kind === 'missing_value' || !knownValues.includes(Number(number.replace(',', '.')))
    )
  )
    return null
  if (q.kind === 'missing_value') {
    if (Object.keys(item.measurements).some((name) => measurementKey(name) === key)) return null
    if (
      item.productionDetails?.measurements.some(
        (row) =>
          measurementKey(row.name) === key && (q.basis === 'unknown' || row.basis === q.basis)
      )
    )
      return null
  }
  return q.question.trim()
}
