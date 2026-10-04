
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
