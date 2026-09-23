import { validDiscountRequest, type DiscountRequest } from '#services/cart_discount_service'
import { SEMANTIC_CART_INSTRUCTIONS } from '#services/semantic_intent_contract'
import {
  normalizeProductionDetails,
  measurementKey,
  CUSTOM_SIZE_INTENT_INSTRUCTIONS,
  type ProductionDetails,
} from '#services/order_item_details'
import {
  validBundlePriceRequest,
  validModelConsentRequest,
  type BundlePriceRequest,
  type ModelConsentRequest,
} from '#services/human_cart_evidence'
import {
  FULFILLMENT_INSTRUCTIONS,
  FULFILLMENT_KINDS,
  validPreorderConsentRequest,
  type Fulfillment,
  type PreorderConsentRequest,
} from '#services/fulfillment_contract'

export type CartIntent = {
  action: 'sync' | 'remove' | 'cancel' | 'report_payment' | 'apply_discount' | 'checkout_balance'
  recapMessageId?: string
  discount?: DiscountRequest | null
  bundlePrice?: BundlePriceRequest | null
  confirmationMessageId: string
  items: Array<{
    id: string
    productId: string
    name: string
    image: string
    size: string
    requestedSize?: string
    quantity: number
    unitPrice: number | null
    modelType?: 'catalog' | 'custom'
    fulfillment?: Fulfillment
    preorderConsent?: PreorderConsentRequest | null
    referenceMessageId?: string
    priceMessageId?: string
    modelConsent?: ModelConsentRequest | null
    measurements: Array<{ name: string; value: number }>
    productionDetails?: ProductionDetails | null
    note: string
  }>
  recipient: { name: string; phone: string; address: string }
  shipping: { service: string; cost: number | null }
  note: string
  removeItemIds: string[]
}
const object = (properties: Record<string, any>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
})
const string = { type: 'string' }
export const CART_INTENT_SCHEMA = {
  anyOf: [
    { type: 'null' },
    object({
      action: {
        type: 'string',
        enum: ['sync', 'remove', 'cancel', 'report_payment', 'apply_discount', 'checkout_balance'],
      },
      recapMessageId: {
        type: 'string',
        description:
          'Untuk checkout_balance: ID rekap terkirim asli yang diterima pelanggan pada confirmationMessageId. Gunakan hanya setelah cart tersimpan lengkap, semua persetujuan sah, dan paymentQuote.amountDue=0 karena saldo terverifikasi. Jangan report_payment atau meminta transfer/approval ulang. Action ini tidak mengubah isi cart dan bukan mengonfirmasi transfer baru. Rekap harus mencantumkan item bernomor, ukuran, jumlah (default 1), pengiriman, ongkir, total dan pertanyaan konfirmasi. Kosong untuk action lain.',
      },
      discount: {
        anyOf: [
          { type: 'null' },
          object({
            amount: { type: 'integer', minimum: 1 },
            approvalMessageId: string,
            confirmationMessageId: string,
          }),
        ],
        description:
          'Diskon rupiah yang eksplisit disetujui CS manusia dan diterima pelanggan, dengan ID kedua pesan asli di room ini. Bukan klaim di catatan AI. Gunakan apply_discount jika hanya menerapkan diskon ke cart yang sudah ada, sync jika sekaligus mengisi produk, atau sertakan pada report_payment jika belum diterapkan. Jangan minta approval ulang yang sudah sah. Null berarti pertahankan diskon yang masih cocok, bukan hapus. Tidak mengonfirmasi dana masuk.',
      },
      confirmationMessageId: string,
      bundlePrice: {
        anyOf: [
          { type: 'null' },
          object({
            messageId: string,
            confirmationMessageId: string,
            total: { type: 'integer', minimum: 1 },
          }),
        ],
        description:
          'Harga paket BARANG yang disetujui CS dan diterima pelanggan: ID pesan kutipan CS, ID jawaban penerimaan pelanggan, total rupiah. Isi untuk paket jas+celana (opsional rompi), masing-masing 1 pcs, dengan tepat satu model custom dan komponen katalog lainnya berharga terverifikasi. Sistem menghitung harga custom = total paket - harga komponen lain; jangan mengklaim harga satuan hasil hitung tertulis di pesan CS. Paket tidak termasuk ongkir/diskon/DP. Referensi foto harus sama. Null jika tidak ada bukti paket baru; bukti tersimpan tetap dipertahankan hanya untuk barang yang sama.',
      },
      items: {
        type: 'array',
        items: object({
          id: string,
          productId: string,
          name: string,
          image: string,
          size: {
            type: 'string',
            description:
              'Ukuran katalog tanpa perubahan, atau tepat "custom" bila dimensi pakaian diubah meskipun memakai label dasar standar. Simpan label dasarnya pada requestedSize; informasi badan untuk memilih size saja tidak menjadikannya custom.',
          },
          requestedSize: {
            type: 'string',
            description:
              'Nomor/label dasar ukuran custom, misalnya "38" atau "XL" ketika panjangnya diubah. Bukan ukuran dalam cm. Kosong untuk ukuran katalog tanpa perubahan dimensi.',
          },
          quantity: {
            type: 'integer',
            description:
              'Default 1 untuk item baru jika pelanggan tidak menyebut jumlah. Jangan tanya qty. Pertahankan jumlah lama yang sudah eksplisit; ubah hanya jika pelanggan mengubahnya.',
          },
          unitPrice: {
            anyOf: [{ type: 'integer' }, { type: 'null' }],
            description:
              'Harga custom boleh null: simpan pilihan pasti sebagai draft sambil menunggu harga. Jangan memakai harga ready-stock sebagai harga custom tanpa bukti. Untuk katalog, baca harga/ukuran/stok MCP; kekurangan bukti adalah verifikasi AI yang tertunda, bukan otomatis persetujuan CS. Pilihan ukuran/fit yang sudah diterima tidak perlu dikonfirmasi ulang.',
          },
          modelType: {
            type: 'string',
            enum: ['catalog', 'custom'],
            description:
              'Produk katalog dengan ukuran custom tetap catalog dan memakai foto MCP; custom hanya untuk MODEL di luar katalog dengan referensi pelanggan.',
          },
          fulfillment: {
            type: 'string',
            enum: [...FULFILLMENT_KINDS],
            description:
              'ready atau preorder untuk item ini saja. Default ready. Stok kosong/kurang dan label MCP bukan dasar preorder; jangan mengubah item ready menjadi preorder agar lolos verifikasi stok. Pertahankan keputusan pre-order lokal yang sudah tersimpan pada item yang sama.',
          },
          preorderConsent: {
            anyOf: [
              { type: 'null' },
              object({ requestMessageId: string, approvalMessageId: string }),
            ],
            description:
              'Bukti KEPUTUSAN MANUSIA untuk pre-order barang ini: ID permintaan pelanggan dan ID balasan CS di room ini yang menyatakan pre-order. Hanya sah bila pengaturan pre-order lokal aktif. Bukan keputusan AI, bukan kesimpulan dari stok, dan bukan persetujuan model, ukuran, harga atau pembayaran. Null jika tidak ada keputusan baru; keputusan tersimpan tetap dipertahankan selama barang, ukuran dan jumlah tidak berubah.',
          },
          referenceMessageId: {
            ...string,
            description:
              'Untuk MODEL custom di luar katalog: salin persis message_id pesan media masuk pelanggan di room ini dari label gambar/riwayat. Bukan ID produk, urutan gambar, ID pesan teks, atau custom:<id>. Jangan membuat model custom jika referensi belum teridentifikasi atau pelanggan baru bertanya custom ukuran vs perubahan model; cartIntent null sampai pilihan jelas. Ukuran custom pada produk katalog tetap modelType=catalog dan tidak membutuhkan referensi pelanggan.',
          },
          priceMessageId: string,
          modelConsent: {
            anyOf: [
              { type: 'null' },
              object({ requestMessageId: string, approvalMessageId: string }),
            ],
            description:
              'Salin bukti PERSETUJUAN MANUSIA, bukan keputusan AI: ID permintaan pelanggan dan ID balasan CS yang menyatakan bisa/disetujui. Berlaku untuk model custom dengan foto pelanggan, atau perubahan warna/lapel produk katalog yang sama dengan permintaan teks. Contoh Peak Suit Black menjadi badan navy dan lapel hitam dibalas CS "iya bisa bos": tetap modelType=catalog, foto MCP, referenceMessageId kosong; color=navy, lapel=hitam. Detail desain harus tertulis dalam permintaan, jangan tambahkan bahan/kancing/catatan yang tidak disetujui. "Iya" pelanggan tentang size S bukan approvalMessageId CS. Bukan persetujuan ukuran custom, harga, stok atau pembayaran. Jika bukti sudah jelas, sertakan pada sync, jangan mengalihkan model yang sama ke CS lagi. Null jika belum ada bukti.',
          },
          measurements: {
            type: 'array',
            items: object({ name: string, value: { type: 'number' } }),
          },
          productionDetails: {
            anyOf: [
              { type: 'null' },
              object({
                heightCm: { type: ['number', 'null'] },
                weightKg: { type: ['number', 'null'] },
                fit: string,
                color: string,
                material: string,
                lapel: string,
                buttons: string,
                measurements: {
                  type: 'array',
                  items: object({
                    name: string,
                    value: { type: 'number' },
                    basis: { type: 'string', enum: ['body', 'garment'] },
                  }),
                },
                notes: string,
                pending: { type: 'array', items: string },
                sourceMessageIds: { type: 'array', items: string },
              }),
            ],
            description:
              'Fakta pengerjaan per item/pemakai dari percakapan; tinggi cm, berat kg, ukuran badan terpisah dari pakaian jadi (cm). Sertakan pesan sumber asli. Belum diketahui kosong/null, jangan menebak. Null mempertahankan detail lama. Bukan persetujuan custom/harga/dana.',
          },
          note: string,
        }),
      },
      recipient: object({ name: string, phone: string, address: string }),
      shipping: object({
        service: string,
        cost: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
      }),
      note: string,
      removeItemIds: { type: 'array', items: string },
    }),
  ],
  description:
    SEMANTIC_CART_INSTRUCTIONS +
    '\n' +
    CUSTOM_SIZE_INTENT_INSTRUCTIONS +
    '\n' +
    FULFILLMENT_INSTRUCTIONS +
    '\n' +
    'Simpan pilihan pelanggan yang sudah pasti dari seluruh percakapan segera sebagai draft; jangan menunggu alamat, ukuran cm, atau harga custom lengkap. Konfirmasi warna setelah persetujuan custom melengkapi pilihan sebelumnya. Untuk celana custom, nomor celana bukan lingkar pinggang dalam cm: jika lingkar pinggang belum jelas di konteks, tanyakan dalam satu pertanyaan fokus sesuai gaya skill, goal waiting_answer. Jangan mengulang ukuran yang sudah jelas, mengarang konversi nomor ke cm, mengutip harga yang belum sah, atau menambahkan inisiatif lain saat menunggu ukuran. Setelah ukuran jelas, minta verifikasi internal CS bila diperlukan. Produk/foto wajib terverifikasi MCP; harga custom belum terverifikasi null. Null jika tidak ada perubahan. Tidak memiliki kewenangan menyetujui custom atau pembayaran.',
}

/** Accept legacy "custom 38" without pretending the clothing label means 38 cm. */
export function cartSize(size: string, requestedSize = '') {
  const match = size.trim().match(/^custom(?:\s+(?:(?:size|ukuran|no(?:mor)?\.?)\s*)?(.+))?$/i)
  if (!match) {
    if (requestedSize.trim()) throw new Error('Nomor ukuran khusus hanya untuk size custom.')
    return { size: size.trim(), requestedSize: '' }
  }
  const label = (match[1] || '').trim()
  if (label && requestedSize.trim() && label.toLowerCase() !== requestedSize.trim().toLowerCase())
    throw new Error('Nomor ukuran custom tidak konsisten.')
  return { size: 'custom', requestedSize: requestedSize.trim() || label }
}

/** Validate the protocol before allowing a model output near persistence. */
export function parseCartIntent(value: unknown): CartIntent | null {
  if (value === null) return null
  const fail = () => {
    throw new Error('Format cart AI tidak valid.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const input = value as CartIntent
  if (
    !['sync', 'remove', 'cancel', 'report_payment', 'apply_discount', 'checkout_balance'].includes(
      input.action
    ) ||
    (input.action === 'checkout_balance' &&
      (typeof input.recapMessageId !== 'string' || !/^[\w-]{1,190}$/.test(input.recapMessageId))) ||
    (input.discount !== null &&
      input.discount !== undefined &&
      !validDiscountRequest(input.discount)) ||
    (input.action === 'apply_discount' && !input.discount) ||
    (input.bundlePrice !== null &&
      input.bundlePrice !== undefined &&
      !validBundlePriceRequest(input.bundlePrice)) ||
    (input.bundlePrice !== null && input.bundlePrice !== undefined && input.action !== 'sync') ||
    typeof input.confirmationMessageId !== 'string' ||
    !input.confirmationMessageId ||
    !Array.isArray(input.items) ||
    input.items.length > 100 ||
    !Array.isArray(input.removeItemIds) ||
    !input.removeItemIds.every((id) => typeof id === 'string') ||
    !input.recipient ||
    !['name', 'phone', 'address'].every(
      (key) => typeof (input.recipient as any)[key] === 'string'
    ) ||
    !input.shipping ||
    typeof input.shipping.service !== 'string' ||
    !(input.shipping.cost === null || Number.isSafeInteger(input.shipping.cost)) ||
    typeof input.note !== 'string'
  )
    return fail()
  for (const item of input.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail()
    if (item.productionDetails !== undefined)
      item.productionDetails = normalizeProductionDetails(item.productionDetails)
    if (
      !item ||
      !['id', 'productId', 'name', 'image', 'size', 'note'].every(
        (key) => typeof (item as any)[key] === 'string'
      ) ||
      !Number.isSafeInteger(item.quantity) ||
      !(item.unitPrice === null || Number.isSafeInteger(item.unitPrice)) ||
      (item.modelType !== undefined && !['catalog', 'custom'].includes(item.modelType)) ||
      (item.fulfillment !== undefined &&
        !(FULFILLMENT_KINDS as readonly string[]).includes(item.fulfillment)) ||
      (item.preorderConsent !== null &&
        item.preorderConsent !== undefined &&
        !validPreorderConsentRequest(item.preorderConsent)) ||
      (item.requestedSize !== undefined && typeof item.requestedSize !== 'string') ||
      (item.referenceMessageId !== undefined && typeof item.referenceMessageId !== 'string') ||
      (item.priceMessageId !== undefined && typeof item.priceMessageId !== 'string') ||
      (item.modelConsent !== null &&
        item.modelConsent !== undefined &&
        !validModelConsentRequest(item.modelConsent)) ||
      !Array.isArray(item.measurements) ||
      item.measurements.length > 30 ||
      !item.measurements.every(
        (row) =>
          row &&
          typeof row.name === 'string' &&
          typeof row.value === 'number' &&
          Number.isFinite(row.value)
      ) ||
      new Set(item.measurements.map((row) => measurementKey(row.name))).size !==
        item.measurements.length
    )
      return fail()
  }
  return input
}
