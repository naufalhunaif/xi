import type { TraceSink } from '#services/trace_service'
import { CartSelectionIncompleteError } from '#services/cart_selection_recovery'

export type FailureContext = {
  stage: 'mcp_auth' | 'provider' | 'processing'
  provider?: 'chatgpt' | 'claude'
  source?: string
}
export type AiFailureDetail = FailureContext & {
  code: string
  message: string
  action: string
  retryable: boolean
}

/** Only allowlisted diagnostics cross the UI/log boundary. No raw CLI/OAuth output. */
export class AiProcessFailure extends Error {
  constructor(public detail: AiFailureDetail) {
    super(detail.message)
    this.name = 'AiProcessFailure'
  }
}

export function aiFailureDetail(error: unknown, context: FailureContext): AiFailureDetail {
  if (error instanceof AiProcessFailure) return { ...error.detail }
  const text = (error instanceof Error ? error.message : String(error)).slice(0, 20_000)
  const source =
    context.source && /^[a-z0-9][a-z0-9-]{0,63}$/.test(context.source) ? context.source : undefined
  const detail = (code: string, message: string, action: string, retryable = false) => ({
    stage: context.stage,
    ...(context.provider ? { provider: context.provider } : {}),
    ...(source ? { source } : {}),
    code,
    message,
    action,
    retryable,
  })
  if (
    error instanceof CartSelectionIncompleteError ||
    (context.stage === 'processing' && text === 'Size belum valid.')
  )
    return detail(
      'CART_SELECTION_INCOMPLETE',
      'Pilihan ukuran belum lengkap; cart belum diubah.',
      'Periksa konteks pilihan dan kelanjutan percakapan; jangan mengarang ukuran atau mengulang sync yang sama.'
    )
  if (
    context.stage === 'processing' &&
    /Foto referensi model khusus belum tersedia di room ini\./.test(text)
  )
    return detail(
      'CART_REFERENCE_UNAVAILABLE',
      'Referensi foto untuk model custom belum terverifikasi di room ini.',
      'Periksa message_id media pelanggan pada cart; ukuran custom untuk produk katalog tetap memakai model katalog.'
    )
  if (/ENOENT|command not found|no such file/i.test(text))
    return detail(
      'AI_PROCESS_MISSING',
      'Program AI tidak ditemukan oleh worker.',
      'Periksa PATH dan lokasi program AI pada worker.'
    )
  if (/^(?:ChatGPT|Claude) terlalu lama merespons\.$/.test(text))
    return detail(
      'AI_TIMEOUT',
      'Proses AI dihentikan setelah melewati batas waktu 180 detik.',
      'Periksa ukuran prompt, status layanan AI, dan log worker sebelum mencoba kembali.'
    )
  if (/EACCES|EPERM|permission denied/i.test(text))
    return detail(
      'AI_PERMISSION_DENIED',
      'Worker tidak memiliki izin menjalankan proses AI.',
      'Periksa izin program dan folder autentikasi worker.'
    )
  if (
    /\bER_[A-Z_]+\b|ECONN(?:REFUSED|RESET).*3306|database|deadlock|lock wait timeout|Knex: Timeout acquiring a connection|Acquire connection error|PROTOCOL_CONNECTION_LOST/i.test(
      text
    ) ||
    (error instanceof Error &&
      /(?:mysql2|knex|tarn|@adonisjs\/lucid)[/\\]/.test(error.stack || '') &&
      /ECONN|ETIMEDOUT|ENOTFOUND|timed out|connection.*(?:lost|closed)|socket hang up/i.test(text))
  )
    return detail(
      'DATABASE_UNAVAILABLE',
      'Data workspace belum dapat diakses.',
      'Periksa database dan log layanan database.',
      true
    )
  if (
    /unauthorized|\b401\b|invalid_grant|invalid_token|not logged in|login required|authentication|hubungkan ulang|sesi.*(?:berakhir|kedaluwarsa)|run \/login|please (?:run )?\/?log ?in|invalid api key|token (?:has )?expired|api key.*(?:ditolak|belum diisi)|API_KEY_INVALID|api key not valid|PERMISSION_DENIED/i.test(
      text
    )
  )
    return detail(
      context.stage === 'mcp_auth' ? 'MCP_AUTH_REQUIRED' : 'AI_AUTH_REQUIRED',
      'Autentikasi perlu dihubungkan ulang.',
      'Hubungkan ulang sumber yang tercantum melalui pengaturan.'
    )
  if (/\b403\b|forbidden|access denied/i.test(text))
    return detail(
      'ACCESS_DENIED',
      'Akses ditolak oleh layanan.',
      'Periksa izin akun dan sumber yang tercantum.'
    )
  if (
    /context_length_exceeded|context[_ ]window|maximum context length|prompt (?:is )?too long|input (?:is )?too long|too many (?:input )?tokens/i.test(
      text
    )
  )
    return detail(
      'AI_CONTEXT_LIMIT',
      'Input melampaui kapasitas konteks layanan AI.',
      'Periksa ukuran prompt dan kapasitas model; jangan mengulang input yang sama.'
    )
  if (
    /\b429\b|rate.?limit|usage.?limit|quota|exceeded.*limit|hit.*limit|limit (?:reached|exceeded)|reached.*limit|resets? (?:at|in|\d)|out of (?:credits|usage)|credit balance|RESOURCE_EXHAUSTED/i.test(
      text
    )
  )
    return detail(
      'USAGE_LIMIT',
      'Batas pemakaian layanan tercapai.',
      'Tunggu batas pemakaian pulih sebelum mencoba lagi.',
      true
    )
  if (
    /invalid(?:[_ ]json)?[_ ]schema|invalid schema for (?:response_format|text\.format)|schema.*(?:required|additionalProperties).*missing|missing.*(?:required|additionalProperties).*schema/i.test(
      text
    )
  )
    return detail(
      'AI_SCHEMA_INVALID',
      'Skema keluaran AI ditolak oleh layanan.',
      'Perbarui build worker dan periksa skema JSON aplikasi; permintaan ditolak sebelum jawaban dibuat.'
    )
  if (
    /unknown (?:option|argument)|unexpected argument|invalid.*model|model.*(?:not found|not supported)|unrecognized/i.test(
      text
    )
  )
    return detail(
      'AI_CONFIG_INVALID',
      'Konfigurasi atau versi program AI tidak sesuai.',
      'Periksa model, versi program, dan build worker.'
    )
  if (/Balasan ditahan|pemeriksaan data bisnis|belum.*terverifikasi/i.test(text))
    return detail(
      'BUSINESS_EVIDENCE_MISSING',
      'Bukti data bisnis belum cukup untuk menjawab.',
      'Periksa hasil tool dan akses MCP pada aktivitas ini.'
    )
  if (/tidak menghasilkan balasan|no (?:final|assistant) (?:message|output)/i.test(text))
    return detail(
      'AI_OUTPUT_EMPTY',
      'Proses AI berakhir tanpa pesan jawaban akhir.',
      'Periksa diagnostik provider dan versi worker; jangan mengulang otomatis.'
    )
  if (
    /JSON|Balasan AI kosong|Format cart|Tidak ada pesan pelanggan|tidak menghasilkan balasan|structured.output/i.test(
      text
    )
  )
    return detail(
      'AI_OUTPUT_INVALID',
      'Hasil AI belum memenuhi format balasan.',
      'Periksa model dan hasil validasi; jangan kirim keluaran mentah.'
    )
  if (/gambar|media|video|ffmpeg/i.test(text))
    return detail(
      'MEDIA_UNAVAILABLE',
      'Media belum berhasil diproses.',
      'Periksa ketersediaan media dan proses pengunduhannya.',
      true
    )
  if (
    /timeout|timed out|terlalu lama|ETIMEDOUT|ENOTFOUND|ECONN|fetch failed|network|sementara tidak tersedia|\b50[0234]\b|connection|koneksi/i.test(
      text
    )
  )
    return detail(
      context.stage === 'mcp_auth' ? 'MCP_UNAVAILABLE' : 'AI_UNAVAILABLE',
      'Layanan sementara tidak dapat dihubungi.',
      'Periksa koneksi layanan sebelum mencoba lagi.',
      true
    )
  return detail(
    'AI_PROCESS_FAILED',
    'Proses belum berhasil diselesaikan.',
    'Periksa layanan pada tahap yang tercantum; kode ini belum mengidentifikasi penyebab pastinya.'
  )
}

export async function traceAiOperation<T>(
  sink: TraceSink | undefined,
  key: string,
  label: string,
  context: FailureContext,
  operation: () => Promise<T>
) {
  sink?.({ key, label, status: 'running', detail: { ...context, diagnosticsVersion: 2 } })
  try {
    const result = await operation()
    sink?.({ key, label, status: 'completed', detail: { ...context, diagnosticsVersion: 2 } })
    return result
  } catch (error) {
    const failure = aiFailureDetail(error, context)
    sink?.({ key, label, status: 'failed', detail: failure })
    throw new AiProcessFailure(failure)
  }
}

/** Terminal events only: a recoverable MCP tool error is not a failed model turn. */
export function providerFailure(provider: string, event: Record<string, any>) {
  const text = [
    event.error?.message,
    event.error?.code,
    event.error?.type,
    event.code,
    typeof event.error === 'string' ? event.error : '',
    event.message,
    event.result,
    ...(Array.isArray(event.errors) ? event.errors : []),
  ]
    .filter((value) => typeof value === 'string')
    .join('\n')
  if (provider === 'chatgpt' && event.type === 'error') {
    const failure = aiFailureDetail(new Error(text), { stage: 'provider', provider: 'chatgpt' })
    // A subsequent turn.completed clears this provisional failure. Preserve explicit
    // request refusals when the CLI exits without turn.failed or a final message.
    if (
      [
        'USAGE_LIMIT',
        'AI_AUTH_REQUIRED',
        'ACCESS_DENIED',
        'AI_SCHEMA_INVALID',
        'AI_CONTEXT_LIMIT',
        'AI_CONFIG_INVALID',
        'AI_OUTPUT_INVALID',
      ].includes(failure.code)
    )
      return failure
  }
  // https://code.claude.com/docs/en/agent-sdk/typescript#sdkratelimitevent
  // Warnings/allowed events are informational, not exhausted usage.
  if (
    provider === 'claude' &&
    ((event.type === 'rate_limit_event' && event.rate_limit_info?.status === 'rejected') ||
      (event.type === 'assistant' && event.error === 'rate_limit'))
  )
    return aiFailureDetail(new Error('rate_limit'), { stage: 'provider', provider: 'claude' })
  const failed =
    provider === 'chatgpt'
      ? event.type === 'turn.failed'
      : event.type === 'result' && event.is_error === true
  if (!failed) return undefined
  return aiFailureDetail(new Error(text), {
    stage: 'provider',
    provider: provider === 'claude' ? 'claude' : 'chatgpt',
  })
}

/** A later generic exit must not discard an earlier explicit rate-limit signal. */
export function updateProviderFailure(
  previous: AiFailureDetail | undefined,
  provider: string,
  event: Record<string, any>
) {
  if (provider === 'chatgpt' && event.type === 'turn.completed') return undefined
  if (provider === 'claude' && event.type === 'result' && event.is_error === false) return undefined
  const next = providerFailure(provider, event)
  if (!next) return previous
  const generic = new Set(['AI_PROCESS_FAILED', 'AI_OUTPUT_INVALID', 'AI_OUTPUT_EMPTY'])
  if (previous && generic.has(next.code) && !generic.has(previous.code)) return previous
  return next.code !== 'AI_PROCESS_FAILED' || !previous ? next : previous
}
