// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import env from '#start/env'
import { codexCommand, codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { claudeBinary, claudeOAuthEnv } from '#services/claude_oauth_service'
import { codexPerformanceArgs, claudePerformanceArgs } from '#services/ai_runtime_options'
import { observeProviderProcess } from '#services/provider_process_diagnostics'
import { recordUsage, usageFromEvent, type TokenUsage } from '#services/usage_service'
import { LEAN_OUTPUT_SCHEMA } from '#beta3/prompt'

/**
 * Pemanggil AI jalur ramping: satu proses CLI (Codex/Claude OAuth yang sama),
 * TANPA MCP, tanpa tool, satu schema kecil. Sengaja tidak memakai runAi lama.
 */
export type LeanProviderSettings = {
  aiProvider: 'chatgpt' | 'claude'
  chatgptModel: string
  chatgptSpeed: string
  chatgptReasoning: string
  codexBin: string
  claudeModel: string
  claudeSpeed: string
  claudeReasoning: string
  claudeBin: string
}

export type LeanProviderResult = {
  text: string
  usage: TokenUsage | null
  durationMs: number
  provider: 'chatgpt' | 'claude'
  model: string
}

const TIMEOUT_MS = 120_000

export async function runLeanProvider(
  settings: LeanProviderSettings,
  prompt: { system: string; user: string },
  imagePaths: string[] = [],
  phase = 'beta3-reply',
  schema: Record<string, unknown> = LEAN_OUTPUT_SCHEMA
): Promise<LeanProviderResult> {
  const provider = settings.aiProvider === 'claude' ? 'claude' : 'chatgpt'
  const model = provider === 'claude' ? settings.claudeModel : settings.chatgptModel
  const workingDirectory = await mkdtemp(join(tmpdir(), 'wa-lean-'))
  const started = Date.now()
  let usage: TokenUsage | null = null
  let status: 'completed' | 'failed' = 'failed'
  try {
    const schemaPath = join(workingDirectory, 'lean.schema.json')
    await writeFile(schemaPath, JSON.stringify(schema), { mode: 0o600 })
    const observe = (event: Record<string, any>) => {
      const next = usageFromEvent(provider, event)
      if (next)
        usage = {
          input: (usage?.input || 0) + next.input,
          output: (usage?.output || 0) + next.output,
          cached: (usage?.cached || 0) + next.cached,
          cacheWrite: (usage?.cacheWrite || 0) + next.cacheWrite,
        }
    }
    const text =
      provider === 'claude'
        ? await runClaudeLean(settings, prompt, workingDirectory, schemaPath, imagePaths, observe)
        : await runCodexLean(settings, prompt, workingDirectory, schemaPath, imagePaths, observe)
    status = 'completed'
    return { text, usage, durationMs: Date.now() - started, provider, model }
  } finally {
    await recordUsage({
      provider,
      phase,
      model,
      status,
      usage,
      durationMs: Date.now() - started,
    }).catch(() => {})
    await rm(workingDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

function collect(
  child: ReturnType<typeof spawn>,
  provider: 'chatgpt' | 'claude',
  stdin: string,
  onEvent: (event: Record<string, any>) => void,
  extract: (event: Record<string, any>) => string | undefined
) {
  return new Promise<string>((resolve, reject) => {
    let output = ''
    let errors = ''
    let finalText = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (finalText.trim()) resolve(finalText.trim())
      else reject(new Error(errors.trim() || 'AI tidak menghasilkan balasan.'))
    }
    const parseLines = () => {
      const lines = output.split('\n')
      output = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, any>
          onEvent(event)
          const text = extract(event)
          if (text) finalText = text
        } catch {
          // Baris bukan JSON (peringatan CLI) diabaikan.
        }
      }
    }
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(
        new Error(
          provider === 'claude'
            ? 'Claude terlalu lama merespons.'
            : 'ChatGPT terlalu lama merespons.'
        )
      )
    }, TIMEOUT_MS)
    observeProviderProcess(child, provider)
    child.stdout?.on('data', (chunk) => {
      output += String(chunk)
      if (output.length > 500_000) {
        child.kill('SIGKILL')
        finish(new Error('Respons AI terlalu besar.'))
        return
      }
      parseLines()
    })
    child.stderr?.on('data', (chunk) => {
      errors = `${errors}${String(chunk)}`.slice(-10_000)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      output += '\n'
      parseLines()
      if (code === 0) finish()
      else finish(new Error(errors.trim() || `AI berhenti dengan kode ${code}.`))
    })
    child.stdin?.on('error', (error) => finish(error))
    child.stdin?.end(stdin)
  })
}

async function runCodexLean(
  settings: LeanProviderSettings,
  prompt: { system: string; user: string },
  workingDirectory: string,
  schemaPath: string,
  imagePaths: string[],
  onEvent: (event: Record<string, any>) => void
) {
  const instructions = join(workingDirectory, 'instructions.md')
  await writeFile(instructions, prompt.system, { mode: 0o600 })
  const child = spawn(
    codexCommand(settings.codexBin || env.get('CODEX_BIN')),
    [
      'exec',
      '--ephemeral',
      '--ignore-user-config',
      ...codexOAuthArguments(),
      '-c',
      `model_instructions_file=${JSON.stringify(instructions)}`,
      ...(settings.chatgptModel ? ['--model', settings.chatgptModel] : []),
      ...codexPerformanceArgs(settings.chatgptReasoning, settings.chatgptSpeed),
      ...imagePaths.flatMap((path) => ['--image', path]),
      '--ignore-rules',
      '--output-schema',
      schemaPath,
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
    { env: { ...codexOAuthEnv() }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  return collect(child, 'chatgpt', prompt.user, onEvent, (event) =>
    event.type === 'item.completed' && event.item?.type === 'agent_message'
      ? String(event.item.text || '')
      : undefined
  )
}

async function runClaudeLean(
  settings: LeanProviderSettings,
  prompt: { system: string; user: string },
  workingDirectory: string,
  schemaPath: string,
  imagePaths: string[],
  onEvent: (event: Record<string, any>) => void
) {
  const executable = await claudeBinary(settings.claudeBin)
  const schema = JSON.stringify(LEAN_OUTPUT_SCHEMA)
  void schemaPath
  const user = imagePaths.length
    ? `${prompt.user}\n\nLampiran gambar pelanggan (baca dengan tool Read):\n${imagePaths.map((path, index) => `${index + 1}. ${path}`).join('\n')}`
    : prompt.user
  const reasoning = settings.claudeReasoning
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
      '--system-prompt',
      prompt.system,
      '--tools',
      imagePaths.length ? 'Read' : '',
      ...(imagePaths.length ? ['--allowedTools', 'Read'] : []),
      '--disable-slash-commands',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      ...(settings.claudeModel ? ['--model', settings.claudeModel] : []),
      ...claudePerformanceArgs(reasoning, settings.claudeSpeed),
    ],
    {
      cwd: workingDirectory,
      env: {
        ...claudeOAuthEnv(),
        CLAUDE_CODE_EFFORT_LEVEL: reasoning && reasoning !== 'auto' ? reasoning : undefined,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  return collect(child, 'claude', user, onEvent, (event) =>
    event.type === 'result'
      ? event.structured_output
        ? JSON.stringify(event.structured_output)
        : String(event.result || '')
      : undefined
  )
}
