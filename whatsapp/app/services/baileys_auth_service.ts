import db from '#services/workspace_database'
import { workspaceState } from '#services/workspace_service'
import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationState,
  type SignalDataTypeMap,
  type SignalKeyStore,
} from '@whiskeysockets/baileys'

const encode = (value: unknown) => JSON.stringify(value, BufferJSON.replacer)
const decode = (value: string) => JSON.parse(value, BufferJSON.reviver)

export async function databaseAuthState(): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
  clear: () => Promise<void>
}> {
  const initialState = await workspaceState()
  const authVersion = initialState.auth_version
  const saved = await db.from('baileys_auth').where({ category: 'creds', auth_key: 'main' }).first()
  const creds = saved ? decode(saved.payload) : initAuthCreds()
  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      if (!ids.length) return {}
      const currentState = await workspaceState()
      if (currentState.auth_version !== authVersion) return {}
      const rows = await db.from('baileys_auth').where('category', type).whereIn('auth_key', ids)
      const result: { [id: string]: SignalDataTypeMap[T] } = {}
      for (const row of rows) {
        let value = decode(row.payload)
        if (type === 'app-state-sync-key')
          value = proto.Message.AppStateSyncKeyData.fromObject(value)
        result[row.auth_key] = value
      }
      return result
    },
    async set(data) {
      await db.transaction(async (trx) => {
        const current = await trx
          .from('whatsapp_workspace_state')
          .where('id', 1)
          .forUpdate()
          .firstOrFail()
        if (current.auth_version !== authVersion) return
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          for (const [key, value] of Object.entries(data[category] || {})) {
            if (value === null || value === undefined) {
              await trx.from('baileys_auth').where({ category, auth_key: key }).delete()
            } else {
              await trx.rawQuery(
                `INSERT INTO baileys_auth (category, auth_key, payload) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
                [category, key, encode(value)]
              )
            }
          }
        }
      })
    },
  }
  return {
    state: { creds, keys },
    saveCreds: async () => {
      await db.transaction(async (trx) => {
        const current = await trx
          .from('whatsapp_workspace_state')
          .where('id', 1)
          .forUpdate()
          .firstOrFail()
        if (current.auth_version !== authVersion) return
        await trx.rawQuery(
          `INSERT INTO baileys_auth (category, auth_key, payload) VALUES ('creds', 'main', ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
          [encode(creds)]
        )
      })
    },
    clear: async () => {
      await db.transaction(async (trx) => {
        const current = await trx
          .from('whatsapp_workspace_state')
          .where('id', 1)
          .forUpdate()
          .firstOrFail()
        if (current.auth_version === authVersion) await trx.from('baileys_auth').delete()
      })
    },
  }
}
