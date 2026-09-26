import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { ensureDefaults } from '#services/settings_service'
import {
  EMPTY_WORKSPACE,
  LEGACY_WORKSPACE,
  inWorkspace,
  type WorkspaceScope,
} from '#services/workspace_context'

let registry: Promise<void> | undefined
export function normalizeWorkspacePhone(value: unknown) {
  const phone = String(value || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/^\+/, '')
  if (!/^\d{6,20}$/.test(phone)) throw new Error('Nomor WhatsApp tidak valid.')
  return phone
}
function scopeOf(row: any, version: string): WorkspaceScope {
  return row
    ? {
        id: Number(row.id),
        phone: row.phone || null,
        prefix: row.legacy ? '' : `w${Number(row.id)}_`,
        version,
      }
    : { ...EMPTY_WORKSPACE, version }
}
export function ensureWorkspaceRegistry() {
  registry ??= inWorkspace(LEGACY_WORKSPACE, async () => {
    await ensureDefaults()
    await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_workspaces (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      phone VARCHAR(20) NULL UNIQUE,
      legacy TINYINT(1) NOT NULL DEFAULT 0,
      archived_at DATETIME NULL,
      created_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.rawQuery(`CREATE TABLE IF NOT EXISTS whatsapp_workspace_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      active_id INT UNSIGNED NULL,
      session_id INT UNSIGNED NULL,
      worker_id CHAR(36) NULL,
      version CHAR(36) NOT NULL,
      auth_version CHAR(36) NOT NULL,
      updated_at DATETIME NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
    await db.rawQuery(
      'ALTER TABLE whatsapp_workspace_state ADD COLUMN IF NOT EXISTS worker_id CHAR(36) NULL'
    )
    await db.rawQuery(
      'ALTER TABLE whatsapp_workspace_state ADD COLUMN IF NOT EXISTS cleanup_workspace_id INT UNSIGNED NULL'
    )
    await db.rawQuery(
      'ALTER TABLE whatsapp_workspace_state ADD COLUMN IF NOT EXISTS cleanup_worker_id CHAR(36) NULL'
    )
    await db.rawQuery(
      'ALTER TABLE whatsapp_workspace_state ADD COLUMN IF NOT EXISTS reset_worker_id CHAR(36) NULL'
    )
    await db.rawQuery(
      'ALTER TABLE whatsapp_workspace_state ADD COLUMN IF NOT EXISTS contact_cleanup_worker_id CHAR(36) NULL'
    )
    await db.transaction(async (trx) => {
      const connection = await trx
        .from('whatsapp_connection')
        .where('id', 1)
        .forUpdate()
        .firstOrFail()
      if (await trx.from('whatsapp_workspace_state').where('id', 1).first()) return
      let phone: string | null = null
      try {
        phone = normalizeWorkspacePhone(connection.phone)
      } catch {
        const saved = await trx
          .from('baileys_auth')
          .where({ category: 'creds', auth_key: 'main' })
          .first()
        try {
          phone = normalizeWorkspacePhone(JSON.parse(saved?.payload || '{}').me?.id)
        } catch {
          /* Unknown legacy owner is archived, never assigned to a new number. */
        }
      }
      const active = Boolean(phone && connection.desired_connected)
      await trx.table('whatsapp_workspaces').insert({
        id: 1,
        phone,
        legacy: true,
        archived_at: active ? null : new Date(),
        created_at: new Date(),
      })
      await trx.table('whatsapp_workspace_state').insert({
        id: 1,
        active_id: active ? 1 : null,
        session_id: phone ? 1 : null,
        version: randomUUID(),
        auth_version: randomUUID(),
        updated_at: new Date(),
      })
    })
  }).catch((error) => {
    registry = undefined
    throw error
  })
  return registry
}
export async function workspaceState() {
  await ensureWorkspaceRegistry()
  return db.from('whatsapp_workspace_state').where('id', 1).firstOrFail()
}
export async function activeWorkspace() {
  const state = await workspaceState()
  const row = state.active_id
    ? await db.from('whatsapp_workspaces').where('id', state.active_id).first()
    : null
  return scopeOf(row, state.version)
}
/** A queued cleanup still owns its original number even after an external logout. */
export async function cleanupWorkspace() {
  const state = await workspaceState()
  const row = state.cleanup_workspace_id
    ? await db.from('whatsapp_workspaces').where('id', state.cleanup_workspace_id).first()
    : null
  return scopeOf(row, state.version)
}
export async function activateWorkspace(value: unknown, authVersion: string) {
  const phone = normalizeWorkspacePhone(value)
  await ensureWorkspaceRegistry()
  await db.rawQuery(
    'INSERT IGNORE INTO whatsapp_workspaces (phone,legacy,archived_at,created_at) VALUES (?,0,NULL,?)',
    [phone, new Date()]
  )
  const row = await db.from('whatsapp_workspaces').where('phone', phone).firstOrFail()
  const scope = scopeOf(row, '')
  // DDL/init is deliberately outside the registry transaction.
  await inWorkspace(scope, () => ensureDefaults())
  return db.transaction(async (trx) => {
    const state = await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .forUpdate()
      .firstOrFail()
    const connection = await trx.from('whatsapp_connection').where('id', 1).firstOrFail()
    if (state.auth_version !== authVersion || !connection.desired_connected)
      throw new Error('Koneksi sudah dibatalkan.')
    if (state.active_id && Number(state.active_id) !== scope.id)
      await trx
        .from('whatsapp_workspaces')
        .where('id', state.active_id)
        .update({ archived_at: new Date() })
    const version = Number(state.active_id) === scope.id ? state.version : randomUUID()
    await trx.from('whatsapp_workspaces').where('id', scope.id).update({ archived_at: null })
    await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({ active_id: scope.id, session_id: scope.id, version, updated_at: new Date() })
    return { ...scope, version }
  })
}
/** Archive is a pointer/state change; all per-number tables, IDs and media remain intact. */
export async function archiveWorkspace() {
  await ensureWorkspaceRegistry()
  await db.transaction(async (trx) => {
    const state = await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .forUpdate()
      .firstOrFail()
    if (state.active_id)
      await trx
        .from('whatsapp_workspaces')
        .where('id', state.active_id)
        .update({ archived_at: new Date() })
    await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({
        active_id: null,
        version: state.active_id ? randomUUID() : state.version,
        auth_version: randomUUID(),
        updated_at: new Date(),
      })
    await trx.from('whatsapp_connection').where('id', 1).update({
      desired_connected: false,
      status: 'disconnected',
      phone: null,
      qr_data_url: null,
      updated_at: new Date(),
    })
  })
}

export async function clearWorkspaceSession() {
  await ensureWorkspaceRegistry()
  await db.transaction(async (trx) => {
    await trx.from('whatsapp_workspace_state').where('id', 1).forUpdate().firstOrFail()
    // Hanya sesi nomor utama; sesi nomor tambahan (ln<id>|…) tetap.
    await trx.from('baileys_auth').whereNot('auth_key', 'like', 'ln%|%').delete()
    await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({ session_id: null, updated_at: new Date() })
  })
}

export async function withActiveWorkspace<T>(action: () => Promise<T>) {
  const scope = await activeWorkspace()
  if (!scope.id) throw new Error('Hubungkan nomor WhatsApp terlebih dahulu.')
  return inWorkspace(scope, action)
}

export async function registerWorkspaceWorker(workerId: string) {
  await ensureWorkspaceRegistry()
  await db.from('whatsapp_workspace_state').where('id', 1).update({ worker_id: workerId, cleanup_worker_id: workerId, reset_worker_id: workerId, contact_cleanup_worker_id: workerId })
}
/** A pre-upgrade worker must never connect a new phone using the old, unscoped code. */
export async function workspaceWorkerReady() {
  const state = await workspaceState()
  const connection = await db.from('whatsapp_connection').where('id', 1).firstOrFail()
  return Boolean(
    state.worker_id && (!connection.worker_id || connection.worker_id === state.worker_id)
  )
}
