import db from '#services/workspace_database'
import { queueOutgoingMessage } from '#services/message_service'
import { listPaymentMethods } from '#services/payment_method_service'
import { ensureLeanTables } from '#services/lean/lean_tables'
import {
  mergeCustomerNote,
  readCustomerNote,
  writeCustomerNote,
  writeOrderSpec,
} from '#services/lean/lean_customer_service'
import { rupiah } from '#services/lean/lean_catalog_service'

/**
 * Jalur 2 (event): form order dari pelanggan dibaca KODE, disimpan sebagai order
 * menunggu CS. AI tetap yang membalas kata-katanya. CS mengisi ongkir/total di
 * dashboard → sistem mengirim total + rekening. Tidak ada verifikasi MCP di
 * tengah chat.
 */
export type ParsedOrderForm = {
  customerName: string
  address: string
  district: string
  regency: string
  postalCode: string
  phone: string
  note: string
}

const FIELD_PATTERNS: Array<[keyof ParsedOrderForm, RegExp]> = [
  ['customerName', /^\s*nama(?:\s+penerima)?\s*[:;=]\s*(.+)$/im],
  ['address', /^\s*alamat(?:\s+lengkap)?\s*[:;=]\s*(.+)$/im],
  ['district', /^\s*kec(?:amatan)?\.?\s*[:;=]\s*(.+)$/im],
  ['regency', /^\s*(?:kab(?:upaten)?|kota|kab\/kota)\.?\s*[:;=]\s*(.+)$/im],
  ['postalCode', /^\s*kode\s*pos\s*[:;=]\s*(.+)$/im],
  ['phone', /^\s*(?:no\.?\s*(?:telp|hp|wa|telepon)|telp|hp|nomor\s*(?:hp|telp))\s*[:;=]\s*(.+)$/im],
  ['note', /^\s*(?:note|catatan|keterangan)\s*[:;=]\s*([\s\S]+)$/im],
]

/** Form order dikenali kalau ada nama + alamat + salah satu dari telp/kecamatan/kode pos. */
export function parseOrderForm(text: string): ParsedOrderForm | null {
  if (!text || text.length < 20) return null
  const result: Partial<ParsedOrderForm> = {}
  for (const [field, pattern] of FIELD_PATTERNS) {
    const match = text.match(pattern)
    if (match)
      result[field] = match[1]
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, field === 'note' ? 1000 : 300)
  }
  if (!result.customerName || !result.address) return null
  if (!result.phone && !result.district && !result.postalCode) return null
  return {
    customerName: result.customerName,
    address: result.address,
    district: result.district || '',
    regency: result.regency || '',
    postalCode: (result.postalCode || '').replace(/[^\d]/g, ''),
    phone: (result.phone || '').replace(/[^\d+]/g, ''),
    note: result.note || '',
  }
}

export async function saveLeanOrder(input: {
  jid: string
  sourceMessageId?: string
  form: ParsedOrderForm
  items: string
  spec?: string
  chatNote?: string
  shippingOptions?: unknown
}) {
  await ensureLeanTables()
  const existing = await db
    .from('whatsapp_lean_orders')
    .where('jid', input.jid)
    .where('status', 'pending')
    .orderBy('id', 'desc')
    .first()
  const now = new Date()
  const values = {
    jid: input.jid,
    source_message_id: input.sourceMessageId || null,
    customer_name: input.form.customerName.slice(0, 190),
    address: input.form.address,
    district: input.form.district.slice(0, 120),
    regency: input.form.regency.slice(0, 120),
    postal_code: input.form.postalCode.slice(0, 20),
    phone: input.form.phone.slice(0, 40),
    items: input.items.slice(0, 4000),
    spec: input.spec ? input.spec.slice(0, 4000) : null,
    shipping_options: input.shippingOptions ? JSON.stringify(input.shippingOptions) : null,
    note: input.form.note || null,
    chat_note: input.chatNote || null,
    updated_at: now,
  }
  if (existing) {
    await db.from('whatsapp_lean_orders').where('id', existing.id).update(values)
    return Number(existing.id)
  }
  const [id] = await db
    .table('whatsapp_lean_orders')
    .insert({ ...values, status: 'pending', created_at: now })
  return Number(id)
}

/** Tarif yang baru berhasil dihitung setelah form masuk disimpan ke order pending. */
export async function updatePendingOrderRates(id: number, rates: unknown) {
  await ensureLeanTables()
  await db
    .from('whatsapp_lean_orders')
    .where('id', id)
    .where('status', 'pending')
    .update({ shipping_options: JSON.stringify(rates), updated_at: new Date() })
}

/** Spesifikasi yang diperbarui AI setelah form masuk tetap ikut ke order yang masih menunggu CS. */
export async function updatePendingOrderSpec(jid: string, spec: string) {
  await ensureLeanTables()
  await db
    .from('whatsapp_lean_orders')
    .where('jid', jid)
    .whereIn('status', ['pending', 'awaiting_payment'])
    .update({ spec: spec.slice(0, 4000), items: spec.slice(0, 4000), updated_at: new Date() })
}

async function nextOrderNumber() {
  const stamp = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' })
    .format(new Date())
    .replace(/-/g, '')
  const prefix = `PO-${stamp}-`
  const last = await db
    .from('whatsapp_lean_orders')
    .where('order_number', 'like', `${prefix}%`)
    .orderBy('order_number', 'desc')
    .first()
  const sequence = last ? Number(String(last.order_number).slice(prefix.length)) + 1 : 1
  return `${prefix}${String(sequence).padStart(3, '0')}`
}

export async function listLeanOrders(status?: string, q?: string) {
  await ensureLeanTables()
  const query = db.from('whatsapp_lean_orders').orderBy('id', 'desc').limit(300)
  if (status && status !== 'all') {
    if (status === 'active') query.whereIn('status', ['pending', 'awaiting_payment'])
    else query.where('status', status)
  }
  const term = String(q || '').trim()
  if (term) {
    const like = `%${term.replace(/[%_]/g, '')}%`
    query.where((inner) =>
      inner
        .where('order_number', 'like', like)
        .orWhere('customer_name', 'like', like)
        .orWhere('phone', 'like', like)
        .orWhere('jid', 'like', like)
        .orWhere('items', 'like', like)
        .orWhere('spec', 'like', like)
        .orWhere('district', 'like', like)
        .orWhere('regency', 'like', like)
    )
  }
  return query
}

/** Jumlah order per status untuk tab halaman Order. */
export async function countLeanOrders() {
  await ensureLeanTables()
  const rows = await db
    .from('whatsapp_lean_orders')
    .select('status')
    .count('* as total')
    .groupBy('status')
  const counts: Record<string, number> = { all: 0 }
  for (const row of rows) {
    counts[String(row.status)] = Number(row.total)
    counts.all += Number(row.total)
  }
  return counts
}

export async function latestLeanOrder(jid: string) {
  await ensureLeanTables()
  return db.from('whatsapp_lean_orders').where('jid', jid).orderBy('id', 'desc').first()
}

export async function readLeanOrder(id: number) {
  await ensureLeanTables()
  return db.from('whatsapp_lean_orders').where('id', id).first()
}

/** Pesan total yang dikirim kode setelah CS mengisi ongkir. Formatnya meniru CS. */
export function renderTotalMessage(input: {
  items: string
  subtotal: number
  shippingService: string
  shippingCost: number
}) {
  const total = input.subtotal + input.shippingCost
  const lines = [
    input.items.trim(),
    `Ongkir${input.shippingService ? ` ${input.shippingService}` : ''} ${rupiah(input.shippingCost)}`,
    '',
    `Total ${rupiah(input.subtotal)} + ${rupiah(input.shippingCost)} = ${rupiah(total)} bos`,
  ]
  return lines.join('\n')
}

export function renderPaymentMessage(
  methods: Array<{ bank: string; number: string; holder: string }>
) {
  if (!methods.length) return ''
  const target = methods
    .map((method) => `${method.bank} ${method.number} an ${method.holder}`.trim())
    .join('\n')
  return `Untuk pembayaran tf ke rek ${target} agar pesanan langsung kami proses`
}

export async function approveLeanOrder(input: {
  id: number
  shippingService: string
  shippingCost: number
  subtotal: number
  csNote?: string
}) {
  await ensureLeanTables()
  const order = await readLeanOrder(input.id)
  if (!order) throw new Error('Order tidak ditemukan.')
  if (order.status !== 'pending') throw new Error('Order sudah diproses.')
  const total = input.subtotal + input.shippingCost
  const orderNumber = order.order_number || (await nextOrderNumber())
  await db
    .from('whatsapp_lean_orders')
    .where('id', input.id)
    .update({
      order_number: orderNumber,
      shipping_service: input.shippingService.slice(0, 40),
      shipping_cost: input.shippingCost,
      subtotal: input.subtotal,
      total,
      cs_note: input.csNote || null,
      status: 'awaiting_payment',
      updated_at: new Date(),
    })
  const previous = await readCustomerNote(String(order.jid))
  await writeCustomerNote(
    String(order.jid),
    mergeCustomerNote(previous, {
      'Nama': String(order.customer_name || ''),
      'Alamat': [order.address, order.district, order.regency, order.postal_code]
        .filter(Boolean)
        .join(', '),
      'Telp': String(order.phone || ''),
      'Order terakhir': `${orderNumber}: ${String(order.spec || order.items || '')
        .split('\n')
        .slice(0, 3)
        .join(
          ' / '
        )} (${new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short', year: 'numeric' }).format(new Date())})`,
      'Kebiasaan': input.shippingService ? `ongkir ${input.shippingService}` : '',
    })
  )
  return {
    ...order,
    order_number: orderNumber,
    total,
    shipping_cost: input.shippingCost,
    subtotal: input.subtotal,
  }
}

export async function markLeanOrderPaid(id: number, csNote?: string) {
  await ensureLeanTables()
  const order = await readLeanOrder(id)
  if (!order) throw new Error('Order tidak ditemukan.')
  // Lunas → antre ke grup produksi default (Order → Grup produksi default), dikirim worker.
  const routing = await db.from('whatsapp_order_routing').where('id', 1).first()
  const groupJid = routing?.group_jid ? String(routing.group_jid) : null
  await db
    .from('whatsapp_lean_orders')
    .where('id', id)
    .update({
      status: 'paid',
      cs_note: csNote || order.cs_note,
      order_number: order.order_number || (await nextOrderNumber()),
      group_jid: groupJid,
      group_status: groupJid ? 'pending' : 'none',
      group_error: null,
      updated_at: new Date(),
    })
  await writeOrderSpec(String(order.jid), '')
  return { ...order, group_jid: groupJid }
}

export async function requeueLeanOrderGroup(id: number) {
  await ensureLeanTables()
  const order = await readLeanOrder(id)
  if (!order) throw new Error('Order tidak ditemukan.')
  const routing = await db.from('whatsapp_order_routing').where('id', 1).first()
  const groupJid = routing?.group_jid ? String(routing.group_jid) : null
  if (!groupJid) throw new Error('Grup produksi default belum diatur di halaman Order.')
  await db.from('whatsapp_lean_orders').where('id', id).update({
    group_jid: groupJid,
    group_status: 'pending',
    group_error: null,
    updated_at: new Date(),
  })
}

/** Teks untuk grup produksi: tanpa alamat, telepon, dan bukti transfer. */
export function renderGroupOrderMessage(order: Record<string, any>) {
  const lines = [
    `PESANAN BARU ${order.order_number || `#${order.id}`}`,
    `Nama: ${order.customer_name || '-'}`,
    '',
    String(order.spec || order.items || '-').trim(),
  ]
  if (order.note) lines.push('', `Catatan pelanggan: ${String(order.note).trim()}`)
  if (order.cs_note) lines.push(`Catatan CS: ${String(order.cs_note).trim()}`)
  lines.push(
    '',
    `Pembayaran: lunas${order.total ? ` ${rupiah(Number(order.total))}` : ''}${order.shipping_service ? ` (${order.shipping_service})` : ''}`
  )
  return lines.join('\n')
}

/** Satu order lean yang menunggu dikirim ke grup; dipanggil worker. */
export async function nextLeanGroupOrder() {
  await ensureLeanTables()
  return db
    .from('whatsapp_lean_orders')
    .where('group_status', 'pending')
    .whereNotNull('group_jid')
    .orderBy('id', 'asc')
    .first()
}

export async function finishLeanGroupOrder(id: number, error?: string) {
  await db
    .from('whatsapp_lean_orders')
    .where('id', id)
    .update(
      error
        ? { group_status: 'failed', group_error: error.slice(0, 500), updated_at: new Date() }
        : {
            group_status: 'sent',
            group_sent_at: new Date(),
            group_error: null,
            updated_at: new Date(),
          }
    )
}

export async function cancelLeanOrder(id: number, csNote?: string) {
  await ensureLeanTables()
  await db
    .from('whatsapp_lean_orders')
    .where('id', id)
    .update({ status: 'cancelled', cs_note: csNote || null, updated_at: new Date() })
}

/**
 * Total otomatis: AI merinci item + layanan; kode memverifikasi tiap baris ke
 * KATALOG (nama produk + warna → harga; XXL-3XL memakai harga besar) dan layanan
 * ke tarif yang tersimpan di order. Semua harus cocok persis — kalau tidak,
 * order tetap menunggu CS seperti biasa.
 */
export type VerifiedAutoTotal = {
  orderId: number
  items: string
  subtotal: number
  shippingService: string
  shippingCost: number
}

export function matchAutoTotal(
  draft: { rincian: string; subtotal: number; layanan: string },
  catalog: Array<{
    product: string
    color: string
    price: number | null
    note: string
    active: boolean
  }>,
  prices: Array<{ service: string; price: number }>,
  /** Teks lain tempat mencari nama layanan bila draft.layanan kosong (catatan, spesifikasi, pesan). */
  hints: string[] = []
):
  | { ok: true; items: string; subtotal: number; shippingService: string; shippingCost: number }
  | { ok: false; reason: string } {
  const lines = draft.rincian
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) => line && !/^(kerah|saku|list|kancing|bahan|warna bagian|catatan|note)\b/i.test(line)
    )
  if (!lines.length) return { ok: false, reason: 'rincian kosong' }
  // Nama produk terpanjang dicoba dulu: "Setelan Peak Suit" sebelum "Peak Suit".
  const rows = catalog
    .filter((row) => row.active && row.price !== null)
    .sort((a, b) => `${b.product} ${b.color}`.length - `${a.product} ${a.color}`.length)
  const norm = (text: string) => text.toLowerCase().replace(/\s+/g, ' ').trim()
  let sum = 0
  for (const line of lines) {
    const text = norm(line)
    const row = rows.find(
      (candidate) =>
        text.includes(norm(candidate.product)) &&
        (!candidate.color || text.includes(norm(candidate.color)))
    )
    if (!row) return { ok: false, reason: `baris tidak cocok katalog: ${line}` }
    const big = /\b(xxl|3xl|xxxl)\b/i.test(line) ? row.note.match(/XXL-3XL ([\d.]+)/)?.[1] : null
    const unit = big ? Number(big.replace(/\./g, '')) : Number(row.price)
    const qty = Math.max(1, Number(line.match(/(\d+)\s*(?:x|pcs|pc|buah)\b/i)?.[1] || 1))
    sum += unit * qty
  }
  // subtotal 0 = draft dari kode (spesifikasi), pakai jumlah katalog apa adanya.
  if (draft.subtotal > 0 && sum !== draft.subtotal)
    return { ok: false, reason: `subtotal AI ${draft.subtotal} ≠ katalog ${sum}` }
  if (sum <= 0) return { ok: false, reason: 'harga katalog kosong' }
  const key = (text: string) => text.toLowerCase().replace(/[^a-z]/g, '')
  let chosen = draft.layanan
    ? prices.find((row) => key(row.service) === key(draft.layanan) && row.price > 0)
    : null
  if (!chosen && !draft.layanan) {
    // Nama layanan (tanpa angka) sebagai kata utuh di teks petunjuk; terpanjang menang (CTCYES sebelum CTC).
    const hay = ` ${hints.join(' ')} `.toLowerCase()
    const candidates = prices
      .filter((row) => row.price > 0)
      .map((row) => ({ row, name: row.service.replace(/\d+$/, '').toLowerCase() }))
      .filter(({ name }) => name.length >= 3 && new RegExp(`[^a-z]${name}[^a-z]`).test(hay))
      .sort((a, b) => b.name.length - a.name.length)
    chosen = candidates[0]?.row || null
  }
  if (!chosen)
    return {
      ok: false,
      reason: draft.layanan
        ? `layanan ${draft.layanan} tidak ada di tarif`
        : 'layanan belum dipilih',
    }
  return {
    ok: true,
    items: lines.join('\n'),
    subtotal: sum,
    shippingService: chosen.service.replace(/\d+$/, ''),
    shippingCost: Math.round(chosen.price),
  }
}

export async function verifyAutoTotal(
  orderId: number,
  draft: { rincian: string; subtotal: number; layanan: string },
  catalog: Array<{
    product: string
    color: string
    price: number | null
    note: string
    active: boolean
  }>,
  hints: string[] = []
): Promise<{ ok: true; total: VerifiedAutoTotal } | { ok: false; reason: string }> {
  const order = await readLeanOrder(orderId)
  if (!order || order.status !== 'pending') return { ok: false, reason: 'order bukan pending' }
  const options = order.shipping_options ? JSON.parse(String(order.shipping_options)) : null
  if (!options?.prices?.length) return { ok: false, reason: 'tarif ongkir belum ada di order' }
  const result = matchAutoTotal(draft, catalog, options.prices, hints)
  if (!result.ok) return result
  return {
    ok: true,
    total: {
      orderId,
      items: result.items,
      subtotal: result.subtotal,
      shippingService: result.shippingService,
      shippingCost: result.shippingCost,
    },
  }
}

/** Setujui order lalu kirim pesan total + rekening — dipakai tombol CS dan total otomatis. */
export async function sendLeanTotal(input: VerifiedAutoTotal & { csNote?: string }) {
  const order = await approveLeanOrder({
    id: input.orderId,
    shippingService: input.shippingService,
    shippingCost: input.shippingCost,
    subtotal: input.subtotal,
    csNote: input.csNote,
  })
  await queueOutgoingMessage({
    jid: String(order.jid),
    body: renderTotalMessage({
      items: input.items,
      subtotal: input.subtotal,
      shippingService: input.shippingService,
      shippingCost: input.shippingCost,
    }),
  })
  const allMethods = await listPaymentMethods()
  const methods = allMethods.filter((method) => method.enabled)
  const payment = renderPaymentMessage(
    methods.map((method) => ({
      bank: method.name,
      number: method.destination,
      holder: method.accountName,
    }))
  )
  if (payment) await queueOutgoingMessage({ jid: String(order.jid), body: payment })
  return { orderNumber: String(order.order_number || `#${order.id}`), total: Number(order.total) }
}

/** Alasan total belum otomatis, ditampilkan ke CS di Beta 2 / panel pesanan. */
export async function noteAutoTotalReason(orderId: number, reason: string) {
  await ensureLeanTables()
  await db
    .from('whatsapp_lean_orders')
    .where('id', orderId)
    .where('status', 'pending')
    .update({ auto_total_reason: reason ? reason.slice(0, 190) : null, updated_at: new Date() })
}
