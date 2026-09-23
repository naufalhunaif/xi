import db from '#services/workspace_database'
import { orderMessages } from '#services/order_message_evidence'
import {
  readCart,
  saveCart,
  cancelCart,
  reportPayment,
  applyCartDiscount,
  checkoutFromBalance,
  tryConfirmedBalanceCheckout,
  type Cart,
} from '#services/cart_service'
import { cartSize, type CartIntent } from '#services/cart_contract'
import type { AiDecision } from '#services/ai_service'
import {
  HumanCartEvidenceError,
  modelConsentFingerprint,
  verifiedPreorderDecision,
} from '#services/human_cart_evidence'
import { fulfillmentFingerprint } from '#services/fulfillment_contract'
import { pendingApprovalKind } from '#services/approval_wait_service'
import type { CheckoutConsentError } from '#services/checkout_consent_service'
import { matchShippingQuote, requiresShippingQuote } from '#services/shipping_evidence_service'
import { scopedCustomSizeQuestion } from '#services/custom_size_question'
import {
  incompleteCartSelection,
  CartSelectionIncompleteError,
} from '#services/cart_selection_recovery'
export { shippingEvidence } from '#services/shipping_evidence_service'

export type CartEvidence = {
  products: Array<Record<string, any>>
  shipping: Array<Record<string, any>>
}

/** Expected business validation failure, not a connection/stale-context/programming error. */
export class CartVerificationError extends Error {}
export class CartReferenceError extends CartVerificationError {
  readonly code = 'CART_REFERENCE_UNAVAILABLE'
  constructor(public referenceIssue: 'missing_id' | 'not_in_room' | 'not_visual' | 'not_loaded') {
    super(
      {
        missing_id: 'ID pesan foto referensi model khusus belum diisi oleh AI.',
        not_in_room:
          'Pesan foto referensi model khusus tidak ditemukan sebagai pesan pelanggan di room ini.',
        not_visual: 'ID referensi model khusus menunjuk pesan tanpa foto atau media visual.',
        not_loaded: 'Gambar referensi model masih dimuat.',
      }[referenceIssue]
    )
  }
}
export class CatalogLookupError extends CartVerificationError {
  constructor(public issue: CatalogIssue) {
    super('Produk dan gambar cart belum terverifikasi dari MCP.')
  }
}
export type CatalogIssue = {
  code:
    | 'CATALOG_PRODUCT_UNVERIFIED'
    | 'CATALOG_SIZE_MISSING'
    | 'CATALOG_PRICE_MISMATCH'
    | 'CATALOG_STOCK_UNVERIFIED'
  productId: string
  size: string
}

/** Only a focused, non-transactional choice question may survive incomplete catalog evidence.
 * Wording comes from the loaded skills/model; this gate never manufactures product claims.
 */
export function safeCatalogQuestion(message: string) {
  return (
    message.length <= 300 &&
    /^[^?\n.!]+\?$/.test(message.trim()) &&
    /\b(atau|or)\b/i.test(message) &&
    /\b(mau|pilih|ingin|prefer|want|would)\b/i.test(message) &&
    !/\d|https?:|\brp\b|harga|price|total|ongkir|cost|transfer|bayar|payment|ready|stok|stock|tersedia|available|bisa|approved|setuju|estimasi|hari|minggu|besok|kirim|deliver|ship|gratis|free|jamin|guarantee|diskon|discount|custom|produksi|production/i.test(
      message
    )
  )
}

export function holdCatalogDraft(
  decision: AiDecision,
  issues: CatalogIssue[],
  understandingOnly = false
): AiDecision {
  const question =
    !understandingOnly && decision.decision === 'reply' && safeCatalogQuestion(decision.message)
      ? decision.message.trim()
      : ''
  return {
    ...decision,
    decision: question ? 'reply' : 'silent',
    message: question,
    initiative: '',
    images: [],
    cartIntent: null,
    handoff_category: 'none',
    approvalWait: null,
    reason: 'Data katalog masih perlu diperiksa AI; bukan permintaan persetujuan CS.',
    note: [
      decision.note,
      decision.cartIntent?.items
        .map(
          (item) =>
            `${item.name} · ${item.size} · ${item.quantity} pcs (pilihan, belum terverifikasi)`
        )
        .join('; '),
      `Verifikasi katalog tertunda: ${issues.map((issue) => `${issue.productId}/${issue.size}: ${issue.code}`).join('; ')}`,
    ]
      .filter(Boolean)
      .join('\n'),
    goal: {
      objective: decision.goal?.objective || 'Melengkapi pesanan pelanggan',
      status: question ? 'waiting_answer' : 'waiting',
      waiting_for: question
        ? 'Jawaban pelanggan atas pilihan berikutnya'
        : 'Verifikasi data katalog oleh AI',
      next_action:
        'Pertahankan pilihan dan ukuran yang sudah disetujui. Periksa ukuran/harga/stok melalui MCP sebelum transaksi; kebijakan pre-order hanya dari pengaturan lokal. Jangan meminta approval CS hanya karena bukti MCP belum lengkap.',
      follow_up: null,
    },
  }
}

/** A business evidence mismatch is neither a provider outage nor permission to spend. */
export function holdCheckoutForReview(
  decision: AiDecision,
  error: CheckoutConsentError
): AiDecision {
  return {
    ...decision,
    decision: 'silent',
    message: '',
    initiative: '',
    images: [],
    cartIntent: null,
    handoff_category: 'none',
    approvalWait: null,
    reason: error.message,
    note: [decision.note, `${error.code}: ${error.message}`].filter(Boolean).join('\n'),
    goal: {
      objective: decision.goal?.objective || 'Menyelesaikan pesanan pelanggan',
      status: 'waiting_answer',
      waiting_for: error.message,
      next_action:
        'Periksa detail checkout dan sumber pesan yang ditandai; jangan meminta transfer atau approval ulang yang sudah sah.',
      follow_up: null,
    },
  }
}

/** Keep a skill-written, focused measurement question; never publish an unverified quote. */
export function resolveCartIssues(
  decision: AiDecision,
  cart: Cart & {
    issues?: string[]
    onlyPendingCustomPrices?: boolean
    catalogIssues?: CatalogIssue[]
  },
  understandingOnly = false
): AiDecision {
  if (cart.catalogIssues?.length && cart.issues?.length === cart.catalogIssues.length)
    return holdCatalogDraft(decision, cart.catalogIssues, understandingOnly)
  const customQuestion =
    !understandingOnly &&
    cart.onlyPendingCustomPrices &&
    decision.decision === 'reply' &&
    decision.goal?.status === 'waiting_answer'
      ? scopedCustomSizeQuestion(
          decision.customSizeQuestion,
          [decision.message, decision.initiative || ''],
          cart.items
        )
      : null
  if (customQuestion)
    return {
      ...decision,
      message: customQuestion,
      initiative: '',
      images: [],
      businessMedia: [],
      cartIntent: null,
      handoff_category: 'none',
      approvalWait: null,
      note: [decision.note, ...(cart.issues || [])].filter(Boolean).join('\n'),
      goal: { ...decision.goal!, follow_up: null },
    }
  const message = decision.message.trim()
  const needsWaist = cart.items.some(
    (item) =>
      item.size === 'custom' &&
      /pants|celana|trousers/i.test(item.name) &&
      !Object.keys(item.measurements).some((name) => /lingkar\s*pinggang|waist|^lp$/i.test(name)) &&
      !item.productionDetails?.measurements.some(
        (m) => m.basis === 'body' && /lingkar\s*pinggang|waist|^lp$/i.test(m.name)
      )
  )
  const focusedQuestion =
    message.length <= 400 &&
    /^[^?]+\?$/.test(message) &&
    /lingkar\s*pinggang|waist/i.test(message) &&
    /\bcm\b|sentimeter|centimet/i.test(message) &&
    !/\d|https?:|\brp\b|harga|price|total|ongkir|cost|transfer|bayar/i.test(message)
  if (
    !understandingOnly &&
    !decision.customSizeQuestion &&
    cart.onlyPendingCustomPrices &&
    needsWaist &&
    focusedQuestion &&
    decision.decision === 'reply' &&
    decision.goal?.status === 'waiting_answer'
  ) {
    return {
      ...decision,
      initiative: '',
      images: [],
      cartIntent: null,
      handoff_category: 'none',
      note: [decision.note, ...(cart.issues || [])].filter(Boolean).join('\n'),
      goal: { ...decision.goal, follow_up: null },
    }
  }
  return {
    ...holdUnverifiedCartReply(decision, cart.issues?.join(' '), understandingOnly),
    approvalWait: understandingOnly ? null : pendingApprovalKind(cart.items),
  }
}

/** Route unresolved cart approval to humans without publishing unverified details. */
export function holdUnverifiedCartReply(
  decision: AiDecision,
  reason = 'Draft cart tersimpan; usulan harga masih perlu diverifikasi.',
  understandingOnly = false
): AiDecision {
  const pendingItems = decision.cartIntent?.items
    .map(
      (item) =>
        `${item.name} · ukuran ${item.size}${item.requestedSize ? ` ${item.requestedSize}` : ''} · ${item.quantity} pcs`
    )
    .join('; ')
  return {
    ...decision,
    decision: understandingOnly ? 'silent' : 'handoff',
    message: '',
    initiative: '',
    images: [],
    cartIntent: null,
    handoff_category: understandingOnly ? 'none' : 'human_authorization',
    reason,
    note: [
      decision.note,
      `Pemeriksaan cart: ${reason}`,
      pendingItems ? `Rincian pilihan pelanggan: ${pendingItems}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    goal: {
      objective: decision.goal?.objective || 'Melengkapi pesanan pelanggan',
      status: 'waiting_approval',
      waiting_for: 'Verifikasi ukuran, harga, atau ketersediaan oleh CS',
      next_action: 'Periksa pilihan pelanggan dan data MCP; setujui detail custom bila diperlukan',
      follow_up: null,
    },
  }
}
export async function applyAiCartIntent(
  jid: string,
  version: string,
  intent: CartIntent,
  evidence: CartEvidence
): Promise<
  Awaited<ReturnType<typeof readCart>> & {
    issues?: string[]
    onlyPendingCustomPrices?: boolean
    catalogIssues?: CatalogIssue[]
    settledOrder?: Awaited<ReturnType<typeof checkoutFromBalance>>
  }
> {
  if (incompleteCartSelection(intent).length) throw new CartSelectionIncompleteError()
  if (intent.action === 'checkout_balance') {
    const settledOrder = await checkoutFromBalance(
      jid,
      version,
      intent.confirmationMessageId,
      intent.recapMessageId || ''
    )
    return { ...(await readCart(jid)), settledOrder }
  }
  const issues: string[] = []
  const catalogIssues: CatalogIssue[] = []
  const catalogPending = new Set<CartIntent['items'][number]>()
  const preorder = new Set<CartIntent['items'][number]>()
  let customPriceIssues = 0
  const pendingCustomPrice = (item: CartIntent['items'][number]) => {
    customPriceIssues++
    issues.push(
      `${item.name} · custom${item.requestedSize ? ` ${item.requestedSize}` : ''} tersimpan sebagai draft; harga custom perlu verifikasi CS.`
    )
  }
  const cart = await readCart(jid)
  if (cart.version !== version) throw new Error('Cart berubah selama AI memproses.')
  const confirmation = await orderMessages()
    .where('jid', jid)
    .where('direction', 'in')
    .where('message_id', intent.confirmationMessageId)
    .first()
  if (!confirmation) throw new Error('Konfirmasi pelanggan untuk cart tidak ditemukan.')
  const lastCancel = await db
    .from('whatsapp_cart_events')
    .where('jid', jid)
    .whereRaw(
      "(action = 'cancelled' OR (action = 'payment_confirmed' AND JSON_EXTRACT(summary_json, '$.cartCleared') = true))"
    )
    .orderBy('id', 'desc')
    .first()
  if (
    lastCancel &&
    new Date(confirmation.created_at).getTime() <= new Date(lastCancel.created_at).getTime()
  )
    throw new Error('Pesanan telah dibatalkan atau dibayar; perlu pilihan pelanggan yang baru.')
  if (intent.action === 'report_payment')
    return reportPayment(jid, version, confirmation.message_id, 'ai', intent.discount)
  if (intent.action === 'apply_discount') {
    if (!intent.discount) throw new Error('Referensi persetujuan diskon belum tersedia.')
    return applyCartDiscount(jid, version, intent.discount, 'ai')
  }
  if (intent.action === 'cancel') return cancelCart(jid, version, 'ai')
  if (intent.action === 'remove') {
    if (
      !intent.removeItemIds.length ||
      intent.removeItemIds.some((id) => !cart.items.some((item) => item.id === id))
    )
      throw new Error('Item yang dibatalkan tidak valid.')
    return saveCart(
      jid,
      version,
      {
        ...cart,
        items: cart.items.filter((item) => !intent.removeItemIds.includes(item.id)),
        shipping: { service: cart.shipping.service, cost: null },
      },
      'ai'
    )
  }
  if (intent.action !== 'sync') throw new Error('Tindakan cart AI tidak valid.')
  // Revalidate retained package evidence, never silently keep its allocation after goods change.
  const previousBundle = cart.items.find((i) => i.bundlePriceEvidence)?.bundlePriceEvidence
  if (!intent.bundlePrice && previousBundle)
    intent.bundlePrice = {
      messageId: previousBundle.messageId,
      confirmationMessageId: previousBundle.confirmationMessageId,
      total: previousBundle.total,
    }
  // Sync can update/add, but removals must be an explicit, separately validated action.
  if (cart.items.some((old) => !intent.items.some((item) => item.id === old.id)))
    throw new Error('Gunakan tindakan hapus untuk membatalkan item.')
  /** A pre-order decision is local and human: a stored one for the same goods, or fresh CS evidence.
   * An unauthorized flip keeps the draft as ready and asks a human, instead of dropping the cart. */
  const resolvePreorder = async (
    item: CartIntent['items'][number],
    previous?: Cart['items'][number]
  ) => {
    const stored =
      previous?.fulfillment === 'preorder' &&
      fulfillmentFingerprint(previous) === fulfillmentFingerprint(item)
    if (item.fulfillment !== 'preorder') {
      if (item.preorderConsent) item.preorderConsent = null
      return stored
    }
    if (stored && !item.preorderConsent) return true
    if (!item.preorderConsent) {
      item.fulfillment = 'ready'
      issues.push(
        `${item.name} · ${item.size}: PREORDER_NOT_AUTHORIZED — stok kurang atau kosong bukan dasar pre-order; perlu keputusan CS/pemilik.`
      )
      return false
    }
    try {
      await verifiedPreorderDecision(db, jid, item, item.preorderConsent)
      return true
    } catch (error) {
      if (!(error instanceof HumanCartEvidenceError)) throw error
      item.fulfillment = 'ready'
      item.preorderConsent = null
      issues.push(
        `${item.name} · ${item.size}: PREORDER_NOT_AUTHORIZED — ${(error as Error).message}`
      )
      return false
    }
  }
  // Lines represent individual wearers/specifications; stock belongs to the shared SKU/size.
  // Resolve authorized fulfillment first so a proposed PO cannot hide ready-stock demand.
  for (const item of intent.items) {
    Object.assign(item, cartSize(item.size, item.requestedSize))
    const previous = cart.items.find((old) => old.id === item.id)
    if (await resolvePreorder(item, previous)) preorder.add(item)
  }
  const stockKey = (item: { productId: string; size: string }) =>
    JSON.stringify([item.productId, item.size.trim().toLowerCase()])
  const readyDemand = new Map<string, number>()
  const previousReadyDemand = new Map<string, number>()
  for (const item of intent.items) {
    if (item.modelType === 'custom' || item.size === 'custom' || preorder.has(item)) continue
    const key = stockKey(item)
    readyDemand.set(key, (readyDemand.get(key) || 0) + item.quantity)
  }
  for (const item of cart.items) {
    if (item.modelType === 'custom' || item.size === 'custom' || item.fulfillment === 'preorder')
      continue
    const key = stockKey(item)
    previousReadyDemand.set(key, (previousReadyDemand.get(key) || 0) + item.quantity)
  }
  for (const item of intent.items) {
    if (item.productionDetails) {
      const ids = item.productionDetails.sourceMessageIds
      if (!ids.length) throw new Error('Detail pengerjaan membutuhkan pesan sumber.')
      const sources = await orderMessages()
        .where('jid', jid)
        .whereIn('message_id', ids)
        .where((q) =>
          q
            .where('direction', 'in')
            .orWhere((out) =>
              out
                .where('direction', 'out')
                .whereIn('sender_type', ['cs', 'owner'])
                .whereIn('status', ['sent', 'delivered', 'read'])
            )
        )
        .select('message_id')
      if (new Set(sources.map((row) => row.message_id)).size !== ids.length)
        throw new Error('Pesan sumber detail pengerjaan tidak ditemukan di room ini.')
    }
    const previous = cart.items.find((old) => old.id === item.id)
    if (item.modelType === 'custom') {
      if (!item.referenceMessageId) throw new CartReferenceError('missing_id')
      const reference = await orderMessages()
        .where('jid', jid)
        .where('direction', 'in')
        .where('message_id', String(item.referenceMessageId || ''))
        .first()
      if (!reference) throw new CartReferenceError('not_in_room')
      if (!['image', 'video', 'gif', 'sticker'].includes(reference.media_type))
        throw new CartReferenceError('not_visual')
      const referenceImage =
        reference.media_type === 'image' || reference.media_type === 'sticker'
          ? reference.media_url || reference.thumbnail_url
          : reference.thumbnail_url
      if (!referenceImage) throw new CartReferenceError('not_loaded')
      item.image = referenceImage
      item.productId = `custom:${reference.message_id}`
      // AI copies a human quote from this room, never guesses a noncatalog price.
      const sameModel =
        previous?.modelType === 'custom' &&
        previous.referenceMessageId === item.referenceMessageId &&
        previous.size === item.size &&
        (previous.requestedSize || '') === (item.requestedSize || '') &&
        previous.image === item.image &&
        modelConsentFingerprint(previous) ===
          modelConsentFingerprint({
            ...previous,
            ...item,
            productionDetails: item.productionDetails ?? previous.productionDetails,
          } as any)
      const proposedPrice = item.unitPrice
      const priceId = item.priceMessageId
      item.unitPrice = sameModel ? previous.unitPrice : null
      item.priceMessageId = sameModel ? previous.priceMessageId : ''
      if (
        !intent.bundlePrice &&
        priceId &&
        proposedPrice !== null &&
        Number.isSafeInteger(proposedPrice) &&
        proposedPrice > 0
      ) {
        const quote = await orderMessages()
          .where('jid', jid)
          .where('direction', 'out')
          .whereIn('sender_type', ['cs', 'owner'])
          .whereNotIn('status', ['failed', 'queued'])
          .where('message_id', priceId)
          .first()
        if (quote && humanQuoteContainsPrice(String(quote.body || ''), proposedPrice)) {
          item.unitPrice = proposedPrice
          item.priceMessageId = priceId
        } else {
          // Keep confirmed product details; an unverified proposal is not an approved price.
          issues.push('Usulan harga belum cocok dengan pesan CS; harga belum diubah.')
        }
      }
      continue
    }
    const retained =
      previous &&
      previous.catalogVerification !== 'pending' &&
      previous.modelType !== 'custom' &&
      previous.productId === item.productId &&
      previous.name === item.name &&
      previous.image === item.image &&
      previous.size === item.size &&
      previous.unitPrice === item.unitPrice &&
      previous.quantity === item.quantity &&
      (preorder.has(item) ||
        (readyDemand.get(stockKey(item)) || 0) <= (previousReadyDemand.get(stockKey(item)) || 0)) &&
      (item.size !== 'custom' ||
        ((previous.requestedSize || '') === (item.requestedSize || '') &&
          previous.note === item.note &&
          (!item.priceMessageId || item.priceMessageId === previous.priceMessageId)))
    if (retained) {
      if (item.size === 'custom') {
        item.priceMessageId = previous.priceMessageId
      }
      continue
    }
    const product = evidence.products.find(
      (row) => String(row.id) === item.productId && row.name === item.name
    )
    if (!product || !product.imageUrls?.length)
      throw new CatalogLookupError({
        code: 'CATALOG_PRODUCT_UNVERIFIED',
        productId: item.productId,
        size: item.size,
      })
    // The catalog owns the image; the model cannot inject a different URL.
    item.image = product.imageUrls.includes(item.image) ? item.image : product.imageUrls[0]
    const size = product.sizes?.find(
      (row: any) =>
        String(row.size_name || row.name || row.size).toLowerCase() === item.size.toLowerCase()
    )
    if (item.size === 'custom') {
      // A catalog garment made in a special size is not a new noncatalog model.
      // Keep its verified identity/photo even when there is no custom-price row.
      const catalogPrice = Number(size?.price)
      const sameCustom =
        previous?.modelType === 'catalog' &&
        previous.size === 'custom' &&
        previous.productId === item.productId &&
        previous.name === item.name &&
        (previous.requestedSize || '') === (item.requestedSize || '') &&
        previous.note === item.note &&
        previous.quantity === item.quantity
      if (
        Number.isSafeInteger(catalogPrice) &&
        catalogPrice > 0 &&
        item.unitPrice === catalogPrice
      ) {
        item.priceMessageId = ''
      } else if (
        item.priceMessageId &&
        item.unitPrice !== null &&
        (await verifiedHumanPrice(jid, item.priceMessageId, item.unitPrice))
      ) {
        // A human quote is evidence, not approval of the customer's measurements.
      } else if (
        sameCustom &&
        previous.priceMessageId &&
        (item.unitPrice === null || item.unitPrice === previous.unitPrice)
      ) {
        item.unitPrice = previous.unitPrice
        item.priceMessageId = previous.priceMessageId
      } else {
        if (Number.isSafeInteger(catalogPrice) && catalogPrice > 0 && item.unitPrice !== null)
          throw new CartVerificationError(
            'Size atau harga custom cart belum cocok dengan MCP atau kutipan CS.'
          )
        item.unitPrice = null
        item.priceMessageId = ''
      }
      continue
    }
    const code = !size
      ? 'CATALOG_SIZE_MISSING'
      : size.price === null ||
          size.price === undefined ||
          !Number.isSafeInteger(Number(size.price)) ||
          Number(size.price) <= 0 ||
          Number(size.price) !== item.unitPrice
        ? 'CATALOG_PRICE_MISMATCH'
        : preorder.has(item)
          ? null
          : size.stock === null ||
              size.stock === undefined ||
              !Number.isFinite(Number(size.stock)) ||
              Number(size.stock) < (readyDemand.get(stockKey(item)) || item.quantity)
            ? 'CATALOG_STOCK_UNVERIFIED'
            : null
    if (code) {
      catalogIssues.push({ code, productId: item.productId, size: item.size })
      issues.push(`${item.name} · ${item.size}: ${code}`)
      catalogPending.add(item)
      item.unitPrice = null
    }
  }
  let shipping = { ...intent.shipping }
  if (intent.shipping.cost !== null && requiresShippingQuote(intent, cart)) {
    const match = matchShippingQuote(
      evidence.shipping,
      intent.shipping.service,
      intent.shipping.cost
    )
    if (!match)
      throw new Error(
        'Ongkir belum cocok dengan layanan, isi paket, atau tujuan saat ini. Periksa ulang tarif melalui MCP.'
      )
    shipping = {
      ...shipping,
      ...verifiedShippingMetadata(match),
    }
  } else if (intent.shipping.cost !== null) {
    shipping = { ...cart.shipping, ...shipping }
  }
  const saved = await saveCart(
    jid,
    version,
    {
      ...intent,
      discountRequest: intent.discount,
      shipping,
      items: intent.items.map((item) => ({
        ...item,
        catalogVerification: catalogPending.has(item) ? 'pending' : 'verified',
        id: item.id || undefined,
        measurements: Object.fromEntries(item.measurements.map((row) => [row.name, row.value])),
      })),
    },
    'ai'
  ).catch((error) => {
    if (error instanceof HumanCartEvidenceError) throw new CartVerificationError(error.message)
    throw error
  })
  for (const item of saved.items) {
    if (item.unitPrice !== null) continue
    if (item.fulfillment === 'preorder')
      issues.push(
        `${item.name} · ${item.size}: PREORDER_PRICE_UNVERIFIED — pre-order tersimpan tanpa harga sah; harga perlu ditetapkan CS sebelum rekap atau pembayaran.`
      )
    else if (item.modelType === 'custom' || item.size === 'custom')
      pendingCustomPrice(item as unknown as CartIntent['items'][number])
  }
  if (!issues.length) {
    const settled = await tryConfirmedBalanceCheckout(jid, saved.version)
    if (settled) return settled
  }
  return {
    ...saved,
    ...(issues.length
      ? { issues, catalogIssues, onlyPendingCustomPrices: issues.length === customPriceIssues }
      : {}),
  }
}

async function verifiedHumanPrice(jid: string, messageId: string, amount: number) {
  const quote = await orderMessages()
    .where('jid', jid)
    .where('direction', 'out')
    .whereIn('sender_type', ['cs', 'owner'])
    .whereNotIn('status', ['failed', 'queued'])
    .where('message_id', messageId)
    .first()
  return Boolean(quote && humanQuoteContainsPrice(String(quote.body || ''), amount))
}

export function humanQuoteContainsPrice(body: string, amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) return false
  const explicit = body.matchAll(
    /\b(?:rp\.?\s*|harga(?:\s+(?:satuan|model))?\s*[:=]?\s*)(\d+(?:[.,]\d{3})*(?:,00)?)(?!\d)/gi
  )
  const rupiah = (value: string) => Number(value.replace(/,00$/, '').replace(/[.,]/g, ''))
  if ([...explicit].some((match) => rupiah(match[1]) === amount)) return true
  // Grouped Indonesian money such as "jas, celana 705.000 bos" needs no Rp prefix.
  // Boundaries prevent matching a piece of a phone number, code, or decimal measurement.
  const grouped = body.matchAll(/(?<![\w.,+\-])\d{1,3}(?:[.,]\d{3})+(?:,00)?(?![\w.,])/g)
  if ([...grouped].some((match) => rupiah(match[0]) === amount)) return true
  const compact = body.matchAll(/(?<![\w.,+\-])(\d+(?:[.,]\d{1,2})?)\s*(ribu|rb|k|juta|jt)\b/gi)
  return [...compact].some(
    (match) =>
      Math.round(
        Number(match[1].replace(',', '.')) * (/^(juta|jt)$/i.test(match[2]) ? 1_000_000 : 1000)
      ) === amount
  )
}

function verifiedShippingMetadata(row: Record<string, any>) {
  return {
    serviceCode: String(row.service || row.code || row.service_code || row.raw?.service_code || ''),
    destinationCode: row.quote?.destinationCode || '',
    weightKg: row.quote?.weightKg ?? null,
  }
}
