// Beta 3 — salinan terisolasi Beta 2. Tabel whatsapp_beta3_*, state & skill sendiri.
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import env from '#start/env'
import { codexCommand, codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { claudeBinary, claudeOAuthEnv } from '#services/claude_oauth_service'
import { codexPerformanceArgs, claudePerformanceArgs } from '#services/ai_runtime_options'
import { observeProviderProcess } from '#services/provider_process_diagnostics'
import { recordUsage, usageFromEvent, type TokenUsage } from '#services/usage_service'
import { LEAN_OUTPUT_SCHEMA } from '#beta3/prompt'
import { withAiAccount } from '#services/ai_account_context'
import {
  aiAccountRef,
  markAiAccountLimited,
  markAiAccountUsed,
  nextAiRecovery,
  recordAiEvent,
  usableAiAccounts,
  type AiProviderName,
} from '#services/ai_accounts'
import { AiProcessFailure, aiFailureDetail } from '#services/ai_failure_service'

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
  provider: AiProviderName
  model: string
}

const TIMEOUT_MS = 120_000
// Alias selalu menunjuk Flash terbaru (model 2.5 kini tertutup untuk API key baru).
export const GEMINI_DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'
/** Cadangan saat model Gemini pilihan sedang penuh (dicoba berurutan, akun sama). */
const GEMINI_FALLBACK_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-flash-latest']

/** Kegagalan yang berarti akun ini tidak bisa melayani sekarang → coba akun berikutnya. */
const SWITCHABLE = new Set(['USAGE_LIMIT', 'ACCESS_DENIED', 'AI_AUTH_REQUIRED'])
/** Kegagalan yang akan terulang di akun mana pun (isi/skema) → tidak perlu pindah akun. */
const STOP_CODES = new Set(['AI_CONTEXT_LIMIT', 'AI_SCHEMA_INVALID', 'DATABASE_UNAVAILABLE'])

/**
 * Banyak akun AI: dicoba sesuai urutan di Pengaturan → AI. Akun yang habis kuota
 * atau perlu login dijeda sementara, lalu otomatis dipakai lagi setelah pulih.
 */
export async function runLeanProvider(
  settings: LeanProviderSettings,
  prompt: { system: string; user: string },
  imagePaths: string[] = [],
  phase = 'beta3-reply',
  schema: Record<string, unknown> = LEAN_OUTPUT_SCHEMA,
  meta: { jid?: string } = {}
): Promise<LeanProviderResult> {
  const jid = meta.jid || ''
  const accounts = await usableAiAccounts(Date.now(), phase).catch(() => null)
  if (!accounts) return runLeanOnce(settings, settings.aiProvider, {}, prompt, imagePaths, phase, schema)
  if (!accounts.length) {
    const recovery = await nextAiRecovery().catch(() => 0)
    throw new AiProcessFailure({
      stage: 'provider',
      code: 'USAGE_LIMIT',
      message: recovery
        ? `Semua akun AI sedang jeda sampai ${new Date(recovery).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit' })}.`
        : 'Belum ada akun AI yang aktif.',
      action: 'Tambah atau aktifkan akun di Pengaturan → AI.',
      retryable: true,
    })
  }
  let lastError: unknown
  for (const account of accounts) {
    await recordAiEvent(account.id, 'start', phase, '', null, jid).catch(() => {})
    try {
      const result = await withAiAccount(aiAccountRef(account), () =>
        runLeanOnce(
          settings,
          account.provider,
          { model: account.model, apiKey: account.apiKey },
          prompt,
          imagePaths,
          phase,
          schema
        )
      )
      await markAiAccountUsed(account.id).catch(() => {})
      const tokens = result.usage ? result.usage.input + result.usage.output : null
      await recordAiEvent(account.id, 'ok', phase, '', tokens, jid).catch(() => {})
      return result
    } catch (error) {
      const detail = aiFailureDetail(error, {
        stage: 'provider',
        provider: account.provider === 'claude' ? 'claude' : 'chatgpt',
      })
      lastError = error
      const reason = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
      await recordAiEvent(
        account.id,
        SWITCHABLE.has(detail.code) ? 'limited' : 'fail',
        phase,
        `${detail.code}: ${reason}`,
        null,
        jid
      ).catch(() => {})
      if (STOP_CODES.has(detail.code)) throw error
      // Kuota habis / perlu login → akun dijeda. Gangguan lain → cukup coba akun berikutnya.
      // Kuota/login → jeda lama; gangguan lain → jeda singkat agar tidak dicoba tiap pesan.
      await markAiAccountLimited(
        account.id,
        SWITCHABLE.has(detail.code) ? detail.code : 'AI_PROCESS_FAILED',
        SWITCHABLE.has(detail.code) ? `${detail.message} ${reason}` : reason
      ).catch(() => {})
    }
  }
  throw lastError
}

/** Tes satu akun dengan permintaan kecil; hasil/alasan gagal ditampilkan di Pengaturan. */
export async function testAiAccount(
  settings: LeanProviderSettings,
  account: { id: number; provider: AiProviderName; model?: string; apiKey?: string; legacy?: boolean }
) {
  const schema = {
    type: 'object',
    additionalProperties: false,
    properties: { jawab: { type: 'string' } },
    required: ['jawab'],
  }
  const started = Date.now()
  try {
    const result = await withAiAccount(
      account.legacy ? null : { id: account.id, provider: account.provider },
      () =>
        runLeanOnce(
          settings,
          account.provider,
          { model: account.model, apiKey: account.apiKey },
          { system: 'Balas HANYA JSON sesuai skema.', user: 'Tes koneksi. Isi "jawab" dengan kata: siap' },
          [],
          'test',
          schema
        )
    )
    return { ok: true, ms: Date.now() - started, model: result.model, text: result.text.slice(0, 120) }
  } catch (error) {
    const detail = aiFailureDetail(error, {
      stage: 'provider',
      provider: account.provider === 'claude' ? 'claude' : 'chatgpt',
    })
    return {
      ok: false,
      ms: Date.now() - started,
      code: detail.code,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    }
  }
}

async function runLeanOnce(
  settings: LeanProviderSettings,
  providerName: AiProviderName,
  account: { model?: string; apiKey?: string },
  prompt: { system: string; user: string },
  imagePaths: string[],
  phase: string,
  schema: Record<string, unknown>
): Promise<LeanProviderResult> {
  const provider: AiProviderName =
    providerName === 'claude' ? 'claude' : providerName === 'gemini' ? 'gemini' : 'chatgpt'
  const model =
    account.model ||
    (provider === 'claude'
      ? settings.claudeModel
      : provider === 'gemini'
        ? GEMINI_DEFAULT_MODEL
        : settings.chatgptModel)
  const tuned =
    provider === 'claude'
      ? { ...settings, claudeModel: model }
      : provider === 'chatgpt'
        ? { ...settings, chatgptModel: model }
        : settings
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
        ? await runClaudeLean(tuned, prompt, workingDirectory, schema, imagePaths, observe)
        : provider === 'gemini'
          ? await runGeminiLean(model, account.apiKey || '', prompt, schema, imagePaths, observe)
          : await runCodexLean(tuned, prompt, workingDirectory, schemaPath, imagePaths, observe)
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

/** Teks error dari event Codex (`error`, `turn.failed`) atau Claude (`result` is_error, pesan API). */
function eventFailure(event: Record<string, any>) {
  if (event.type === 'error') return String(event.message || event.error?.message || 'error')
  if (event.type === 'turn.failed') return String(event.error?.message || 'turn failed')
  if (event.type === 'result' && (event.is_error || String(event.subtype || '').startsWith('error')))
    return String(event.result || event.error || event.subtype || 'error')
  if (event.type === 'assistant' && event.error) {
    const text = (event.message?.content || []).map((part: any) => part?.text || '').join(' ')
    return `${event.error}: ${text}`.trim()
  }
  return ''
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
    // Pesan error dari event JSON (kuota habis, belum login) — sering tidak ada di stderr.
    let eventError = ''
    let finalText = ''
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else if (finalText.trim()) resolve(finalText.trim())
      else reject(new Error(eventError || errors.trim() || 'AI tidak menghasilkan balasan.'))
    }
    const parseLines = () => {
      const lines = output.split('\n')
      output = lines.pop() || ''
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as Record<string, any>
          onEvent(event)
          const failure = eventFailure(event)
          if (failure) eventError = failure.slice(0, 600)
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
      // Satu baris bisa besar (hasil tool Read berisi gambar base64), jadi batasnya longgar.
      if (output.length > 40_000_000) {
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
      if (code === 0 && !(eventError && !finalText.trim())) finish()
      else finish(new Error(eventError || errors.trim() || `AI berhenti dengan kode ${code}.`))
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
  outputSchema: Record<string, unknown>,
  imagePaths: string[],
  onEvent: (event: Record<string, any>) => void
) {
  const executable = await claudeBinary(settings.claudeBin)
  // Skema sesuai pemanggil (balasan, rekap, dll.), bukan selalu skema balasan.
  const schema = JSON.stringify(outputSchema)
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

/** Gemini lewat API key (Google AI Studio). Satu panggilan HTTP, keluaran JSON. */
async function runGeminiLean(
  model: string,
  apiKey: string,
  prompt: { system: string; user: string },
  schema: Record<string, unknown>,
  imagePaths: string[],
  onEvent: (event: Record<string, any>) => void
) {
  if (!apiKey) throw new AiProcessFailure({
    stage: 'provider',
    code: 'AI_AUTH_REQUIRED',
    message: 'API key Gemini belum diisi.',
    action: 'Isi API key di Pengaturan → AI.',
    retryable: false,
  })
  const images: Array<Record<string, unknown>> = []
  for (const path of imagePaths.slice(0, 4)) {
    const data = await readFile(path).catch(() => null)
    if (!data) continue
    const mime = /\.png$/i.test(path) ? 'image/png' : /\.webp$/i.test(path) ? 'image/webp' : 'image/jpeg'
    images.push({ inline_data: { mime_type: mime, data: data.toString('base64') } })
  }
  const call = async (withSchema: boolean, useModel = model) => {
    const body = {
      system_instruction: {
        parts: [
          {
            text: withSchema
              ? prompt.system
              : `${prompt.system}\n\nBalas HANYA dengan satu objek JSON sesuai skema berikut:\n${JSON.stringify(schema)}`,
          },
        ],
      },
      contents: [{ role: 'user', parts: [{ text: prompt.user }, ...images] }],
      generationConfig: {
        responseMimeType: 'application/json',
        // Suhu rendah: gaya lebih stabil dan mirip model lain.
        temperature: 0.3,
        ...(withSchema ? { responseJsonSchema: schema } : {}),
      },
    }
    let response: Response
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }
      )
    } catch (error) {
      const cause = (error as any)?.cause?.code || (error as any)?.cause?.message || ''
      throw new Error(
        `Gemini: server Google tidak bisa dihubungi (${cause || (error instanceof Error ? error.message : String(error))}).`
      )
    }
    const data = (await response.json().catch(() => ({}))) as any
    return { response, data }
  }
  let withSchema = true
  let { response, data } = await call(true)
  // Versi API/model lama belum mendukung skema JSON → ulangi dengan skema di instruksi.
  if (response.status === 400 && /schema|responseJsonSchema/i.test(JSON.stringify(data?.error || ''))) {
    withSchema = false
    ;({ response, data } = await call(false))
  }
  // Model sedang penuh ("high demand"/503) → coba model Gemini lain yang lebih ringan dulu.
  const busy = () =>
    response.status === 503 ||
    /high demand|overloaded|UNAVAILABLE|try again later/i.test(JSON.stringify(data?.error || ''))
  for (const fallback of GEMINI_FALLBACK_MODELS) {
    if (!busy() || fallback === model) continue
    ;({ response, data } = await call(withSchema, fallback))
  }
  if (!response.ok) {
    const message = String(data?.error?.message || `HTTP ${response.status}`).slice(0, 300)
    if (response.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message))
      throw new Error(`Gemini: usage limit — ${message}`)
    if (
      response.status === 401 ||
      response.status === 403 ||
      /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(JSON.stringify(data?.error || ''))
    )
      throw new AiProcessFailure({
        stage: 'provider',
        code: 'AI_AUTH_REQUIRED',
        message: 'API key Gemini ditolak.',
        action: 'Periksa API key di Pengaturan → AI.',
        retryable: false,
      })
    throw new Error(`Gemini: ${message}`)
  }
  const meta = data?.usageMetadata || {}
  onEvent({
    type: 'gemini.usage',
    usage: {
      input: Number(meta.promptTokenCount || 0),
      output: Number(meta.candidatesTokenCount || 0) + Number(meta.thoughtsTokenCount || 0),
      cached: Number(meta.cachedContentTokenCount || 0),
    },
  })
  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map((part: any) => String(part?.text || ''))
    .join('')
    .trim()
  if (!text) throw new Error('Gemini tidak menghasilkan balasan.')
  return text
}
