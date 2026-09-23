import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import logger from '@adonisjs/core/services/logger'
import { initializeDatabase } from '#services/init_model'
import { providerFailure } from '#services/ai_failure_service'
import { latestSnapshotWriter } from '#services/latest_snapshot_writer'
import { noteDiagnosticTrace } from '#services/worker_diagnostics'

export type TraceEvent = {
  key: string
  label: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  detail?: unknown
}
export type TraceSink = (event: TraceEvent) => void

export function traceInterruption(status: string, updatedAt: string | Date, now = Date.now()) {
  const lastUpdate = new Date(updatedAt).getTime()
  if (status !== 'running' || !Number.isFinite(lastUpdate) || now - lastUpdate <= 240_000)
    return null
  return {
    code: 'TRACE_UPDATES_STALE',
    lastUpdatedAt: new Date(lastUpdate).toISOString(),
    message:
      'Tidak ada pembaruan aktivitas selama lebih dari 4 menit. Penyebab proses belum terkonfirmasi.',
    action:
      'Periksa log dan status worker pada waktu tersebut, termasuk restart/deploy atau kehabisan memori. Jangan menjalankan ulang sebelum memastikan proses sebelumnya sudah berhenti.',
  }
}

// Credential names remain redacted; only finite, non-negative accounting numbers are public.
const TOKEN_METRICS = new Set([
  'tokens',
  'estimatedTokens',
  'savedTokens',
  'providerInputTokens',
  'providerCachedInputTokens',
])

/** Store bounded audit evidence only. Never persist provider reasoning events or credentials. */
export function redactTrace(value: unknown, depth = 0): unknown {
  if (depth > 10) return '[diringkas]'
  if (typeof value === 'string') {
    try {
      if (/^\s*[\[{]/.test(value)) return redactTrace(JSON.parse(value), depth + 1)
    } catch {}
    return value
      .replace(/Bearer\s+[\w.\-]+/gi, 'Bearer [disembunyikan]')
      .replace(/(?:sk-[\w-]{8,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)/g, '[disembunyikan]')
      .replace(
        /((?:access_token|refresh_token|api_key|password|secret|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s,;"'&}]+/gi,
        '$1[disembunyikan]'
      )
      .replace(/https?:\/\/[^\s"'<>]+/g, (url) => {
        try {
          const parsed = new URL(url)
          parsed.username = ''
          parsed.password = ''
          if (parsed.search) parsed.search = '?redacted'
          parsed.hash = ''
          return parsed.toString()
        } catch {
          return '[URL]'
        }
      })
      .slice(0, 6000)
  }
  if (Array.isArray(value)) return value.slice(0, 12).map((item) => redactTrace(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          TOKEN_METRICS.has(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0
            ? item
            : key === 'reasoning' &&
                typeof item === 'string' &&
                ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(item)
              ? item
              : /token|secret|password|authorization|cookie|api.?key|base64|thinking|reasoning/i.test(
                    key
                  ) ||
                  (key === 'data' &&
                    ['image', 'audio'].includes(String((value as Record<string, unknown>).type)))
                ? '[disembunyikan]'
                : key === 'findings' && Array.isArray(item)
                  ? item.slice(0, 32).map((finding) => redactTrace(finding, depth + 1))
                  : key === 'sections' && Array.isArray(item)
                    ? item.slice(0, 40).map((section) => redactTrace(section, depth + 1))
                    : redactTrace(item, depth + 1),
        ])
    )
  }
  return value ?? null
}

function snapshot(value: unknown) {
  const safe = redactTrace(value)
  const json = JSON.stringify(safe)
  const limit =
    value && typeof value === 'object' && Array.isArray((value as any).findings) ? 32000 : 16000
  return json.length <= limit ? safe : { excerpt: json.slice(0, limit - 1000), truncated: true }
}

export async function startTrace(jid: string, input: unknown) {
  await initializeDatabase()
  const id = randomUUID()
  const steps: Array<TraceEvent & { startedAt: string; finishedAt?: string; durationMs?: number }> =
    []
  let finished = false
  await db.table('whatsapp_ai_traces').insert({
    id,
    jid,
    status: 'running',
    input_json: JSON.stringify(snapshot(input)),
    steps_json: '[]',
    created_at: new Date(),
    updated_at: new Date(),
  })
  const writer = latestSnapshotWriter(
    async (values) => {
      await db
        .from('whatsapp_ai_traces')
        .where('id', id)
        .update({ ...values, updated_at: new Date() })
    },
    () => logger.warn('Pencatatan detail proses AI gagal.')
  )
  const emit: TraceSink = (event) => {
    if (finished) return
    try {
      noteDiagnosticTrace(id, event)
    } catch {
      /* Optional telemetry must not interrupt a reply. */
    }
    const existing = steps.find((step) => step.key === event.key)
    if (!existing && steps.length >= 100) return
    const step = existing || { ...event, startedAt: new Date().toISOString() }
    const label = String(redactTrace(event.label)).slice(0, 255)
    Object.assign(step, event, { label, detail: snapshot(event.detail) })
    if (event.status !== 'running') {
      step.finishedAt = new Date().toISOString()
      step.durationMs = Date.now() - new Date(step.startedAt).getTime()
    }
    if (!existing) steps.push(step)
    writer.enqueue({ steps_json: JSON.stringify(steps), label })
  }
  return {
    id,
    emit,
    async finish(
      status: 'completed' | 'failed' | 'cancelled',
      decision?: unknown,
      messageId?: string
    ) {
      for (const step of steps.filter((item) => item.status === 'running'))
        emit({
          ...step,
          status: status === 'cancelled' ? 'cancelled' : 'failed',
          detail: {
            ...((decision as any)?.failure ? { failure: (decision as any).failure } : {}),
            note:
              status === 'cancelled'
                ? 'Pengiriman dibatalkan karena konteks atau status berubah.'
                : (decision as any)?.failure?.message ||
                  'Proses berakhir tanpa konfirmasi selesai.',
          },
        })
      finished = true
      try {
        noteDiagnosticTrace(id, { key: 'trace-finished', status })
      } catch {
        /* Optional telemetry. */
      }
      writer.enqueue({
        status,
        decision_json: JSON.stringify(snapshot(decision)),
        message_id: messageId || null,
      })
      await writer.flush()
    },
  }
}

export async function readTrace(jid: string, id?: string) {
  await initializeDatabase()
  const query = db.from('whatsapp_ai_traces').where('jid', jid)
  if (id) query.where('id', id)
  const row = await query.orderBy('created_at', 'desc').first()
  if (!row) return null
  const interruption = traceInterruption(row.status, row.updated_at)
  const input = JSON.parse(row.input_json)
  const messageIds = Array.isArray(input.messages)
    ? input.messages
        .map((item: any) => item.id)
        .filter((value: unknown) => typeof value === 'string')
    : []
  const media = messageIds.length
    ? await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .whereIn('message_id', messageIds)
        .select('media_type', 'media_url', 'thumbnail_url')
    : []
  return {
    id: row.id,
    status: interruption ? 'interrupted' : row.status,
    ...(interruption ? { interruption } : {}),
    label: row.label,
    input,
    media,
    steps: JSON.parse(row.steps_json),
    decision: row.decision_json ? JSON.parse(row.decision_json) : null,
    createdAt: new Date(row.created_at).toISOString(),
    messageId: row.message_id,
  }
}

/** A strict allowlist: raw thinking/reasoning/assistant text is deliberately ignored. */
export function traceProviderEvents(sink: TraceSink, prefix: string) {
  const tools = new Map<string, { label: string; args: unknown }>()
  return (provider: string, event: Record<string, any>) => {
    const failure = providerFailure(provider, event)
    if (failure) {
      sink({ key: prefix, label: 'Proses AI gagal', status: 'failed', detail: failure })
      return
    }
    if (provider === 'chatgpt') {
      const item = event.item
      if (
        !['item.started', 'item.updated', 'item.completed'].includes(event.type) ||
        item?.type !== 'mcp_tool_call'
      )
        return
      const key = `${prefix}:${item.id || `${item.server}:${item.tool}`}`
      const done = event.type === 'item.completed'
      const label = `${item.server || 'MCP'} · ${item.tool || 'tool'}`
      const args = item.arguments ?? tools.get(key)?.args
      tools.set(key, { label, args })
      sink({
        key,
        label,
        status: done
          ? item.error || item.status === 'failed' || item.result?.isError
            ? 'failed'
            : 'completed'
          : 'running',
        detail: { parameters: args, result: item.result, error: item.error },
      })
      return
    }
    for (const block of event.message?.content || []) {
      if (block.type === 'tool_use' && block.id && block.name?.startsWith('mcp__')) {
        const [, server, ...name] = block.name.split('__')
        const label = `${server} · ${name.join('__')}`
        tools.set(block.id, { label, args: block.input })
        sink({
          key: `${prefix}:${block.id}`,
          label,
          status: 'running',
          detail: { parameters: block.input },
        })
      }
      if (block.type === 'tool_result' && tools.has(block.tool_use_id)) {
        const tool = tools.get(block.tool_use_id)!
        sink({
          key: `${prefix}:${block.tool_use_id}`,
          label: tool.label,
          status: block.is_error ? 'failed' : 'completed',
          detail: { parameters: tool.args, result: block.content },
        })
      }
    }
  }
}
