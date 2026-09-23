import { randomUUID, createHash } from 'node:crypto'
import db from '#services/workspace_database'
import { orderMessages } from '#services/order_message_evidence'
import { assertNotInternalPhone } from '#services/customer_identity_service'
import { initializeDatabase } from '#services/init_model'
import { cartSize } from '#services/cart_contract'
import {
  applyHumanCartEvidence,
  bundlePriceFingerprint,
  modelConsentFingerprint,
  matchesBundleEvidence,
  matchesModelEvidence,
  type BundlePriceEvidence,
  type ModelConsentEvidence,
} from '#services/human_cart_evidence'
import {
  fulfillmentFingerprint,
  type Fulfillment,
  type PreorderConsentEvidence,
} from '#services/fulfillment_contract'
import { readProductionPolicy } from '#services/production_service'
import { customerBalanceQuote } from '#services/customer_balance_quote'
import { matchesCheckoutRecap, checkoutFingerprint } from '#services/balance_checkout_evidence'
import { resolveCheckoutConsent } from '#services/checkout_consent_service'
import { schedulePaymentWaitNotice } from '#services/payment_wait_notice_service'
import { syncApprovalWaitEpisode } from '#services/approval_wait_service'
import {
  normalizeProductionDetails,
  productionFingerprint,
  hasCustomMeasurements,
  measurementName,
  measurementKey,
  legacyMeasurementFingerprint,
  type ProductionDetails,
} from '#services/order_item_details'
import { onOrderPayment, operationsForOrders } from '#services/order_operations_service'
import { orderNumber, insertNumberedOrder } from '#services/order_number'
import {
  cartAmounts,
  discountFingerprint,
  verifyCartDiscount,
  type DiscountApproval,
  type DiscountRequest,
} from '#services/cart_discount_service'

export type CartItem = {
  id: string
  productId: string
  name: string
  image: string
  size: string
  requestedSize?: string
  quantity: number
  unitPrice: number | null
  catalogVerification?: 'pending' | 'verified'
  modelType: 'catalog' | 'custom'
  fulfillment: Fulfillment
  fulfillmentNote: string
  fulfillmentDecidedBy: string | null
  preorderConsentEvidence?: PreorderConsentEvidence
  modelApproval: 'standard' | 'pending' | 'approved' | 'rejected'
  modelApprovalNote: string
  modelApprovedBy: string | null
  referenceMessageId: string
  priceMessageId: string
  bundlePriceEvidence?: BundlePriceEvidence
  modelConsentEvidence?: ModelConsentEvidence
  measurements: Record<string, number>
  productionDetails?: ProductionDetails | null
  note: string
  approval: 'standard' | 'pending' | 'approved' | 'rejected'
  approvalNote: string
  approvedBy: string | null
}
export type Cart = {
  jid: string
  version: string
  items: CartItem[]
  recipient: { name: string; phone: string; address: string }
  shipping: {
    service: string
    cost: number | null
    serviceCode?: string
    destinationCode?: string
    weightKg?: number | null
  }
  note: string
  paymentStatus: string
  proofMessageId: string | null
  subtotal: number
  discount: number
  discountApproval?: DiscountApproval | null
  total: number
  totalComplete: boolean
}
const uncertain =
  /\b(sepertinya|mungkin|kira[- ]?kira|kurang lebih|belum pasti|belum tahu|tidak tahu|unknown|tbd)\b/i
function text(value: unknown, label: string, required = false, max = 500) {
  const result = String(value ?? '').trim()
  if ((required && !result) || result.length > max) throw new Error(`${label} belum valid.`)
  return result
}
function definite(value: unknown, label: string, required = true) {
  const result = text(value, label, required)
  if (uncertain.test(result)) throw new Error(`${label} harus pasti, bukan perkiraan.`)
  return result
}
function integer(value: unknown, label: string, minimum = 0, maximum = 1_000_000_000) {
  if (value === '' || value === null || value === undefined)
    throw new Error(`${label} wajib diisi.`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum)
    throw new Error(`${label} tidak valid.`)
  return result
}
function validateJid(jid: string) {
  if (!/^[^@\s]+@(?:s\.whatsapp\.net|lid)$/.test(jid) || jid.length > 190)
    throw new Error('Room tidak valid.')
}
function productImage(value: unknown) {
  const image = text(value, 'Gambar produk', true, 2000)
  if (image.startsWith('/') && !image.startsWith('//') && !image.includes('\\')) return image
  try {
    const url = new URL(image)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      throw new Error()
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname))
      throw new Error()
    return url.toString()
  } catch {
    throw new Error('URL gambar produk tidak valid.')
  }
}
function approvalFingerprint(item: CartItem) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        item.productId,
        modelConsentFingerprint(item),
        item.size,
        item.requestedSize || '',
        legacyMeasurementFingerprint(item.measurements),
        productionFingerprint(item.productionDetails),
      ])
    )
    .digest('hex')
}
function modelFingerprint(item: CartItem) {
  return JSON.stringify([
    item.productId,
    modelConsentFingerprint(item),
    item.image,
    item.modelType,
    item.referenceMessageId,
    item.unitPrice,
    item.requestedSize || '',
    productionFingerprint(item.productionDetails),
  ])
}
function normalizeItem(input: Record<string, any>, previous?: CartItem): CartItem {
  const { size, requestedSize } = cartSize(
    definite(input.size, 'Size'),
    definite(input.requestedSize, 'Nomor ukuran custom', false)
  )
  const custom = size.toLowerCase() === 'custom'
  const customModel = input.modelType === 'custom'
  if (previous?.modelType === 'custom' && !customModel)
    throw new Error('Model khusus tidak boleh diubah menjadi katalog untuk melewati persetujuan.')
  const measurements: Record<string, number> = {}
  if (
    input.measurements !== null &&
    input.measurements !== undefined &&
    (typeof input.measurements !== 'object' || Array.isArray(input.measurements))
  )
    throw new Error('Detail ukuran tidak valid.')
  const measurementNames = new Set<string>()
  const entries = Object.entries(input.measurements || {}).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length > 30) throw new Error('Maksimal 30 detail ukuran.')
  for (const [label, value] of entries) {
    const name = measurementName(definite(label, 'Nama ukuran'))
    const key = measurementKey(name)
    if (measurementNames.has(key)) throw new Error('Detail ukuran duplikat.')
    measurementNames.add(key)
    const amount = Number(value)
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > 400 ||
      !/^\d+(?:\.\d{1,2})?$/.test(String(value))
    )
      throw new Error(`Ukuran ${name} harus angka pasti dalam cm.`)
    if (['__proto__', 'constructor', 'prototype'].includes(name))
      throw new Error('Nama ukuran tidak valid.')
    measurements[name] = amount
  }
  // A draft may precede measurements; approval and checkout still require them.
  if (!custom && entries.length) throw new Error('Detail ukuran hanya untuk size custom.')
  const item: CartItem = {
    id: previous?.id || randomUUID(),
    productId: definite(input.productId, 'ID produk'),
    name: definite(input.name, 'Nama produk'),
    image: productImage(input.image),
    size: custom ? 'custom' : size,
    requestedSize,
    quantity: integer(input.quantity ?? previous?.quantity ?? 1, 'Jumlah', 1, 1000),
    unitPrice:
      input.catalogVerification === 'pending' ||
      ((customModel || custom) && input.unitPrice === null)
        ? null
        : integer(input.unitPrice, 'Harga', 1),
    catalogVerification: input.catalogVerification === 'pending' ? 'pending' : 'verified',
    modelType: customModel ? 'custom' : 'catalog',
    fulfillment: 'ready',
    fulfillmentNote: '',
    fulfillmentDecidedBy: null,
    modelApproval: customModel ? 'pending' : 'standard',
    modelApprovalNote: '',
    modelApprovedBy: null,
    referenceMessageId: text(input.referenceMessageId, 'Referensi model', customModel, 190),
    priceMessageId: text(input.priceMessageId, 'Referensi harga', false, 190),
    measurements,
    productionDetails: normalizeProductionDetails(
      input.productionDetails ??
        (previous && previous.productId === input.productId ? previous.productionDetails : null)
    ),
    note: definite(input.note, 'Catatan item', false),
    approval: custom ? 'pending' : 'standard',
    approvalNote: '',
    approvedBy: null,
  }
  if (
    custom &&
    hasCustomMeasurements(item) &&
    previous &&
    approvalFingerprint(item) === approvalFingerprint(previous)
  ) {
    item.approval = previous.approval
    item.approvalNote = previous.approvalNote
    item.approvedBy = previous.approvedBy
  }
  if (customModel && previous && modelFingerprint(item) === modelFingerprint(previous)) {
    item.modelApproval = previous.modelApproval
    item.modelApprovalNote = previous.modelApprovalNote
    item.modelApprovedBy = previous.modelApprovedBy
  }
  if (
    previous?.modelConsentEvidence &&
    matchesModelEvidence(previous.modelConsentEvidence, item, previous)
  ) {
    item.modelApproval = previous.modelApproval
    item.modelApprovalNote = previous.modelApprovalNote
    item.modelApprovedBy = previous.modelApprovedBy
    item.modelConsentEvidence = {
      ...previous.modelConsentEvidence,
      fingerprint: modelConsentFingerprint(item),
    }
  }
  // Pre-order is a stored local decision about these goods; a changed item falls back to ready.
  if (
    previous?.fulfillment === 'preorder' &&
    fulfillmentFingerprint(previous) === fulfillmentFingerprint(item)
  ) {
    item.fulfillment = 'preorder'
    item.fulfillmentNote = previous.fulfillmentNote
    item.fulfillmentDecidedBy = previous.fulfillmentDecidedBy
    if (previous.preorderConsentEvidence)
      item.preorderConsentEvidence = previous.preorderConsentEvidence
  }
  if (previous?.bundlePriceEvidence) item.bundlePriceEvidence = previous.bundlePriceEvidence
  return item
}
function decode(row: any): Cart {
  const items = JSON.parse(row.items_json) as CartItem[]
  const shipping = JSON.parse(row.shipping_json)
  const discountApproval = row.discount_json
    ? (JSON.parse(row.discount_json) as DiscountApproval)
    : null
  const { subtotal, discount, total } = cartAmounts(items, shipping.cost, discountApproval)
  return {
    jid: row.jid,
    version: row.version,
    items,
    recipient: JSON.parse(row.recipient_json),
    shipping,
    note: row.note,
    paymentStatus: row.payment_status,
    proofMessageId: row.proof_message_id,
    subtotal,
    discount,
    discountApproval,
    total,
    totalComplete:
      items.length > 0 &&
      items.every((item) => item.unitPrice !== null && item.catalogVerification !== 'pending') &&
      shipping.cost !== null,
  }
}
export async function readCart(jid: string) {
  validateJid(jid)
  await initializeDatabase()
  await db.rawQuery(
    `INSERT IGNORE INTO whatsapp_carts
    (jid,version,items_json,recipient_json,shipping_json,note,updated_at)
    VALUES (?,?,'[]','{"name":"","phone":"","address":""}','{"service":"","cost":null}','',?)`,
    [jid, randomUUID(), new Date()]
  )
  const cart = decode(await db.from('whatsapp_carts').where('jid', jid).firstOrFail())
  return { ...cart, paymentQuote: await customerBalanceQuote(jid, cart.total, cart.totalComplete) }
}
async function mutate(
  jid: string,
  version: string,
  change: (cart: Cart, trx: any) => Promise<void | false>,
  action = 'updated',
  actor = 'cs'
) {
  await readCart(jid)
  await db.transaction(async (trx) => {
    const cart = decode(
      await trx.from('whatsapp_carts').where('jid', jid).forUpdate().firstOrFail()
    )
    if (cart.version !== version) throw new Error('Cart berubah. Muat ulang sebelum menyimpan.')
    if ((await change(cart, trx)) === false) return
    await syncApprovalWaitEpisode(trx, jid, cart.items)
    decode({
      ...(await trx.from('whatsapp_carts').where('jid', jid).firstOrFail()),
      items_json: JSON.stringify(cart.items),
      shipping_json: JSON.stringify(cart.shipping),
      discount_json: cart.discountApproval ? JSON.stringify(cart.discountApproval) : null,
    })
    await trx
      .from('whatsapp_carts')
      .where('jid', jid)
      .update({
        version: randomUUID(),
        items_json: JSON.stringify(cart.items),
        recipient_json: JSON.stringify(cart.recipient),
        shipping_json: JSON.stringify(cart.shipping),
        discount_json: cart.discountApproval ? JSON.stringify(cart.discountApproval) : null,
        note: cart.note,
        payment_status: cart.paymentStatus,
        proof_message_id: cart.proofMessageId,
        updated_at: new Date(),
      })
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action,
      actor,
      summary_json: JSON.stringify({
        items: cart.items.map((item) => ({
          id: item.id,
          name: item.name,
          size: item.size,
          approval: item.approval,
          fulfillment: item.fulfillment,
          preorderConsentEvidence: item.preorderConsentEvidence || null,
          modelApproval: item.modelApproval,
          modelConsentEvidence: item.modelConsentEvidence || null,
          bundlePriceEvidence: item.bundlePriceEvidence || null,
        })),
        paymentStatus: cart.paymentStatus,
        discountApproval: cart.discountApproval || null,
      }),
      created_at: new Date(),
    })
  })
  return readCart(jid)
}
export async function saveCart(
  jid: string,
  version: string,
  input: Record<string, any>,
  actor = 'cs'
) {
  return mutate(
    jid,
    version,
    async (cart, trx) => {
      if (!Array.isArray(input.items) || input.items.length > 50)
        throw new Error('Isi cart tidak valid.')
      const ids = new Set<string>()
      const previousItems = cart.items
      cart.items = input.items.map((item: any) => {
        const previous = item.id ? cart.items.find((old) => old.id === item.id) : undefined
        if (item.id && (!previous || ids.has(item.id))) throw new Error('Item cart tidak valid.')
        if (item.id) ids.add(item.id)
        return normalizeItem(item, previous)
      })
      for (const item of cart.items) {
        if (
          item.bundlePriceEvidence &&
          !matchesBundleEvidence(item.bundlePriceEvidence, cart.items, previousItems)
        ) {
          if (!input.bundlePrice) {
            item.unitPrice = null
            item.priceMessageId = ''
          }
          delete item.bundlePriceEvidence
        } else if (item.bundlePriceEvidence) {
          item.bundlePriceEvidence = {
            ...item.bundlePriceEvidence,
            fingerprint: bundlePriceFingerprint(cart.items),
          }
        }
      }
      await applyHumanCartEvidence(trx, jid, cart.items, previousItems, input)
      if (
        cart.discountApproval &&
        cart.discountApproval.fingerprint !== discountFingerprint(cart.items)
      )
        cart.discountApproval = null
      if (input.discountRequest !== null && input.discountRequest !== undefined)
        cart.discountApproval = await verifyCartDiscount(
          trx,
          jid,
          cart.items,
          input.discountRequest
        )
      cart.recipient = {
        name: definite(input.recipient?.name, 'Nama penerima', false),
        phone: text(input.recipient?.phone, 'Nomor penerima', false, 40),
        address: definite(input.recipient?.address, 'Alamat', false),
      }
      if (cart.recipient.phone && !/^\+?[0-9 ()-]{6,30}$/.test(cart.recipient.phone))
        throw new Error('Nomor penerima tidak valid.')
      assertNotInternalPhone(jid, cart.recipient.phone)
      cart.shipping = {
        service: definite(input.shipping?.service, 'Layanan pengiriman', false),
        cost:
          input.shipping?.cost === null ||
          input.shipping?.cost === '' ||
          input.shipping?.cost === undefined
            ? null
            : integer(input.shipping.cost, 'Ongkir'),
        ...(input.shipping?.cost !== null && input.shipping?.serviceCode
          ? {
              serviceCode: text(input.shipping.serviceCode, 'Kode layanan', false, 100),
              destinationCode: text(input.shipping.destinationCode, 'Kode tujuan', false, 190),
              weightKg:
                Number.isFinite(input.shipping.weightKg) && input.shipping.weightKg > 0
                  ? input.shipping.weightKg
                  : null,
            }
          : {}),
      }
      cart.note = definite(input.note, 'Catatan pesanan', false)
      if (!cart.items.length) {
        cart.paymentStatus = 'none'
        cart.proofMessageId = null
      }
    },
    'updated',
    actor
  )
}
export async function approveCustom(
  jid: string,
  version: string,
  itemId: string,
  approved: boolean,
  note: string,
  actor: string
) {
  return mutate(
    jid,
    version,
    async (cart) => {
      const item = cart.items.find((row) => row.id === itemId)
      if (!item || item.size !== 'custom') throw new Error('Item custom tidak ditemukan.')
      if (approved && !hasCustomMeasurements(item))
        throw new Error('Isi detail ukuran custom dalam cm sebelum menyetujui.')
      item.approval = approved ? 'approved' : 'rejected'
      item.approvalNote = text(note, 'Catatan persetujuan', !approved)
      item.approvedBy = actor
    },
    approved ? 'custom_approved' : 'custom_rejected',
    actor
  )
}
/** Owner/CS records the local fulfillment decision; stock levels never decide it by themselves. */
export async function setItemFulfillment(
  jid: string,
  version: string,
  itemId: string,
  fulfillment: Fulfillment,
  note: string,
  actor: string
) {
  if (fulfillment !== 'ready' && fulfillment !== 'preorder')
    throw new Error('Jenis pemenuhan tidak valid.')
  const policy = await readProductionPolicy()
  if (fulfillment === 'preorder' && !policy.rules.preorder.enabled)
    throw new Error('Aktifkan pengaturan pre-order lokal sebelum menandai item pre-order.')
  return mutate(
    jid,
    version,
    async (cart) => {
      const item = cart.items.find((row) => row.id === itemId)
      if (!item) throw new Error('Item cart tidak ditemukan.')
      if (item.fulfillment === fulfillment) return false
      item.fulfillment = fulfillment
      item.fulfillmentNote = text(note, 'Catatan pemenuhan', false)
      item.fulfillmentDecidedBy = fulfillment === 'preorder' ? actor : null
      if (fulfillment === 'ready') delete item.preorderConsentEvidence
    },
    fulfillment === 'preorder' ? 'preorder_marked' : 'preorder_cleared',
    actor
  )
}
export async function applyCartDiscount(
  jid: string,
  version: string,
  discount: DiscountRequest,
  actor = 'ai'
) {
  return mutate(
    jid,
    version,
    async (cart, trx) => {
      const approved = await verifyCartDiscount(trx, jid, cart.items, discount)
      if (JSON.stringify(cart.discountApproval) === JSON.stringify(approved)) return false
      cart.discountApproval = approved
    },
    'discount_applied',
    actor
  )
}

export async function reportPayment(
  jid: string,
  version: string,
  proofId?: string,
  actor = 'cs',
  discount?: DiscountRequest | null
) {
  return mutate(
    jid,
    version,
    async (cart, trx) => {
      if (!cart.items.length) throw new Error('Cart masih kosong.')
      if (discount) cart.discountApproval = await verifyCartDiscount(trx, jid, cart.items, discount)
      if (proofId) {
        const proof = await orderMessages(trx)
          .where('jid', jid)
          .where('message_id', proofId)
          .where('direction', 'in')
          .first()
        if (!proof) throw new Error('Pesan transfer tidak ditemukan di room ini.')
      }
      if (cart.paymentStatus !== 'reported' && actor === 'ai')
        await schedulePaymentWaitNotice(trx, jid, proofId || null)
      cart.paymentStatus = 'reported'
      cart.proofMessageId = proofId || null
    },
    'transfer_reported',
    actor
  )
}
export async function approveModel(
  jid: string,
  version: string,
  itemId: string,
  approved: boolean,
  note: string,
  actor: string
) {
  return mutate(
    jid,
    version,
    async (cart) => {
      const item = cart.items.find((row) => row.id === itemId)
      if (!item || item.modelType !== 'custom') throw new Error('Model khusus tidak ditemukan.')
      item.modelApproval = approved ? 'approved' : 'rejected'
      item.modelApprovalNote = text(note, 'Catatan model', !approved)
      item.modelApprovedBy = actor
    },
    approved ? 'model_approved' : 'model_rejected',
    actor
  )
}
export async function cancelCart(jid: string, version: string, actor = 'cs') {
  return mutate(
    jid,
    version,
    async (cart) => {
      cart.items = []
      cart.discountApproval = null
      cart.recipient = { name: '', phone: '', address: '' }
      cart.shipping = { service: '', cost: null }
      cart.note = ''
      cart.paymentStatus = 'none'
      cart.proofMessageId = null
    },
    'cancelled',
    actor
  )
}
function orderView(row: any) {
  return {
    id: Number(row.id),
    number: orderNumber(row),
    jid: row.jid,
    cart: JSON.parse(row.snapshot_json),
    total: Number(row.total),
    paid: Number(row.paid),
    cashPaid: Number(row.paid) - Number(row.balance_applied || 0),
    balanceApplied: Number(row.balance_applied || 0),
    balance: Math.max(0, Number(row.total) - Number(row.paid)),
    overpayment: Math.max(0, Number(row.paid) - Number(row.total)),
    status: row.status,
    createdAt: row.created_at,
  }
}
export async function listOrders(jid: string) {
  validateJid(jid)
  await initializeDatabase()
  const orders = await db.from('whatsapp_orders').where('jid', jid).orderBy('id', 'desc').limit(100)
  return operationsForOrders(orders.map(orderView))
}
export async function readCustomerBalance(jid: string) {
  validateJid(jid)
  await initializeDatabase()
  const total = await db
    .from('whatsapp_customer_balance_entries')
    .where('jid', jid)
    .sum('amount as balance')
    .first()
  const entries = await db
    .from('whatsapp_customer_balance_entries as entry')
    .leftJoin('whatsapp_order_payments as payment', 'payment.id', 'entry.payment_id')
    .leftJoin('whatsapp_orders as order', 'order.id', 'entry.order_id')
    .where('entry.jid', jid)
    .orderBy('entry.id', 'desc')
    .limit(100)
    .select('entry.*', 'payment.reference', 'order.order_number')
  return {
    balance: Number(total?.balance || 0),
    currency: 'IDR',
    entries: entries.map((entry) => ({
      id: Number(entry.id),
      orderNumber: orderNumber({ id: entry.order_id, order_number: entry.order_number }),
      paymentId: entry.payment_id === null ? null : Number(entry.payment_id),
      amount: Number(entry.amount),
      reason: entry.reason,
      reference: entry.reference,
      createdAt: entry.created_at,
    })),
  }
}
// Caller must hold the customer's cart lock. Cash confirmation, cancellation and
// balance allocation all use this lock, preventing double spending across orders.
async function allocateCustomerBalance(
  jid: string,
  actor: string,
  trx: import('@adonisjs/lucid/types/database').TransactionClientContract,
  newOrderId?: number,
  deferNewOrderDispatch = false
) {
  const ledger = await trx
    .from('whatsapp_customer_balance_entries')
    .where('jid', jid)
    .sum('amount as balance')
    .first()
  let available = Number(ledger?.balance || 0)
  const allocations: { orderNumber: string; amount: number }[] = []
  if (available <= 0) return allocations
  const orders = await trx
    .from('whatsapp_orders')
    .where('jid', jid)
    .where('status', 'active')
    .whereColumn('paid', '<', 'total')
    .orderBy('id', 'asc')
    .forUpdate()
  for (const order of orders) {
    const amount = Math.min(available, Number(order.total) - Number(order.paid))
    if (amount <= 0) break
    await trx.table('whatsapp_customer_balance_entries').insert({
      jid,
      order_id: order.id,
      payment_id: null,
      amount: -amount,
      reason: 'order_payment',
      created_at: new Date(),
    })
    await trx
      .from('whatsapp_orders')
      .where('id', order.id)
      .update({
        paid: Number(order.paid) + amount,
        balance_applied: Number(order.balance_applied || 0) + amount,
        updated_at: new Date(),
      })
    available -= amount
    await onOrderPayment(
      Number(order.id),
      actor,
      trx,
      Number(order.id) === newOrderId,
      deferNewOrderDispatch && Number(order.id) === newOrderId
    )
    allocations.push({ orderNumber: orderNumber(order), amount })
  }
  if (allocations.length) {
    await trx
      .from('whatsapp_carts')
      .where('jid', jid)
      .update({ version: randomUUID(), updated_at: new Date() })
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action: 'balance_applied',
      actor,
      summary_json: JSON.stringify({ allocations, remainingBalance: available }),
      created_at: new Date(),
    })
  }
  return allocations
}

export async function applyCustomerBalance(jid: string, actor = 'system:customer-balance') {
  await readCart(jid)
  return db.transaction(async (trx) => {
    await trx.from('whatsapp_carts').where('jid', jid).forUpdate().firstOrFail()
    return allocateCustomerBalance(jid, actor, trx)
  })
}

/** Spending verified credit is not verification of a new transfer. All spenders share this lock. */
export async function recordBalanceRecap(
  jid: string,
  version: string,
  recapMessageId: string,
  body: string
) {
  if (!/(?:^|\n)\s*\**(?:grand )?total\s*\**\s*:/i.test(body)) return
  await db.transaction(async (trx) => {
    const row = await trx.from('whatsapp_carts').where('jid', jid).forUpdate().first()
    if (!row) return
    const cart = decode(row)
    if (cart.version !== version || !matchesCheckoutRecap(cart, body)) return
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action: 'balance_recap',
      actor: 'ai',
      summary_json: JSON.stringify({ recapMessageId, fingerprint: checkoutFingerprint(cart) }),
      created_at: new Date(),
    })
  })
}

export async function checkoutFromBalance(
  jid: string,
  version: string,
  confirmationMessageId: string,
  recapMessageId: string
) {
  await readCart(jid)
  const orderId = await db.transaction(async (trx) => {
    const row = await trx.from('whatsapp_carts').where('jid', jid).forUpdate().firstOrFail()
    const receipt = await trx
      .from('whatsapp_cart_events')
      .where({ jid, action: 'payment_confirmed' })
      .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(summary_json, '$.balanceConfirmationMessageId')) = ?", [
        confirmationMessageId,
      ])
      .first()
    if (receipt) return JSON.parse(receipt.summary_json).orderId as number
    const cart = decode(row)
    if (cart.version !== version)
      throw new Error('Cart berubah. Periksa ulang sebelum checkout saldo.')
    if (
      !cart.totalComplete ||
      cart.total <= 0 ||
      !cart.items.length ||
      cart.items.some(
        (item) =>
          item.unitPrice === null ||
          (item.modelType === 'custom' && item.modelApproval !== 'approved') ||
          (item.size === 'custom' && (item.approval !== 'approved' || !hasCustomMeasurements(item)))
      )
    )
      throw new Error('Harga, model, atau ukuran pesanan belum disetujui.')
    if (
      !cart.recipient.name ||
      !cart.recipient.phone ||
      !cart.recipient.address ||
      !cart.shipping.service ||
      cart.shipping.cost === null
    )
      throw new Error('Lengkapi penerima, alamat, dan pengiriman sebelum checkout saldo.')
    const consent = await resolveCheckoutConsent(trx, cart, {
      confirmationMessageId,
      recapMessageId,
    })
    // Record the evidence actually verified, including a fallback when AI picked the wrong IDs.
    confirmationMessageId = consent!.confirmationMessageId
    recapMessageId = consent!.recapMessageId
    const quote = await customerBalanceQuote(jid, cart.total, true, undefined, trx)
    if (quote.amountDue !== 0 || quote.balanceToUse !== cart.total)
      throw new Error('Saldo tersedia belum cukup setelah memperhitungkan tagihan sebelumnya.')
    const createdAt = new Date()
    const {
      number,
      result: [id],
    } = await insertNumberedOrder(createdAt, (order_number) =>
      trx.table('whatsapp_orders').insert({
        order_number,
        jid,
        snapshot_json: JSON.stringify({
          ...cart,
          checkoutEvidence: { confirmationMessageId, recapMessageId },
        }),
        total: cart.total,
        paid: 0,
        status: 'active',
        created_at: createdAt,
        updated_at: createdAt,
      })
    )
    await allocateCustomerBalance(jid, 'system:confirmed-balance', trx, Number(id))
    const order = await trx.from('whatsapp_orders').where('id', id).firstOrFail()
    if (Number(order.paid) !== cart.total)
      throw new Error('Alokasi saldo belum lengkap; checkout dibatalkan.')
    await syncApprovalWaitEpisode(trx, jid, [])
    await trx.from('whatsapp_carts').where('jid', jid).update({
      version: randomUUID(),
      items_json: '[]',
      discount_json: null,
      recipient_json: '{"name":"","phone":"","address":""}',
      shipping_json: '{"service":"","cost":null}',
      note: '',
      payment_status: 'none',
      proof_message_id: null,
      updated_at: createdAt,
    })
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action: 'payment_confirmed',
      actor: 'system:confirmed-balance',
      created_at: createdAt,
      summary_json: JSON.stringify({
        orderId: Number(id),
        orderNumber: number,
        amount: 0,
        balanceApplied: cart.total,
        cartCleared: true,
        balanceConfirmationMessageId: confirmationMessageId,
        recapMessageId,
      }),
    })
    return Number(id)
  })
  return orderView(await db.from('whatsapp_orders').where({ id: orderId, jid }).firstOrFail())
}

/** Deterministic recovery: no AI action is needed to settle an already accepted, unchanged cart. */
export async function tryConfirmedBalanceCheckout(jid: string, version: string) {
  const candidate = await db.transaction(async (trx) => {
    const row = await trx.from('whatsapp_carts').where('jid', jid).forUpdate().first()
    if (!row) return null
    const cart = decode(row)
    if (cart.version !== version) throw new Error('Cart berubah selama pemeriksaan checkout.')
    if (
      !cart.items.length ||
      !cart.totalComplete ||
      cart.total <= 0 ||
      !cart.recipient.name ||
      !cart.recipient.phone ||
      !cart.recipient.address ||
      !cart.shipping.service ||
      cart.shipping.cost === null ||
      cart.items.some(
        (item) =>
          (item.modelType === 'custom' && item.modelApproval !== 'approved') ||
          (item.size === 'custom' && (item.approval !== 'approved' || !hasCustomMeasurements(item)))
      )
    )
      return null
    const consent = await resolveCheckoutConsent(trx, cart)
    if (!consent) return null
    const quote = await customerBalanceQuote(jid, cart.total, true, undefined, trx)
    return quote.amountDue === 0 && quote.balanceToUse === cart.total ? consent : null
  })
  if (!candidate) return null
  const settledOrder = await checkoutFromBalance(
    jid,
    version,
    candidate.confirmationMessageId,
    candidate.recapMessageId
  )
  return { ...(await readCart(jid)), settledOrder }
}

export async function confirmPayment(jid: string, input: Record<string, any>, actor: string) {
  if (input.verified !== true)
    throw new Error('Periksa dana masuk sebelum mengonfirmasi pembayaran.')
  await readCart(jid)
  if (input.reviewId) {
    const { reviewedPaymentInput } = await import('#services/payment_review_service')
    input = { ...input, ...(await reviewedPaymentInput(jid, String(input.reviewId))) }
  }
  const key = text(input.requestKey, 'ID konfirmasi', true, 36)
  if (!/^[a-f0-9-]{36}$/i.test(key)) throw new Error('ID konfirmasi tidak valid.')
  const reference = text(input.reference, 'Referensi transfer', !input.reviewId, 190) || null
  const amount = integer(input.amount, 'Jumlah pembayaran', 1)
  const methodId = integer(input.methodId, 'Metode pembayaran', 1)
  const orderId = await db.transaction(async (trx) => {
    const row = await trx.from('whatsapp_carts').where('jid', jid).forUpdate().firstOrFail()
    const receipt = await trx.from('whatsapp_order_payments').where('request_key', key).first()
    if (receipt) {
      const order = await trx.from('whatsapp_orders').where('id', receipt.order_id).firstOrFail()
      if (
        order.jid !== jid ||
        Number(receipt.amount) !== amount ||
        (receipt.reference || null) !== reference ||
        Number(receipt.method_id) !== methodId
      )
        throw new Error('ID konfirmasi sudah digunakan.')
      return order.id
    }
    if (input.reviewId) {
      const { validatePaymentReview } = await import('#services/payment_review_service')
      await validatePaymentReview(jid, input, row, trx)
    }
    const method = await trx
      .from('whatsapp_payment_methods')
      .where('id', methodId)
      .where('enabled', true)
      .first()
    if (!method) throw new Error('Pilih metode pembayaran aktif.')
    if (
      reference &&
      (await trx
        .from('whatsapp_order_payments')
        .where('method_id', methodId)
        .where('reference', reference)
        .first())
    )
      throw new Error('Referensi transfer sudah dikonfirmasi.')
    let order: any
    let proofId: string | null = input.reviewId ? input.proofMessageId : null
    if (input.orderId) {
      order = await trx
        .from('whatsapp_orders')
        .where('id', input.orderId)
        .where('jid', jid)
        .forUpdate()
        .first()
      if (!order || order.status !== 'active')
        throw new Error('Order tidak dapat menerima pembayaran.')
      if (
        proofId &&
        (await trx.from('whatsapp_order_payments').where('proof_message_id', proofId).first())
      )
        throw new Error('Bukti ini sudah digunakan.')
    } else {
      const cart = decode(row)
      if (cart.version !== input.version)
        throw new Error('Cart berubah. Periksa ulang sebelum konfirmasi.')
      if (!cart.items.length || cart.paymentStatus !== 'reported')
        throw new Error('Tandai transfer pelanggan terlebih dahulu.')
      if (
        cart.items.some(
          (item) =>
            item.size === 'custom' && (item.approval !== 'approved' || !hasCustomMeasurements(item))
        )
      )
        throw new Error('Ukuran custom belum disetujui CS.')
      if (
        cart.items.some((item) => item.modelType === 'custom' && item.modelApproval !== 'approved')
      )
        throw new Error('Model di luar katalog belum disetujui CS.')
      if (cart.items.some((item) => item.unitPrice === null))
        throw new Error('Harga model belum dikonfirmasi.')
      if (cart.items.some((item) => item.catalogVerification === 'pending'))
        throw new Error('Data katalog pesanan belum terverifikasi.')
      if (
        !cart.recipient.name ||
        !cart.recipient.phone ||
        !cart.recipient.address ||
        !cart.shipping.service ||
        cart.shipping.cost === null
      )
        throw new Error('Lengkapi penerima, alamat, dan pengiriman sebelum konfirmasi.')
      proofId = input.reviewId ? input.proofMessageId : cart.proofMessageId
      if (
        proofId &&
        (await trx.from('whatsapp_order_payments').where('proof_message_id', proofId).first())
      )
        throw new Error('Bukti ini sudah digunakan.')
      const createdAt = new Date()
      const {
        number,
        result: [id],
      } = await insertNumberedOrder(createdAt, (order_number) =>
        trx.table('whatsapp_orders').insert({
          order_number,
          jid,
          snapshot_json: JSON.stringify(cart),
          total: cart.total,
          paid: 0,
          status: 'active',
          created_at: createdAt,
          updated_at: createdAt,
        })
      )
      order = { id, order_number: number, total: cart.total, paid: 0 }
      await syncApprovalWaitEpisode(trx, jid, [])
      await trx.from('whatsapp_carts').where('jid', jid).update({
        version: randomUUID(),
        items_json: '[]',
        discount_json: null,
        recipient_json: '{"name":"","phone":"","address":""}',
        shipping_json: '{"service":"","cost":null}',
        note: '',
        payment_status: 'none',
        proof_message_id: null,
        updated_at: new Date(),
      })
    }
    // Apply existing credit first, using the same oldest-order priority as the quote.
    // The cart lock serializes all credit spending and payment confirmation.
    await allocateCustomerBalance(
      jid,
      actor,
      trx,
      input.orderId ? undefined : Number(order.id),
      true
    )
    order = await trx.from('whatsapp_orders').where('id', order.id).firstOrFail()
    // Only the newly received excess becomes credit; never re-credit prior payments.
    const overpayment = Math.max(0, Number(order.paid) + amount - Number(order.total))
    const credit = overpayment - Math.max(0, Number(order.paid) - Number(order.total))
    const [paymentId] = await trx.table('whatsapp_order_payments').insert({
      order_id: order.id,
      request_key: key,
      amount,
      method_id: methodId,
      method_json: JSON.stringify({
        name: method.name,
        destination: method.destination,
        accountName: method.account_name,
      }),
      reference,
      proof_message_id: proofId,
      proof_hash: input.reviewId ? input.review.proof_hash : null,
      confirmed_by: actor,
      created_at: new Date(),
    })
    if (credit > 0) {
      await trx.table('whatsapp_customer_balance_entries').insert({
        jid,
        order_id: order.id,
        payment_id: paymentId,
        amount: credit,
        reason: 'overpayment',
        created_at: new Date(),
      })
    }
    await trx
      .from('whatsapp_orders')
      .where('id', order.id)
      .update({ paid: Number(order.paid) + amount, updated_at: new Date() })
    await trx
      .from('whatsapp_carts')
      .where('jid', jid)
      .update({ version: randomUUID(), updated_at: new Date() })
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action: 'payment_confirmed',
      actor,
      summary_json: JSON.stringify({
        orderNumber: orderNumber(order),
        amount,
        overpayment,
        creditedToBalance: credit,
        cartCleared: !input.orderId,
      }),
      created_at: new Date(),
    })
    await allocateCustomerBalance(
      jid,
      actor,
      trx,
      input.orderId ? undefined : Number(order.id),
      true
    )
    await onOrderPayment(Number(order.id), actor, trx, !input.orderId)
    return order.id
  })
  return orderView(await db.from('whatsapp_orders').where('id', orderId).firstOrFail())
}
export async function cancelOrder(jid: string, id: number, actor = 'cs') {
  validateJid(jid)
  await readCart(jid)
  await db.transaction(async (trx) => {
    await trx.from('whatsapp_carts').where('jid', jid).forUpdate().firstOrFail()
    const order = await trx
      .from('whatsapp_orders')
      .where('id', id)
      .where('jid', jid)
      .forUpdate()
      .first()
    if (!order) throw new Error('Order tidak ditemukan.')
    if (order.status === 'cancelled') return
    await trx
      .from('whatsapp_orders')
      .where('id', id)
      .update({ status: 'cancelled', updated_at: new Date() })
    await trx
      .from('whatsapp_carts')
      .where('jid', jid)
      .update({ version: randomUUID(), updated_at: new Date() })
    await trx.table('whatsapp_cart_events').insert({
      jid,
      action: 'order_cancelled',
      actor,
      summary_json: JSON.stringify({ orderId: id }),
      created_at: new Date(),
    })
  })
  // Payment audit is retained. Cancelling never claims to refund a transfer.
}
