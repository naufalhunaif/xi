import { createHash } from 'node:crypto'

export function mcpTokenVariable(slug: string) {
  return `WA_MCP_${createHash('sha256').update(slug).digest('hex').slice(0, 24).toUpperCase()}`
}
export function mcpTokenEnvironment(tokens: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(tokens)
      .filter(([, token]) => token)
      .map(([slug, token]) => [mcpTokenVariable(slug), token])
  )
}
export function claudeMcpConnection(url: string, slug: string, shared: boolean) {
  return {
    type: 'http',
    url,
    ...(shared ? { headers: { Authorization: 'Bearer ${' + mcpTokenVariable(slug) + '}' } } : {}),
  }
}
