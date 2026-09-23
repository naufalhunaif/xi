import type { Cart } from '#services/cart_service'
import { createHash } from 'node:crypto'
import { bundlePriceFingerprint } from '#services/human_cart_evidence'

export const checkoutFingerprint = (cart: Cart) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        bundlePriceFingerprint(cart.items),
        cart.items.map((item) => [
          item.id,
          item.measurements,
          item.productionDetails?.heightCm,
          item.productionDetails?.weightKg,
          item.productionDetails?.fit,
          item.productionDetails?.measurements,
        ]),
        cart.recipient,
        cart.shipping,
        cart.discount,
        cart.total,
      ])
    )
    .digest('hex')

const clean = (value: string) =>
  value.toLowerCase().replace(/[*_]/g, '').replace(/\s+/g, ' ').trim()
const words = (value: string) =>
  clean(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
const contains = (body: string, value: string) =>
  words(value).every((word) => words(body).includes(word))
export function acceptsCheckout(body: string) {
  return /^(?:(?:oke|ok|okay|iya|ya|yes|betul|(?:benar|bener)(?: semua)?|(?:sudah|udah) (?:benar|bener|sesuai)|setuju|lanjut)(?:\s+(?:siap|setuju|lanjut))?(?:\s+(?:bos|bosku|gan|kak|pak|ka))?[.!\s]*)$/i.test(
    clean(body)
  )
}

/** Only harmless follow-ups may pass an unprocessed turn. Unknown requests pause checkout. */
export function checkoutFollowup(body: string) {
  const value = clean(body)
    .replace(/[?!.,]+$/g, '')
    .trim()
  // An internal-business question is not an order change and never grants new consent.
  if (
    /\b(?:omset(?:mu)?|omzet(?:mu)?|backend|database)\b/.test(value) &&
    !/\b(?:ganti|ubah|batal|jangan|tunda|tahan|tambah|kurang|alamat|ukuran|warna|pesanan|order|transfer)\b/.test(
      value
    )
  )
    return true
  return (
    acceptsCheckout(value) ||
    // A status nudge preserves existing consent; it never grants consent by itself.
    /^(?:gimana|bagaimana)(?: (?:kelanjutannya|prosesnya|pesanannya|kabar(?:nya)?))?(?: ya)?(?: bos| bosku| gan| kak| pak| ka)?$/.test(
      value
    ) ||
    /^(?:(?:oke|iya|ya)[, ]+)?(?:kapan (?:di ?kirim|sampai)|(?:pesanan|paket)(?:nya| saya)? (?:kapan (?:di ?kirim|sampai)|sudah di ?kirim)|(?:berapa lama|estimasi) (?:pengiriman|kirim|sampai)|(?:jadi )?pembayaran sama kah ke rekening s?belumnya|(?:rekening|pembayaran)(?:nya)? (?:masih )?sama(?: dengan| ke)?(?: rekening)? sebelumnya|(?:terima kasih|makasih|thanks|di ?tunggu|pagi|selamat pagi))(?: ya)?(?: bos| bosku| gan| kak)?$/.test(
      value
    )
  )
}

/** Payment explanation can bridge an already matching recap, never substitute for one. */
export function balanceExplanation(cart: Cart, body: string) {
  const value = clean(body)
  if (
    !/saldo|kelebihan pembayaran/.test(value) ||
    !/tidak perlu transfer|gak perlu transfer|nggak perlu transfer|sisa tagihan(?:nya)?\s*(?:rp\.?\s*)?0\b/.test(
      value
    )
  )
    return false
  const amounts = [...value.matchAll(/\brp\.?\s*(\d+(?:[.,]\d{3})*)/g)].map((m) =>
    Number(m[1].replace(/[.,]/g, ''))
  )
  return (
    amounts.includes(cart.total) && amounts.every((amount) => amount === 0 || amount === cart.total)
  )
}

/** Conservative compatibility for recaps sent before checkout snapshot binding existed.
 * No fuzzy prices, no nearest product match, no generic "oke" without a full recap.
 */
export function matchesCheckoutRecap(cart: Cart, body: string) {
  if (!cart.totalComplete || !cart.items.length || cart.total <= 0) return false
  const lines = body.split(/\r?\n/).map(clean).filter(Boolean)
  const amount = (line: string) => {
    const match = line.match(
      /:\s*(?:rp\.?|idr)?\s*(\d+(?:[.,]\d{3})*)\s*(?:bos|bosku|gan|kak)?[.!]?$/
    )
    return match ? Number(match[1].replace(/[.,]/g, '')) : NaN
  }
  const totals = lines.filter((line) => /^(?:grand )?total\s*:/.test(line))
  const shipping = lines.filter((line) => /^(?:ongkir|shipping cost)\s*:/.test(line))
  if (
    totals.length !== 1 ||
    amount(totals[0]) !== cart.total ||
    shipping.length !== 1 ||
    amount(shipping[0]) !== cart.shipping.cost ||
    !lines.some(
      (line) =>
        /^(?:pengiriman|shipping|kurir|layanan)\s*:/.test(line) &&
        contains(line, cart.shipping.service)
    )
  )
    return false
  const discounts = lines.filter((line) => /^(?:diskon|discount)\s*:/.test(line))
  if (cart.discount && (discounts.length !== 1 || amount(discounts[0]) !== cart.discount))
    return false
  // Explicit one-line item recaps only; ambiguous layouts require a fresh, clear recap.
  const itemLines = lines
    .filter((line) => /^\d+[.)]\s+/.test(line))
    .map((line) => line.replace(/^\d+[.)]\s+/, ''))
  if (itemLines.length !== cart.items.length) return false
  const used = new Set<number>()
  for (const item of cart.items) {
    const candidates = itemLines.flatMap((line, index) => {
      if (used.has(index)) return []
      if (item.productionDetails?.color && !contains(line, item.productionDetails.color)) return []
      const size = item.size === 'custom' ? `custom ${item.requestedSize || ''}` : item.size
      if (!contains(line, size)) return []
      if (item.quantity !== 1 && !new RegExp(`\\b${item.quantity}\\s*(?:pcs|x|buah)\\b`).test(line))
        return []
      const quantities = [...line.matchAll(/\b(\d+)\s*(?:pcs|x|buah)\b/g)]
      if (quantities.some((match) => Number(match[1]) !== item.quantity)) return []
      let identity = contains(line, item.name)
      if (!identity) {
        const kind = /\b(jas|suit|jacket)\b/i.test(item.name)
          ? /\bjas\b/
          : /\b(pants|celana|trousers)\b/i.test(item.name)
            ? /\bcelana\b/
            : null
        // Legacy translations only when colour and (for custom) front-button detail agree.
        const d = item.productionDetails
        identity = Boolean(
          kind?.test(line) &&
          d?.color &&
          contains(line, d.color) &&
          (item.modelType !== 'custom' ||
            (/\bcustom\b/.test(line) &&
              d.buttons &&
              contains(
                line.replace(/\bdua\b/g, '2').replace(/\bsatu\b/g, '1'),
                d.buttons
                  .replace(/\bdepan\b/gi, '')
                  .replace(/\bdua\b/gi, '2')
                  .replace(/\bsatu\b/gi, '1')
              )))
        )
      }
      return identity ? [index] : []
    })
    if (candidates.length !== 1) return false
    used.add(candidates[0])
  }
  return /(?:sudah|udah).*(?:benar|bener|sesuai)|(?:konfirmasi|confirm).*(?:pesanan|order)|correct\?/i.test(
    body
  )
}
