import database from '@adonisjs/lucid/services/db'
import { workspaceSql } from '#services/workspace_context'

/** Identifiers in builders are scoped by Knex wrapIdentifier (config/database.ts).
 * Scope raw SQL and transaction raw SQL too. No SQL values or payloads are rewritten.
 */
function scopedClient<T extends object>(resolve: () => T): T {
  // Ace imports command modules before booting Lucid. Resolve its live binding
  // only when the running command/request actually accesses the database.
  return new Proxy({} as T, {
    get(_target, key) {
      const target = resolve()
      const value = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'raw' || key === 'rawQuery')
        return (sql: string, ...args: unknown[]) => value.call(target, workspaceSql(sql), ...args)
      if (key === 'transaction')
        return (callback?: unknown, ...args: unknown[]) => {
          if (typeof callback === 'function')
            return value.call(target, (trx: object) => callback(scopedClient(() => trx)), ...args)
          return value
            .call(target, callback, ...args)
            .then((trx: object) => scopedClient(() => trx))
        }
      return value.bind(target)
    },
  })
}
export default scopedClient(() => database)
