import { catalogModelFamily } from '#services/color_semantics'

export const CUSTOM_PRICE_PATTERN_INSTRUCTIONS = `POLA HARGA CUSTOM — INTERNAL: pelajari harga dari produk aktif sebanding yang benar-benar dibaca, bukan angka contoh atau ingatan. Cocokkan model/konstruksi (single/double breasted bukan jumlah kancing saja), kelas/bahan, komponen jas saja/set dan ukuran standar yang sama. Bedakan harga jual per varian dari modal, harga mulai, promo, paket dan ukuran custom; satu produk dengan banyak size bukan banyak contoh independen. Ringkasan pola aplikasi hanya statistik sampel, bukan seluruh katalog atau bukti kesetaraan desain. Mayoritas tidak menghapus produk pengecualian; periksa selisih dan sumber pembanding secara terarah, tanpa scan seluruh katalog. Jika bukti sebanding belum cukup, jangan buat angka.
Pola konsisten boleh menjadi usulan harga INTERNAL untuk review CS, termasuk bila custom model/warna memakai kelas produk yang sama; nominal selalu dari data, tidak menetapkan double breasted selalu 535.000. Catat pembanding/size/bahan/komponen, harga dominan atau rentang, pengecualian dan hal yang belum pasti di note/reason. Custom ukuran/perubahan dimensi tetap membutuhkan pemeriksaan ukuran serta harga, meski label dasar standar. Persetujuan model, ukuran dan harga terpisah.
Jangan menyampaikan nominal usulan sebagai harga custom ke pelanggan, termasuk dengan kata perkiraan/estimasi/sekitar/mulai dari atau tanpa kata tersebut. Harga final custom baru dari persetujuan CS yang sah; jangan mengisi unitPrice/priceMessageId atau menagih dari pola. Harga katalog yang ditanya langsung tetap dijawab dari sumber sesuai produk. Selama menunggu harga custom, gunakan alur pemeriksaan manusia yang tersedia dan bantu satu rincian relevan yang kurang; tidak perlu membahas ketidakpastian harga secara mekanis atau meminta izin custom lagi. Jangan menjanjikan pemeriksaan tanpa tindakan, mengarang persetujuan atau mengulang analisis saat masih menunggu.`

type Product = {
  id: string
  family: string
  material: string
  currency: string
  sizes: Map<string, number>
  observedAt: number
}
const label = (value: unknown) =>
  typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ') : ''

/** Request-local statistics from actual detail reads. Never used by transaction validators. */
export function createCatalogPricePatternIndex(now = Date.now) {
  const products = new Map<string, Product>()
  return (server: string, tool: string, result: any, observedAt = now()) => {
    for (const [key, product] of products)
      if (now() - product.observedAt >= 60_000) products.delete(key)
    if (tool !== 'get_product' || !result || result.isError || result.is_error) return null
    let row = result.structuredContent ?? result.structured_content
    if (!row) {
      try {
        row = JSON.parse(result.content?.find((block: any) => block.type === 'text')?.text)
      } catch {
        return null
      }
    }
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      !row.id ||
      row.error ||
      row.ok === false ||
      row.success === false
    )
      return null
    const key = JSON.stringify([server, String(row.id)])
    // A changed/inactive/unpriced response replaces old evidence, even when no new sample survives.
    products.delete(key)
    if (!Number.isFinite(observedAt) || now() - observedAt >= 60_000) return null
    if ([false, 0, '0'].includes(row.is_active) || (row.status && row.status !== 'active'))
      return null
    const family = catalogModelFamily(String(row.name || ''))
    if (!family || !Array.isArray(row.sizes)) return null
    const sizes = new Map<string, number>()
    const conflicts = new Set<string>()
    for (const size of row.sizes) {
      const name = label(size?.size_name ?? size?.name ?? size?.size)
      const raw = size?.price
      const price =
        typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))
          ? Number(raw)
          : NaN
      if (
        !name ||
        /custom|kustom|all|mulai|from/.test(name) ||
        !Number.isSafeInteger(price) ||
        price <= 0
      )
        continue
      if (sizes.has(name) && sizes.get(name) !== price) conflicts.add(name)
      sizes.set(name, price)
    }
    for (const name of conflicts) sizes.delete(name)
    if (!sizes.size) return null
    const product = {
      id: String(row.id),
      family,
      material: label(row.material),
      currency: label(row.currency),
      sizes,
      observedAt,
    }
    products.set(key, product)
    // Bounded, per source and per phase; never learns a new global business price rule.
    if (products.size > 100) products.delete(products.keys().next().value!)
    const peers = [...products.entries()]
      .filter(
        ([peerKey, p]) =>
          JSON.parse(peerKey)[0] === server &&
          p.family === family &&
          p.material === product.material &&
          p.currency === product.currency
      )
      .map(([, p]) => p)
    if (peers.length < 2) return null
    const samples = new Map<string, Array<{ id: string; price: number }>>()
    for (const peer of peers)
      for (const [size, price] of peer.sizes) {
        const values = samples.get(size) || []
        values.push({ id: peer.id, price })
        samples.set(size, values)
      }
    const patterns = [...samples]
      .filter(([, values]) => values.length >= 2)
      .map(([size, values]) => {
        const counts = new Map<number, number>()
        values.forEach(({ price }) => counts.set(price, (counts.get(price) || 0) + 1))
        const frequencies = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])
        const majority = frequencies[0][1] > values.length / 2 ? frequencies[0][0] : null
        return {
          size,
          products: values.length,
          dominantPrice: majority,
          consistent: counts.size === 1,
          min: Math.min(...counts.keys()),
          max: Math.max(...counts.keys()),
          sources: values.slice(0, 6),
          omittedSources: Math.max(0, values.length - 6),
        }
      })
    if (!patterns.length) return null
    return {
      status: 'internal_review_only',
      server,
      modelFamily: family,
      material: product.material || null,
      currency: product.currency || null,
      patterns: patterns.slice(0, 4),
      omittedSizes: Math.max(0, patterns.length - 4),
      note: 'Sample from detail reads, grouped by name without color; NOT verified design/material/set equivalence, catalog coverage or custom price approval. Review exceptions and missing attributes. Internal CS review only; never quote these amounts as the customer custom price or copy into cart. Custom size always requires review.',
    }
  }
}
