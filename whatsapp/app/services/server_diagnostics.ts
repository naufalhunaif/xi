import mysql from 'mysql2/promise'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, join } from 'node:path'
import { freemem, totalmem, loadavg } from 'node:os'
import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { diagnosticTrace, safeDate } from '#services/diagnostic_contract'
import { readWorkerDiagnostics } from '#services/worker_diagnostics'
import { selectReplySkills, selectEvaluationSkills } from '#services/reply_skill_selection'
import { diagnosticUsage } from '#services/diagnostic_usage'
import { applicationPoolMetrics } from '#services/diagnostic_pool'
import { providerProcessDiagnostics } from '#services/provider_process_diagnostics'

const errorCode = (error: any) =>
  /^[A-Z][A-Z0-9_]{0,79}$/.test(String(error?.code)) ? error.code : 'DIAGNOSTIC_READ_FAILED'
let pending: Promise<any> | undefined
let last: { key: string; time: number; value: any } | undefined

/** Separate short-lived connection: can report a DB outage without waiting in the app pool. */
export async function collectServerDiagnostics(
  workspaceId: number,
  traceId?: string,
  connect = () =>
    mysql.createConnection({
      host: env.get('DB_HOST'),
      port: env.get('DB_PORT'),
      user: env.get('DB_USER'),
      password: env.get('DB_PASSWORD'),
      database: env.get('DB_DATABASE'),
      connectTimeout: 3000,
      multipleStatements: false,
    })
) {
  if (!Number.isSafeInteger(workspaceId) || workspaceId < 1)
    throw new Error('Invalid diagnostic scope')
  const started = Date.now()
  const worker = await readWorkerDiagnostics(app.makePath('storage', 'diagnostics'), workspaceId)
  const ai = await readFile(new URL('./ai_service.js', import.meta.url))
    .catch(() => readFile(new URL('./ai_service.ts', import.meta.url)))
    .catch(() => null)
  const runtime = {
    pid: process.pid,
    release: basename(join(process.cwd(), '..')),
    fingerprint: ai ? createHash('sha256').update(ai).digest('hex').slice(0, 16) : 'unavailable',
    nodeVersion: process.version,
    uptimeSeconds: process.uptime(),
    rssBytes: process.memoryUsage().rss,
    databasePools: applicationPoolMetrics(),
    providerProcesses: providerProcessDiagnostics(workspaceId),
    hostMemoryFreeBytes: freemem(),
    hostMemoryTotalBytes: totalmem(),
    hostLoadAverage: loadavg(),
  }
  const result: any = {
    contractVersion: 2,
    observedAt: new Date().toISOString(),
    workspaceId,
    runtime,
    workers: worker,
    database: { status: 'unavailable' },
    traces: [],
    evidence: [],
  }
  let connection: mysql.Connection | undefined
  try {
    connection = await connect()
    const query = async (sql: string, values: any[] = []) => {
      const [rows] = await connection!.query({ sql, values, timeout: 3000 })
      return rows as any[]
    }
    await query('SELECT 1 AS ok')
    result.database = {
      status: 'reachable',
      latencyMs: Date.now() - started,
      probe: 'independent_connection_not_app_pool',
    }
    const prefix = workspaceId === 1 ? '' : `w${workspaceId}_`
    const reads = [
      [
        'connection',
        async () => {
          const rows = await query(
            'SELECT status, worker_heartbeat_at FROM whatsapp_connection WHERE id = 1'
          )
          return rows[0]
            ? { status: rows[0].status, heartbeatAt: safeDate(rows[0].worker_heartbeat_at) }
            : null
        },
      ],
      [
        'skills',
        async () => {
          const rows = await query(`SELECT name, content FROM ${prefix}whatsapp_skills ORDER BY id`)
          const skills = rows.map((row) => ({
            name: String(row.name),
            content: String(row.content || ''),
          }))
          return {
            ...selectReplySkills(skills).detail,
            evaluation: selectEvaluationSkills(skills).detail,
          }
        },
      ],
      [
        'usage',
        async () => {
          const recent = await query(
            `SELECT phase, status, input_tokens, output_tokens, cached_tokens, cache_write_tokens,
              duration_ms, created_at FROM ${prefix}whatsapp_ai_usage
              ORDER BY id DESC LIMIT 20`
          )
          const phases = await query(
            `SELECT phase, COUNT(*) runs, COUNT(input_tokens) measured_runs,
              SUM(input_tokens) input_tokens, SUM(output_tokens) output_tokens,
              SUM(cached_tokens) cached_tokens, SUM(cache_write_tokens) cache_write_tokens,
              SUM(status='failed') failed_runs, SUM(duration_ms) duration_ms
              FROM ${prefix}whatsapp_ai_usage WHERE created_at >= ? GROUP BY phase`,
            [new Date(Date.now() - 86400_000)]
          )
          return diagnosticUsage(recent, phases)
        },
      ],
      [
        'traces',
        async () => {
          const rows = await query(
            `SELECT t.id, t.status, t.created_at, t.updated_at, t.steps_json, t.decision_json, t.message_id,
              c.items_json AS cart_items_json, c.updated_at AS cart_updated_at,
              g.status AS goal_status, g.updated_at AS goal_updated_at, g.next_run_at, g.recovery_json,
              contact.handling_mode, contact.ai_excluded
              FROM ${prefix}whatsapp_ai_traces t
              LEFT JOIN ${prefix}whatsapp_carts c ON c.jid = t.jid
              LEFT JOIN ${prefix}whatsapp_chat_goals g ON g.jid = t.jid
              LEFT JOIN ${prefix}whatsapp_contacts contact ON contact.jid = t.jid
              ${traceId ? 'WHERE t.id = ?' : ''} ORDER BY t.created_at DESC LIMIT 5`,
            traceId ? [traceId] : []
          )
          return rows.map((row) => diagnosticTrace(row))
        },
      ],
    ] as const
    for (const [key, read] of reads) {
      try {
        result[key] = await read()
      } catch (error) {
        result[key] = { unavailable: true, code: errorCode(error) }
      }
    }
  } catch (error) {
    result.database = {
      status: 'unavailable',
      code: errorCode(error),
      latencyMs: Date.now() - started,
    }
  } finally {
    connection?.destroy()
  }
  if (result.database.status === 'unavailable')
    result.evidence.push({
      code: 'DATABASE_PROBE_FAILED',
      confirmed: true,
      source: 'independent_connection',
    })
  if (!result.workers.some((row: any) => row.heartbeatFresh)) {
    const latest = result.workers[0]
    result.evidence.push({
      code: !latest
        ? 'WORKER_TELEMETRY_UNAVAILABLE'
        : latest.stopped
          ? 'WORKER_STOP_RECORDED'
          : 'WORKER_HEARTBEAT_STALE',
      confirmed: true,
      ...(latest ? { pid: latest.pid } : {}),
      cause: 'unknown',
    })
  }
  for (const row of result.workers) {
    if (
      row.heartbeatFresh &&
      row.databasePools?.some((pool: any) => pool.pendingAcquires > 0 && pool.free === 0)
    )
      result.evidence.push({
        code: 'WORKER_DB_POOL_WAITING',
        confirmed: true,
        pid: row.pid,
        cause: 'unknown',
      })
    if (row.heartbeatFresh && row.fingerprint !== runtime.fingerprint)
      result.evidence.push({ code: 'WEB_WORKER_BUILD_MISMATCH', confirmed: true, pid: row.pid })
  }
  for (const key of ['connection', 'skills', 'traces'])
    if (result[key]?.unavailable)
      result.evidence.push({
        code: 'DIAGNOSTIC_COMPONENT_READ_FAILED',
        component: key,
        databaseCode: result[key].code,
        confirmed: true,
      })
  if (Array.isArray(result.traces))
    for (const trace of result.traces) {
      if (trace.updatesStale)
        result.evidence.push({ code: 'TRACE_UPDATES_STALE', traceId: trace.id, cause: 'unknown' })
      if (trace.steps.some((step: any) => step.key === 'skill-routing-fallback'))
        result.evidence.push({
          code: 'FULL_SKILL_FALLBACK_STARTED',
          traceId: trace.id,
          confirmed: true,
        })
    }
  result.durationMs = Date.now() - started
  result.limits =
    'Read-only observations; stale telemetry does not prove OOM, a stopped process, or a running provider. Database probe does not measure the application connection pool.'
  return result
}

export async function serverDiagnostics(workspaceId: number, traceId?: string) {
  if (
    !Number.isSafeInteger(workspaceId) ||
    workspaceId < 1 ||
    (traceId && !/^[a-f0-9-]{36}$/.test(traceId))
  )
    throw new Error('Invalid diagnostic scope')
  const key = `${workspaceId}:${traceId || ''}`
  if (last?.key === key && Date.now() - last.time < 2000) return last.value
  if (pending) return { busy: true, retryAfterSeconds: 2 }
  pending = collectServerDiagnostics(workspaceId, traceId)
  try {
    const value = await pending
    last = { key, time: Date.now(), value }
    return value
  } finally {
    pending = undefined
  }
}
