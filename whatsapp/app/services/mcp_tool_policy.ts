import { GUIDE_READ_TOOLS } from '#services/business_guide_contract'

const MCP_READ_TOOLS: Record<string, string[]> = {
  orion: [
    'discover_orion_data',
    'list_orion_data',
    'get_orion_data',
    'search_destinations',
    'check_shipping_rates',
    'track_awb',
  ],
  store: [
    'list_stores',
    'store_overview',
    'get_product_options',
    'list_records',
    'get_record',
    ...GUIDE_READ_TOOLS,
  ],
  material: ['store_overview', 'list_records', 'get_record', ...GUIDE_READ_TOOLS],
  invoice: [
    'list_product_rules',
    'get_product_rule',
    'resolve_invoice_items',
    'list_invoices',
    'get_invoice',
    ...GUIDE_READ_TOOLS,
  ],
  fit: ['fit_advisor', 'list_records', 'get_record', ...GUIDE_READ_TOOLS],
}

export function enabledBusinessTools(connection: { slug: string; name?: string }) {
  // Shipment writes must pass through the order-scoped, durable bridge, including
  // on ordinary chat turns. Renaming the Orion connection must not bypass it.
  return /orion/i.test(`${connection.slug} ${connection.name || ''}`)
    ? MCP_READ_TOOLS.orion
    : MCP_READ_TOOLS[connection.slug]
}
