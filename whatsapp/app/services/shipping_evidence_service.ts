import { legacyMeasurementFingerprint, productionFingerprint } from '#services/order_item_details'

type Row = Record<string, any>
type ToolCall = { server?: string; tool: string; arguments?: Row; result?: any }

export function mcpShippingData(result: any): unknown {
  if (result?.isError || result?.is_error) return null
  const structured = result?.structured_content ?? result?.structuredContent
  if (structured) return structured
  for (const part of result?.content || []) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue
    // Some business MCPs wrap JSON in a short "Data:" explanation.
    const text = part.text.trim().replace(/^.*?\n\s*Data:\s*\n?/s, '')
    try {
      return JSON.parse(text)
    } catch {}
  }
  return null
}

export function shippingEvidence(calls: ToolCall[]) {
  const rows: Row[] = []
  for (const call of calls) {
    if (!/shipping|ongkir|tariff|rate|cost/i.test(call.tool)) continue
    const data = mcpShippingData(call.result) as Row | null
    if (!data) continue
    const weight = Number(call.arguments?.weight_kg ?? data.weight_kg)
    const quote = {
      server: call.server || '',
      tool: call.tool,
      destinationCode: String(call.arguments?.destination_code ?? data.destination_code ?? ''),
      weightKg: Number.isFinite(weight) && weight > 0 ? weight : null,
    }
    function walk(value: any, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 8) return
      if (!Array.isArray(value) && shippingAliases(value).length && shippingCost(value) !== null)
        rows.push({ ...value, quote })
      for (const child of Object.values(value)) walk(child, depth + 1)
    }
    walk(data)
  }
  return rows
}

function normalized(value: unknown) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : ''
}
function shippingAliases(row: Row) {
  return [
    row.service,
    row.code,
    row.name,
    row.service_code,
    row.service_display,
    row.raw?.service_code,
    row.raw?.service_display,
  ]
    .map(normalized)
    .filter(Boolean)
}
function shippingCost(row: Row) {
  const value = row.cost ?? row.price ?? row.tariff ?? row.value
  if (value === null || value === undefined || value === '') return null
  const cost = Number(value)
  return Number.isSafeInteger(cost) && cost >= 0 ? cost : null
}

export type ShippingCartState = {
  items: Row[]
  recipient: { address: string }
  shipping: { service: string; cost: number | null }
}

/** Keeping a saved quote is not a new quote. Share this rule with cart persistence. */
export function requiresShippingQuote(next: ShippingCartState, previous?: ShippingCartState) {
  if (next.shipping.cost === null) return false
  if (!previous) return true
  // A malformed model draft cannot claim an unchanged package.
  if (
    !Array.isArray(next.items) ||
    !next.recipient ||
    typeof next.recipient.address !== 'string' ||
    !Number.isSafeInteger(next.shipping.cost) ||
    next.shipping.cost < 0 ||
    !next.shipping.service
  )
    return true
  try {
    return (
      next.shipping.cost !== previous.shipping.cost ||
      next.shipping.service !== previous.shipping.service ||
      shippingContentsChanged(previous, next)
    )
  } catch {
    return true
  }
}

/** Match only aliases actually provided by the same quote, never guess a service code. */
export function matchShippingQuote(rows: Row[], service: string, cost: number) {
  const name = normalized(service)
  if (!name || !Number.isSafeInteger(cost) || cost < 0) return undefined
  return rows.findLast((row) => shippingAliases(row).includes(name) && shippingCost(row) === cost)
}

/** Quantity, product composition and destination changes require a fresh shipping lookup. */
export function shippingContentsChanged(
  previous: { items: Row[]; recipient: { address: string } },
  next: { items: Row[]; recipient: { address: string } }
) {
  const signature = (items: Row[], retained: Row[] = []) =>
    JSON.stringify(
      items
        .map((item) => {
          // Match saveCart's retention rule before comparing a partial AI sync.
          const old =
            item.id &&
            retained.find((row) => row.id === item.id && row.productId === item.productId)
          const details = productionFingerprint(item.productionDetails ?? old?.productionDetails)
          if (details) {
            // Sources/pending are bookkeeping, and a color-only correction does
            // not change package weight. Physical design/size changes may do so.
            delete (details as Partial<typeof details>).pending
            delete (details as Partial<typeof details>).color
          }
          const measurements = Array.isArray(item.measurements)
            ? Object.fromEntries(item.measurements.map((row: Row) => [row.name, row.value]))
            : item.measurements || {}
          return [
            item.productId,
            item.name,
            item.modelType || 'catalog',
            item.referenceMessageId || '',
            item.size,
            item.requestedSize || '',
            item.quantity,
            item.note || '',
            legacyMeasurementFingerprint(measurements),
            details,
          ]
        })
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    )
  return (
    normalized(previous.recipient.address) !== normalized(next.recipient.address) ||
    signature(previous.items) !== signature(next.items, previous.items)
  )
}
