import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import db from '#services/workspace_database'
import { sharedMcpToken } from '#services/shared_mcp_oauth_service'
import { mcpOAuthFetch } from '#services/mcp_oauth_fetch'
import { workspaceScope } from '#services/workspace_context'
import { ShippingError, type OrionCall } from '#services/orion_shipping_contract'

const allowed = new Set([
  'list_orion_data',
  'get_orion_data',
  'search_destinations',
  'check_shipping_rates',
  'create_awb',
  'track_awb',
])
export async function withOrion<T>(
  action: (call: OrionCall, slug: string) => Promise<T>
): Promise<T> {
  const rows = await db
    .from('whatsapp_mcp_connections')
    .where('enabled', true)
    .where((q) => q.where('slug', 'orion').orWhere('name', 'like', '%orion%'))
  if (rows.length !== 1) throw new ShippingError('ORION_CONNECTION_REQUIRED')
  const source = rows[0]
  let token: string
  try {
    token = await sharedMcpToken(source.slug, source.url)
  } catch {
    throw new ShippingError('ORION_AUTH_REQUIRED')
  }
  if (!token) throw new ShippingError('ORION_AUTH_REQUIRED')
  const client = new Client({ name: 'whatsapp-shipping', version: '1.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(source.url), {
        // OAuth's deadline is per flow; shipping has multiple sequential calls.
        // Give each HTTP request its own bounded, DNS-pinned fetch instance.
        fetch: (input, init) => mcpOAuthFetch(source.url)(input, init),
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
      { timeout: 15000 }
    )
    return await action(async (name, args) => {
      if (!allowed.has(name)) throw new ShippingError('ORION_TOOL_NOT_ALLOWED')
      const workspace = await db.from('whatsapp_workspace_state').where('id', 1).first()
      if (Number(workspace?.active_id) !== workspaceScope().id)
        throw new ShippingError('ORION_CONNECTION_REQUIRED')
      const current = await db.from('whatsapp_mcp_connections').where('id', source.id).first()
      if (!current?.enabled || current.url !== source.url)
        throw new ShippingError('ORION_CONNECTION_REQUIRED')
      try {
        return await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 })
      } catch {
        throw new ShippingError('ORION_UNAVAILABLE')
      }
    }, source.slug)
  } catch (error) {
    throw error instanceof ShippingError ? error : new ShippingError('ORION_UNAVAILABLE')
  } finally {
    await client.close().catch(() => {})
  }
}
