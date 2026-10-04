import { createHash } from 'node:crypto'
import { type IntentIndex } from '#services/conversation_levels'
import {
  selectModelProfile,
  reducedOutputNeedsPrimary,
  ADAPTIVE_REASONING_INSTRUCTIONS,
  type AdaptiveRoute,
} from '#services/adaptive_model_policy'
import { observeProviderProcess } from '#services/provider_process_diagnostics'
import { type EvidenceCache } from '#services/evidence_cache'
import { type SkillRoutingPlan, type RoutingContext } from '#services/skill_routing_service'
import { enabledBusinessTools } from '#services/mcp_tool_policy'
import {
  AiLoopGuard,
  phaseAllowsHistory,
  claudeTaskArgs,
  TASK_SYSTEM_PROMPT,
} from '#services/ai_cost_policy'
import { spawn } from 'node:child_process'
import { codexPerformanceArgs, claudePerformanceArgs } from '#services/ai_runtime_options'
import { startMcpCacheBridge } from '#services/mcp_cache_bridge'
import {
  SKILL_EDIT_SCHEMA,
  SKILL_EDIT_INSTRUCTIONS,
  type EditableSkill,
} from '#services/skill_edit_contract'
import { sharedMcpToken } from '#services/shared_mcp_oauth_service'
import {
  aiFailureDetail,
  AiProcessFailure,
  updateProviderFailure,
  traceAiOperation,
  type AiFailureDetail,
} from '#services/ai_failure_service'
import {
  mcpTokenVariable,
  mcpTokenEnvironment,
  claudeMcpConnection,
} from '#services/mcp_runtime_auth'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import env from '#start/env'
import { claudeBinary, claudeOAuthEnv } from '#services/claude_oauth_service'
import { codexOAuthArguments, codexOAuthEnv, codexCommand } from '#services/workspace_oauth'
import logger from '@adonisjs/core/services/logger'
import { type ProductionPolicy } from '#services/production_contract'
import { type PaymentMethod } from '#services/payment_context_service'
import { recordUsage, usageFromEvent, type TokenUsage } from '#services/usage_service'
import { claudeQuotaWindows, type QuotaWindow } from '#services/ai_quota_contract'
import { quotaState, saveQuotaWindows } from '#services/ai_quota_store'
import {
  planProviderRun,
  runWithProviderFailover,
  settingsForProvider,
} from '#services/ai_provider_failover'
import { traceProviderEvents, type TraceSink } from '#services/trace_service'
import { promptBreakdown } from '#services/prompt_size_service'
import { type CompactSkillPlan } from '#services/compact_reply_policy'
import { startDeferredMcpBridge } from '#services/deferred_business_tools'

import { conversationHistoryTools, type ConversationAccess } from '#services/conversation_memory'

type AiSettings = {
  levelPrompt?: string
  fullLevelContext?: boolean
  levelIndices?: IntentIndex[]
  adaptiveRoute?: AdaptiveRoute
  modelSelection?: ReturnType<typeof selectModelProfile> & { reason: string }
  turnMcpCache?: EvidenceCache
  replySkills?: Array<{ name: string; content: string }>
  routingContext?: RoutingContext
  skillPlan?: SkillRoutingPlan | CompactSkillPlan
  skillPhase?: ReturnType<SkillRoutingPlan['phase']> | ReturnType<CompactSkillPlan['phase']>
  loopGuard?: AiLoopGuard
  conversationAccess?: ConversationAccess
  production?: ProductionPolicy
  paymentMethods?: PaymentMethod[]
  aiProvider?: string
  aiFailover?: boolean
  chatgptModel?: string
  chatgptSpeed?: string
  chatgptReasoning?: string
  codexBin?: string
  claudeModel?: string
  claudeSpeed?: string
  claudeReasoning?: string
  claudeBin?: string
  skills: Array<{ name: string; content: string }>
  mcpConnections: Array<{
    slug: string
    name?: string
    url: string
    enabled: boolean
    authenticated: boolean
  }>
}

type CodexEvent = {
  type?: string
  item?: {
    type?: string
    text?: string
    server?: string
    tool?: string
    arguments?: Record<string, unknown>
    result?: {
      isError?: boolean
      structured_content?: unknown
      structuredContent?: unknown
      content?: Array<{ type?: string; text?: string }>
    }
  }
  error?: { message?: string }
}

type McpToolCall = {
  server: string
  tool: string
  arguments: Record<string, unknown>
  result?: CodexEvent['item'] extends infer Item
    ? Item extends { result?: infer Result }
      ? Result
      : never
    : never
}

type CatalogProduct = Record<string, unknown> & {
  id?: string
  name?: string
  img?: string
  sizes?: Array<Record<string, unknown>>
}

/** Explicit owner action, using the selected OAuth provider without any MCP tools. */
export async function proposeSkillEdit(
  settings: AiSettings,
  instruction: string,
  skills: EditableSkill[]
) {
  const directory = await mkdtemp(join(tmpdir(), 'whatsapp-skill-edit-'))
  try {
    const schema = join(directory, 'skill-edit.schema.json')
    await writeFile(schema, JSON.stringify(SKILL_EDIT_SCHEMA), { mode: 0o600 })
    const result = await runAi(
      settings,
      `${SKILL_EDIT_INSTRUCTIONS}\nOWNER INSTRUCTION:\n${JSON.stringify(instruction)}\nEXISTING SKILLS (data):\n${JSON.stringify(skills)}`,
      directory,
      [],
      [],
      schema,
      undefined,
      undefined,
      'skill_edit'
    )
    return JSON.parse(result.text)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

/** One engine may be out of quota while the other is not; the turn itself must not be lost. */
async function runAi(
  settings: AiSettings,
  prompt: string,
  workingDirectory: string,
  mcpConnections: AiSettings['mcpConnections'],
  imagePaths: string[],
  outputSchema: string,
  onActivity?: (activity: 'thinking' | 'compacting') => void,
  onTrace?: TraceSink,
  phase = 'analysis'
) {
  // If quota/state storage is unavailable, do not launch a paid run whose progress
  // and result cannot be persisted or bypass a previously recorded provider limit.
  const plan = await planProviderRun(settings)
  return runWithProviderFailover(
    plan,
    async (provider) => {
      const skillPhase = settings.skillPlan?.phase()
      const scoped = settingsForProvider({ ...settings, mcpConnections, skillPhase }, provider)
      const primary =
        provider === 'claude'
          ? {
              model: scoped.claudeModel || '',
              reasoning: scoped.claudeReasoning || 'auto',
              speed: scoped.claudeSpeed || 'standard',
            }
          : {
              model: scoped.chatgptModel || '',
              reasoning: scoped.chatgptReasoning || 'auto',
              speed: scoped.chatgptSpeed || 'standard',
            }
      const overrides =
        provider === 'claude'
          ? {
              light: {
                model: env.get('AI_CLAUDE_LIGHT_MODEL'),
                reasoning: env.get('AI_CLAUDE_LIGHT_REASONING'),
              },
              standard: {
                model: env.get('AI_CLAUDE_STANDARD_MODEL'),
                reasoning: env.get('AI_CLAUDE_STANDARD_REASONING'),
              },
            }
          : {
              light: {
                model: env.get('AI_CHATGPT_LIGHT_MODEL'),
                reasoning: env.get('AI_CHATGPT_LIGHT_REASONING'),
              },
              standard: {
                model: env.get('AI_CHATGPT_STANDARD_MODEL'),
                reasoning: env.get('AI_CHATGPT_STANDARD_REASONING'),
              },
            }
      const profile = selectModelProfile(
        provider,
        scoped.adaptiveRoute,
        primary,
        overrides,
        imagePaths.length > 0 || !['analysis', 'index-analysis'].includes(phase)
      )
      const invoke = async (selected: typeof profile, key: string, reason: string) => {
        const effective = {
          ...scoped,
          ...(provider === 'claude'
            ? {
                claudeModel: selected.model,
                claudeReasoning: selected.reasoning,
                claudeSpeed: selected.speed,
              }
            : {
                chatgptModel: selected.model,
                chatgptReasoning: selected.reasoning,
                chatgptSpeed: selected.speed,
              }),
          modelSelection: { ...selected, reason },
        }
        onTrace?.({
          key: `${key}:model-selection`,
          label: `Profil ${selected.tier} · ${selected.model || 'default'}`,
          status: 'completed',
          detail: { provider, modelSelection: effective.modelSelection },
        })
        return runAiOnce(
          effective,
          scoped.adaptiveRoute?.enabled &&
            phase !== 'index-analysis' &&
            !phase.startsWith('visual-observation')
            ? `${ADAPTIVE_REASONING_INSTRUCTIONS}\n\n${prompt}`
            : prompt,
          workingDirectory,
          effective.mcpConnections,
          imagePaths,
          outputSchema,
          onActivity,
          onTrace,
          key
        )
      }
      const promote = (deep = false) => {
        // Latch the rest of this reply to the primary profile, including later validation phases.
        if (settings.adaptiveRoute) {
          settings.adaptiveRoute.tier = 'complex'
          settings.adaptiveRoute.reason = deep
            ? 'promoted_to_primary'
            : 'reduced_profile_requires_primary'
        }
        return selectModelProfile(provider, scoped.adaptiveRoute, primary, overrides, true)
      }
      let result: Awaited<ReturnType<typeof runAiOnce>>
      try {
        result = await invoke(profile, phase, scoped.adaptiveRoute?.reason || 'primary_default')
      } catch (error) {
        // One recovery for an unsupported/rejected reduced profile. Quota/network failures
        // continue through the existing provider backoff/failover, never a model retry loop.
        if (
          profile.tier === 'complex' ||
          !(error instanceof AiProcessFailure) ||
          !['AI_OUTPUT_INVALID', 'AI_PROCESS_FAILED'].includes(error.detail.code)
        )
          throw error
        result = await invoke(promote(), `${phase}:primary:${phase}`, 'reduced_profile_failed')
        skillPhase?.assertCovered(result.text)
        return result
      }
      if (
        profile.tier === 'standard' &&
        (reducedOutputNeedsPrimary(result.text) ||
          result.toolCalls.some((call) => !['list_products', 'get_product'].includes(call.tool)))
      ) {
        let deep = false
        try {
          deep = JSON.parse(result.text)?.requiresDeepReasoning === true
        } catch {}
        result = await invoke(promote(deep), `${phase}:primary:${phase}`, 'output_requires_primary')
      }
      skillPhase?.assertCovered(result.text)
      return result
    },
    (error) => (error instanceof AiProcessFailure ? error.detail.code : ''),
    (event) =>
      onTrace?.({
        key: `${phase}:failover`,
        label:
          event.type === 'switch'
            ? `Kuota ${event.configured} habis · memakai ${event.provider}`
            : event.type === 'recovered'
              ? `Giliran dilayani mesin cadangan · ${event.provider}`
              : `${event.provider} menolak (${event.code}) · mencoba ${event.next}`,
        status: event.type === 'switch' ? 'running' : 'completed',
        detail: { stage: 'provider', configured: plan.configured, limits: plan.limits, ...event },
      })
  )
}

async function runAiOnce(
  settings: AiSettings,
  prompt: string,
  workingDirectory: string,
  mcpConnections: AiSettings['mcpConnections'],
  imagePaths: string[],
  outputSchema: string,
  onActivity?: (activity: 'thinking' | 'compacting') => void,
  onTrace?: TraceSink,
  phase = 'analysis'
) {
  const provider = settings.aiProvider === 'claude' ? 'claude' : 'chatgpt'
  const started = Date.now()
  const quotaGeneration =
    provider === 'claude'
      ? await quotaState('claude')
          .then((row) => row.generation as string)
          .catch(() => null)
      : null
  const quotaWindows = new Map<string, QuotaWindow>()
  let usage: TokenUsage | null = null
  let status: 'completed' | 'failed' = 'failed'
  let schemaDiagnostic: Record<string, unknown> = {}
  let failure: AiFailureDetail | undefined
  let terminalFailure: AiFailureDetail | undefined
  let cacheBridge:
    | Awaited<ReturnType<typeof startMcpCacheBridge>>
    | Awaited<ReturnType<typeof startDeferredMcpBridge>>
    | undefined
  const traceEvents = onTrace ? traceProviderEvents(onTrace, phase) : undefined
  const label = phase.startsWith('visual-observation')
    ? 'Mengamati detail gambar · tanpa data transaksi'
    : phase === 'index-analysis'
      ? 'Memahami pesan pada level index · tanpa MCP bisnis'
      : phase === 'comparison'
        ? imagePaths.length
          ? 'Membandingkan gambar pelanggan dan kandidat'
          : 'Menyusun balasan dari bukti visual'
        : phase === 'cart-notes-repair'
          ? 'Memperbaiki penulisan catatan desain · tanpa MCP'
          : 'Menganalisis input dan data bisnis'
  onTrace?.({ key: phase, label, status: 'running' })
  const loopGuard = settings.loopGuard || new AiLoopGuard()
  const countTool = loopGuard.observer(provider)
  const observe = (event: Record<string, any>) => {
    if (provider === 'claude')
      for (const window of claudeQuotaWindows(event)) quotaWindows.set(window.key, window)
    terminalFailure = updateProviderFailure(terminalFailure, provider, event)
    traceEvents?.(provider, event)
    const next = usageFromEvent(provider, event)
    if (next)
      usage = {
        input: (usage?.input || 0) + next.input,
        output: (usage?.output || 0) + next.output,
        cached: (usage?.cached || 0) + next.cached,
        cacheWrite: (usage?.cacheWrite || 0) + next.cacheWrite,
      }
    return countTool(event)
  }
  try {
    const schemaText = await readFile(outputSchema, 'utf8')
    const schema = JSON.parse(schemaText)
    const phaseInput = promptBreakdown([
      ['task', prompt],
      ['schema', schemaText],
      ['system', TASK_SYSTEM_PROMPT],
    ])
    schemaDiagnostic = {
      inputProfile: {
        estimatedTextTokens: phaseInput.tokens,
        images: imagePaths.length,
        includesImageTokens: false,
        businessSources: mcpConnections.filter((item) => item.enabled && item.authenticated).length,
      },
      diagnosticsVersion: 3,
      schemaFingerprint: createHash('sha256').update(schemaText).digest('hex').slice(0, 16),
      routingFieldRequired:
        Array.isArray(schema.required) && schema.required.includes('needsFullSkillContext'),
      workerPid: process.pid,
    }
    const mcpTokens: Record<string, string> = {}
    for (const connection of mcpConnections.filter((item) => item.enabled && item.authenticated)) {
      const token = await traceAiOperation(
        onTrace,
        `${phase}:mcp-auth:${connection.slug}`,
        `Memeriksa akses MCP · ${connection.slug}`,
        { stage: 'mcp_auth', source: connection.slug, provider },
        () => sharedMcpToken(connection.slug, connection.url)
      )
      if (token) mcpTokens[connection.slug] = token
    }
    const bridge =
      settings.skillPlan && 'compact' in settings.skillPlan
        ? startDeferredMcpBridge
        : startMcpCacheBridge
    cacheBridge = await bridge(mcpConnections, mcpTokens, onTrace, phase, {
      turnCache: settings.turnMcpCache,
      skills: settings.skillPhase?.tools,
      history:
        phaseAllowsHistory(phase) &&
        settings.conversationAccess &&
        settings.conversationAccess.anchorId > 0
          ? conversationHistoryTools(settings.conversationAccess)
          : undefined,
    })
    const result =
      provider === 'claude'
        ? await runClaude(
            prompt,
            workingDirectory,
            cacheBridge.connections,
            imagePaths,
            outputSchema,
            onActivity,
            settings.claudeBin,
            settings.claudeModel,
            settings.claudeSpeed,
            settings.claudeReasoning,
            observe,
            cacheBridge.tokens
          )
        : await runCodex(
            prompt,
            workingDirectory,
            cacheBridge.connections,
            imagePaths,
            outputSchema,
            onActivity,
            settings.codexBin,
            settings.chatgptModel,
            settings.chatgptSpeed,
            settings.chatgptReasoning,
            observe,
            cacheBridge.tokens
          )
    if (terminalFailure) throw new AiProcessFailure(terminalFailure)
    status = 'completed'
    return cacheBridge &&
      'canonicalCalls' in cacheBridge &&
      Array.isArray(cacheBridge.canonicalCalls)
      ? {
          ...result,
          toolCalls: [
            ...result.toolCalls.filter((call) => call.server !== 'business_business_data'),
            ...cacheBridge.canonicalCalls,
          ],
        }
      : result
  } catch (error) {
    failure = terminalFailure || aiFailureDetail(error, { stage: 'provider', provider })
    throw new AiProcessFailure(failure)
  } finally {
    await cacheBridge?.close()
    if (quotaGeneration && quotaWindows.size)
      await saveQuotaWindows('claude', quotaGeneration, [...quotaWindows.values()]).catch(() =>
        logger.warn('Pencatatan kuota AI gagal.')
      )
    const durationMs = Date.now() - started
    onTrace?.({
      key: phase,
      label,
      status,
      detail: {
        ...(failure || { provider }),
        ...schemaDiagnostic,
        modelSelection: settings.modelSelection,
        ...(usage ? { usage: usage as TokenUsage } : {}),
        toolCallsInTask: loopGuard.calls,
        identicalToolResultLimit: loopGuard.maximumIdentical,
        durationMs,
      },
    })
    await recordUsage({
      provider,
      phase,
      model: provider === 'claude' ? settings.claudeModel : settings.chatgptModel,
      usage,
      status,
      durationMs,
    }).catch(() => logger.warn('Pencatatan usage AI gagal.'))
  }
}

function toolResultValue(call: McpToolCall) {
  if (call.result?.structured_content) return call.result.structured_content
  const text = call.result?.content?.find((item) => item.type === 'text')?.text
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function extractCatalogProducts(calls: McpToolCall[]) {
  const products = new Map<string, CatalogProduct>()
  for (const call of calls) {
    if (call.tool !== 'get_product') continue
    const value = toolResultValue(call)
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const product = value as CatalogProduct
    const key = String(product.id || product.name || '')
    if (key && product.img)
      products.set(`${call.server}:${key}`, { ...product, sourceServer: call.server })
  }
  return [...products.values()]
}

async function runCodex(
  prompt: string,
  workingDirectory: string,
  mcpConnections: AiSettings['mcpConnections'],
  imagePaths: string[],
  outputSchema: string,
  onActivity?: (activity: 'thinking' | 'compacting') => void,
  codexBin?: string,
  model?: string,
  speed?: string,
  reasoning?: string,
  onEvent?: (event: Record<string, any>) => boolean | void,
  mcpTokens: Record<string, string> = {}
) {
  // Replace the coding persona, not the business skills/context in the user prompt.
  // Use a private file inside this run's directory, removed by the caller's finally.
  const instructions = join(workingDirectory, 'task-instructions.md')
  await writeFile(instructions, TASK_SYSTEM_PROMPT, { mode: 0o600 })
  return new Promise<{ text: string; toolCalls: McpToolCall[] }>((resolve, reject) => {
    onActivity?.('thinking')
    const mcpArguments = mcpConnections
      .filter((connection) => connection.enabled && connection.authenticated)
      .flatMap((connection) => {
        const name = `business_${connection.slug}`
        const enabledTools = enabledBusinessTools(connection)
        return [
          '-c',
          `mcp_servers.${name}.url=${JSON.stringify(connection.url)}`,
          ...(mcpTokens[connection.slug]
            ? [
                '-c',
                `mcp_servers.${name}.bearer_token_env_var=${JSON.stringify(mcpTokenVariable(connection.slug))}`,
              ]
            : []),
          '-c',
          `mcp_servers.${name}.enabled=true`,
          '-c',
          `mcp_servers.${name}.required=false`,
          ...(enabledTools
            ? ['-c', `mcp_servers.${name}.enabled_tools=${JSON.stringify(enabledTools)}`]
            : []),
          '-c',
          `mcp_servers.${name}.default_tools_approval_mode="writes"`,
        ]
      })
    const child = spawn(
      codexCommand(codexBin || env.get('CODEX_BIN')),
      [
        'exec',
        '--ephemeral',
        '--ignore-user-config',
        ...codexOAuthArguments(),
        '-c',
        `model_instructions_file=${JSON.stringify(instructions)}`,
        ...(model ? ['--model', model] : []),
        ...codexPerformanceArgs(reasoning, speed),
        ...mcpArguments,
        ...imagePaths.flatMap((path) => ['--image', path]),
        '--ignore-rules',
        '--output-schema',
        outputSchema,
        '--disable',
        'shell_tool',
        '--disable',
        'apps',
        '--disable',
        'browser_use',
        '--disable',
        'computer_use',
        '--disable',
        'image_generation',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        '--color',
        'never',
        '--json',
        '-C',
        workingDirectory,
        '-',
      ],
      {
        env: { ...codexOAuthEnv(), ...mcpTokenEnvironment(mcpTokens) },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    observeProviderProcess(child, 'chatgpt')
    let output = ''
    let errors = ''
    let finalText = ''
    const toolCalls: McpToolCall[] = []
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (finalText.trim()) resolve({ text: finalText.trim(), toolCalls })
      else reject(new Error(errors.trim() || 'ChatGPT tidak menghasilkan balasan.'))
    }
    const parseLines = () => {
      const lines = output.split('\n')
      output = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as CodexEvent
          if (onEvent?.(event) === false) {
            child.kill('SIGKILL')
            finish(
              new AiProcessFailure({
                stage: 'provider',
                code: 'AI_TOOL_LOOP',
                message:
                  'Proses AI dihentikan karena tool yang sama berulang dengan hasil identik.',
                action: 'Periksa jejak tool dan persempit pencarian sebelum mencoba kembali.',
                retryable: false,
              })
            )
            return
          }
          if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
            finalText = String(event.item.text || '')
          }
          if (
            event.type === 'item.completed' &&
            event.item?.type === 'mcp_tool_call' &&
            event.item.server &&
            event.item.tool
          ) {
            toolCalls.push({
              server: event.item.server,
              tool: event.item.tool,
              arguments: event.item.arguments || {},
              result: event.item.result,
            })
          }
          if (event.type?.includes('compact')) onActivity?.('compacting')
        } catch {
          // Codex may emit a warning before its JSONL stream.
        }
      }
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('ChatGPT terlalu lama merespons.'))
    }, 180_000)

    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 1_000_000) {
        child.kill('SIGKILL')
        finish(new Error('Respons ChatGPT terlalu besar.'))
        return
      }
      parseLines()
    })
    child.stderr.on('data', (chunk) => {
      errors = `${errors}${String(chunk)}`.slice(-10_000)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      output += '\n'
      parseLines()
      if (code === 0) finish()
      else finish(new Error(errors.trim() || `Codex berhenti dengan kode ${code}.`))
    })
    child.stdin.on('error', (error) => finish(error))
    child.stdin.end(prompt)
  })
}

type ClaudeEvent = {
  type?: string
  result?: string
  structured_output?: unknown
  message?: {
    content?: Array<{
      type?: string
      id?: string
      name?: string
      input?: Record<string, unknown>
      tool_use_id?: string
      is_error?: boolean
      content?: string | Array<{ type?: string; text?: string }>
    }>
  }
}

async function runClaude(
  prompt: string,
  workingDirectory: string,
  mcpConnections: AiSettings['mcpConnections'],
  imagePaths: string[],
  outputSchema: string,
  onActivity?: (activity: 'thinking' | 'compacting') => void,
  binOverride?: string,
  model?: string,
  speed?: string,
  reasoning?: string,
  onEvent?: (event: Record<string, any>) => boolean | void,
  mcpTokens: Record<string, string> = {}
) {
  const activeConnections = mcpConnections.filter(
    (connection) => connection.enabled && connection.authenticated
  )
  const mcpConfig = join(workingDirectory, 'mcp.json')
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcpServers: Object.fromEntries(
        activeConnections.map((connection) => [
          `business_${connection.slug}`,
          claudeMcpConnection(connection.url, connection.slug, Boolean(mcpTokens[connection.slug])),
        ])
      ),
    }),
    { mode: 0o600 }
  )
  const schema = await readFile(outputSchema, 'utf8')
  const mediaPrompt = imagePaths.length
    ? `${prompt}\n\nBaca dan analisis lampiran media berikut dengan tool Read:\n${imagePaths
        .map((path, index) => `${index + 1}. ${path}`)
        .join('\n')}`
    : prompt
  const executable = await claudeBinary(binOverride)

  return new Promise<{ text: string; toolCalls: McpToolCall[] }>((resolve, reject) => {
    onActivity?.('thinking')
    const allowedTools = [
      ...(imagePaths.length ? ['Read'] : []),
      ...activeConnections.flatMap((connection) => {
        const enabledTools = enabledBusinessTools(connection)
        return enabledTools
          ? enabledTools.map((tool) => `mcp__business_${connection.slug}__${tool}`)
          : [`mcp__business_${connection.slug}`]
      }),
    ]
    const child = spawn(
      executable,
      [
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--json-schema',
        schema,
        '--no-session-persistence',
        '--permission-mode',
        'dontAsk',
        ...claudeTaskArgs(imagePaths.length > 0),
        ...(allowedTools.length ? ['--allowedTools', allowedTools.join(',')] : []),
        '--mcp-config',
        mcpConfig,
        '--strict-mcp-config',
        ...(model ? ['--model', model] : []),
        ...claudePerformanceArgs(reasoning, speed),
      ],
      {
        cwd: workingDirectory,
        env: {
          ...claudeOAuthEnv(),
          ...mcpTokenEnvironment(mcpTokens),
          // Do not let the service's inherited effort override the workspace setting.
          CLAUDE_CODE_EFFORT_LEVEL: reasoning && reasoning !== 'auto' ? reasoning : undefined,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    )

    let output = ''
    let errors = ''
    let finalText = ''
    let settled = false
    const toolCalls: McpToolCall[] = []
    observeProviderProcess(child, 'claude')
    const pendingTools = new Map<string, McpToolCall>()
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (finalText.trim()) resolve({ text: finalText.trim(), toolCalls })
      else reject(new Error(errors.trim() || 'Claude tidak menghasilkan balasan.'))
    }
    const parseLines = () => {
      const lines = output.split('\n')
      output = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as ClaudeEvent
          if (onEvent?.(event) === false) {
            child.kill('SIGKILL')
            finish(
              new AiProcessFailure({
                stage: 'provider',
                code: 'AI_TOOL_LOOP',
                message:
                  'Proses AI dihentikan karena tool yang sama berulang dengan hasil identik.',
                action: 'Periksa jejak tool dan persempit pencarian sebelum mencoba kembali.',
                retryable: false,
              })
            )
            return
          }
          if (event.type?.includes('compact')) onActivity?.('compacting')
          for (const block of event.message?.content || []) {
            if (block.type === 'tool_use' && block.id && block.name?.startsWith('mcp__')) {
              const [, server = '', ...toolParts] = block.name.split('__')
              const call: McpToolCall = {
                server,
                tool: toolParts.join('__'),
                arguments: block.input || {},
              }
              pendingTools.set(block.id, call)
              toolCalls.push(call)
            }
            if (block.type === 'tool_result' && block.tool_use_id) {
              const call = pendingTools.get(block.tool_use_id)
              if (call) {
                const contents = Array.isArray(block.content)
                  ? block.content
                  : [{ type: 'text', text: String(block.content || '') }]
                call.result = { content: contents, ...(block.is_error ? { isError: true } : {}) }
              }
            }
          }
          if (event.type === 'result') {
            finalText = event.structured_output
              ? JSON.stringify(event.structured_output)
              : String(event.result || '')
          }
        } catch {
          // Claude mengirim aliran JSONL; abaikan baris diagnostik non-JSON.
        }
      }
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('Claude terlalu lama merespons.'))
    }, 180_000)

    child.stdout.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 1_000_000) {
        child.kill('SIGKILL')
        finish(new Error('Respons Claude terlalu besar.'))
        return
      }
      parseLines()
    })
    child.stderr.on('data', (chunk) => {
      errors = `${errors}${String(chunk)}`.slice(-10_000)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      output += '\n'
      parseLines()
      if (code === 0) finish()
      else finish(new Error(errors.trim() || `Claude berhenti dengan kode ${code}.`))
    })
    child.stdin.on('error', (error) => finish(error))
    child.stdin.end(mediaPrompt)
  })
}
