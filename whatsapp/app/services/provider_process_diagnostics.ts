import type { ChildProcess } from 'node:child_process'
import { workspaceScope } from '#services/workspace_context'

const processes = new Map<
  number,
  {
    pid: number
    workspaceId: number
    provider: string
    startedAt: string
    exitedAt?: string
    exitCode?: number | null
    signal?: string | null
    state: string
  }
>()

/** Process lifecycle only. Never stores command lines, environment, prompts or stderr. */
export function observeProviderProcess(child: ChildProcess, provider: 'chatgpt' | 'claude') {
  const workspaceId = workspaceScope().id
  child.once('spawn', () => {
    if (!child.pid) return
    processes.set(child.pid, {
      pid: child.pid,
      workspaceId,
      provider,
      startedAt: new Date().toISOString(),
      state: 'running',
    })
    if (processes.size > 16) processes.delete(processes.keys().next().value!)
  })
  child.once('exit', (exitCode, signal) => {
    const row = child.pid && processes.get(child.pid)
    if (row)
      Object.assign(row, { state: 'exited', exitedAt: new Date().toISOString(), exitCode, signal })
  })
}

export function providerProcessDiagnostics(workspaceId?: number) {
  return [...processes.values()]
    .filter((row) => workspaceId === undefined || row.workspaceId === workspaceId)
    .map((row) => ({ ...row }))
}
