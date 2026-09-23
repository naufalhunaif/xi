import { spawn } from 'node:child_process'

/** Account metadata only. No thread/turn, model generation, MCP, or login is started. */
export function readCodexQuota(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 8000
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args, 'app-server'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let done = false
    let buffer = ''
    let bytes = 0
    let phase = 0
    const finish = (error?: Error, result?: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill('SIGTERM')
      const kill = setTimeout(() => child.kill('SIGKILL'), 1000)
      kill.unref()
      child.once('close', () => clearTimeout(kill))
      if (error) reject(error)
      else resolve(result)
    }
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const timer = setTimeout(() => finish(new Error('QUOTA_UNAVAILABLE')), timeoutMs)
    child.on('error', () => finish(new Error('QUOTA_UNAVAILABLE')))
    child.stdin.on('error', () => finish(new Error('QUOTA_UNAVAILABLE')))
    child.on('close', () => finish(new Error('QUOTA_UNAVAILABLE')))
    child.stderr.on('data', () => {}) // Never expose CLI stderr or authentication details.
    child.stdout.on('data', (chunk) => {
      if (done) return
      bytes += chunk.length
      if (bytes > 512_000) return finish(new Error('QUOTA_UNAVAILABLE'))
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        if (done) break
        let message: any
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (!message || typeof message !== 'object') continue
        if (message.id !== phase || message.method) continue
        if (message.error) return finish(new Error('QUOTA_UNAVAILABLE'))
        if (phase === 0) {
          phase = 1
          send({ method: 'initialized', params: {} })
          send({ method: 'account/rateLimits/read', id: 1, params: {} })
        } else finish(undefined, message.result)
      }
    })
    send({
      method: 'initialize',
      id: 0,
      params: {
        clientInfo: { name: 'whatsapp_usage', title: 'WhatsApp Usage', version: '1.0.0' },
      },
    })
  })
}
