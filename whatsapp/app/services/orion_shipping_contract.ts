import { DateTime } from 'luxon'
import {
  mcpShippingData,
  shippingEvidence,
  matchShippingQuote,
} from '#services/shipping_evidence_service'

export class ShippingError extends Error {
  constructor(public code: string) {
    super(code)
  }
}
export type OrionCall = (name: string, args: Record<string, unknown>) => Promise<any>
export function orionData(result: any): any {
  // Preserve a known validation reason without exposing addresses or raw tool errors.
  const errorPayload = result?.structuredContent ?? result?.structured_content
  if (
    result?.isError ||
    result?.is_error ||
    errorPayload?.success === false ||
    errorPayload?.error
  ) {
    const messages = [
      errorPayload?.error,
      errorPayload?.message,
      errorPayload?.error_message,
      ...(result?.content || [])
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text),
    ]
    if (
      messages.some(
        (message: unknown) =>
          typeof message === 'string' && message.includes('Weight must be greater than zero.')
      )
    )
      throw new ShippingError('ORION_WEIGHT_REJECTED')
  }
  const value = mcpShippingData(result)
  if (
    !value ||
    typeof value !== 'object' ||
    (value as any).success === false ||
    (value as any).error
  )
    throw new ShippingError('ORION_RESPONSE_INVALID')
  const body = unwrap(value)
  if (body?.success === false || body?.status === false || body?.error)
    throw new ShippingError('ORION_RESPONSE_INVALID')
  return value
}
export function unwrap(value: any): any {
  for (let i = 0; i < 5; i++) {
    const nested =
      value?.data ??
      value?.result ??
      value?.record ??
      value?.tracking ??
      (typeof value?.awb === 'object' ? value.awb : null)
    if (!nested || typeof nested !== 'object') break
    value = nested
  }
  return value
}
export function orionRows(value: any): any[] {
  const body = unwrap(value)
  if (Array.isArray(body)) return body
  for (const key of ['records', 'items', 'rows', 'results', 'destinations', 'awbs'])
    if (Array.isArray(body?.[key])) return body[key]
  throw new ShippingError('ORION_RESPONSE_INVALID')
}
export function awbNumber(value: any): string {
  const row = unwrap(value)
  const number = String(
    row?.awb ?? row?.awb_no ?? row?.tracking_number ?? row?.cnote_no ?? ''
  ).trim()
  return /^[A-Za-z0-9-]{6,64}$/.test(number) ? number : ''
}

/** Orion's city/region field is full_address, not the customer's street text. */
export function orionDestinationAddress(destination: any): string {
  for (const value of [destination.full_address, destination.address, destination.name]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  const parts = ['subdistrict_name', 'district_name', 'city_name', 'province_name', 'zip_code']
    .map((key) => destination[key])
    .filter((value) => typeof value === 'string' && value.trim())
  return parts.length >= 3 ? parts.join(', ') : ''
}
const placeText = (value: unknown) =>
  String(value || '')
    .toLowerCase()
    .replace(/\b(?:kelurahan|kel\.?|desa|kecamatan|kec\.?|kabupaten|kab\.?|kota|provinsi)\s+/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ')

function regionText(address: string) {
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  // Road names can contain other villages; prefer the explicitly listed administrative area.
  if (parts.length > 1 && /^(?:jl\.?|jalan|gg\.?|gang)\s/i.test(parts[0])) parts.shift()
  return placeText(parts.join(' '))
}
function destinationMatches(destination: any, address: string) {
  const region = ` ${regionText(address)} `
  const places = ['subdistrict_name', 'district_name', 'city_name'].map((key) =>
    placeText(destination[key])
  )
  return places.every(Boolean) && places.every((place) => region.includes(` ${place} `))
}

/** Carrier codes may cover multiple villages. Resolve the actual region, not the first code hit. */
async function resolveOrionDestination(call: OrionCall, address: string, code: string) {
  if (code) {
    const destination = unwrap(
      orionData(await call('get_orion_data', { resource: 'destinations', id: code }))
    )
    if (String(destination.code || '').trim() !== code)
      throw new ShippingError('SHIPPING_DESTINATION_REQUIRED')
    if (
      destinationMatches(destination, address) ||
      (!destination.subdistrict_name && orionDestinationAddress(destination))
    )
      return destination
  }
  const parts = address
    .split(',')
    .map((part) => part.trim())
    .filter((part) => !/^(?:jl\.?|jalan|gg\.?|gang)\s/i.test(part))
    .map(placeText)
    .filter((part) => part.length >= 2 && !/\d/.test(part))
  const queries = [...new Set([...parts, address])].slice(0, 6)
  for (const query of queries) {
    const rows = orionRows(orionData(await call('search_destinations', { query, limit: 50 })))
    const matches = rows.filter(
      (row) =>
        row.code &&
        (!code || String(row.code) === code) &&
        destinationMatches(row, address) &&
        orionDestinationAddress(row)
    )
    const distinct = new Map(
      matches.map((row) => [
        `${row.code}|${orionDestinationAddress(row)}|${row.zip_code || ''}`,
        row,
      ])
    )
    if (distinct.size > 1) throw new ShippingError('SHIPPING_DESTINATION_REQUIRED')
    if (distinct.size === 1) return distinct.values().next().value
  }
  throw new ShippingError('SHIPPING_DESTINATION_REQUIRED')
}

/** Exact reference matching only; a fuzzy search hit is never another order's AWB. */
export async function findOrionAwb(call: OrionCall, reference: string) {
  const matches = new Map<string, any>()
  let offset = 0
  for (let page = 0; page < 20; page++) {
    const data = orionData(
      await call('list_orion_data', {
        resource: 'awbs',
        query: reference,
        limit: 200,
        offset,
      })
    )
    const rows = orionRows(data)
    for (const row of rows) {
      if (String(row.order_id ?? '') !== reference) continue
      const awb = awbNumber(row)
      if (!awb) throw new ShippingError('AWB_REFERENCE_INCOMPLETE')
      matches.set(awb, row)
    }
    const body = unwrap(data)
    const more = data.has_more ?? body.has_more
    if (more === false || (more === undefined && rows.length < 200)) {
      if (matches.size > 1) throw new ShippingError('MULTIPLE_AWBS')
      return matches.values().next().value || null
    }
    const next = Number(data.next_offset ?? body.next_offset ?? offset + 200)
    if (!Number.isSafeInteger(next) || next <= offset)
      throw new ShippingError('ORION_RESPONSE_INVALID')
    offset = next
  }
  throw new ShippingError('ORION_LOOKUP_INCOMPLETE')
}

/** Input keys come from the server's create_awb schema (2026-09-15).
 * Missing facts are not inferred from body weight, estimated dates or customer prose.
 */
export async function prepareOrionShipment(call: OrionCall, cart: any, reference: string) {
  const recipient = cart.recipient || {}
  const shipping = cart.shipping || {}
  if (!recipient.name || !recipient.address || !/^\+?[0-9]{8,16}$/.test(recipient.phone || ''))
    throw new ShippingError('SHIPPING_RECIPIENT_REQUIRED')
  const weight = Number(shipping.weightKg)
  if (!(weight > 0 && weight <= 1000)) throw new ShippingError('SHIPPING_WEIGHT_REQUIRED')
  const destination = await resolveOrionDestination(
    call,
    recipient.address,
    String(shipping.destinationCode || '').trim()
  )
  const code = String(destination.code || '').trim()
  const address = orionDestinationAddress(destination)
  const zip = String(destination.zip_code ?? destination.postal_code ?? destination.zip ?? '')
  if (!code || !address || !/^\d{5}$/.test(zip))
    throw new ShippingError('SHIPPING_DESTINATION_REQUIRED')
  const args = { destination_code: code, weight_kg: weight }
  const rates = await call('check_shipping_rates', args)
  orionData(rates)
  const quote = matchShippingQuote(
    shippingEvidence([{ tool: 'check_shipping_rates', arguments: args, result: rates }]),
    shipping.serviceCode || shipping.service,
    shipping.cost
  )
  if (!quote) throw new ShippingError('SHIPPING_RATE_CHANGED')
  const service = quote.service_code ?? quote.raw?.service_code ?? quote.code ?? quote.service
  if (!service || !cart.items?.length) throw new ShippingError('SHIPPING_DETAILS_REQUIRED')
  const goods = cart.items.map((item: any) => `${item.quantity} × ${item.name}`).join(', ')
  if (goods.length > 500) throw new ShippingError('SHIPPING_DETAILS_REQUIRED')
  return {
    order_id: reference,
    service: String(service),
    price: shipping.cost,
    name: recipient.name,
    street: recipient.address,
    address,
    phone: recipient.phone,
    zip_code: zip,
    code,
    qty: 1,
    // Rate lookup uses kilograms; Orion's AWB form / Connect bridge uses grams.
    weight: Math.max(1, Math.round(weight * 1000)),
    goodsdesc: goods,
    goodstype: 1,
    cod_flag: 'N',
    cod_amount: 0,
  }
}

function assertTrackingIdentity(value: any, expectedAwb: string) {
  // Validate identifiers before unwrapping: Orion wraps JNE history under
  // tracking.data, while the shipment number is also present on outer layers.
  let layer = value
  for (let depth = 0; layer && typeof layer === 'object' && depth < 6; depth++) {
    for (const candidate of [
      typeof layer.awb === 'string' ? layer.awb : null,
      layer.awb_no,
      layer.tracking_number,
      layer.cnote_no,
      layer.cnote?.cnote_no,
    ]) {
      if (candidate != null && String(candidate).trim() !== expectedAwb)
        throw new ShippingError('TRACKING_ID_MISMATCH')
    }
    layer =
      layer.data ??
      layer.result ??
      layer.record ??
      layer.tracking ??
      (typeof layer.awb === 'object' ? layer.awb : null)
  }
  const data = unwrap(value)
  const actual = awbNumber(data)
  if (actual && actual !== expectedAwb) throw new ShippingError('TRACKING_ID_MISMATCH')
}

/** Observed Connect/JNE not-yet-indexed response is a wait, never proof of shipping.
 * This exception applies only to track_awb, not creation/lookup or generic failures.
 */
export function orionTrackingData(result: any, expectedAwb: string) {
  const value = mcpShippingData(result) as any
  if (value && typeof value === 'object') {
    assertTrackingIdentity(value, expectedAwb)
    const tracking = value.tracking
    const data = tracking?.data
    if (
      value.awb === expectedAwb &&
      tracking?.awb === expectedAwb &&
      !value.error &&
      value.success !== false &&
      value.status !== false &&
      tracking.status === null &&
      !tracking.error &&
      tracking.success !== false &&
      data?.status === false &&
      data?.error === 'Cnote No. Not Found.' &&
      Object.keys(data).every((key) => ['error', 'status'].includes(key))
    )
      return { awb: expectedAwb, history: [], trackingState: 'awaiting_update' }
  }
  return orionData(result)
}

/** Only explicit carrier events prove movement. Booking/AWB creation never does. */
export function shipmentMovement(
  value: any,
  expectedAwb: string,
  since?: Date
): { status: string; at: string } | null {
  return shipmentEvents(value, expectedAwb, since)[0] || null
}

/** Completion requires a dated delivery event for the same AWB, not a summary label. */
export function shipmentDelivery(value: any, expectedAwb: string, since?: Date) {
  return (
    shipmentEvents(value, expectedAwb, since).findLast((event) => event.status === 'delivered') ||
    null
  )
}

function shipmentEvents(value: any, expectedAwb: string, since?: Date) {
  assertTrackingIdentity(value, expectedAwb)
  const data = unwrap(value)
  const events = data.history ?? data.events ?? data.manifest
  if (!Array.isArray(events)) throw new ShippingError('TRACKING_DETAILS_REQUIRED')
  const movements: Array<{ status: string; at: string }> = []
  for (const event of events) {
    let status = String(event.status ?? event.status_code ?? '')
      .trim()
      .toLowerCase()
      .replace(/[ -]+/g, '_')
    // Only the observed JNE pickup/receipt contracts are accepted, never a
    // generic 'on process' label or an unrecognized event code.
    if (String(data.cnote?.cnote_no || '') === expectedAwb) {
      const description = String(event.desc || '')
        .trim()
        .toUpperCase()
      const code = String(event.code || '').toUpperCase()
      if (
        ['PU0', 'S01'].includes(code) &&
        description.startsWith('SHIPMENT PICKED UP BY JNE COURIER')
      )
        status = 'picked_up'
      if (code === 'RC1' && description.startsWith('SHIPMENT RECEIVED AT')) status = 'in_transit'
      if (description.startsWith('DELIVERED TO ')) status = 'delivered'
    }
    if (
      ![
        'picked_up',
        'pickup_completed',
        'in_transit',
        'on_transit',
        'out_for_delivery',
        'delivered',
      ].includes(status)
    )
      continue
    const rawDate = event.timestamp ?? event.date ?? event.datetime ?? ''
    const date =
      typeof rawDate === 'string' && /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}$/.test(rawDate)
        ? DateTime.fromFormat(rawDate, 'dd-MM-yyyy HH:mm', { zone: 'Asia/Jakarta' }).toJSDate()
        : new Date(rawDate)
    if (
      !Number.isFinite(date.getTime()) ||
      date.getTime() > Date.now() + 60_000 ||
      (since && date < since)
    )
      continue
    movements.push({ status, at: date.toISOString() })
  }
  return movements.sort((a, b) => a.at.localeCompare(b.at))
}
