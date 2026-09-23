import {
  orionData,
  orionRows,
  unwrap,
  ShippingError,
  type OrionCall,
} from '#services/orion_shipping_contract'

/** A narrow pre-dispatch validation rejection, not a timeout or generic carrier failure.
 * Audit references must match this exact request, recipient and destination. An empty
 * AWB search alone is never proof that creation failed. Each audit ID is consumed once.
 */
export async function findRejectedWeightAttempt(
  call: OrionCall,
  references: string[],
  cart: any,
  consumed: string[]
): Promise<string | null> {
  let offset = 0
  const candidates: string[] = []
  let conflicting = false
  for (let page = 0; page < 20; page++) {
    const data = orionData(
      await call('list_orion_data', {
        resource: 'mcp_activity',
        query: 'create_awb',
        limit: 200,
        offset,
      })
    )
    const rows = orionRows(data)
    for (const row of rows) {
      if (row.tool_name !== 'create_awb') continue
      let args: any
      try {
        args =
          typeof row.arguments_json === 'string'
            ? JSON.parse(row.arguments_json)
            : row.arguments_json
      } catch {
        continue
      }
      const payload = args?.data
      if (!payload || !references.includes(String(payload.order_id || ''))) continue
      if (
        row.status !== 'failed' ||
        row.error_message !== 'Weight must be greater than zero.' ||
        row.result_json != null ||
        !row.completed_at ||
        !row.id ||
        String(payload.phone) !== String(cart.recipient?.phone) ||
        String(payload.code) !== String(cart.shipping?.destinationCode) ||
        Number(payload.weight) !== Number(cart.shipping?.weightKg)
      ) {
        conflicting = true
        continue
      }
      if (!consumed.includes(String(row.id))) candidates.push(String(row.id))
    }
    const body = unwrap(data)
    const more = data.has_more ?? body.has_more
    if (more === false || (more === undefined && rows.length < 200))
      return !conflicting && candidates.length === 1 ? candidates[0] : null
    const next = Number(data.next_offset ?? body.next_offset ?? offset + 200)
    if (!Number.isSafeInteger(next) || next <= offset)
      throw new ShippingError('ORION_LOOKUP_INCOMPLETE')
    offset = next
  }
  throw new ShippingError('ORION_LOOKUP_INCOMPLETE')
}
