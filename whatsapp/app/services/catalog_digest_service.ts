/** Shapes bulky catalog listings before they enter the model's context.
 *
 * Listing results are a finding aid, never transaction evidence: `extractCatalogProducts`
 * and `prepareCatalogImages` both read `get_product` results only, so nothing here can
 * weaken a cart, price, stock or image check. Price and stock are deliberately left out
 * of the digest so a stale line can never be quoted as a fact.
 */
import { GUIDE_READ_TOOLS } from '#services/business_guide_contract'
import { catalogColorSearchHints } from '#services/color_semantics'

export type ShapedResult = {
  result: unknown
  shape: 'digest' | 'trimmed' | 'unchanged'
  before: number
  after: number
  rows: number
}

// URL fields only. The model cannot see pixels from a string, and no listing result is
// read by the app, so dropping these from a list costs nothing and saves the most bytes.
const MEDIA_FIELDS = ['image_urls', 'images', 'image_url', 'img', 'thumbnail', 'thumbnail_url']
const LISTING_TOOLS = ['list_records', 'list_products']
/** Every tool whose result the app itself parses. Data spread over many MCP servers means
 * shaping cannot be decided by tool name alone, so anything that carries evidence is named
 * here and never touched: catalog products, business guides (their url IS read), shipping
 * rates, fit results and conversation history. */
const EVIDENCE_TOOLS = new Set([
  'get_product',
  'check_shipping_rates',
  'fit_advisor',
  'read_conversation_history',
  ...GUIDE_READ_TOOLS,
])
const FILTER_ARGS = ['q', 'query', 'search']
const ROW_KEYS = ['rows', 'products', 'data']
/** Catalogue changes are rare, so the digest is a cached snapshot. The note has to say so:
 * a model that treats a stale list as exhaustive would answer "tidak ada" for a new product. */
const DIGEST_NOTE =
  'Ringkasan identitas untuk menemukan produk, diambil dari snapshot katalog yang di-cache. Harga, ukuran, stok dan foto TIDAK ada di sini: ambil get_record pada produk yang dipilih. Jika produk yang dicari pelanggan tidak ada dalam daftar ini, JANGAN menyimpulkan produknya tidak ada: panggil list_records dengan argumen q untuk mencari data terkini.'
const TRIM_NOTE =
  'Tautan foto dihilangkan dari daftar; ambil get_record pada produk yang dipilih untuk fotonya.'

const text = (value: unknown) => (typeof value === 'string' ? value : '')
const size = (value: unknown) => {
  try {
    return typeof value === 'string' ? value.length : (JSON.stringify(value)?.length ?? 0)
  } catch {
    return 0
  }
}

export function isProductListing(tool: string, args: Record<string, any>) {
  if (!LISTING_TOOLS.includes(tool)) return false
  // list_records serves many resources; only the product one is a catalogue scan.
  const resource = String(args?.resource || '').trim()
  return tool === 'list_products' ? true : resource === 'products'
}
/** A keyword search is already narrow; only an unfiltered scan is replaced by the digest. */
export function isUnfilteredProductListing(tool: string, args: Record<string, any>) {
  return (
    isProductListing(tool, args) && !FILTER_ARGS.some((key) => String(args?.[key] ?? '').trim())
  )
}

/** Only a list that actually looks like products is reshaped; anything else passes through. */
function productRows(data: Record<string, any>) {
  for (const key of ROW_KEYS) {
    const rows = data[key]
    if (!Array.isArray(rows) || !rows.length) continue
    if (rows.every((row) => row && typeof row === 'object' && ('id' in row || 'name' in row)))
      return { key, rows: rows as Array<Record<string, any>> }
  }
  return null
}

function digestLine(row: Record<string, any>) {
  const name = text(row.name).trim()
  const publicName = text(row.public_name).trim()
  const label = publicName && publicName !== name ? `${name} (${publicName})` : name
  return [String(row.id ?? '').trim(), label, text(row.category).trim() || '-']
    .filter((part, index) => index < 2 || part)
    .join(' | ')
}

function shapeValue(tool: string, args: Record<string, any>, value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (EVIDENCE_TOOLS.has(tool)) return null
  const data = value as Record<string, any>
  const found = productRows(data)
  if (!found) return null
  const { key: rowKey, rows } = found
  if (isUnfilteredProductListing(tool, args)) {
    return {
      shape: 'digest' as const,
      rows: rows.length,
      value: {
        store_id: data.store_id,
        total: data.total ?? rows.length,
        ...(data.next_cursor !== undefined ? { next_cursor: data.next_cursor } : {}),
        ...(data.has_more !== undefined ? { has_more: data.has_more } : {}),
        format: 'id | nama | kategori',
        note: DIGEST_NOTE,
        colorSearchIndex: catalogColorSearchHints(
          rows.flatMap((row) => [text(row.name), text(row.public_name)])
        ),
        products: rows.map((row) => digestLine(row)),
      },
    }
  }
  if (!rows.some((row) => MEDIA_FIELDS.some((field) => field in row))) return null
  return {
    shape: 'trimmed' as const,
    rows: rows.length,
    value: {
      ...data,
      note: TRIM_NOTE,
      [rowKey]: rows.map((row) => {
        const copy = { ...row }
        for (const field of MEDIA_FIELDS) delete copy[field]
        return copy
      }),
    },
  }
}

/** Anything unexpected passes through untouched: a smaller prompt is never worth
 * handing the model a result shape it did not ask for. */
export function shapeCatalogResult(
  tool: string,
  args: Record<string, any>,
  result: unknown
): ShapedResult {
  const unchanged = (value: unknown): ShapedResult => ({
    result: value,
    shape: 'unchanged',
    before: size(value),
    after: size(value),
    rows: 0,
  })
  if (!result || typeof result !== 'object' || Array.isArray(result)) return unchanged(result)
  const envelope = result as Record<string, any>
  if (envelope.isError === true || envelope.is_error === true) return unchanged(result)
  const content = envelope.content
  if (!Array.isArray(content)) return unchanged(result)
  const index = content.findIndex((item) => item?.type === 'text' && typeof item.text === 'string')
  if (index < 0) return unchanged(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(content[index].text)
  } catch {
    return unchanged(result)
  }
  const shaped = shapeValue(tool, args, parsed)
  if (!shaped) return unchanged(result)
  const next = {
    ...envelope,
    content: content.map((item, position) =>
      position === index ? { ...item, text: JSON.stringify(shaped.value) } : item
    ),
    ...(envelope.structuredContent !== undefined ? { structuredContent: shaped.value } : {}),
    ...(envelope.structured_content !== undefined ? { structured_content: shaped.value } : {}),
  }
  return {
    result: next,
    shape: shaped.shape,
    before: size(result),
    after: size(next),
    rows: shaped.rows,
  }
}
