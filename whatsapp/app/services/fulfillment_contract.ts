import { createHash } from 'node:crypto'

export const FULFILLMENT_KINDS = ['ready', 'preorder'] as const
export type Fulfillment = (typeof FULFILLMENT_KINDS)[number]
export type PreorderConsentRequest = { requestMessageId: string; approvalMessageId: string }
export type PreorderConsentEvidence = PreorderConsentRequest & { fingerprint: string }

const validId = (id: unknown) => typeof id === 'string' && /^[\w-]{1,190}$/.test(id)
export const validPreorderConsentRequest = (value: any): value is PreorderConsentRequest =>
  Boolean(value && validId(value.requestMessageId) && validId(value.approvalMessageId))

/** Fulfillment belongs to specific goods and a specific count, never to the room or the cart. */
export type FulfillmentGoods = {
  productId: string
  name: string
  size: string
  requestedSize?: string
  quantity: number
  modelType?: string
}
export function fulfillmentFingerprint(item: FulfillmentGoods) {
  return `v1:${createHash('sha256')
    .update(
      JSON.stringify([
        item.productId,
        item.name.trim().toLowerCase(),
        item.modelType === 'custom' ? 'custom' : 'catalog',
        item.size,
        item.requestedSize || '',
        item.quantity,
      ])
    )
    .digest('hex')}`
}
export const matchesPreorderEvidence = (
  evidence: PreorderConsentEvidence,
  item: FulfillmentGoods
) => evidence.fingerprint === fulfillmentFingerprint(item)
export const isPreorder = (item: { fulfillment?: string }) => item.fulfillment === 'preorder'

/** A human decision must name pre-order; stock, catalog labels and silence never do. */
export function humanPreorderDecision(body: string) {
  const value = String(body || '')
  if (
    /\?|\b(tidak|tak|gak|nggak|ga|belum|bukan|batal|jangan|tunda|kalau|jika|asal|nanti|mungkin|not|cannot|if|ongkir|shipping|diskon|discount|dp|transfer|bayar|lunas)\b/i.test(
      value
    )
  )
    return false
  return (
    /(?:pre[\s-]?order|\bpo\b|inden)/i.test(value) &&
    /\b(bisa|boleh|setuju|disetujui|approved|oke|ok|iya|ya|siap|kita|kami)\b/i.test(value)
  )
}

export const FULFILLMENT_INSTRUCTIONS =
  'CART CAMPURAN: ready, pre-order, custom model dan custom ukuran boleh berada dalam satu cart. Status, rincian, harga dan persetujuan melekat pada item masing-masing; custom adalah jenis model/ukuran, bukan pengganti field fulfillment. Pertahankan item lain yang masih dipilih saat menambah atau mengubah satu item. Cart campuran bukan izin mengirim terpisah atau mengenakan ongkir tambahan. ' +
  'PEMENUHAN PER ITEM: items[].fulfillment adalah ready atau preorder dan disimpan per item, bukan per cart, agar estimasi barang ready dan pre-order tidak tertukar. Default ready. Stok kosong, stok kurang, label/deskripsi MCP, dan lamanya produksi bukan dasar pre-order. Jangan mengubah item ready menjadi preorder hanya karena stok tidak mencukupi; pertahankan ready dan biarkan verifikasi stok berjalan. preorder hanya sah jika pengaturan lokal pre-order aktif dan ada keputusan CS/pemilik: keputusan yang sudah tersimpan pada item cart, atau items[].preorderConsent {requestMessageId, approvalMessageId} berisi ID permintaan pelanggan dan ID balasan CS di room ini yang menyatakan pre-order untuk barang tersebut. Pre-order tidak melewati verifikasi produk, ukuran dan harga: bila harga belum tersedia, biarkan unitPrice null, jangan mengarang harga, jangan meminta transfer atau konfirmasi rekap, dan serahkan harga ke CS. Mengubah barang, ukuran, atau jumlah membatalkan keputusan pre-order lama dan memerlukan keputusan baru.'
