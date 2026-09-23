// MCP stdio adapter or one-shot reader. Only one fixed HTTPS endpoint from a private config.
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

export async function fetchDiagnostics(config, traceId, fetcher = fetch) {
  const url = new URL(config.url)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.pathname.endsWith('/api/ops/diagnostics')
  )
    throw new Error('Invalid diagnostics endpoint')
  if (
    !/^[A-Za-z0-9_-]{43}$/.test(config.token || '') ||
    !Number.isFinite(config.expiresAt) ||
    config.expiresAt <= Date.now()
  )
    throw new Error('Diagnostics access expired or invalid')
  if (traceId !== undefined && (typeof traceId !== 'string' || !/^[a-f0-9-]{36}$/.test(traceId)))
    throw new Error('Invalid trace ID')
  if (traceId) url.searchParams.set('traceId', traceId)
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${config.token}`, accept: 'application/json' },
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Diagnostics HTTP ${response.status}`)
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('Unexpected diagnostics response')
  let bytes = 0
  const chunks = []
  for await (const chunk of response.body) {
    bytes += chunk.length
    if (bytes > 1_048_576) throw new Error('Diagnostics response too large')
    chunks.push(Buffer.from(chunk))
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (value.workspaceId !== config.workspaceId) throw new Error('Diagnostics workspace mismatch')
  return value
}

export function diagnosticsServer(config, fetcher = fetch) {
  const server = new Server(
    { name: 'whatsapp-diagnostics', version: '1.0.0' },
    { capabilities: { tools: {} } }
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'get_whatsapp_diagnostics',
        description:
          'Read current WhatsApp server/worker/database observations and sanitized recent traces, or one trace by ID. Does not restart, retry, send messages or return customer content. Stale telemetry does not establish its cause.',
        inputSchema: {
          type: 'object',
          properties: { traceId: { type: 'string', pattern: '^[a-f0-9-]{36}$' } },
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    ],
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (
      request.params.name !== 'get_whatsapp_diagnostics' ||
      Object.keys(request.params.arguments || {}).some((key) => key !== 'traceId')
    )
      return {
        isError: true,
        content: [{ type: 'text', text: 'Unsupported diagnostic operation' }],
      }
    try {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              await fetchDiagnostics(config, request.params.arguments?.traceId, fetcher)
            ),
          },
        ],
      }
    } catch {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Diagnostics unavailable. Check endpoint connectivity, deployment and access expiry; no server action was performed.',
          },
        ],
      }
    }
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const file = process.env.WHATSAPP_DIAGNOSTICS_CONFIG
    if (!file) throw new Error('Set WHATSAPP_DIAGNOSTICS_CONFIG to the private client.json path')
    const config = JSON.parse(await readFile(file, 'utf8'))
    if (process.argv.includes('--once'))
      console.log(JSON.stringify(await fetchDiagnostics(config), null, 2))
    else await diagnosticsServer(config).connect(new StdioServerTransport())
  } catch {
    console.error(
      'Diagnostics connection failed. Check private config, expiry, URL and server deployment. No credentials are printed.'
    )
    process.exitCode = 1
  }
}
