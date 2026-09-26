import { AsyncLocalStorage } from 'node:async_hooks'

export type WorkspaceScope = { id: number; prefix: string; phone: string | null; version: string }
const scopes = new AsyncLocalStorage<WorkspaceScope>()
export const EMPTY_WORKSPACE: WorkspaceScope = { id: 0, prefix: 'w0_', phone: null, version: '' }
export const LEGACY_WORKSPACE: WorkspaceScope = { id: 1, prefix: '', phone: null, version: '' }
export const workspaceScope = () => scopes.getStore() || LEGACY_WORKSPACE
export function inWorkspace<T>(scope: WorkspaceScope, action: () => T): T {
  if (
    !Number.isSafeInteger(scope.id) ||
    scope.id < 0 ||
    scope.prefix !== (scope.id === 1 ? '' : `w${scope.id}_`)
  )
    throw new Error('Invalid workspace scope.')
  return scopes.run(scope, action)
}
const globalTables = new Set([
  'whatsapp_connection',
  'whatsapp_workspaces',
  'whatsapp_workspace_state',
  'whatsapp_lines',
  // Akun AI berlaku untuk semua nomor/workspace.
  'whatsapp_ai_accounts',
])
export function workspaceIdentifier(identifier: string) {
  if (/^whatsapp_[a-z0-9_]+$/.test(identifier) && !globalTables.has(identifier))
    return workspaceScope().prefix + identifier
  return identifier
}
/** Raw queries use the same namespace as query builders; values/comments are untouched. */
export function workspaceSql(sql: string) {
  return sql.replace(
    /'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|--[^\n]*|\/\*[\s\S]*?\*\/|`[^`]+`|\bwhatsapp_[a-z0-9_]+\b/g,
    (token) => {
      if (token.startsWith('`')) return '`' + workspaceIdentifier(token.slice(1, -1)) + '`'
      return workspaceIdentifier(token)
    }
  )
}

/** Stable per-number filenames prevent profile/media cache collisions after switching. */
export function workspaceFileName(name: string) {
  return workspaceScope().prefix + name
}

export function ownsWorkspaceMedia(name: string) {
  const scope = workspaceScope()
  if (!scope.id || !/^(?:profiles\/)?[a-zA-Z0-9_.-]+$/.test(name)) return false
  const file = name.split('/').pop()!
  return scope.prefix ? file.startsWith(scope.prefix) : !/^w\d+_/.test(file)
}
