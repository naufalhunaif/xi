import app from '@adonisjs/core/services/app'
import { mkdirSync, realpathSync } from 'node:fs'
import { dirname, delimiter } from 'node:path'
import { workspaceScope } from '#services/workspace_context'
import { currentAiAccount } from '#services/ai_account_context'

/** Bare `codex` means the CLI installed and verified with this release, not a global copy. */
export function codexCommand(value?: string) {
  const configured = String(value || '').trim()
  return !configured || configured === 'codex'
    ? app.makePath('node_modules', '.bin', 'codex')
    : configured
}

/** Only child processes receive these overrides. Legacy credentials remain untouched. */
export function workspaceOAuthDirectory(provider: 'codex' | 'claude') {
  const scope = workspaceScope()
  const account = currentAiAccount()
  if (account) {
    // Tiap akun AI tambahan punya folder login sendiri.
    const directory = app.makePath(
      'storage',
      'whatsapp-workspaces',
      String(scope.id || 1),
      'ai-accounts',
      String(account.id),
      provider
    )
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    return realpathSync(directory)
  }
  if (!scope.prefix) return undefined
  const directory = app.makePath('storage', 'whatsapp-workspaces', String(scope.id), provider)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Stable across aaPanel release symlinks (also used by the macOS Keychain identity).
  return realpathSync(directory)
}
export function codexRuntimeEnv() {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', TERM: 'dumb' }
  childEnv.PATH = [
    dirname(process.execPath),
    app.makePath('node_modules', '.bin'),
    process.env.PATH || '',
  ].join(delimiter)
  delete childEnv.OPENAI_API_KEY
  delete childEnv.CODEX_API_KEY
  return childEnv
}
export function codexOAuthEnv() {
  const childEnv = codexRuntimeEnv()
  const directory = workspaceOAuthDirectory('codex')
  if (directory) childEnv.CODEX_HOME = directory
  return childEnv
}
export function codexOAuthArguments() {
  return workspaceScope().prefix || currentAiAccount()
    ? ['-c', 'cli_auth_credentials_store="file"', '-c', 'mcp_oauth_credentials_store="file"']
    : []
}
