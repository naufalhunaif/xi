import db from '#services/workspace_database'
import { orderMessages } from '#services/order_message_evidence'
import { workspaceScope } from '#services/workspace_context'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { initializeDatabase } from '#services/init_model'
import { readSettings } from '#services/settings_service'
import { readReceiptImage } from '#services/ai_service'
import { parseReceipt, type ReceiptReading } from '#services/payment_receipt_contract'
import { paymentDataSignature, type PaymentMethod } from '#services/payment_context_service'
import { cartAmounts } from '#services/cart_discount_service'
import { customerBalanceQuote } from '#services/customer_balance_quote'

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const account = (value: string) => value.replace(/[\s-]/g, '')

function bankIdentity(value: string) {
  const name = normalize(value)
    .replace(/^pt/, '')
    .replace(/(?:persero)?tbk$/, '')
    .replace(/persero$/, '')
  // Full legal name and abbreviation identify the same bank, not any name containing "BRI".
  if (['bri', 'bankbri', 'bankrakyatindonesia', 'bankrakyatindonesiabri'].includes(name))
    return 'bri'
  return name
}

export function receiptAssessment(reading: ReceiptReading, methods: PaymentMethod[]) {
  const issues: string[] = []
  if (!reading.isReceipt) issues.push('Gambar ini belum dikenali sebagai bukti transfer.')
  if (reading.status !== 'success') issues.push('Status transfer berhasil belum terbaca.')
  if (!reading.amount || reading.currency.toUpperCase() !== 'IDR')
    issues.push('Nominal transfer dalam rupiah belum terbaca jelas.')
  const destination = account(reading.recipientAccount)
  const bank = bankIdentity(reading.recipientBank)
  const candidates = methods.filter((method) => {
    const name = bankIdentity(method.name)
    return (
      method.enabled &&
      /^\d{5,30}$/.test(destination) &&
      account(method.destination) === destination &&
      bank.length >= 3 &&
      name === bank
    )
  })
  const method = candidates.length === 1 ? candidates[0] : null
  if (!method) issues.push('Rekening tujuan belum cocok dengan satu metode pembayaran aktif.')
  return { method, issues }
}

async function proofFile(message: any) {
  const url = String(message?.media_url || '')
  const match = url.match(/\/media\/([a-zA-Z0-9_.-]+)$/)
  if (
    !url.startsWith(`${(env.get('APP_BASE_PATH') || '')}/media/`) ||
    !match ||
    message.media_type !== 'image' ||
    message.direction !== 'in'
  )
    throw new Error('Bukti transfer berupa gambar belum tersedia.')
  const root = await realpath(app.makePath('public', 'media'))
  const path = await realpath(join(root, match[1]))
  if (!path.startsWith(`${root}${sep}`)) throw new Error('Bukti transfer tidak valid.')
  const info = await stat(path)
  if (!info.isFile() || info.size > 20_000_000) throw new Error('Gambar bukti belum dapat dibaca.')
  const hash = createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
  return { path, hash, url }
}

const inFlight = new Map<string, Promise<any>>()

/** Explicit operator action; does not send a customer reply or confirm any money. */
export async function preparePaymentReview(
  jid: string,
  version: string,
  orderId?: number,
  reader = readReceiptImage
) {
  if (
    !/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid) ||
    (orderId !== undefined && (!Number.isSafeInteger(orderId) || orderId <= 0))
  )
    throw new Error('Pesanan tidak valid.')
  const key = `${workspaceScope().prefix}:${jid}:${version}:${orderId || ''}`
  if (inFlight.has(key)) return inFlight.get(key)!
  const pending = prepare(jid, version, orderId, reader)
  inFlight.set(key, pending)
  try {
    return await pending
  } finally {
    inFlight.delete(key)
  }
}

async function prepare(
  jid: string,
  version: string,
  orderId: number | undefined,
  reader: typeof readReceiptImage
) {
  await initializeDatabase()
  const cart = await db.from('whatsapp_carts').where('jid', jid).first()
  if (!cart || cart.version !== version) throw new Error('Cart berubah. Buka kembali konfirmasi.')
  const order = orderId
    ? await db.from('whatsapp_orders').where('jid', jid).where('id', orderId).first()
    : null
  if (orderId && (!order || order.status !== 'active' || Number(order.paid) >= Number(order.total)))
    throw new Error('Order tidak dapat menerima pembayaran.')
  if (!orderId && (cart.payment_status !== 'reported' || !JSON.parse(cart.items_json).length))
    throw new Error('Bukti pembayaran pelanggan belum tersedia untuk cart ini.')

  let proof =
    !orderId && cart.proof_message_id
      ? await orderMessages()
          .where('jid', jid)
          .where('direction', 'in')
          .where('message_id', cart.proof_message_id)
          .first()
      : null
  if (proof && proof.media_type !== 'image' && proof.reply_to_message_id) {
    proof = await orderMessages()
      .where('jid', jid)
      .where('direction', 'in')
      .where('message_id', proof.reply_to_message_id)
      .first()
  }
  if (!proof || proof.media_type !== 'image') {
    const query = orderMessages()
      .where('jid', jid)
      .where('direction', 'in')
      .where('media_type', 'image')
      .whereNot('status', 'failed')
      .whereNotIn(
        'message_id',
        db
          .from('whatsapp_order_payments')
          .select('proof_message_id')
          .whereNotNull('proof_message_id')
      )
      .orderBy('id', 'desc')
    if (order) query.where('created_at', '>=', order.created_at)
    else if (proof) query.where('created_at', '<=', proof.created_at)
    proof = await query.first()
  }
  if (!proof) throw new Error('Gambar bukti transfer belum tersedia. Tunggu bukti dari pelanggan.')
  if (await db.from('whatsapp_order_payments').where('proof_message_id', proof.message_id).first())
    throw new Error('Bukti transfer ini sudah dikonfirmasi.')
  const file = await proofFile(proof)
  const settings = await readSettings()
  const signature = paymentDataSignature(settings.paymentMethods)
  const reviewQuery = db
    .from('whatsapp_payment_reviews')
    .where('jid', jid)
    .where('cart_version', version)
    .where('proof_hash', file.hash)
    .where('proof_message_id', proof.message_id)
    .where('methods_signature', signature)
    .orderBy('created_at', 'desc')
  if (orderId) reviewQuery.where('order_id', orderId)
  else reviewQuery.whereNull('order_id')
  let review = await reviewQuery.first()
  if (!review) {
    const reading = parseReceipt(await reader(settings, file.path))
    review = {
      id: randomUUID(),
      jid,
      cart_version: version,
      order_id: orderId || null,
      order_paid: order ? Number(order.paid) : null,
      proof_message_id: proof.message_id,
      proof_hash: file.hash,
      methods_signature: signature,
      reading_json: JSON.stringify(reading),
      created_at: new Date(),
    }
    await db.table('whatsapp_payment_reviews').insert(review)
  }
  const current = await db.from('whatsapp_carts').where('jid', jid).firstOrFail()
  if (current.version !== version)
    throw new Error('Cart berubah selama bukti dibaca. Buka kembali konfirmasi.')
  const reading = parseReceipt(JSON.parse(review.reading_json))
  const { method, issues } = receiptAssessment(reading, settings.paymentMethods)
  const total = order
    ? Number(order.total) - Number(order.paid)
    : cartAmounts(
        JSON.parse(cart.items_json),
        JSON.parse(cart.shipping_json).cost,
        cart.discount_json ? JSON.parse(cart.discount_json) : null
      ).total
  const paymentQuote = await customerBalanceQuote(jid, total, true, orderId)
  const quoteJson = JSON.stringify(paymentQuote)
  if (review.payment_quote_json !== quoteJson) {
    if (review.payment_quote_json) {
      // Another operator may still have the previous quote open. Keep it immutable.
      review = {
        ...review,
        id: randomUUID(),
        payment_quote_json: quoteJson,
        created_at: new Date(),
      }
      await db.table('whatsapp_payment_reviews').insert(review)
    } else {
      await db
        .from('whatsapp_payment_reviews')
        .where('id', review.id)
        .update({ payment_quote_json: quoteJson })
    }
  }
  return {
    id: review.id,
    proofUrl: file.url,
    amount: reading.amount,
    billAmount: Math.max(0, total),
    paymentQuote,
    remainingDue: Math.max(0, paymentQuote.amountDue! - (reading.amount || 0)),
    overpayment: Math.max(0, (reading.amount || 0) - paymentQuote.amountDue!),
    methodName: method?.name || '',
    destination: method?.destination || reading.recipientAccount,
    reference: reading.reference,
    ready: issues.length === 0,
    issues,
  }
}

/** Resolve only server-stored readings, never values supplied by the browser. */
export async function reviewedPaymentInput(jid: string, id: string) {
  const review = await db.from('whatsapp_payment_reviews').where('jid', jid).where('id', id).first()
  if (!review) throw new Error('Hasil pembacaan bukti tidak ditemukan.')
  const reading = parseReceipt(JSON.parse(review.reading_json))
  const settings = await readSettings()
  const { method, issues } = receiptAssessment(reading, settings.paymentMethods)
  if (issues.length || !method)
    throw new Error('Bukti transfer belum cukup jelas untuk dikonfirmasi.')
  if (review.methods_signature !== paymentDataSignature(settings.paymentMethods))
    throw new Error('Metode pembayaran berubah. Periksa bukti kembali.')
  return {
    amount: reading.amount!,
    methodId: method.id,
    reference: reading.reference.trim(),
    orderId: review.order_id,
    proofMessageId: review.proof_message_id,
    review,
  }
}

export async function validatePaymentReview(
  jid: string,
  input: Record<string, any>,
  cart: any,
  trx: any
) {
  const review = input.review
  if (cart.version !== input.version || review.cart_version !== cart.version)
    throw new Error('Pesanan berubah. Periksa bukti kembali.')
  const methods = await trx.from('whatsapp_payment_methods').orderBy('id', 'asc')
  const signature = paymentDataSignature(
    methods.map((row: any) => ({
      id: Number(row.id),
      name: row.name,
      destination: row.destination,
      accountName: row.account_name,
      enabled: Boolean(row.enabled),
    }))
  )
  if (review.methods_signature !== signature)
    throw new Error('Metode pembayaran berubah. Periksa bukti kembali.')
  const proof = await orderMessages(trx)
    .where('jid', jid)
    .where('direction', 'in')
    .where('message_id', review.proof_message_id)
    .first()
  const file = await proofFile(proof)
  if (file.hash !== review.proof_hash) throw new Error('Gambar bukti berubah. Baca ulang bukti.')
  if (await trx.from('whatsapp_order_payments').where('proof_hash', file.hash).first())
    throw new Error('Bukti transfer ini sudah dikonfirmasi.')
  // Include pre-upgrade confirmations whose hash exists only in a stored review.
  if (
    await trx
      .from('whatsapp_payment_reviews as review')
      .join(
        'whatsapp_order_payments as payment',
        'payment.proof_message_id',
        'review.proof_message_id'
      )
      .where('review.proof_hash', file.hash)
      .first()
  )
    throw new Error('Bukti transfer ini sudah dikonfirmasi.')
  let total = cartAmounts(
    JSON.parse(cart.items_json),
    JSON.parse(cart.shipping_json).cost,
    cart.discount_json ? JSON.parse(cart.discount_json) : null
  ).total
  if (review.order_id) {
    const order = await trx
      .from('whatsapp_orders')
      .where('jid', jid)
      .where('id', review.order_id)
      .first()
    if (!order || Number(order.paid) !== Number(review.order_paid))
      throw new Error('Pembayaran order berubah. Periksa kembali.')
    total = Math.max(0, Number(order.total) - Number(order.paid))
  }
  const quote = await customerBalanceQuote(jid, total, true, review.order_id || undefined, trx)
  if (!review.payment_quote_json || JSON.stringify(quote) !== review.payment_quote_json)
    throw new Error('Saldo atau tagihan berubah. Periksa bukti kembali.')
}
