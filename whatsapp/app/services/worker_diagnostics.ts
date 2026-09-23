import { mkdir, writeFile, rename, readFile, readdir, stat, unlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { diagnosticStep } from '#services/diagnostic_contract'
import { workspaceScope } from '#services/workspace_context'
import { applicationPoolMetrics } from '#services/diagnostic_pool'
import { providerProcessDiagnostics } from '#services/provider_process_diagnostics'

let activity: Map<string, any> | undefined
export function noteDiagnosticTrace(id: string, event: any) {
  if (!activity) return
  const previous = activity.get(id) || { id, workspaceId: workspaceScope().id, steps: [] }
  const safe = diagnosticStep(event)
  const existing = previous.steps.find((step: any) => step.key === safe.key)
  const now = new Date().toISOString()
  const step = {
    ...safe,
    startedAt: existing?.startedAt || now,
    ...(safe.status !== 'running' ? { finishedAt: now } : {}),
  }
  const steps = [...previous.steps.filter((item: any) => item.key !== step.key), step]
  // Keep the active analysis even when many completed MCP rows arrive afterwards.
  previous.steps = [
    ...steps.filter((item: any) => item.status === 'running').slice(-10),
    ...steps.filter((item: any) => item.status !== 'running').slice(-25),
  ]
  previous.updatedAt = now
  activity.delete(id)
  activity.set(id, previous)
  if (activity.size > 8) activity.delete(activity.keys().next().value!)
}

export async function startWorkerDiagnostics(directory: string) {
  activity = new Map()
  const delay = monitorEventLoopDelay({ resolution: 50 })
  delay.enable()
  const release = basename(join(process.cwd(), '..'))
  const fingerprint = await readFile(new URL('./ai_service.js', import.meta.url))
    .catch(() => readFile(new URL('./ai_service.ts', import.meta.url)))
    .then((value) => createHash('sha256').update(value).digest('hex').slice(0, 16))
    .catch(() => 'unavailable')
  let writing = false
  let stopped = false
  const file = join(directory, `worker-${process.pid}.json`)
  const publish = async () => {
    if (writing) return
    writing = true
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const value = {
        pid: process.pid,
        release,
        fingerprint,
        seenAt: new Date().toISOString(),
        stopped,
        uptimeSeconds: process.uptime(),
        rssBytes: process.memoryUsage().rss,
        databasePools: applicationPoolMetrics(),
        providerProcesses: providerProcessDiagnostics(),
        eventLoopMaxMs: delay.max / 1e6,
        activity: [...(activity?.values() || [])],
      }
      const temp = `${file}.tmp`
      await writeFile(temp, JSON.stringify(value), { mode: 0o600 })
      await rename(temp, file)
      delay.reset()
    } catch {
      /* Diagnostics must never stop customer processing. */
    } finally {
      writing = false
    }
  }
  await publish()
  // Remove only our own obsolete telemetry files; never credentials or other storage.
  const existingFiles = await readdir(directory).catch(() => [])
  for (const entry of existingFiles.filter((item) => /^worker-\d+\.json$/.test(item))) {
    const path = join(directory, entry)
    const old = await stat(path).catch(() => null)
    if (old && old.mtimeMs < Date.now() - 86_400_000) await unlink(path).catch(() => {})
  }
  const timer = setInterval(() => {
    void publish()
  }, 5000)
  timer.unref()
  return async () => {
    clearInterval(timer)
    stopped = true
    delay.disable()
    await publish()
    activity = undefined
  }
}

export async function readWorkerDiagnostics(directory: string, workspaceId: number) {
  const allFiles = await readdir(directory).catch(() => [])
  const entries = allFiles.filter((file) => /^worker-\d+\.json$/.test(file))
  const dated = await Promise.all(
    entries.map(async (file) => {
      const info = await stat(join(directory, file)).catch(() => null)
      return { file, time: info?.mtimeMs || 0 }
    })
  )
  const files = dated
    .sort((a, b) => b.time - a.time)
    .slice(0, 64)
    .map((entry) => entry.file)
  const rows = await Promise.all(
    files.map(async (file) => {
      try {
        const raw = await readFile(join(directory, file), 'utf8')
        if (raw.length > 512_000) return null
        const value = JSON.parse(raw)
        const ageMs = Date.now() - Date.parse(value.seenAt)
        if (!Number.isFinite(ageMs) || ageMs > 86_400_000) return null
        return {
          pid: value.pid,
          release: value.release,
          fingerprint: value.fingerprint,
          seenAt: value.seenAt,
          stopped: value.stopped,
          uptimeSeconds: value.uptimeSeconds,
          rssBytes: value.rssBytes,
          databasePools: value.databasePools,
          providerProcesses: Array.isArray(value.providerProcesses)
            ? value.providerProcesses.filter((item: any) => item.workspaceId === workspaceId)
            : [],
          eventLoopMaxMs: value.eventLoopMaxMs,
          ageMs,
          heartbeatFresh: ageMs >= 0 && ageMs < 20_000 && !value.stopped,
          activity: Array.isArray(value.activity)
            ? value.activity.filter((item: any) => item.workspaceId === workspaceId)
            : [],
        }
      } catch {
        return null
      }
    })
  )
  return rows.filter(Boolean)
}
