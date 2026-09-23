import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/** Metadata-only diagnostic: never refreshes tokens or invokes shipping/business tools. */
export default class InspectOrion extends BaseCommand {
  static commandName = 'orion:inspect'
  static description = 'Inspect Orion tool schemas without creating shipments or reading orders'
  static options: CommandOptions = { startApp: true }
  @flags.boolean({
    description: 'Read the AWB resource contract; never create or track a shipment',
  })
  declare shipping: boolean

  async run() {
    const { default: db } = await import('@adonisjs/lucid/services/db')
    const { inWorkspace } = await import('#services/workspace_context')
    const { readSharedMcpState } = await import('#services/shared_mcp_oauth_service')
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } =
      await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const { mcpOAuthFetch } = await import('#services/mcp_oauth_fetch')
    const state = await db.from('whatsapp_workspace_state').where('id', 1).first()
    const id = Number(state?.active_id || state?.session_id || 1)
    const workspace = await db.from('whatsapp_workspaces').where('id', id).first()
    if (!workspace) throw new Error('Workspace tidak ditemukan.')
    const prefix = workspace.legacy ? '' : `w${id}_`
    await inWorkspace({ id, prefix, phone: null, version: state?.version || '' }, async () => {
      const rows = await db
        .from(`${prefix}whatsapp_mcp_connections`)
        .where((q) => q.where('slug', 'orion').orWhere('name', 'like', '%orion%'))
      for (const row of rows) {
        const auth = readSharedMcpState(row)
        const url = new URL(row.url)
        this.logger.info(
          JSON.stringify({
            source: row.slug,
            endpoint: url.origin + url.pathname,
            enabled: Boolean(row.enabled),
            shared: Boolean(row.shared_authenticated),
            storedToken: Boolean(auth?.tokens?.access_token),
          })
        )
        const client = new Client({ name: 'whatsapp-orion-inspect', version: '1.0.0' })
        try {
          await client.connect(
            new StreamableHTTPClientTransport(url, {
              fetch: (input, init) => mcpOAuthFetch(row.url)(input, init),
              requestInit: {
                headers: auth?.tokens?.access_token
                  ? { Authorization: `Bearer ${auth.tokens.access_token}` }
                  : {},
              },
            }),
            { timeout: 15_000 }
          )
          let cursor: string | undefined
          for (let page = 0; page < 10; page++) {
            const result = await client.listTools({ cursor }, { timeout: 15_000 })
            for (const tool of result.tools)
              this.logger.info(
                JSON.stringify({
                  name: tool.name,
                  description: tool.description,
                  inputSchema: tool.inputSchema,
                  outputSchema: tool.outputSchema,
                  annotations: tool.annotations,
                })
              )
            cursor = result.nextCursor
            if (!cursor) break
          }
          if (this.shipping) {
            const contract = await client.callTool(
              { name: 'discover_orion_data', arguments: { resource: 'awbs' } },
              undefined,
              { timeout: 15000 }
            )
            this.logger.info(JSON.stringify({ awbResourceContract: contract }))
          }
        } catch {
          this.logger.error(
            'Daftar tool Orion belum dapat diakses. Hubungkan ulang sumber Orion di Pengaturan WhatsApp workspace ini.'
          )
          this.exitCode = 1
        } finally {
          await client.close().catch(() => {})
        }
      }
      if (!rows.length) {
        this.logger.error('Koneksi Orion tidak ditemukan di workspace ini.')
        this.exitCode = 1
      }
    })
  }
}
