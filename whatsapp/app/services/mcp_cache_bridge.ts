import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { mcpBusinessFetch } from '#services/mcp_oauth_fetch'
import { EvidenceCache, evidenceKey, createTurnEvidenceCache } from '#services/evidence_cache'
import {
  mcpCacheTtl,
  cacheableMcpResult,
  mcpTurnCacheTtl,
  cacheableTurnMcpResult,
} from '#services/mcp_cache_policy'
import { payloadChars, estimateTokens } from '#services/prompt_size_service'
import { shapeCatalogResult } from '#services/catalog_digest_service'
import { createCatalogPricePatternIndex } from '#services/catalog_price_pattern'
import { enabledBusinessTools } from '#services/mcp_tool_policy'
import { inWorkspace, workspaceScope } from '#services/workspace_context'
import type { TraceSink } from '#services/trace_service'

type Connection = {
  slug: string
  name?: string
  url: string
  enabled: boolean
  authenticated: boolean
}
type Upstream = Pick<Client, 'listTools' | 'callTool' | 'close'> &
  Partial<
    Pick<
      Client,
      | 'getInstructions'
      | 'getServerCapabilities'
      | 'getServerVersion'
      | 'listResources'
      | 'listResourceTemplates'
      | 'readResource'
      | 'listPrompts'
      | 'getPrompt'
    >
  >

/** Per-run loopback-only MCP bridge; original credentials never reach the local CLI config. */
export async function startMcpCacheBridge(
  connections: Connection[],
  tokens: Record<string, string>,
  onTrace?: TraceSink,
  phase = 'analysis',
  dependencies: {
    cache?: EvidenceCache
    turnCache?: EvidenceCache
    connect?: (connection: Connection, token: string) => Promise<Upstream>
    skills?: Upstream
    history?: Upstream
    business?: Upstream
    closeTimeoutMs?: number
  } = {}
) {
  const businessConnection: Connection | undefined = dependencies.business
    ? {
        slug: 'business_data',
        name: 'Deferred business reads',
        url: 'local://business-data',
        enabled: true,
        authenticated: true,
      }
    : undefined
  const historyConnection: Connection | undefined = dependencies.history
    ? {
        slug: 'conversation_history',
        name: 'Conversation history',
        url: 'local://conversation-history',
        enabled: true,
        authenticated: true,
      }
    : undefined
  const skillConnection: Connection | undefined = dependencies.skills
    ? {
        slug: 'skill_library',
        name: 'Business skill library',
        url: 'local://skill-library',
        enabled: true,
        authenticated: true,
      }
    : undefined
  // Reserved local capability cannot be overridden by a saved business source.
  connections = connections.filter(
    (row) =>
      ![
        'conversation_history',
        'skill_library',
        ...(businessConnection ? ['business_data'] : []),
      ].includes(row.slug)
  )
  if (historyConnection) connections = [...connections, historyConnection]
  if (skillConnection) connections = [...connections, skillConnection]
  if (businessConnection) connections = [...connections, businessConnection]
  const active = connections.filter((row) => row.enabled && row.authenticated)
  if (!active.length) return { connections, tokens, close: async () => {} }
  const scope = workspaceScope()
  const cache = dependencies.cache || new EvidenceCache()
  const turnCache = dependencies.turnCache || createTurnEvidenceCache()
  const localTokens: Record<string, string> = {}
  const remotes = new Map<string, Promise<Upstream>>()
  const toolSchemas = new Map<string, unknown>()
  const pricePatterns = createCatalogPricePatternIndex()
  const connect =
    dependencies.connect ||
    (async (connection, token) => {
      const client = new Client({ name: 'whatsapp-evidence-cache', version: '1.0.0' })
      try {
        await client.connect(
          new StreamableHTTPClientTransport(new URL(connection.url), {
            fetch: (input, init) => mcpBusinessFetch(connection.url)(input, init),
            requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
          }),
          { timeout: 15_000 }
        )
        return client
      } catch (error) {
        await client.close().catch(() => {})
        throw error
      }
    })
  const upstream = (connection: Connection) => {
    let pending = remotes.get(connection.slug)
    if (!pending) {
      pending =
        connection === businessConnection
          ? Promise.resolve(dependencies.business!)
          : connection === historyConnection
            ? Promise.resolve(dependencies.history!)
            : connection === skillConnection
              ? Promise.resolve(dependencies.skills!)
              : connect(connection, tokens[connection.slug] || '')
      remotes.set(connection.slug, pending)
      pending.catch(() => remotes.delete(connection.slug))
    }
    return pending
  }
  const routes = new Map<string, Connection>(
    active.map((connection) => {
      localTokens[connection.slug] = randomBytes(32).toString('hex')
      return [`/mcp/${randomBytes(24).toString('hex')}`, connection] as const
    })
  )
  let sequence = 0
  const sessions = new Set<Server>()
  const server = createServer((req, res) => {
    void inWorkspace(scope, async () => {
      const connection = routes.get(req.url || '')
      const auth = Buffer.from(req.headers.authorization || '')
      const expected = Buffer.from(`Bearer ${connection ? localTokens[connection.slug] : ''}`)
      if (
        !connection ||
        req.headers.origin ||
        req.headers.host !== host ||
        auth.length !== expected.length ||
        !timingSafeEqual(auth, expected)
      ) {
        res.writeHead(403).end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let protocol: Server | undefined
      try {
        let size = 0
        const chunks: Buffer[] = []
        for await (const chunk of req) {
          size += chunk.length
          if (size > 1_048_576) {
            res.writeHead(413).end()
            return
          }
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const remote = await upstream(connection)
        const capabilities = remote.getServerCapabilities?.()
        protocol = new Server(
          remote.getServerVersion?.() || { name: `business_${connection.slug}`, version: '1.0.0' },
          {
            capabilities: {
              tools: {},
              ...(capabilities?.resources ? { resources: {} } : {}),
              ...(capabilities?.prompts ? { prompts: {} } : {}),
            },
            instructions: remote.getInstructions?.(),
          }
        )
        sessions.add(protocol)
        // Preserve read-only resource/prompt capabilities. These are always live.
        if (capabilities?.resources) {
          protocol.setRequestHandler(ListResourcesRequestSchema, (request) =>
            remote.listResources!(request.params)
          )
          protocol.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
            remote.listResourceTemplates!(request.params)
          )
          protocol.setRequestHandler(ReadResourceRequestSchema, (request) =>
            remote.readResource!(request.params)
          )
        }
        if (capabilities?.prompts) {
          protocol.setRequestHandler(ListPromptsRequestSchema, (request) =>
            remote.listPrompts!(request.params)
          )
          protocol.setRequestHandler(GetPromptRequestSchema, (request) =>
            remote.getPrompt!(request.params)
          )
        }
        protocol.setRequestHandler(ListToolsRequestSchema, async (request) => {
          const discovery = await turnCache.readThrough({
            key: [
              'mcp-tools-v1',
              connection.slug,
              connection.url,
              evidenceKey(tokens[connection.slug] || ''),
              remote.getServerVersion?.(),
              remote.getInstructions?.(),
              request.params,
            ],
            ttl: connection === historyConnection || connection === skillConnection ? 0 : 60_000,
            fetch: () => remote.listTools(request.params),
            valid: (value) =>
              Array.isArray(value?.tools) && value.tools.length > 0 && !value.isError,
          })
          const listed = discovery.value as Awaited<ReturnType<Upstream['listTools']>>
          const enabled = enabledBusinessTools(connection)
          // Tools render at the head of the prompt, so any reordering upstream invalidates
          // the whole cached prefix. Sorting by name keeps the bytes stable between runs.
          const result = {
            ...listed,
            tools: listed.tools
              .filter((tool) => !enabled || enabled.includes(tool.name))
              .sort((a, b) => a.name.localeCompare(b.name)),
          }
          for (const tool of result.tools) toolSchemas.set(`${connection.slug}:${tool.name}`, tool)
          const chars = payloadChars(result.tools)
          onTrace?.({
            key: `${phase}:mcp-tools:${connection.slug}`,
            label: 'Skema tool MCP dikirim ke AI',
            status: 'completed',
            detail: {
              server: `business_${connection.slug}`,
              tools: result.tools.length,
              toolsBefore: listed.tools.length,
              savedTokens: estimateTokens(payloadChars(listed.tools) - chars),
              chars,
              estimatedTokens: estimateTokens(chars),
              cache: { ...discovery.report, scope: 'reply' },
              note: 'Dikirim ulang pada setiap langkah tool dalam satu panggilan.',
            },
          })
          return result
        })
        protocol.setRequestHandler(CallToolRequestSchema, async (request) => {
          const name = request.params.name
          const enabled = enabledBusinessTools(connection)
          if (enabled && !enabled.includes(name))
            return {
              isError: true,
              content: [{ type: 'text', text: 'Tool tidak tersedia untuk tugas ini.' }],
            }
          const args = request.params.arguments || {}
          const schema = toolSchemas.get(`${connection.slug}:${name}`) as any
          const readOnly =
            schema &&
            schema.annotations?.readOnlyHint !== false &&
            schema.annotations?.destructiveHint !== true
          const persistentTtl = readOnly ? mcpCacheTtl(name, args) : 0
          const turnTtl = readOnly && !persistentTtl ? mcpTurnCacheTtl(name, args) : 0
          const ttl = persistentTtl || turnTtl
          const key = `${phase}:mcp-cache:${++sequence}`
          onTrace?.({
            key,
            label: 'Memeriksa cache MCP',
            status: 'running',
            detail: { server: `business_${connection.slug}`, tool: name, arguments: args },
          })
          try {
            const result = await (turnTtl ? turnCache : cache).readThrough({
              // Schema, endpoint, OAuth identity and every argument participate in invalidation.
              key: [
                'mcp-v1',
                connection.slug,
                connection.url,
                evidenceKey(tokens[connection.slug] || ''),
                schema,
                remote.getServerVersion?.(),
                remote.getInstructions?.(),
                name,
                args,
              ],
              ttl,
              fetch: () =>
                upstream(connection).then((client) =>
                  client.callTool(request.params, undefined, { timeout: 30_000 })
                ),
              valid: (value) =>
                turnTtl
                  ? cacheableTurnMcpResult(name, args, value)
                  : cacheableMcpResult(name, args, value),
            })
            // A catalog listing is a finding aid; only get_product results carry evidence,
            // so shaping this cannot weaken a cart, price, stock or image check.
            const shaped = shapeCatalogResult(name, args, result.value)
            const pattern = pricePatterns(
              connection.slug,
              name,
              result.value,
              result.report.storedAt
            )
            // Add app-derived advisory separately. Original MCP fields and receipt stay intact.
            const delivered =
              pattern && Array.isArray((shaped.result as any)?.content)
                ? {
                    ...(shaped.result as any),
                    content: [
                      ...(shaped.result as any).content,
                      {
                        type: 'text',
                        text: JSON.stringify({ appInternalPricePattern: pattern }),
                      },
                    ],
                  }
                : shaped.result
            onTrace?.({
              key,
              label:
                result.report.source === 'cache' ? 'Hasil MCP dari cache' : 'Hasil MCP langsung',
              status: 'completed',
              detail: {
                server: `business_${connection.slug}`,
                tool: name,
                arguments: args,
                ...(shaped.shape === 'unchanged'
                  ? {}
                  : {
                      shaped: shaped.shape,
                      rows: shaped.rows,
                      charsBefore: shaped.before,
                      savedTokens: estimateTokens(Math.max(0, shaped.before - shaped.after)),
                    }),
                chars: payloadChars(delivered),
                estimatedTokens: estimateTokens(payloadChars(delivered)),
                ...(pattern ? { pricePattern: pattern } : {}),
                cache: {
                  ...result.report,
                  scope: turnTtl ? 'reply' : persistentTtl ? 'workspace' : 'none',
                  ...(result.report.storedAt
                    ? {
                        storedAt: new Date(result.report.storedAt).toISOString(),
                        ageSeconds: Math.max(
                          0,
                          Math.floor((Date.now() - result.report.storedAt) / 1000)
                        ),
                      }
                    : {}),
                  ...(result.report.expiresAt
                    ? { expiresAt: new Date(result.report.expiresAt).toISOString() }
                    : {}),
                },
              },
            })
            return delivered as typeof result.value
          } catch (error) {
            onTrace?.({
              key,
              label: 'Hasil MCP langsung',
              status: 'failed',
              detail: {
                server: `business_${connection.slug}`,
                tool: name,
                arguments: args,
                cache: { source: 'mcp', status: 'error', staleUsed: false },
              },
            })
            throw error
          }
        })
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        })
        const current = protocol
        res.on('close', () => {
          sessions.delete(current)
          void current.close().catch(() => {})
        })
        await protocol.connect(transport)
        await transport.handleRequest(req, res, body)
      } catch {
        if (!res.headersSent)
          res.writeHead(502, { 'content-type': 'application/json' }).end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: 'MCP bridge unavailable' },
            })
          )
        else res.end()
        if (protocol) {
          sessions.delete(protocol)
          await protocol.close().catch(() => {})
        }
      }
    })
  })
  server.requestTimeout = 45_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('MCP bridge address unavailable')
  const host = `127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  return {
    connections: connections.map((connection) => {
      const path = [...routes].find(([, row]) => row === connection)?.[0]
      return path ? { ...connection, url: `http://${host}${path}` } : connection
    }),
    tokens: localTokens,
    close() {
      if (closing) return closing
      closing = (async () => {
        // Stop accepting local requests before awaiting remote SDK cleanup. A stalled
        // connect/close must not hide the provider's terminal result indefinitely.
        const stopped = new Promise<void>((resolve) => server.close(() => resolve()))
        server.closeAllConnections()
        const tasks = [
          stopped,
          ...[...sessions].map((session) => Promise.resolve().then(() => session.close())),
          ...[...remotes.values()].map(async (pending) => {
            const client = await pending
            await client.close()
          }),
        ]
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeoutMs = dependencies.closeTimeoutMs ?? 5_000
        try {
          const settled = await Promise.race([
            Promise.allSettled(tasks).then(() => true),
            new Promise<false>((resolve) => {
              timer = setTimeout(() => resolve(false), timeoutMs)
            }),
          ])
          if (!settled)
            onTrace?.({
              key: `${phase}:mcp-cleanup`,
              label: 'Penutupan koneksi MCP melewati batas waktu',
              status: 'failed',
              detail: {
                code: 'MCP_CLEANUP_TIMEOUT',
                timeoutMs,
                note: 'Koneksi lokal ditutup. Hasil atau kegagalan AI tetap dicatat; tidak menjalankan ulang AI.',
              },
            })
        } finally {
          clearTimeout(timer)
        }
      })()
      return closing
    },
  }
}
