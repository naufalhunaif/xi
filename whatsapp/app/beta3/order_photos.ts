import { listLeanCatalog } from '#beta3/catalog_service'

export type OrderPhoto = { product: string; color: string; url: string }

const norm = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/**
 * Foto produk yang dipesan: cocokkan nama produk (+ warna) dari katalog dengan teks
 * order (spec/items/chat_note). Tanpa AI; cukup pencocokan nama.
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
  const rows = catalog
    .map((row) => ({ row, product: norm(row.product), color: norm(row.color) }))
    .filter((entry) => entry.product.length >= 3)
    // Nama lebih panjang dicek dulu supaya "Tuxedo Slim" menang atas "Tuxedo".
    .sort((a, b) => b.product.length - a.product.length)
  return orders.map((order) => {
    const text = ` ${norm(`${order.spec || ''} ${order.items || ''} ${order.chat_note || ''}`)} `
    const photos: OrderPhoto[] = []
    const seenProducts = new Set<string>()
    for (const entry of rows) {
      if (photos.length >= 4) break
      if (!text.includes(` ${entry.product} `)) continue
      const colorHit = entry.color && text.includes(` ${entry.color} `)
      if (entry.color && !colorHit && seenProducts.has(entry.product)) continue
      if (!colorHit && seenProducts.has(entry.product)) continue
      photos.push({
        product: entry.row.product,
        color: entry.row.color,
        url: String(entry.row.photoUrl),
      })
      seenProducts.add(entry.product)
    }
    return { ...order, photos }
  })
}
