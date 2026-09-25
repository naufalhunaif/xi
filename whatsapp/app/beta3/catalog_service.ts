// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import db from '#services/workspace_database'
import { workspaceScope } from '#services/workspace_context'
import { ensureLeanTables } from '#beta3/tables'

/**
 * Digest katalog: satu baris teks per varian, disiapkan aplikasi (bukan hasil tool
 * yang ditarik model). Sumbernya diimpor dari JSON (web/MCP/Excel) lewat
 * importLeanCatalog; AI hanya membaca teksnya.
 */
export type LeanCatalogInput = {
  product: string
  color?: string
  category?: string
  price?: number | null
  sizesReady?: string[] | string
  sizesAll?: string[] | string
  photoUrl?: string | null
  materialAvailable?: boolean
  features?: string
  material?: string
  sizeGroup?: string
  fit?: string
  note?: string
  active?: boolean
}

export type LeanCatalogRow = {
  id: number
  product: string
  color: string
  category: string
  price: number | null
  sizesReady: string
  sizesAll: string
  photoUrl: string | null
  materialAvailable: boolean
  features: string
  /** Ciri hasil analisis AI dari foto; dipakai bila admin tidak mengisi ciri. */
  featuresAi: string
  /** Seri bahan (mis. Black Label); beda seri beda harga. */
  material: string
  /** Grup ukuran produk; menunjuk baris SIZE CHART yang berlaku. */
  sizeGroup: string
  fit: string
  note: string
  active: boolean
  updatedAt: string
}

const DIGEST_TTL_MS = 5 * 60_000
const digestCache = new Map<string, { text: string; at: number; rows: LeanCatalogRow[] }>()

export function invalidateCatalogDigest() {
  digestCache.delete(workspaceScope().prefix)
}

const sizeText = (value: string[] | string | undefined) =>
  (Array.isArray(value) ? value : String(value || '').split(/[\s,]+/))
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .join(' ')

export function normalizeCatalogInput(raw: unknown): LeanCatalogInput {
  const item = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const product = String(item.product ?? item.name ?? item.nama ?? '').trim()
  if (!product) throw new Error('Kolom product wajib diisi.')
  const price = item.price ?? item.harga
  return {
    product: product.slice(0, 120),
    color: String(item.color ?? item.warna ?? '')
      .trim()
      .slice(0, 80),
    category: String(item.category ?? item.kategori ?? '')
      .trim()
      .slice(0, 60),
    price:
      price === null || price === undefined || price === ''
        ? null
        : Math.max(0, Math.round(Number(String(price).replace(/[^\d]/g, '')))),
    sizesReady: sizeText((item.sizesReady ?? item.sizes_ready ?? item.ready) as string),
    sizesAll: sizeText((item.sizesAll ?? item.sizes_all ?? item.sizes ?? item.ukuran) as string),
    photoUrl:
      (item.photoUrl ?? item.photo_url ?? item.image ?? item.foto)
        ? String(item.photoUrl ?? item.photo_url ?? item.image ?? item.foto).slice(0, 1000)
        : null,
    materialAvailable: Boolean(item.materialAvailable ?? item.material_available ?? item.bahan),
    fit: String(item.fit ?? '')
      .trim()
      .slice(0, 40),
    features: String(item.features ?? item.ciri ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160),
    material: String(item.material ?? item.bahan ?? '')
      .trim()
      .slice(0, 80),
    sizeGroup: String(item.sizeGroup ?? item.size_group ?? '')
      .trim()
      .slice(0, 60),
    note: String(item.note ?? item.catatan ?? '')
      .trim()
      .slice(0, 255),
    active: item.active === undefined ? true : Boolean(item.active),
  }
}

/** Ganti seluruh katalog dengan daftar baru (replace=true) atau upsert per varian. */
export async function importLeanCatalog(list: unknown[], replace = false) {
  await ensureLeanTables()
  const items = list.map(normalizeCatalogInput)
  const now = new Date()
  await db.transaction(async (trx) => {
    // Upsert per varian (bukan hapus semua) supaya ciri foto dari AI tidak hilang tiap
    // katalog berubah; ciri hanya dibuat ulang untuk foto yang benar-benar baru.
    for (const item of items) {
      const values: Record<string, unknown> = {
        product: item.product,
        color: item.color || '',
        category: item.category || '',
        price: item.price ?? null,
        sizes_ready: item.sizesReady || '',
        sizes_all: item.sizesAll || '',
        photo_url: item.photoUrl || null,
        material_available: item.materialAvailable ? 1 : 0,
        fit: item.fit || '',
        features: item.features || '',
        material: item.material || '',
        size_group: item.sizeGroup || '',
        note: item.note || '',
        active: item.active === false ? 0 : 1,
        updated_at: now,
      }
      await trx
        .table('whatsapp_beta3_catalog')
        .insert(values)
        .onConflict(['product', 'color'])
        .merge([
          'category',
          'price',
          'sizes_ready',
          'sizes_all',
          'photo_url',
          'material_available',
          'fit',
          'features',
          'material',
          'size_group',
          'note',
          'active',
          'updated_at',
        ])
    }
    if (replace) {
      const key = (product: unknown, color: unknown) =>
        `${String(product).trim().toLowerCase()}\u0000${String(color || '').trim().toLowerCase()}`
      const keep = new Set(items.map((item) => key(item.product, item.color)))
      const existing = await trx.from('whatsapp_beta3_catalog').select('id', 'product', 'color')
      const stale = existing
        .filter((row: any) => !keep.has(key(row.product, row.color)))
        .map((row: any) => row.id)
      if (stale.length) await trx.from('whatsapp_beta3_catalog').whereIn('id', stale).delete()
    }
  })
  digestCache.delete(workspaceScope().prefix)
  return items.length
}

export async function listLeanCatalog(): Promise<LeanCatalogRow[]> {
  await ensureLeanTables()
  const rows = await db
    .from('whatsapp_beta3_catalog')
    .orderBy('category', 'asc')
    .orderBy('product', 'asc')
    .orderBy('color', 'asc')
  return rows.map((row) => ({
    id: Number(row.id),
    product: String(row.product),
    color: String(row.color || ''),
    category: String(row.category || ''),
    price: row.price === null || row.price === undefined ? null : Number(row.price),
    sizesReady: String(row.sizes_ready || ''),
    sizesAll: String(row.sizes_all || ''),
    photoUrl: row.photo_url ? String(row.photo_url) : null,
    materialAvailable: Boolean(row.material_available),
    features: String(row.features || ''),
    featuresAi: String(row.features_ai || ''),
    material: String(row.material || ''),
    sizeGroup: String(row.size_group || ''),
    fit: String(row.fit || ''),
    note: String(row.note || ''),
    active: Boolean(row.active),
    updatedAt: new Date(row.updated_at).toISOString(),
  }))
}

export const rupiah = (value: number) => value.toLocaleString('id-ID')

const DEFAULT_SIZES = new Set(['S M L XL', 'S M L XL XXL 3XL', 'S M L XL XXL'])

/**
 * Teks digest yang dibaca AI. Dikelompokkan per produk + harga; warna ditulis
 * menurut keadaannya (ready / foto / tanpa foto). 328 varian ≈ 2rb token, dan
 * teksnya stabil antar giliran (ramah cache).
 */
export function renderCatalogDigest(rows: LeanCatalogRow[], now = new Date()) {
  const active = rows.filter((row) => row.active)
  if (!active.length) return 'KATALOG: belum diisi. Jangan menyebut harga/stok; tanyakan ke CS.'
  const stamp = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now)
  const lines: string[] = [
    `KATALOG (data per ${stamp} WIB; harga & stok dari sini, tidak perlu cek tool).`,
    'Legenda: ready = stok jadi (size di kurung); foto = ada foto, stok kosong; tanpa foto = belum ada foto & tidak tampil di web. Semua warna bisa dibuatkan (pre-order) kecuali bertanda "bahan belum ada". Size jas S M L XL, ada XXL-3XL bila harganya disebut; celana 29-37. Ciri model (kerah, kancing) dan seri bahan ada di kurung siku; beda seri bahan beda harga. Sebut ke pelanggan sebagai "Produk - Warna".',
  ]
  type Group = {
    category: string
    product: string
    price: number | null
    big: string
    rows: LeanCatalogRow[]
  }
  const groups = new Map<string, Group>()
  const allSizeGroups = new Set(active.map((row) => row.sizeGroup).filter(Boolean))
  for (const row of active) {
    const big = row.note.match(/XXL-3XL [\d.]+/)?.[0] || ''
    const key = [row.category, row.product, row.price ?? 'x'].join('|')
    let group = groups.get(key)
    if (!group) {
      group = { category: row.category, product: row.product, price: row.price, big, rows: [] }
      groups.set(key, group)
    }
    if (!group.big && big) group.big = big
    group.rows.push(row)
  }
  const label = (row: LeanCatalogRow, product: string) =>
    `${row.color || product}${row.materialAvailable ? '' : ' (bahan belum ada)'}`
  const ciri = (row: LeanCatalogRow) => {
    const parts = [
      row.features || row.featuresAi,
      row.material ? `bahan ${row.material}` : '',
    ].filter(Boolean)
    return parts.length ? ` [${parts.join('; ')}]` : ''
  }
  let category = ''
  for (const group of groups.values()) {
    if (group.category && group.category !== category) {
      category = group.category
      lines.push(`# ${category}`)
    }
    const sizes = [...new Set(group.rows.map((row) => row.sizesAll).filter(Boolean))]
    const sizeNote = sizes.length === 1 && !DEFAULT_SIZES.has(sizes[0]) ? `size ${sizes[0]}` : ''
    const fit = [...new Set(group.rows.map((row) => row.fit).filter(Boolean))].join('/')
    const sizeGroups = [...new Set(group.rows.map((row) => row.sizeGroup).filter(Boolean))]
    const sizeGroupNote =
      allSizeGroups.size > 1 && sizeGroups.length === 1 ? `grup ukuran ${sizeGroups[0]}` : ''
    lines.push(
      [
        group.product,
        group.price === null
          ? 'harga tanya CS'
          : rupiah(group.price) + (group.big ? ` (${group.big})` : ''),
        sizeNote,
        sizeGroupNote,
        fit,
      ]
        .filter(Boolean)
        .join(' | ')
    )
    const ready = group.rows.filter((row) => row.sizesReady)
    const photo = group.rows.filter((row) => !row.sizesReady && row.photoUrl)
    const none = group.rows.filter((row) => !row.sizesReady && !row.photoUrl)
    if (ready.length)
      lines.push(
        `  ready: ${ready.map((row) => `${label(row, group.product)} (${row.sizesReady})${row.photoUrl ? '' : ' tanpa foto'}${ciri(row)}`).join(', ')}`
      )
    if (photo.length)
      lines.push(`  foto: ${photo.map((row) => label(row, group.product) + ciri(row)).join(', ')}`)
    if (none.length)
      lines.push(
        `  tanpa foto: ${none.map((row) => label(row, group.product) + ciri(row)).join(', ')}`
      )
    const extra = [
      ...new Set(
        group.rows
          .map((row) =>
            row.note
              .replace(/XXL-3XL [\d.]+;?\s*/, '')
              .replace(/tidak tampil di web/i, '')
              .replace(/^[;\s]+|[;\s]+$/g, '')
          )
          .filter(Boolean)
      ),
    ]
    if (extra.length) lines.push(`  catatan: ${extra.join('; ')}`)
  }
  return lines.join('\n')
}

export async function catalogDigest(force = false) {
  const key = workspaceScope().prefix
  const cached = digestCache.get(key)
  if (!force && cached && Date.now() - cached.at < DIGEST_TTL_MS) return cached
  const rows = await listLeanCatalog()
  const entry = { text: renderCatalogDigest(rows), at: Date.now(), rows }
  digestCache.set(key, entry)
  return entry
}

const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Cari varian dari nama yang ditulis AI, misalnya "Tuxedo - Black" atau "tuxedo black". */
export function findCatalogVariant(rows: LeanCatalogRow[], label: string) {
  const wanted = fold(label)
  if (!wanted) return undefined
  const exact = rows.find((row) => fold(`${row.product} ${row.color}`) === wanted)
  if (exact) return exact
  const words = wanted.split(' ')
  let best: { row: LeanCatalogRow; score: number } | undefined
  for (const row of rows) {
    const haystack = fold(`${row.product} ${row.color}`)
    const hits = words.filter((word) => haystack.includes(word)).length
    const score = hits / Math.max(words.length, haystack.split(' ').length)
    if (hits === words.length && (!best || score > best.score)) best = { row, score }
  }
  return best?.row
}
