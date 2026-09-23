import { createHash } from 'node:crypto'
import { orderMessages } from '#services/order_message_evidence'
import type { CartItem } from '#services/cart_service'
import { customerAcceptedDiscount } from '#services/cart_discount_service'
import { readProductionPolicy } from '#services/production_service'
import {
  catalogDesignWords,
  catalogColor,
  catalogAssignments,
  catalogDesignAssignments,
  catalogRequestMatches,
  catalogNotesMatch,
  modelApprovalRemainder,
  bodyLabel,
} from '#services/catalog_design_evidence'
import {
  fulfillmentFingerprint,
  humanPreorderDecision,
  matchesPreorderEvidence,
  validPreorderConsentRequest,
  type FulfillmentGoods,
  type PreorderConsentEvidence,
  type PreorderConsentRequest,
} from '#services/fulfillment_contract'

export type BundlePriceRequest = { messageId: string; confirmationMessageId: string; total: number }
export type ModelConsentRequest = { requestMessageId: string; approvalMessageId: string }
export type BundlePriceEvidence = BundlePriceRequest & {
  fingerprint: string
  components: Array<{ productId: string; unitPrice: number; quantity: number }>
}
export type ModelConsentEvidence = ModelConsentRequest & { fingerprint: string }
export class HumanCartEvidenceError extends Error {}
const fail = (text: string): never => {
  throw new HumanCartEvidenceError(text)
}
const validId = (id: unknown) => typeof id === 'string' && /^[\w-]{1,190}$/.test(id)
export const validBundlePriceRequest = (value: any): value is BundlePriceRequest =>
  Boolean(
    value &&
    validId(value.messageId) &&
    validId(value.confirmationMessageId) &&
    Number.isSafeInteger(value.total) &&
    value.total > 0 &&
    value.total <= 1_000_000_000
  )
export const validModelConsentRequest = (value: any): value is ModelConsentRequest =>
  Boolean(value && validId(value.requestMessageId) && validId(value.approvalMessageId))
const canonical = (text: unknown) =>
  String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Price and shipping changes do not change an approved design. Measurements are separately approved. */
function modelHash(item: CartItem, legacy = false) {
  const d = item.productionDetails
  return hash([
    item.productId,
    ...(!legacy
      ? [
          [
            /\b(jas|suit|blazer|jacket)\b/i.test(item.name) ? 'jacket' : '',
            /\b(celana|pants|trousers)\b/i.test(item.name) ? 'pants' : '',
            /\b(rompi|vest|waistcoat)\b/i.test(item.name) ? 'vest' : '',
          ],
        ]
      : []),
    ...(legacy ? [canonical(item.name)] : []),
    item.referenceMessageId,
    item.image,
    item.modelType,
    ...(legacy ? [canonical(item.note)] : []),
    ...[d?.color, d?.material, d?.lapel, d?.buttons, d?.notes].map(canonical),
  ])
}
export const modelConsentFingerprint = (item: CartItem) => `v2:${modelHash(item)}`
function bundleHash(items: CartItem[], legacy = false) {
  return hash(
    items
      .map((i) => [
        i.productId,
        ...(legacy ? [i.name] : []),
        i.size,
        i.requestedSize || '',
        i.quantity,
        i.unitPrice,
        legacy ? modelHash(i, true) : modelConsentFingerprint(i),
      ])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  )
}
export const bundlePriceFingerprint = (items: CartItem[]) => `v2:${bundleHash(items)}`
/** Upgrade only from an intact, trusted stored snapshot, never from AI's proposed text. */
export function matchesBundleEvidence(
  evidence: BundlePriceEvidence,
  items: CartItem[],
  previous: CartItem[]
) {
  return (
    evidence.fingerprint === bundlePriceFingerprint(items) ||
    (evidence.fingerprint === bundleHash(previous, true) &&
      bundlePriceFingerprint(previous) === bundlePriceFingerprint(items))
  )
}
export function matchesModelEvidence(
  evidence: ModelConsentEvidence,
  item: CartItem,
  previous?: CartItem
) {
  if (
    item.modelType === 'catalog' &&
    item.productionDetails?.notes &&
    !catalogNotesMatch(
      item.productionDetails.notes,
      catalogDesignAssignments(item.productionDetails)
    )
  )
    return false
  return (
    evidence.fingerprint === modelConsentFingerprint(item) ||
    Boolean(
      previous &&
      evidence.fingerprint === modelHash(previous, true) &&
      modelConsentFingerprint(previous) === modelConsentFingerprint(item)
    ) ||
    Boolean(
      previous &&
      [modelConsentFingerprint(previous), modelHash(previous, true)].includes(
        evidence.fingerprint
      ) &&
      equivalentCatalogDesign(previous, item)
    )
  )
}
export const humanCsMessage = (row: any) =>
  row?.direction === 'out' &&
  ['cs', 'owner'].includes(row.sender_type) &&
  ['sent', 'delivered', 'read'].includes(row.status)
const human = humanCsMessage
export const earlierMessage = (a: any, b: any) =>
  new Date(a.created_at).getTime() < new Date(b.created_at).getTime() ||
  (new Date(a.created_at).getTime() === new Date(b.created_at).getTime() &&
    Number(a.id) < Number(b.id))
const before = earlierMessage
const imageTypes = ['image', 'video', 'gif', 'sticker']
const uncertain =
  /\?|\b(tidak|tak|gak|nggak|ga|belum|bukan|batal|jangan|kalau|jika|asal|nanti|mungkin|not|cannot|if|ongkir|shipping|diskon|discount|dp|transfer|bayar)\b/i

/** Unambiguous, goods-only package quote. No arithmetic on unknown component prices. */
export function humanBundleQuote(body: string, total: number, items: CartItem[]) {
  if (
    uncertain.test(body) ||
    items.length < 2 ||
    items.length > 3 ||
    items.some((i) => i.quantity !== 1)
  )
    return false
  const kinds = [
    ['jas', /\b(jas|suit|blazer|jacket)\b/i],
    ['celana', /\b(celana|pants|trousers)\b/i],
    ['rompi', /\b(rompi|vest|waistcoat)\b/i],
  ] as const
  const itemKinds = items.map((i) =>
    kinds.filter(([, pattern]) => pattern.test(i.name)).map(([kind]) => kind)
  )
  if (itemKinds.some((k) => k.length !== 1) || new Set(itemKinds.flat()).size !== items.length)
    return false
  const quoteKinds = kinds.filter(([, pattern]) => pattern.test(body)).map(([kind]) => kind)
  if (quoteKinds.length !== items.length || itemKinds.some(([kind]) => !quoteKinds.includes(kind)))
    return false
  const money = [
    ...body.matchAll(
      /(?<![\w.,+\-])(?:rp\.?\s*)?(\d+(?:[.,]\d+)*)\s*(ribu|rb|k|juta|jt)?(?![\w.,])/gi
    ),
  ]
  if (money.length !== 1) return false
  const [, number, unit] = money[0]
  if (!unit && !/^\d+(?:[.,]\d{3})*$/.test(number)) return false
  const amount = unit
    ? Number(number.replace(',', '.')) * (/^(juta|jt)$/i.test(unit) ? 1_000_000 : 1000)
    : Number(number.replace(/[.,]/g, ''))
  return amount === total
}

async function boundaryFor(trx: any, jid: string) {
  return trx
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      "(action = 'cancelled' OR (action = 'payment_confirmed' AND JSON_EXTRACT(summary_json, '$.cartCleared') = true))"
    )
    .orderBy('id', 'desc')
    .first()
}
function afterBoundary(row: any, boundary: any) {
  return !boundary || new Date(row.created_at).getTime() > new Date(boundary.created_at).getTime()
}
async function message(trx: any, jid: string, id: string) {
  return orderMessages(trx).where({ jid, message_id: id }).first()
}
async function priorEvidence(
  trx: any,
  jid: string,
  kind: 'bundlePriceEvidence' | 'modelConsentEvidence',
  id: string
) {
  const key = kind === 'bundlePriceEvidence' ? 'messageId' : 'approvalMessageId'
  const event = await trx
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      `JSON_CONTAINS(JSON_EXTRACT(summary_json, '$.items[*].${kind}.${key}'), JSON_QUOTE(?)) = 1`,
      [id]
    )
    .orderBy('id', 'desc')
    .first()
  return event
    ? JSON.parse(event.summary_json).items?.find((item: any) => item[kind]?.[key] === id)?.[kind]
    : undefined
}
async function orderedBetween(trx: any, jid: string, first: any, last: any) {
  const rows = await orderMessages(trx)
    .where('jid', jid)
    .where('created_at', '>=', first.created_at)
    .where('created_at', '<=', last.created_at)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at')
    .orderBy('id')
    .limit(200)
  if (rows.length === 200)
    fail('Konteks persetujuan terlalu panjang; perlu referensi CS yang lebih jelas.')
  return rows.filter((r: any) => before(first, r) && before(r, last))
}

const designWords = (value: unknown) =>
  canonical(value)
    .replace(/\bblack\b/g, 'hitam')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

/** Rewording cannot revoke intact stored consent or introduce another design detail. */
function equivalentCatalogDesign(previous: CartItem, item: CartItem) {
  const normalized = (value: CartItem) => {
    const d = value.productionDetails
    if (value.modelType !== 'catalog' || value.catalogVerification !== 'verified' || !d) return null
    const color = catalogColor(d.color, bodyLabel)
    const lapel = catalogColor(d.lapel, 'lapel')
    const assignments = catalogDesignAssignments(d)
    if (!assignments.length || !catalogNotesMatch(d.notes, assignments)) return null
    return modelHash({ ...value, productionDetails: { ...d, color, lapel, notes: '' } })
  }
  const previousDesign = normalized(previous)
  return previousDesign !== null && previousDesign === normalized(item)
}

/** A catalog color/lapel change can be requested in text; it is not a new photo model. */
async function verifyCatalogDesignRequest(
  trx: any,
  jid: string,
  item: CartItem,
  question: any,
  boundary: any
) {
  const body = String(question.body || '')
  const details = item.productionDetails
  if (
    item.catalogVerification !== 'verified' ||
    !/\b(warna|badan|lapel)\b/.test(catalogDesignWords(body)) ||
    /\b(ongkir|resi|transfer|diskon|bayar|ukuran|size|atau|bukan|jangan)\b/i.test(body) ||
    !(details?.color || details?.lapel)
  )
    fail('Permintaan perubahan warna katalog belum jelas.')
  const requestWords = catalogDesignWords(body)
  for (const [value, label, field] of [
    [details?.color, bodyLabel, 'Warna badan'],
    [details?.lapel, 'lapel', 'Warna lapel'],
    [details?.material, '(?:bahan|material)', 'Bahan'],
    [details?.buttons, 'kancing', 'Kancing'],
  ]) {
    if (!value && new RegExp(`\\b${label}\\b`).test(requestWords))
      fail(`${field} yang disebut dalam permintaan belum tersimpan pada detail katalog.`)
  }
  // Only explicitly requested design details are approved. No guessed material/buttons/notes.
  const assignments = catalogAssignments(details)
  if (!catalogRequestMatches(body, assignments))
    fail('Penempatan warna badan/lapel tidak cocok dengan permintaan yang disetujui CS.')
  const designAssignments = catalogDesignAssignments(details)
  if (details?.notes && !catalogNotesMatch(details.notes, designAssignments))
    fail(
      'Catatan desain katalog memuat detail yang belum cocok dengan permintaan yang disetujui CS.'
    )
  for (const [value, field, label] of [
    [details?.material, 'Bahan', '(?:bahan|material)'],
    [details?.buttons, 'Kancing', 'kancing'],
  ]) {
    if (
      value &&
      !catalogRequestMatches(body, [{ label: label!, color: catalogColor(value, label!) }])
    )
      fail(`${field} katalog tidak cocok dengan permintaan yang disetujui CS.`)
  }
  const namesProduct = (row: any) =>
    ` ${designWords(row.body)} `.includes(` ${designWords(item.name)} `)
  if (namesProduct(question)) return
  // Follow explicit quotes (including a quoted customer question), never infer an ID.
  let quoted = question
  for (let depth = 0; depth < 3 && quoted.reply_to_message_id; depth++) {
    const parent = await message(trx, jid, quoted.reply_to_message_id)
    if (
      !parent ||
      !before(parent, quoted) ||
      !afterBoundary(parent, boundary) ||
      ['failed', 'queued'].includes(parent.status)
    )
      break
    if (namesProduct(parent)) return
    quoted = parent
  }
  const rows = await orderMessages(trx)
    .where('jid', jid)
    .where('created_at', '<=', question.created_at)
    .whereNotIn('status', ['failed', 'queued'])
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(9)
  for (const row of rows.filter((r: any) => before(r, question)).slice(0, 8)) {
    if (!afterBoundary(row, boundary)) break
    if (namesProduct(row)) return
    // A different visual/product topic makes an unquoted reference ambiguous.
    if (
      imageTypes.includes(row.media_type) ||
      /\b(suit|pants|blazer|tuxedo|celana|rompi)\b/i.test(row.body)
    )
      break
  }
  fail('Permintaan warna perlu terkait dengan produk katalog yang sama.')
}

/** Executed under the cart transaction; input never supplies authority or an approval flag. */
export async function applyHumanCartEvidence(
  trx: any,
  jid: string,
  items: CartItem[],
  previous: CartItem[],
  input: any
) {
  const bundle = input.bundlePrice as BundlePriceRequest | null | undefined
  const hasConsent = input.items.some((i: any) => i.modelConsent || i.preorderConsent)
  if (!bundle && !hasConsent) return
  const boundary = await boundaryFor(trx, jid)
  if (bundle) {
    if (!validBundlePriceRequest(bundle)) fail('Referensi harga paket CS tidak valid.')
    const quote = await message(trx, jid, bundle.messageId)
    const accepted = await message(trx, jid, bundle.confirmationMessageId)
    const target = items.filter((i) => i.modelType === 'custom')
    if (
      !human(quote) ||
      !accepted ||
      accepted.direction !== 'in' ||
      ['failed', 'queued'].includes(accepted.status) ||
      !before(quote, accepted) ||
      !afterBoundary(quote, boundary) ||
      !customerAcceptedDiscount(String(accepted.body)) ||
      !humanBundleQuote(String(quote.body), bundle.total, items) ||
      target.length !== 1
    )
      fail('Harga paket belum cocok dengan kutipan CS, pilihan barang, dan persetujuan pelanggan.')
    const others = items.filter((i) => i !== target[0])
    if (
      others.some(
        (i) =>
          i.modelType === 'custom' ||
          i.size === 'custom' ||
          !Number.isSafeInteger(i.unitPrice) ||
          Number(i.unitPrice) <= 0
      )
    )
      fail('Komponen harga paket belum terverifikasi; jangan membagi harga dengan perkiraan.')
    const reference = await message(trx, jid, target[0].referenceMessageId)
    if (
      !reference ||
      reference.direction !== 'in' ||
      !imageTypes.includes(reference.media_type) ||
      !before(reference, quote)
    )
      fail('Harga paket tidak terkait dengan foto model pesanan ini.')
    const conversation = await orderedBetween(trx, jid, reference, quote)
    if (conversation.some((r: any) => r.direction === 'in' && imageTypes.includes(r.media_type)))
      fail('Ada foto lain sebelum harga paket CS; referensi harga perlu diperjelas.')
    const intervening = await orderedBetween(trx, jid, quote, accepted)
    if (intervening.some((r: any) => human(r)))
      fail('Persetujuan pelanggan tidak langsung terkait kutipan harga paket.')
    const price =
      bundle.total - others.reduce((sum, i) => sum + Number(i.unitPrice) * i.quantity, 0)
    if (!Number.isSafeInteger(price) || price <= 0)
      fail('Harga paket tidak cocok dengan komponen terverifikasi.')
    target[0].unitPrice = price
    target[0].priceMessageId = bundle.messageId
    const fingerprint = bundlePriceFingerprint(items)
    const oldEvidence =
      previous.find((i) => i.bundlePriceEvidence?.messageId === bundle.messageId)
        ?.bundlePriceEvidence ||
      (await priorEvidence(trx, jid, 'bundlePriceEvidence', bundle.messageId))
    if (oldEvidence && !matchesBundleEvidence(oldEvidence, items, previous))
      fail(
        'Harga paket lama tidak boleh diterapkan ke rincian barang yang berubah tanpa kutipan baru.'
      )
    target[0].bundlePriceEvidence = {
      ...bundle,
      fingerprint,
      components: items.map((i) => ({
        productId: i.productId,
        unitPrice: Number(i.unitPrice),
        quantity: i.quantity,
      })),
    }
  }
  for (const [index, item] of items.entries()) {
    const preorder = input.items[index].preorderConsent as PreorderConsentRequest | null | undefined
    if (preorder) {
      const evidence = await verifiedPreorderDecision(trx, jid, item, preorder, boundary)
      item.fulfillment = 'preorder'
      item.preorderConsentEvidence = evidence
      item.fulfillmentDecidedBy = `cs-message:${preorder.approvalMessageId}`
      item.fulfillmentNote = `Keputusan pre-order dari chat CS (${preorder.approvalMessageId}).`
    }
    const request = input.items[index].modelConsent as ModelConsentRequest | null | undefined
    if (!request) continue
    if (!validModelConsentRequest(request)) fail('Referensi persetujuan model tidak valid.')
    const question = await message(trx, jid, request.requestMessageId)
    const approval = await message(trx, jid, request.approvalMessageId)
    const reference = await message(trx, jid, item.referenceMessageId)
    if (
      !question ||
      question.direction !== 'in' ||
      ['failed', 'queued'].includes(question.status) ||
      !human(approval) ||
      (item.modelType === 'custom' &&
        (!reference ||
          reference.direction !== 'in' ||
          !imageTypes.includes(reference.media_type) ||
          !afterBoundary(reference, boundary))) ||
      !before(question, approval) ||
      !afterBoundary(question, boundary) ||
      !afterBoundary(approval, boundary)
    )
      fail('Persetujuan model harus berasal dari CS di percakapan pesanan ini.')
    // A short affirmative is valid only as the immediate human answer to the linked model request.
    const approvalDetails = modelApprovalRemainder(String(approval.body))
    if (approvalDetails === null || (item.modelType !== 'catalog' && approvalDetails))
      fail('Pesan CS belum menyatakan persetujuan model secara jelas.')
    if (approval.reply_to_message_id && approval.reply_to_message_id !== question.message_id)
      fail('Balasan CS mengacu ke pertanyaan lain.')
    const between = await orderedBetween(trx, jid, question, approval)
    if (between.some((r: any) => human(r) || r.direction === 'in'))
      fail('Jawaban CS tidak langsung terkait permintaan model.')
    if (
      !approval.reply_to_message_id &&
      !approvalDetails &&
      between.some((r: any) => r.sender_type === 'ai' && /\?/.test(String(r.body || '')))
    )
      fail(
        'Jawaban singkat CS perlu merujuk permintaan desain, bukan pertanyaan lain di antaranya.'
      )
    if (item.modelType === 'catalog') {
      await verifyCatalogDesignRequest(trx, jid, item, question, boundary)
      if (
        approvalDetails &&
        !catalogNotesMatch(approvalDetails, catalogDesignAssignments(item.productionDetails))
      )
        fail(
          'Rincian jawaban CS berbeda atau bersyarat; jangan menganggap seluruh desain disetujui.'
        )
    } else if (question.message_id !== reference.message_id) {
      if (
        !before(reference, question) ||
        !/\b(model|warna|jas|suit|desain)\b/i.test(question.body) ||
        /\b(ongkir|resi|transfer|diskon|bayar|ukuran|size)\b/i.test(question.body)
      )
        fail('Permintaan persetujuan bukan tentang model ini.')
      if (question.reply_to_message_id !== reference.message_id) {
        const sincePhoto = await orderedBetween(trx, jid, reference, question)
        if (
          sincePhoto.length > 8 ||
          sincePhoto.some((r: any) => human(r) || imageTypes.includes(r.media_type))
        )
          fail('Permintaan model perlu terkait langsung dengan foto referensi.')
      }
      const color = canonical(item.productionDetails?.color)
      if (
        color &&
        !canonical(question.body)
          .split(/[^\p{L}\p{N}]+/u)
          .join(' ')
          .includes(color)
      )
        fail('Warna pesanan tidak cocok dengan permintaan yang disetujui CS.')
    }
    const fingerprint = modelConsentFingerprint(item)
    const oldEvidence =
      previous.find((i) => i.modelConsentEvidence?.approvalMessageId === request.approvalMessageId)
        ?.modelConsentEvidence ||
      (await priorEvidence(trx, jid, 'modelConsentEvidence', request.approvalMessageId))
    if (
      oldEvidence &&
      !matchesModelEvidence(
        oldEvidence,
        item,
        previous.find((i) => i.productId === item.productId)
      )
    )
      fail('Model berubah setelah persetujuan CS; persetujuan lama tidak berlaku.')
    const rejection = await trx
      .from('whatsapp_cart_events')
      .where({ jid, action: 'model_rejected' })
      .where('created_at', '>=', approval.created_at)
      .orderBy('id', 'desc')
      .first()
    if (rejection)
      fail('Persetujuan lama telah diikuti penolakan model; perlu keputusan manusia yang baru.')
    item.modelApproval = 'approved'
    item.modelApprovedBy = `cs-message:${approval.message_id}`
    item.modelApprovalNote = `Persetujuan dari chat CS (${approval.message_id}).`
    item.modelConsentEvidence = { ...request, fingerprint }
  }
}

/** Pre-order is a local owner/CS decision about these goods; stock and MCP labels never grant it. */
export async function verifiedPreorderDecision(
  client: any,
  jid: string,
  item: FulfillmentGoods,
  request: PreorderConsentRequest,
  knownBoundary?: any
): Promise<PreorderConsentEvidence> {
  if (!validPreorderConsentRequest(request)) fail('Referensi keputusan pre-order tidak valid.')
  const policy = await readProductionPolicy()
  if (!policy.rules.preorder.enabled)
    fail('Pengaturan pre-order lokal belum aktif; item tetap ready.')
  const boundary = knownBoundary === undefined ? await boundaryFor(client, jid) : knownBoundary
  const question = await message(client, jid, request.requestMessageId)
  const approval = await message(client, jid, request.approvalMessageId)
  if (
    !question ||
    question.direction !== 'in' ||
    ['failed', 'queued'].includes(question.status) ||
    !human(approval) ||
    !before(question, approval) ||
    !afterBoundary(question, boundary) ||
    !afterBoundary(approval, boundary)
  )
    fail('Keputusan pre-order harus berasal dari CS di percakapan pesanan ini.')
  if (!humanPreorderDecision(String(approval.body)))
    fail('Pesan CS belum menyatakan pre-order untuk barang ini secara jelas.')
  if (approval.reply_to_message_id && approval.reply_to_message_id !== question.message_id)
    fail('Balasan CS mengacu ke pertanyaan lain.')
  const between = await orderedBetween(client, jid, question, approval)
  if (between.some((r: any) => human(r) || r.direction === 'in'))
    fail('Jawaban CS tidak langsung terkait permintaan pre-order.')
  const evidence = { ...request, fingerprint: fulfillmentFingerprint(item) }
  const stale = await client
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      `JSON_CONTAINS(JSON_EXTRACT(summary_json, '$.items[*].preorderConsentEvidence.approvalMessageId'), JSON_QUOTE(?)) = 1`,
      [request.approvalMessageId]
    )
    .orderBy('id', 'desc')
    .first()
  const old = stale
    ? JSON.parse(stale.summary_json).items?.find(
        (row: any) => row.preorderConsentEvidence?.approvalMessageId === request.approvalMessageId
      )?.preorderConsentEvidence
    : undefined
  if (old && !matchesPreorderEvidence(old, item))
    fail('Barang, ukuran, atau jumlah berubah setelah keputusan pre-order; perlu keputusan baru.')
  return evidence
}
