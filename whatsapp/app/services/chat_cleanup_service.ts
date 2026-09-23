import app from '@adonisjs/core/services/app'
import env from '#start/env'
import db from '#services/workspace_database'
import { createHash, randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { ownsWorkspaceMedia, workspaceScope } from '#services/workspace_context'
import { workspaceState } from '#services/workspace_service'
import { csMediaPath } from '#services/cs_media_service'
import { resetDataManifest, resetWorkspaceData } from '#services/data_reset_service'

import {
  contactCleanupTarget,
  contactDataManifest,
  deleteContactData,
  validateContactJids,
} from '#services/contact_cleanup_service'
import { deleteLeanChatData } from '#services/lean/lean_tables'
import { deleteLeanChatData as deleteBeta3ChatData } from '#beta3/tables'

/** Serialize mutations without holding business-table locks across HTTP handlers. */
export async function withChatMutationLock<T>(work: () => Promise<T>): Promise<T> {
  const key = createHash('sha256')
    .update(`${env.get('DB_DATABASE')}:${workspaceScope().id}:chat-mutation`)
    .digest('hex')
  return db.transaction(async (trx) => {
    const [rows] = await trx.rawQuery('SELECT GET_LOCK(?, 0) AS acquired', [key])
    if (Number(rows[0]?.acquired) !== 1) throw new Error('CHAT_MUTATION_BUSY')
    try {
      return await work()
    } finally {
      await trx.rawQuery('SELECT RELEASE_LOCK(?)', [key])
    }
  })
}

export async function requestChatCleanup(
  confirmation: unknown,
  mode: unknown = 'chat',
  jid?: unknown
) {
  const target = mode === 'contact' ? await contactCleanupTarget(jid) : null
  const requestId = randomUUID()
  const scope = workspaceScope()
  if (
    !scope.id ||
    !['chat', 'all', 'contact'].includes(String(mode)) ||
    confirmation !== (target ? target.confirmation : mode === 'all' ? 'RESET ALL' : 'DELETE')
  )
    throw new Error('Konfirmasi penghapusan tidak valid.')
  await db.transaction(async (trx) => {
    const state = await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .forUpdate()
      .firstOrFail()
    if (Number(state.active_id) !== scope.id || state.version !== scope.version)
      throw new Error('Workspace berubah. Muat ulang halaman.')
    if (mode === 'all' && (!state.reset_worker_id || state.reset_worker_id !== state.worker_id))
      throw new Error('Restart WEB dan WORKER versi terbaru sebelum reset data.')
    if (
      mode === 'contact' &&
      (!state.contact_cleanup_worker_id || state.contact_cleanup_worker_id !== state.worker_id)
    )
      throw new Error('Restart WEB dan WORKER versi terbaru sebelum menghapus data pelanggan.')
    if (state.cleanup_workspace_id) throw new Error('Penghapusan lain sedang berjalan.')
    const previous = await trx.from('whatsapp_chat_cleanup').where('id', 1).first()
    // Keep the entire boundary second: WA timestamps have one-second precision.
    const cutoff = new Date(Math.floor(Date.now() / 1000) * 1000)
    await trx
      .table('whatsapp_chat_cleanup')
      .insert({
        id: 1,
        mode,
        status: 'pending',
        cutoff,
        files_json: null,
        request_id: requestId,
        target_jids_json: target ? JSON.stringify(target.jids) : null,
        history_cutoff:
          previous?.mode === 'contact' ? previous.history_cutoff : previous?.cutoff || null,
        updated_at: new Date(),
      })
      .onConflict('id')
      .merge()
    await trx
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({ cleanup_workspace_id: scope.id })
  })
  return requestId
}

export async function chatCleanupStatus() {
  const row = await db.from('whatsapp_chat_cleanup').where('id', 1).first()
  return {
    status: row?.status || 'idle',
    mode: row?.mode || 'chat',
    phone: workspaceScope().phone,
    requestId: row?.request_id || null,
    targetJids: row?.mode === 'contact' ? JSON.parse(row.target_jids_json || '[]') : [],
  }
}

/** No arbitrary URLs, recursive directories, auth files or another number's files. */
export function chatMediaFile(url: unknown): string | null {
  if (typeof url !== 'string') return null
  let parsed: URL
  try {
    parsed = new URL(url, env.get('APP_URL'))
  } catch {
    return null
  }
  if (parsed.origin !== new URL(env.get('APP_URL')).origin) return null
  const base = `${(env.get('APP_BASE_PATH') || '').replace(/\/$/, '')}/media/`
  if (!parsed.pathname.startsWith(base)) return null
  const name = parsed.pathname.slice(base.length)
  if (name.includes('/') || !ownsWorkspaceMedia(name)) return null
  if (name.slice(workspaceScope().prefix.length).startsWith('guide-')) return null
  return name
}

export function acceptsChatTimestamp(timestamp: unknown, cutoff: unknown, replay: boolean) {
  if (!cutoff) return true
  const seconds = Number(timestamp)
  if (!Number.isFinite(seconds) || seconds <= 0) return !replay
  return seconds * 1000 >= new Date(cutoff as string).getTime()
}

/** History cutoff is global for a workspace reset, but room-specific for a contact deletion. */
export async function filterDeletedChatHistory<
  T extends {
    key: { remoteJid?: string | null; remoteJidAlt?: string | null }
    messageTimestamp?: unknown
  },
>(messages: T[], replay: boolean): Promise<T[]> {
  const cleanup = await db.from('whatsapp_chat_cleanup').where('id', 1).first()
  const globalCutoff = cleanup?.mode === 'contact' ? cleanup.history_cutoff : cleanup?.cutoff
  const normalize = (jid: string | null | undefined) => (jid || '').replace(/:\d+(?=@)/, '')
  const jids = [
    ...new Set(
      messages
        .flatMap((message) => [
          normalize(message.key.remoteJid),
          normalize(message.key.remoteJidAlt),
        ])
        .filter(Boolean)
    ),
  ]
  if (!jids.length) return []
  const contacts = await db
    .from('whatsapp_contacts')
    .whereIn('jid', jids)
    .select('jid', 'phone_jid')
  const phones = new Map(contacts.map((row) => [String(row.jid), String(row.phone_jid || '')]))
  const cutoffs = new Map(
    (
      await db
        .from('whatsapp_chat_deletions')
        .whereIn('jid', [...jids, ...phones.values()].filter(Boolean))
    ).map((row) => [String(row.jid), row.cutoff])
  )
  return messages.filter(
    (message) =>
      acceptsChatTimestamp(message.messageTimestamp, globalCutoff, replay) &&
      [
        normalize(message.key.remoteJid),
        normalize(message.key.remoteJidAlt),
        phones.get(normalize(message.key.remoteJid)) || '',
      ].every((jid) => acceptsChatTimestamp(message.messageTimestamp, cutoffs.get(jid), replay))
  )
}

/** Worker calls only after socket closure (no logout) and draining all tracked work. */
export async function executeChatCleanup(
  removeFile: (path: string) => Promise<void> = unlink,
  prepareResetManifest = resetDataManifest
) {
  return withChatMutationLock(async () => {
    const scope = workspaceScope()
    if (Number((await workspaceState()).cleanup_workspace_id) !== scope.id || !scope.id) return
    let cleanup = await db.from('whatsapp_chat_cleanup').where('id', 1).firstOrFail()
    if (!['chat', 'all', 'contact'].includes(cleanup.mode)) throw new Error('Invalid cleanup mode')
    if (cleanup.mode === 'contact' && !cleanup.files_json) {
      const jids = validateContactJids(JSON.parse(cleanup.target_jids_json || 'null'))
      await db
        .from('whatsapp_chat_cleanup')
        .where('id', 1)
        .update({
          status: 'deleting',
          files_json: JSON.stringify(await contactDataManifest(jids, chatMediaFile)),
          updated_at: new Date(),
        })
      cleanup = await db.from('whatsapp_chat_cleanup').where('id', 1).firstOrFail()
    }
    if (cleanup.mode === 'all' && !cleanup.files_json) {
      await db
        .from('whatsapp_chat_cleanup')
        .where('id', 1)
        .update({
          status: 'deleting',
          files_json: JSON.stringify(await prepareResetManifest()),
          updated_at: new Date(),
        })
      cleanup = await db.from('whatsapp_chat_cleanup').where('id', 1).firstOrFail()
    }
    if (!cleanup.files_json) {
      // Orders and their proof/reference media are not chat-only data.
      const preserved: string[] = []
      for (const table of [
        'whatsapp_carts',
        'whatsapp_orders',
        'whatsapp_payment_reviews',
        'whatsapp_order_payments',
        'whatsapp_cart_events',
        'whatsapp_order_message_evidence',
      ]) {
        const rows = await db.from(table).select('*')
        for (const row of rows)
          preserved.push(
            JSON.stringify(row),
            ...Object.values(row).filter((value): value is string => typeof value === 'string')
          )
      }
      const files = new Set<string>()
      const messages = await db
        .from('whatsapp_messages')
        .where('created_at', '<', cleanup.cutoff)
        .select(
          'message_id',
          'reply_to_message_id',
          'media_url',
          'thumbnail_url',
          'media_upload_id'
        )
      const newer = await db
        .from('whatsapp_messages')
        .where('created_at', '>=', cleanup.cutoff)
        .select('media_url', 'thumbnail_url', 'media_upload_id')
      for (const row of newer) preserved.push(JSON.stringify(row))
      const evidenceIds = new Set(
        messages
          .filter((row) => preserved.some((text) => text.includes(JSON.stringify(row.message_id))))
          .map((row) => row.message_id)
      )
      // A payment report can quote its image; keep that source as order evidence too.
      for (let changed = true; changed;) {
        changed = false
        for (const row of messages) {
          if (
            evidenceIds.has(row.message_id) &&
            row.reply_to_message_id &&
            !evidenceIds.has(row.reply_to_message_id)
          ) {
            evidenceIds.add(row.reply_to_message_id)
            changed = true
          }
        }
      }
      for (const message of messages.filter((row) => evidenceIds.has(row.message_id))) {
        const source = await db
          .from('whatsapp_messages')
          .where('message_id', message.message_id)
          .firstOrFail()
        await db
          .table('whatsapp_order_message_evidence')
          .insert(source)
          .onConflict('message_id')
          .ignore()
        preserved.push(JSON.stringify(message))
      }
      for (const message of messages) {
        if (evidenceIds.has(message.message_id)) continue
        for (const value of [message.media_url, message.thumbnail_url]) {
          const name = chatMediaFile(value)
          if (name && !preserved.some((text) => text.includes(name))) files.add(`media/${name}`)
        }
        const id = message.media_upload_id
        if (id && !preserved.some((text) => text.includes(id))) {
          csMediaPath(id) // Validate the ID before saving the deletion manifest.
          files.add(`upload/${id}`)
        }
      }
      await db
        .from('whatsapp_chat_cleanup')
        .where('id', 1)
        .update({
          status: 'deleting',
          files_json: JSON.stringify([...files]),
          updated_at: new Date(),
        })
      cleanup = await db.from('whatsapp_chat_cleanup').where('id', 1).firstOrFail()
    }
    // Keep the manifest until completion so a crash or permission error is retryable.
    for (const item of JSON.parse(cleanup.files_json) as string[]) {
      let path: string
      if (item.startsWith('upload/')) path = csMediaPath(item.slice(7))
      else {
        const name = item.slice(6)
        if (
          !item.startsWith('media/') ||
          name.includes('/') ||
          !ownsWorkspaceMedia(name) ||
          name.slice(scope.prefix.length).startsWith('guide-')
        )
          throw new Error('Invalid media manifest')
        path = app.makePath('public', 'media', name)
      }
      try {
        await removeFile(path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await db.transaction(async (trx) => {
      const state = await trx
        .from('whatsapp_workspace_state')
        .where('id', 1)
        .forUpdate()
        .firstOrFail()
      if (Number(state.cleanup_workspace_id) !== scope.id)
        throw new Error('Workspace changed during cleanup')
      if (cleanup.mode === 'all') await resetWorkspaceData(trx)
      else if (cleanup.mode === 'contact')
        await deleteContactData(
          trx,
          JSON.parse(cleanup.target_jids_json || 'null'),
          new Date(Math.ceil(Date.now() / 1000) * 1000)
        )
      else {
        for (const table of [
          'whatsapp_evidence_cache',
          'whatsapp_customer_memory',
          'whatsapp_sync_retries',
          'whatsapp_ai_reviews',
          'whatsapp_chat_goals',
          'whatsapp_conversation_evaluations',
        ])
          await trx.from(table).delete()
        for (const table of [
          'whatsapp_messages',
          'whatsapp_reactions',
          'whatsapp_ai_traces',
          'whatsapp_evaluation_history',
        ])
          await trx.from(table).where('created_at', '<', cleanup.cutoff).delete()
        // Keep learned rules/rollback history, remove references to deleted chats.
        await trx
          .from('whatsapp_learning_versions')
          .where('created_at', '<', cleanup.cutoff)
          .update({ evidence_json: '[]' })
        for (const table of ['whatsapp_payment_wait_notices', 'whatsapp_approval_wait_episodes'])
          await trx
            .from(table)
            .where('created_at', '<', cleanup.cutoff)
            .whereIn('status', ['pending', 'preparing'])
            .update({ status: 'cancelled', updated_at: new Date() })
        await trx.from('whatsapp_contacts').update({
          activity: null,
          activity_updated_at: null,
          chat_note: null,
          workspace_read_id: 0,
        })
        await deleteLeanChatData(trx)
        await deleteBeta3ChatData(trx)
      }
      await trx
        .from('whatsapp_chat_cleanup')
        .where('id', 1)
        .update({
          status: 'completed',
          files_json: null,
          updated_at: new Date(),
          ...(cleanup.mode === 'all'
            ? { cutoff: new Date(Math.ceil(Date.now() / 1000) * 1000) }
            : {}),
        })
      await trx
        .from('whatsapp_workspace_state')
        .where('id', 1)
        .update({ cleanup_workspace_id: null, version: randomUUID(), updated_at: new Date() })
    })
  })
}
