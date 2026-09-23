import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'
import { readdir } from 'node:fs/promises'
import { ownsWorkspaceMedia, workspaceScope } from '#services/workspace_context'
import { csMediaPath } from '#services/cs_media_service'

/** Explicit allowlist. Never discover/drop tables or touch credentials/configuration. */
export const RESET_DATA_TABLES = [
  'whatsapp_order_group_parts',
  'whatsapp_order_group_jobs',
  'whatsapp_shipping_notices',
  'whatsapp_order_shipping_jobs',
  'whatsapp_order_operation_events',
  'whatsapp_order_operations',
  'whatsapp_customer_balance_entries',
  'whatsapp_order_payments',
  'whatsapp_payment_reviews',
  'whatsapp_order_message_evidence',
  'whatsapp_cart_events',
  'whatsapp_carts',
  'whatsapp_orders',
  'whatsapp_payment_wait_notices',
  'whatsapp_approval_wait_episodes',
  'whatsapp_evidence_cache',
  'whatsapp_customer_memory',
  'whatsapp_sync_retries',
  'whatsapp_ai_reviews',
  'whatsapp_chat_goals',
  'whatsapp_conversation_evaluations',
  'whatsapp_evaluation_history',
  'whatsapp_ai_traces',
  'whatsapp_production_signals',
  'whatsapp_production_changes',
  'whatsapp_reactions',
  'whatsapp_messages',
] as const

/** Called after the worker has drained all work. The caller persists this manifest for retries. */
export async function resetDataManifest(
  listMedia = () => readdir(app.makePath('public', 'media'), { withFileTypes: true })
) {
  const scope = workspaceScope()
  if (!scope.id) throw new Error('Invalid reset workspace')
  const files = new Set<string>()
  // Flat, workspace-prefixed media only. Profiles and guide/tutorial assets are retained.
  const entries = await listMedia().catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (
      entry.isFile() &&
      ownsWorkspaceMedia(entry.name) &&
      !entry.name.slice(scope.prefix.length).startsWith('guide-')
    )
      files.add(`media/${entry.name}`)
  }
  // Uploads use unprefixed UUIDs; only IDs owned by this workspace's message rows qualify.
  for (const table of ['whatsapp_messages', 'whatsapp_order_message_evidence']) {
    let after = 0
    while (true) {
      const rows = await db
        .from(table)
        .select('id', 'media_upload_id')
        .where('id', '>', after)
        .orderBy('id')
        .limit(500)
      if (!rows.length) break
      for (const row of rows)
        if (row.media_upload_id) {
          csMediaPath(row.media_upload_id)
          files.add(`upload/${row.media_upload_id}`)
        }
      after = Number(rows.at(-1)!.id)
    }
  }
  return [...files]
}

export async function resetWorkspaceData(trx: any) {
  if (!workspaceScope().id) throw new Error('Invalid reset workspace')
  for (const table of RESET_DATA_TABLES) await trx.from(table).delete()
  // Preserve skills (including learned generic rules) but erase their conversation evidence.
  await trx.from('whatsapp_learning_versions').update({ evidence_json: '[]', error: null })
  // Basic address-book identity and AI exclusions are configuration, not conversation memory.
  await trx.from('whatsapp_contacts').update({
    activity: null,
    activity_updated_at: null,
    handling_mode: 'ai',
    handoff_reason: null,
    handoff_at: null,
    chat_note: null,
    workspace_read_id: 0,
  })
}
