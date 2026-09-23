import db from '#services/workspace_database'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { initializeDatabase } from '#services/init_model'
import { defaultProductionPolicy, type ProductionRule } from '#services/production_contract'
import { orderNumber } from '#services/order_number'
import {
  nextProductionStage,
  progressProduction,
  startConfirmedProduction,
} from '#services/order_progress_service'
import { normalizeProductionDetails } from '#services/order_item_details'
import { queueOrderShipment, shippingStatesForOrders } from '#services/order_shipping_queue'

export const ORDER_STAGES = [
  'unverified',
  'awaiting_details',
  'queued',
  'production',
  'qc',
  'ready',
  'shipped',
  'completed',
] as const
export type Operations = {
  stage: (typeof ORDER_STAGES)[number]
  kind: 'standard' | 'custom' | 'preorder'
  mixedFulfillment?: boolean
  estimate: ProductionRule | null
  policyVersion: string | null
  eligibleAt: string | null
  startedOn: string | null
  expectedReadyOn: string | null
  shippedOn: string | null
  trackingNumber: string
  carrier: string
  note: string
  externalSource: string
  externalId: string
  source: string
}
type CartSnapshot = {
  items: Array<Record<string, any>>
  recipient: { name: string; address: string; phone: string }
}
const day = () => DateTime.now().setZone('Asia/Jakarta').toISODate()!
export function initialOperations(cart: CartSnapshot): Operations {
  const preorder = cart.items.filter((i) => i.fulfillment === 'preorder')
  return {
    stage: 'unverified',
    // The slowest kind governs one shared estimate; per-item fulfillment stays in the snapshot.
    kind: cart.items.some((i) => i.size === 'custom' || i.modelType === 'custom')
      ? 'custom'
      : preorder.length
        ? 'preorder'
        : 'standard',
    mixedFulfillment: preorder.length > 0 && preorder.length < cart.items.length,
    estimate: null,
    policyVersion: null,
    eligibleAt: null,
    startedOn: null,
    expectedReadyOn: null,
    shippedOn: null,
    trackingNumber: '',
    carrier: '',
    note: '',
    externalSource: '',
    externalId: '',
    source: 'unverified',
  }
}
function parse(row: any, order: any) {
  return row
    ? (JSON.parse(row.data_json) as Operations)
    : initialOperations(JSON.parse(order.snapshot_json))
}
async function ensureRouting(trx?: TransactionClientContract) {
  const client = trx || db
  await client.rawQuery(
    'INSERT IGNORE INTO whatsapp_order_routing (id,version,updated_at) VALUES (1,?,?)',
    [randomUUID(), new Date()]
  )
}
async function groupAllowed(jid: unknown, trx?: TransactionClientContract) {
  if (jid === null || jid === '') return null
  if (typeof jid !== 'string' || !/^[0-9-]+@g\.us$/.test(jid))
    throw new Error('Pilih grup WhatsApp yang tersedia.')
  if (
    !(await (trx || db)
      .from('whatsapp_order_groups')
      .where('jid', jid)
      .where('available', true)
      .first())
  )
    throw new Error('Grup belum tersedia. Perbarui daftar grup.')
  return jid
}
const triggerValue = (value: unknown) => {
  if (value !== 'first_payment' && value !== 'fully_paid')
    throw new Error('Pemicu pembayaran tidak valid.')
  return value
}
export async function orderRouting() {
  await initializeDatabase()
  await ensureRouting()
  const row = await db.from('whatsapp_order_routing').where('id', 1).firstOrFail()
  return {
    version: row.version,
    groupJid: row.group_jid,
    paymentTrigger: row.payment_trigger,
    groupsUpdatedAt: row.groups_updated_at,
    refreshRequested: Boolean(row.refresh_requested),
    groups: await db
      .from('whatsapp_order_groups')
      .where('available', true)
      .orderBy('name', 'asc')
      .select('jid', 'name'),
  }
}
export async function saveOrderRouting(input: Record<string, unknown>) {
  await initializeDatabase()
  await ensureRouting()
  const group = await groupAllowed(input.groupJid)
  const trigger = triggerValue(input.paymentTrigger)
  const updated = await db
    .from('whatsapp_order_routing')
    .where('id', 1)
    .where('version', String(input.version))
    .update({
      group_jid: group,
      payment_trigger: trigger,
      version: randomUUID(),
      updated_at: new Date(),
    })
  if (!updated) throw new Error('Pengaturan berubah. Muat ulang terlebih dahulu.')
  return orderRouting()
}
export async function requestOrderGroups() {
  await initializeDatabase()
  await ensureRouting()
  await db.from('whatsapp_order_routing').where('id', 1).update({ refresh_requested: true })
}
export async function cacheOrderGroups(
  groups: Array<{ id: string; subject?: string; isCommunity?: boolean }>
) {
  await db.transaction(async (trx) => {
    await ensureRouting(trx)
    await trx.from('whatsapp_order_groups').update({ available: false })
    for (const group of groups) {
      if (!/^[0-9-]+@g\.us$/.test(group.id) || group.isCommunity) continue
      await trx.rawQuery(
        `INSERT INTO whatsapp_order_groups (jid,name,available,updated_at) VALUES (?,?,1,?)
        ON DUPLICATE KEY UPDATE name=VALUES(name),available=1,updated_at=VALUES(updated_at)`,
        [group.id, String(group.subject || group.id).slice(0, 255), new Date()]
      )
    }
    await trx
      .from('whatsapp_order_routing')
      .where('id', 1)
      .update({ refresh_requested: false, groups_updated_at: new Date() })
  })
}

/** Only production facts; private cart notes, contact data and payment proof are excluded. */
export function groupOrderSnapshot(order: any) {
  const cart = JSON.parse(order.snapshot_json) as CartSnapshot
  const clean = (value: unknown, limit = 300) => {
    let result = String(value || '').replace(/[\r\n]+/g, ' ')
    for (const secret of [cart.recipient.address, cart.recipient.phone].filter(Boolean)) {
      const pattern = secret
        .trim()
        .split(/\s+/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+')
      result = result.replace(new RegExp(pattern, 'gi'), '[private]')
    }
    return result
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\+?\d[\d ()-]{8,}\d/g, '[private]')
      .slice(0, limit)
      .trim()
  }
  return {
    number: orderNumber(order),
    customerName: clean(cart.recipient.name),
    payment: Number(order.paid) >= Number(order.total) ? 'Lunas terverifikasi' : 'DP terverifikasi',
    items: cart.items.map((item) => ({
      name: clean(item.name),
      size: clean(`${item.size || ''}${item.requestedSize ? ` ${item.requestedSize}` : ''}`, 80),
      quantity: Number(item.quantity),
      measurements: Object.entries(item.measurements || {}).map(([key, value]) => ({
        name: clean(key, 80),
        value: Number(value),
      })),
      image: String(item.image || ''),
      productionDetails: (() => {
        const details = normalizeProductionDetails(item.productionDetails)
        if (!details) return null
        return {
          heightCm: details.heightCm,
          weightKg: details.weightKg,
          fit: clean(details.fit),
          color: clean(details.color),
          material: clean(details.material),
          lapel: clean(details.lapel),
          buttons: clean(details.buttons),
          measurements: details.measurements.map((m) => ({ ...m, name: clean(m.name, 80) })),
          notes: clean(details.notes, 1000),
          pending: details.pending.map((value) => clean(value)),
        }
      })(),
      customApproval: item.size === 'custom' ? clean(item.approval, 30) : '',
      modelApproval: item.modelType === 'custom' ? clean(item.modelApproval, 30) : '',
    })),
  }
}
export function groupOrderParts(snapshot: ReturnType<typeof groupOrderSnapshot>) {
  const lines = [
    `Order ${snapshot.number}`,
    `Nama: ${snapshot.customerName}`,
    snapshot.payment,
    '',
    ...snapshot.items.flatMap((item, i) => [
      `${i + 1}. ${item.name}`,
      `Jumlah: ${item.quantity} pcs · Size: ${item.size}`,
      ...item.measurements.map((m) => `${m.name}: ${m.value} cm`),
      ...(item.productionDetails
        ? [
            ...[
              [
                'Tinggi',
                item.productionDetails.heightCm ? `${item.productionDetails.heightCm} cm` : '',
              ],
              [
                'Berat',
                item.productionDetails.weightKg ? `${item.productionDetails.weightKg} kg` : '',
              ],
              ['Fit', item.productionDetails.fit],
              ['Warna', item.productionDetails.color],
              ['Bahan', item.productionDetails.material],
              ['Lapel', item.productionDetails.lapel],
              ['Kancing', item.productionDetails.buttons],
              ['Catatan pengerjaan', item.productionDetails.notes],
            ]
              .filter(([, value]) => value)
              .map(([key, value]) => `${key}: ${value}`),
            ...item.productionDetails.measurements.map(
              (m) => `${m.basis === 'body' ? 'Badan' : 'Pakaian jadi'} · ${m.name}: ${m.value} cm`
            ),
            ...item.productionDetails.pending.map((p) => `Perlu dilengkapi: ${p}`),
          ]
        : []),
      ...(item.customApproval ? [`Persetujuan ukuran: ${item.customApproval}`] : []),
      ...(item.modelApproval ? [`Persetujuan model: ${item.modelApproval}`] : []),
      '',
    ]),
  ]
  const body = lines.join('\n').trim()
  const parts: Array<{ text: string; image?: string }> = []
  for (let offset = 0; offset < body.length; offset += 3000)
    parts.push({ text: body.slice(offset, offset + 3000) })
  for (const item of snapshot.items)
    if (item.image)
      parts.push({
        text: `${snapshot.number} · ${item.name}\n${item.quantity} pcs · ${item.size}`,
        image: item.image,
      })
  return parts
}
async function queueOrder(order: any, operations: any, trx: TransactionClientContract) {
  if (
    !operations.group_jid ||
    order.status !== 'active' ||
    Number(order.total) <= 0 ||
    Number(order.paid) <= 0 ||
    (operations.payment_trigger === 'fully_paid' && Number(order.paid) < Number(order.total))
  )
    return
  // Both confirmed cash receipts and committed credit debits are payment evidence.
  // Never authorize dispatch from order.paid or an AI's claim alone.
  const cash = await trx
    .from('whatsapp_order_payments')
    .where('order_id', order.id)
    .sum('amount as total')
    .first()
  const credit = await trx
    .from('whatsapp_customer_balance_entries')
    .where({ order_id: order.id, jid: order.jid, reason: 'order_payment' })
    .sum('amount as total')
    .first()
  const verifiedCredit = Math.min(
    Number(order.balance_applied || 0),
    Math.max(0, -Number(credit?.total || 0))
  )
  if (Number(cash?.total || 0) + verifiedCredit < Math.min(Number(order.paid), Number(order.total)))
    return
  if (await trx.from('whatsapp_order_group_jobs').where('order_id', order.id).first()) return
  // Missing group membership must never roll back a valid payment confirmation.
  if (
    !(await trx
      .from('whatsapp_order_groups')
      .where('jid', operations.group_jid)
      .where('available', true)
      .first())
  )
    return
  const snapshot = groupOrderSnapshot(order)
  await trx.table('whatsapp_order_group_jobs').insert({
    order_id: order.id,
    group_jid: operations.group_jid,
    snapshot_json: JSON.stringify(snapshot),
    status: 'queued',
    created_at: new Date(),
    updated_at: new Date(),
  })
  const parts = groupOrderParts(snapshot)
  for (const [index, part] of parts.entries())
    await trx.table('whatsapp_order_group_parts').insert({
      order_id: order.id,
      part_index: index,
      message_id: randomUUID().replaceAll('-', '').toUpperCase(),
      content_json: JSON.stringify(part),
      status: 'queued',
      attempts: 0,
      next_attempt_at: new Date(),
      updated_at: new Date(),
    })
  return true
}

/** Backfill only missing jobs to the group recorded on the order; never replay sent/uncertain jobs. */
export async function recoverOrderGroupQueue() {
  const candidates = await db
    .from('whatsapp_orders as o')
    .join('whatsapp_order_operations as p', 'p.order_id', 'o.id')
    .join('whatsapp_order_groups as g', 'g.jid', 'p.group_jid')
    .leftJoin('whatsapp_order_group_jobs as j', 'j.order_id', 'o.id')
    .whereNull('j.order_id')
    .where('o.status', 'active')
    .where('o.paid', '>', 0)
    .where('g.available', true)
    .select('o.id')
    .orderBy('o.id')
    .limit(50)
  let queued = 0
  for (const candidate of candidates) {
    const added = await db.transaction(async (trx) => {
      const order = await trx.from('whatsapp_orders').where('id', candidate.id).forUpdate().first()
      const operations = await trx
        .from('whatsapp_order_operations')
        .where('order_id', candidate.id)
        .forUpdate()
        .first()
      if (!order || !operations) return false
      return queueOrder(order, operations, trx)
    })
    if (added) queued++
  }
  return queued
}

/** Called inside the existing payment transaction; never sends from a web request. */
export async function onOrderPayment(
  orderId: number,
  actor: string,
  trx: TransactionClientContract,
  newOrder = false,
  deferDispatch = false
) {
  const order = await trx.from('whatsapp_orders').where('id', orderId).firstOrFail()
  let row = await trx
    .from('whatsapp_order_operations')
    .where('order_id', orderId)
    .forUpdate()
    .first()
  let data = parse(row, order)
  if (!row) {
    await ensureRouting(trx)
    const routing = await trx.from('whatsapp_order_routing').where('id', 1).firstOrFail()
    const policyRow = await trx.from('whatsapp_production_policy').where('id', 1).first()
    const policy = policyRow ? JSON.parse(policyRow.policy_json) : defaultProductionPolicy()
    // Explicit creation flag from checkout; never infer legacy order age as production evidence.
    if (newOrder) {
      data.stage = 'queued'
      data.source = 'verified_payment'
      data.estimate =
        data.kind === 'standard'
          ? null
          : policy.rules[data.kind]?.enabled
            ? policy.rules[data.kind]
            : null
      data.policyVersion = policy.version
    }
    row = {
      order_id: orderId,
      version: randomUUID(),
      data_json: JSON.stringify(data),
      group_jid: newOrder ? routing.group_jid : null,
      payment_trigger: routing.payment_trigger,
      updated_at: new Date(),
    }
    await trx.table('whatsapp_order_operations').insert(row)
  }
  const before = JSON.parse(row.data_json)
  if (newOrder || (data.stage === 'queued' && data.source === 'verified_payment'))
    data = startConfirmedProduction(data, order)
  if (
    !data.eligibleAt &&
    data.estimate &&
    (data.estimate.startsAfter === 'payment_details' ||
      (data.estimate.startsAfter === 'approval' && data.stage === 'production') ||
      (data.estimate.startsAfter === 'full_payment_details' &&
        Number(order.paid) >= Number(order.total)))
  ) {
    data.eligibleAt = new Date().toISOString()
    if (data.estimate.dayType === 'calendar' && !data.expectedReadyOn)
      data.expectedReadyOn = DateTime.now()
        .setZone('Asia/Jakarta')
        .plus({ days: data.estimate.estimateDays! })
        .toISODate()
  }
  if (JSON.stringify(data) !== JSON.stringify(before)) {
    await trx
      .from('whatsapp_order_operations')
      .where('order_id', orderId)
      .update({ data_json: JSON.stringify(data), version: randomUUID(), updated_at: new Date() })
    await trx.table('whatsapp_order_operation_events').insert({
      order_id: orderId,
      actor,
      before_json: JSON.stringify(before),
      after_json: JSON.stringify(data),
      created_at: new Date(),
    })
  }
  if (!deferDispatch) await queueOrder(order, { ...row, data_json: JSON.stringify(data) }, trx)
}

export async function operationsForOrders(orders: any[]) {
  if (!orders.length) return orders
  const rows = await db.from('whatsapp_order_operations').whereIn(
    'order_id',
    orders.map((o) => o.id)
  )
  const shipping = await shippingStatesForOrders(orders.map((order) => Number(order.id)))
  return orders.map((order) => {
    const row = rows.find((r) => Number(r.order_id) === Number(order.id))
    return {
      ...order,
      operations: row ? { ...JSON.parse(row.data_json), updatedAt: row.updated_at } : null,
      shipment: shipping.get(Number(order.id)) || null,
    }
  })
}
export async function operationalOrders(input: {
  query?: string
  stage?: string
  tab?: string
  page?: number
  orderId?: number
}) {
  await initializeDatabase()
  const page = Math.max(1, Math.min(10000, Math.floor(Number(input.page) || 1)))
  const base = () =>
    db.from('whatsapp_orders as o').leftJoin('whatsapp_order_operations as p', 'p.order_id', 'o.id')
  const query = base()
  if (input.orderId !== undefined)
    query.where(
      'o.id',
      Number.isSafeInteger(input.orderId) && input.orderId > 0 ? input.orderId : 0
    )
  const search = input.query?.slice(0, 100)
  if (search)
    query.where((q) =>
      q
        .whereRaw('CAST(o.id AS CHAR) = ?', [search.replace(/^WA-0*/i, '')])
        .orWhere('o.order_number', search.trim())
        .orWhereRaw("JSON_UNQUOTE(JSON_EXTRACT(o.snapshot_json, '$.recipient.name')) LIKE ?", [
          `%${search}%`,
        ])
    )
  if (input.tab === 'completed')
    query
      .where('o.status', 'active')
      .whereRaw("JSON_UNQUOTE(JSON_EXTRACT(p.data_json, '$.stage')) = 'completed'")
  else if (input.tab === 'active')
    query
      .where('o.status', 'active')
      .whereRaw(
        "COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.data_json, '$.stage')), 'unverified') <> 'completed'"
      )
  if (input.stage === 'cancelled') query.where('o.status', 'cancelled')
  else if (input.stage && ORDER_STAGES.includes(input.stage as Operations['stage']))
    query
      .where('o.status', 'active')
      .whereRaw("COALESCE(JSON_UNQUOTE(JSON_EXTRACT(p.data_json, '$.stage')), 'unverified') = ?", [
        input.stage,
      ])
  const total = await query.clone().count('* as count').first()
  const rows = await query
    .select(
      'o.*',
      'p.version as operations_version',
      'p.data_json',
      'p.group_jid',
      'p.payment_trigger',
      'p.updated_at as operations_updated_at'
    )
    .orderBy('o.id', 'desc')
    .limit(30)
    .offset((page - 1) * 30)
  const jobs = rows.length
    ? await db.from('whatsapp_order_group_jobs').whereIn(
        'order_id',
        rows.map((r) => r.id)
      )
    : []
  const shipping = await shippingStatesForOrders(rows.map((row) => Number(row.id)))
  return {
    page,
    sources: await db
      .from('whatsapp_mcp_connections')
      .select('slug', 'name')
      .orderBy('name', 'asc'),
    total: Number(total?.count || 0),
    orders: rows.map((row) => ({
      id: Number(row.id),
      number: orderNumber(row),
      jid: row.jid,
      cart: JSON.parse(row.snapshot_json),
      total: Number(row.total),
      paid: Number(row.paid),
      status: row.status,
      createdAt: row.created_at,
      version: row.operations_version || '',
      operations: parse(row.data_json ? row : null, row),
      shipment: shipping.get(Number(row.id)) || null,
      nextProductionStage:
        row.status === 'active'
          ? nextProductionStage(parse(row.data_json ? row : null, row))
          : null,
      operationsUpdatedAt: row.operations_updated_at,
      groupJid: row.group_jid || null,
      paymentTrigger: row.payment_trigger || 'first_payment',
      dispatch: jobs.find((j) => Number(j.order_id) === Number(row.id))?.status || 'not_queued',
      preview: groupOrderSnapshot(row),
    })),
  }
}
function dateInput(value: unknown) {
  if (value === null || value === '') return null
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !DateTime.fromISO(value).isValid
  )
    throw new Error('Tanggal tidak valid.')
  return value
}
export async function saveOrderOperations(id: number, input: Record<string, any>, actor: string) {
  await initializeDatabase()
  await db.transaction(async (trx) => {
    const order = await trx.from('whatsapp_orders').where('id', id).forUpdate().firstOrFail()
    if (order.status !== 'active') throw new Error('Order sudah dibatalkan.')
    const row = await trx
      .from('whatsapp_order_operations')
      .where('order_id', id)
      .forUpdate()
      .first()
    if ((row?.version || '') !== input.version)
      throw new Error('Order berubah. Muat ulang terlebih dahulu.')
    const before = parse(row, order)
    let next = { ...before }
    if (input.advance === true) {
      if (input.operations || input.groupJid !== undefined || input.paymentTrigger !== undefined)
        throw new Error('Pembaruan tahap tidak dapat digabung dengan perubahan lain.')
      const policyRow = await trx.from('whatsapp_production_policy').where('id', 1).first()
      const policy = policyRow ? JSON.parse(policyRow.policy_json) : defaultProductionPolicy()
      next = progressProduction(before, order, policy)
    }
    if (input.operations) {
      const op = input.operations
      if (!ORDER_STAGES.includes(op.stage) || !['standard', 'custom', 'preorder'].includes(op.kind))
        throw new Error('Status produksi tidak valid.')
      next.stage = op.stage
      next.kind = op.kind
      next.mixedFulfillment = before.mixedFulfillment === true
      for (const key of ['startedOn', 'expectedReadyOn', 'shippedOn'] as const)
        next[key] = dateInput(op[key])
      for (const key of [
        'trackingNumber',
        'carrier',
        'note',
        'externalSource',
        'externalId',
      ] as const) {
        if (typeof op[key] !== 'string' || op[key].length > (key === 'note' ? 2000 : 190))
          throw new Error('Keterangan produksi tidak valid.')
        next[key] = op[key].trim()
      }
      if (next.startedOn && next.startedOn > day())
        throw new Error('Tanggal mulai aktual tidak boleh di masa depan.')
      if (next.shippedOn && next.shippedOn > day())
        throw new Error('Tanggal kirim aktual tidak boleh di masa depan.')
      if (next.stage === 'production' && !next.startedOn)
        throw new Error('Isi tanggal mulai produksi aktual.')
      if (
        ['shipped', 'completed'].includes(next.stage) &&
        (!next.shippedOn || !next.trackingNumber)
      )
        throw new Error('Isi tanggal kirim dan resi.')
      if (next.expectedReadyOn && next.startedOn && next.expectedReadyOn < next.startedOn)
        throw new Error('Estimasi selesai mendahului mulai produksi.')
      if (next.shippedOn && next.startedOn && next.shippedOn < next.startedOn)
        throw new Error('Tanggal kirim mendahului mulai produksi.')
      if (before.kind !== next.kind && before.estimate && op.adoptEstimate !== true)
        throw new Error('Jenis pesanan berubah. Pilih sumber estimasi yang sesuai.')
      if (Boolean(next.externalId) !== Boolean(next.externalSource))
        throw new Error('Lengkapi sumber dan ID eksternal.')
      if (
        next.externalSource &&
        !(await trx.from('whatsapp_mcp_connections').where('slug', next.externalSource).first())
      )
        throw new Error('Sumber MCP tidak ditemukan.')
      next.source = 'operator'
      if (op.adoptEstimate === true) {
        if (!next.startedOn)
          throw new Error('Verifikasi tanggal mulai sebelum memakai estimasi pengaturan.')
        const policyRow = await trx.from('whatsapp_production_policy').where('id', 1).first()
        const policy = policyRow ? JSON.parse(policyRow.policy_json) : defaultProductionPolicy()
        const rule = next.kind === 'standard' ? null : policy.rules[next.kind]
        if (!rule?.enabled) throw new Error('Aktifkan pengaturan estimasi untuk jenis pesanan ini.')
        next.estimate = rule
        next.policyVersion = policy.version
        next.eligibleAt = DateTime.fromISO(next.startedOn, { zone: 'Asia/Jakarta' }).toISO()
        if (!next.expectedReadyOn && rule.dayType === 'calendar')
          next.expectedReadyOn = DateTime.fromISO(next.startedOn)
            .plus({ days: rule.estimateDays })
            .toISODate()
      }
    }
    const group =
      input.groupJid !== undefined
        ? await groupAllowed(input.groupJid, trx)
        : row?.group_jid || null
    const trigger =
      input.paymentTrigger !== undefined
        ? triggerValue(input.paymentTrigger)
        : row?.payment_trigger || 'first_payment'
    const job = await trx
      .from('whatsapp_order_group_jobs')
      .where('order_id', id)
      .forUpdate()
      .first()
    if (job && group !== job.group_jid)
      throw new Error('Order sudah diantrekan. Tujuan grup tidak dapat diganti.')
    const record = {
      order_id: id,
      version: randomUUID(),
      data_json: JSON.stringify(next),
      group_jid: group,
      payment_trigger: trigger,
      updated_at: new Date(),
    }
    if (row) await trx.from('whatsapp_order_operations').where('order_id', id).update(record)
    else await trx.table('whatsapp_order_operations').insert(record)
    await trx.table('whatsapp_order_operation_events').insert({
      order_id: id,
      actor,
      before_json: JSON.stringify({ operations: before, groupJid: row?.group_jid || null }),
      after_json: JSON.stringify({ operations: next, groupJid: group }),
      created_at: new Date(),
    })
    await queueOrder(order, record, trx)
    await queueOrderShipment(order, next, trx)
  })
}
