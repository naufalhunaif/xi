import { mcpShippingData, shippingEvidence } from '#services/shipping_evidence_service'
import {
  isProductListing,
  isUnfilteredProductListing,
  shapeCatalogResult,
} from '#services/catalog_digest_service'

/** Deliberate allowlist. Unknown/generic data tools, writes, stock, payment and tracking stay live. */
/** The product catalogue changes a few times a year, so the unfiltered listing behind the
 * digest is worth holding. A keyword search stays live, which keeps a newly added product
 * findable while the snapshot is still warm. */
const PRODUCT_DIGEST_TTL = 6 * 60 * 60_000
export function mcpCacheTtl(tool: string, args: Record<string, any>) {
  if (isUnfilteredProductListing(tool, args)) return PRODUCT_DIGEST_TTL
  if (
    tool === 'check_shipping_rates' &&
    typeof args.destination_code === 'string' &&
    args.destination_code.trim() &&
    Number(args.weight_kg) > 0
  )
    return 15 * 60_000
  if (tool === 'search_destinations' && typeof args.query === 'string' && args.query.trim())
    return 24 * 60 * 60_000
  if (
    tool === 'fit_advisor' &&
    typeof args.type === 'string' &&
    Number(args.height) > 0 &&
    Number(args.weight) > 0
  )
    return 24 * 60 * 60_000
  return 0
}

export function cacheableMcpResult(tool: string, args: Record<string, any>, result: any) {
  if (!result || result.isError || result.is_error) return false
  const data = mcpShippingData(result) as any
  if (!data || data.error || data.ok === false || data.success === false) return false
  // Only remember a listing that actually returned rows; an empty or odd shape stays live.
  if (isUnfilteredProductListing(tool, args))
    return shapeCatalogResult(tool, args, result).shape === 'digest'
  if (tool === 'check_shipping_rates')
    return shippingEvidence([{ tool, arguments: args, result }]).length > 0
  if (tool === 'fit_advisor')
    return (
      data.ok === true &&
      data.data &&
      Object.hasOwn(data.data, args.type === 'pants' ? 'recommended_pants_no' : 'recommended_size')
    )
  if (tool === 'search_destinations') {
    // Do not remember empty searches, textual errors or unknown response shapes.
    const rows = Array.isArray(data) ? data : (data.data ?? data.destinations ?? data.results)
    return Array.isArray(rows) && rows.length > 0
  }
  return false
}

/** Short reuse within a single read-only reply, including its fallback/provider phases. */
export function mcpTurnCacheTtl(tool: string, args: Record<string, any>) {
  if (isProductListing(tool, args)) return 60_000
  if (
    (tool === 'get_product' || (tool === 'get_record' && args.resource === 'products')) &&
    Object.keys(args).some(
      (key) =>
        key !== 'resource' && args[key] !== null && args[key] !== undefined && args[key] !== ''
    )
  )
    return 60_000
  return 0
}

export function cacheableTurnMcpResult(tool: string, args: Record<string, any>, result: any) {
  if (!mcpTurnCacheTtl(tool, args)) return false
  const data = mcpShippingData(result) as any
  if (!data || data.error || data.ok === false || data.success === false) return false
  if (isProductListing(tool, args)) {
    const rows = data.rows ?? data.products ?? data.data
    return (
      Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every((row) => row && typeof row === 'object' && (row.id || row.name) && !row.error)
    )
  }
  return !Array.isArray(data) && Boolean(data.id || data.name)
}
