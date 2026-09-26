import { listLeanCatalog } from '#beta3/catalog_service'

export type OrderPhoto = { product: string; color: string; url: string }

const norm = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Foto produk yang dipesan, hanya bila varian katalognya PERSIS sama (produk + warna).
 * "Tuxedo - Broken White" tidak boleh jadi foto "Tuxedo - White"; pesanan dengan model
 * dari gambar pelanggan ("sesuai gambar") tidak memakai foto katalog sama sekali.
 */
export async function attachOrderPhotos<
  T extends { spec?: unknown; items?: unknown; chat_note?: unknown },
>(orders: T[]): Promise<(T & { photos: OrderPhoto[] })[]> {
  if (!orders.length) return orders.map((o) => ({ ...o, photos: [] }))
  let catalog: Awaited<ReturnType<typeof listLeanCatalog>> = []
  try {
    const all = await listLeanCatalog()
    catalog = all.filter((row) => row.active && row.photoUrl)
  } catch {
    catalog = []
  }
  const byVariant = new Map<string, (typeof catalog)[number]>()
  for (const row of catalog) byVariant.set(`${norm(row.product)}|${norm(row.color)}`, row)
  const products = [...new Set(catalog.map((row) => norm(row.product)))]
    .filter((name) => name.length >= 3)
    // Nama lebih panjang dicek dulu supaya "Tuxedo Slim" menang atas "Tuxedo".
    .sort((a, b) => b.length - a.length)
  return orders.map((order) => {
    const source = String(order.spec || order.items || '')
    const photos: OrderPhoto[] = []
    if (/sesuai gambar|seperti gambar|kayak gambar|dari gambar/i.test(source)) return { ...order, photos }
    for (const raw of source.split('\n')) {
      if (photos.length >= 4) break
      // Baris item: "Produk - Warna" (boleh diawali "Setelan"/nomor, diakhiri size/keterangan).
      const line = raw.replace(/^\s*\d+[.)]\s*/, '').trim()
      const dash = line.split(/\s+[-\u2013\u2014]\s+/)
      if (dash.length < 2) continue
      const left = norm(dash[0])
      const product = products.find((name) => ` ${left} `.includes(` ${name} `))
      if (!product) continue
      // Warna = teks setelah tanda hubung sampai keterangan size/jumlah.
      const color = norm(dash.slice(1).join(' ').split(/,|\bsize\b|\bukuran\b|\bno\b|\(|\bjas\b|\bcelana\b/i)[0])
      const row = byVariant.get(`${product}|${color}`)
      if (!row) continue
      if (photos.some((photo) => photo.url === String(row.photoUrl))) continue
      photos.push({ product: row.product, color: row.color, url: String(row.photoUrl) })
    }
    return { ...order, photos }
  })
}
