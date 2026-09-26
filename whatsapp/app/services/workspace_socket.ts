import type { WASocket } from '@whiskeysockets/baileys'
import { workspaceScope } from '#services/workspace_context'
import { workspaceState } from '#services/workspace_service'

/** Last delivery barrier, including work already running when Disconnect was clicked. */
export function workspaceSocket(socket: WASocket): WASocket {
  const guarded = new Set(['sendMessage', 'readMessages', 'sendPresenceUpdate'])
  return new Proxy(socket, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== 'function') return value
      if (guarded.has(String(key)))
        return async (...args: unknown[]) => {
          const scope = workspaceScope()
          const state = await workspaceState()
          if (!scope.id || Number(state.active_id) !== scope.id || state.version !== scope.version || state.cleanup_workspace_id)
            throw new Error('Nomor sudah tidak aktif.')
          return value.apply(target, args)
        }
      return value.bind(target)
    },
  })
}
