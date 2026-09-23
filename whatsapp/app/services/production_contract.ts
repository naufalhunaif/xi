export const PRODUCTION_KINDS = ['preorder', 'custom'] as const
export type ProductionKind = (typeof PRODUCTION_KINDS)[number]
export type ProductionRule = {
  enabled: boolean
  minDays: number | null
  maxDays: number | null
  estimateDays: number | null
  dayType: 'calendar' | 'working'
  startsAfter: 'payment_details' | 'full_payment_details' | 'approval'
}
export type ProductionPolicy = {
  version: string
  autoAdjust: boolean
  rules: Record<ProductionKind, ProductionRule>
}
export type ProductionSignal = {
  kind: ProductionKind
  direction: 'shorter' | 'longer'
  reason: string
  evidenceMessageIds: string[]
}
export function defaultProductionPolicy(): ProductionPolicy {
  const rule = (): ProductionRule => ({
    enabled: false,
    minDays: null,
    maxDays: null,
    estimateDays: null,
    dayType: 'calendar',
    startsAfter: 'payment_details',
  })
  return { version: 'unconfigured', autoAdjust: true, rules: { preorder: rule(), custom: rule() } }
}
export function validateProductionPolicy(input: unknown): ProductionPolicy {
  const data = input as ProductionPolicy
  if (
    !data ||
    typeof data.version !== 'string' ||
    typeof data.autoAdjust !== 'boolean' ||
    !data.rules
  )
    throw new Error('Invalid production settings.')
  const rules = {} as ProductionPolicy['rules']
  for (const kind of PRODUCTION_KINDS) {
    const rule = data.rules[kind]
    if (
      !rule ||
      typeof rule.enabled !== 'boolean' ||
      !['calendar', 'working'].includes(rule.dayType) ||
      !['payment_details', 'full_payment_details', 'approval'].includes(rule.startsAfter)
    )
      throw new Error('Invalid production rule.')
    const values = [rule.minDays, rule.maxDays, rule.estimateDays]
    if (values.some((n) => n !== null && (!Number.isInteger(n) || n < 1 || n > 365)))
      throw new Error('Production days must be whole numbers from 1 to 365.')
    if (rule.enabled && values.some((n) => n === null))
      throw new Error('Set the minimum, maximum and estimate before enabling.')
    if (rule.minDays !== null && rule.maxDays !== null && rule.minDays > rule.maxDays)
      throw new Error('Minimum cannot exceed maximum.')
    if (
      rule.estimateDays !== null &&
      ((rule.minDays !== null && rule.estimateDays < rule.minDays) ||
        (rule.maxDays !== null && rule.estimateDays > rule.maxDays))
    )
      throw new Error('Estimate must be within the permitted range.')
    rules[kind] = {
      enabled: rule.enabled,
      minDays: rule.minDays,
      maxDays: rule.maxDays,
      estimateDays: rule.estimateDays,
      dayType: rule.dayType,
      startsAfter: rule.startsAfter,
    }
  }
  return { version: data.version, autoAdjust: data.autoAdjust, rules }
}
export const PRODUCTION_SIGNAL_SCHEMA = {
  type: ['object', 'null'],
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: PRODUCTION_KINDS },
    direction: { type: 'string', enum: ['shorter', 'longer'] },
    reason: { type: 'string' },
    evidenceMessageIds: { type: 'array', items: { type: 'string' } },
  },
  required: ['kind', 'direction', 'reason', 'evidenceMessageIds'],
}
export function parseProductionSignal(value: unknown): ProductionSignal | null {
  if (value === null || value === undefined) return null
  const signal = value as ProductionSignal
  if (
    !PRODUCTION_KINDS.includes(signal.kind) ||
    !['shorter', 'longer'].includes(signal.direction) ||
    typeof signal.reason !== 'string' ||
    !signal.reason.trim() ||
    signal.reason.length > 1000 ||
    !Array.isArray(signal.evidenceMessageIds) ||
    !signal.evidenceMessageIds.length ||
    signal.evidenceMessageIds.length > 12 ||
    signal.evidenceMessageIds.some((id) => typeof id !== 'string' || !id || id.length > 190)
  )
    throw new Error('Invalid production evaluation signal.')
  return {
    kind: signal.kind,
    direction: signal.direction,
    reason: signal.reason,
    evidenceMessageIds: [...new Set(signal.evidenceMessageIds)],
  }
}
export function productionDataContext(policy?: ProductionPolicy) {
  return `DATA OPERASIONAL LOKAL — PRODUKSI & PRE-ORDER (sumber: pengaturan pemilik aplikasi, bukan MCP):
${JSON.stringify(policy || defaultProductionPolicy())}
PENENTUAN PRE-ORDER: sumber keputusan adalah pengaturan WhatsApp lokal dan data/keputusan pesanan lokal yang sudah disetujui pemilik atau CS. Jangan menentukan, mengaktifkan, menolak, atau mengubah pre-order berdasarkan field, label, deskripsi produk, aturan, atau durasi dari MCP, termasuk hasil MCP yang tersimpan di cache. Jangan memanggil tool MCP untuk memeriksa apakah pre-order diizinkan. Jika hasil pencarian produk memuat informasi pre-order, abaikan bagian itu untuk keputusan pre-order; MCP bukan sumber kebijakan ini.
Gunakan aturan lokal yang enabled untuk estimasi umum kategori tersebut. Jika hanya membahas kebijakan/estimasi pre-order lokal, business_lookup_required boleh false. Jika disabled/belum diisi, jangan mengaktifkan pre-order atau mengisi estimasi dari MCP sebagai fallback. Aturan durasi yang enabled bukan bukti bahwa setiap produk otomatis pre-order: gunakan keputusan lokal untuk pesanan/produk terkait; jika belum ada dasar lokal yang jelas, jangan menyimpulkan sendiri. Stok kosong tidak otomatis berarti pre-order atau custom, dan stok ready tidak otomatis membatalkan keputusan pre-order lokal.
Harga, stok aktual, ukuran, gambar, dan detail model tetap boleh diverifikasi melalui MCP; verifikasi fakta produk ini tidak boleh dijadikan pemeriksaan kebijakan pre-order. Persetujuan model/custom yang memang diperlukan tetap berlaku. Bila ada pertentangan, keputusan pre-order mengikuti sumber lokal, bukan MCP; jangan mengubah fakta stok atau mengklaim siap kirim untuk mengatasi pertentangan itu.
estimateDays adalah estimasi sampai siap dikirim, BUKAN jaminan selesai, status produksi aktual, atau lama kurir. dayType calendar=hari kalender, working=hari kerja (jangan mengarang kalender libur/tanggal pasti). startsAfter payment_details=DP/pembayaran terverifikasi dan detail pesanan lengkap; full_payment_details=pelunasan terverifikasi dan detail lengkap; approval=persetujuan produksi tercatat. Jangan menganggap pemicu sudah terjadi hanya karena pelanggan berjanji.
Jangan mengganti estimasi/tanggal yang sudah disepakati untuk order berjalan dengan aturan baru. Untuk pertanyaan progres/selesai pesanan, periksa order, janji sebelumnya dan data produksi aktual; jika belum tersedia gunakan keputusan internal sesuai skill, bukan mengarang tahap produksi. Batas minimum/maksimum adalah kapasitas yang disetujui pemilik, bukan diskon waktu yang boleh dinegosiasikan sendiri. Gaya bahasa, inisiatif, dan penanganan tetap mengikuti skill.`
}
