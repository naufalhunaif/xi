import db from '#services/workspace_database'
import { workspaceState } from '#services/workspace_service'
import { lineAuthPrefix } from '#services/line_service'
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

/** Baris sesi nomor tambahan memakai awalan `ln<id>|`; nomor utama tanpa awalan. */
export const LINE_AUTH_PATTERN = 'ln%|%'

/**
 * Sesi Baileys di database. `line` 1 = nomor utama (versi dari workspace state);
 * line ≥ 2 = nomor tambahan (versi dari whatsapp_lines, kunci berawalan).
 */
export async function databaseAuthState(line = 1): Promise<{
  state: AuthenticationState
  saveCreds: () => Promise<void>
  clear: () => Promise<void>
}> {
  const prefix = lineAuthPrefix(line)
  const versionOf = async (trx: any = db) => {
    if (line > 1) {
      const row = await trx.from('whatsapp_lines').where('id', line).first()
      return row ? String(row.auth_version) : ''
    }
    const state = await trx.from('whatsapp_workspace_state').where('id', 1).first()
    return state ? String(state.auth_version) : ''
  }
  if (line === 1) await workspaceState()
  const authVersion = await versionOf()
  const lock = async (trx: any) => {
    // Nomor utama mengunci state workspace; nomor tambahan mengunci barisnya sendiri.
    if (line > 1) await trx.from('whatsapp_lines').where('id', line).forUpdate().first()
    else await trx.from('whatsapp_workspace_state').where('id', 1).forUpdate().firstOrFail()
    return (await versionOf(trx)) === authVersion
  }
  const saved = await db
    .from('baileys_auth')
    .where({ category: 'creds', auth_key: `${prefix}main` })
    .first()
  const creds = saved ? decode(saved.payload) : initAuthCreds()
  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      if (!ids.length) return {}
      if ((await versionOf()) !== authVersion) return {}
      const rows = await db
        .from('baileys_auth')
        .where('category', type)
        .whereIn(
          'auth_key',
          ids.map((id) => prefix + id)
        )
      const result: { [id: string]: SignalDataTypeMap[T] } = {}
      for (const row of rows) {
        let value = decode(row.payload)
        if (type === 'app-state-sync-key')
          value = proto.Message.AppStateSyncKeyData.fromObject(value)
        result[String(row.auth_key).slice(prefix.length)] = value
      }
      return result
    },
    async set(data) {
      await db.transaction(async (trx) => {
        if (!(await lock(trx))) return
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          for (const [key, value] of Object.entries(data[category] || {})) {
            if (value === null || value === undefined) {
              await trx.from('baileys_auth').where({ category, auth_key: prefix + key }).delete()
            } else {
              await trx.rawQuery(
                `INSERT INTO baileys_auth (category, auth_key, payload) VALUES (?, ?, ?)
                 ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
                [category, prefix + key, encode(value)]
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
        if (!(await lock(trx))) return
        await trx.rawQuery(
          `INSERT INTO baileys_auth (category, auth_key, payload) VALUES ('creds', ?, ?)
         ON DUPLICATE KEY UPDATE payload = VALUES(payload)`,
          [`${prefix}main`, encode(creds)]
        )
      })
    },
    clear: async () => {
      await db.transaction(async (trx) => {
        if (!(await lock(trx))) return
        await clearAuthRows(trx, line)
      })
    },
  }
}

/** Hapus sesi satu line saja (nomor utama tidak menyentuh sesi nomor tambahan). */
export async function clearAuthRows(trx: any, line: number) {
  if (line > 1)
    await trx.from('baileys_auth').where('auth_key', 'like', `${lineAuthPrefix(line)}%`).delete()
  else await trx.from('baileys_auth').whereNot('auth_key', 'like', LINE_AUTH_PATTERN).delete()
}
