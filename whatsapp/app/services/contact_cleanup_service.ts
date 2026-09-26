import db from '#services/workspace_database'
import { inWorkspace, workspaceScope } from '#services/workspace_context'
import { csMediaPath } from '#services/cs_media_service'
import { deleteLeanChatData } from '#services/lean/lean_tables'
import { deleteLeanChatData as deleteBeta3ChatData } from '#beta3/tables'

const CUSTOMER_JID = /^\d{5,20}@(s\.whatsapp\.net|lid)$/
export const CONTACT_DATA_TABLES = [
  'whatsapp_shipping_notices',
  'whatsapp_customer_balance_entries',
  'whatsapp_payment_reviews',
  'whatsapp_order_message_evidence',
  'whatsapp_cart_events',
  'whatsapp_carts',
  'whatsapp_orders',
  'whatsapp_payment_wait_notices',
  'whatsapp_approval_wait_episodes',
  'whatsapp_customer_memory',
  'whatsapp_sync_retries',
  'whatsapp_ai_reviews',
  'whatsapp_chat_goals',
  'whatsapp_conversation_evaluations',
  'whatsapp_evaluation_history',
  'whatsapp_ai_traces',
  'whatsapp_production_signals',
  'whatsapp_reactions',
  'whatsapp_messages',
] as const
export const CONTACT_ORDER_TABLES = [
  'whatsapp_order_group_parts',
  'whatsapp_order_group_jobs',
  'whatsapp_order_shipping_jobs',
  'whatsapp_order_operation_events',
  'whatsapp_order_operations',
  'whatsapp_order_payments',
] as const

/** Only aliases explicitly recorded by WhatsApp are joined, never a name/address match. */
export async function contactCleanupTarget(value: unknown) {
  if (typeof value !== 'string' || !CUSTOMER_JID.test(value))
    throw new Error('Pilih room pelanggan yang valid.')
  const contact = await db.from('whatsapp_contacts').where('jid', value).first()
  if (!contact && !(await db.from('whatsapp_messages').where('jid', value).first()))
    throw new Error('Pelanggan tidak ditemukan di nomor aktif.')
  const phoneJid = value.endsWith('@s.whatsapp.net')
    ? value
    : CUSTOMER_JID.test(contact?.phone_jid || '') && contact.phone_jid.endsWith('@s.whatsapp.net')
      ? (contact.phone_jid as string)
      : null
  const aliases = phoneJid
    ? await db
        .from('whatsapp_contacts')
        .where('phone_jid', phoneJid)
        .orWhere('jid', phoneJid)
        .select('jid')
    : []
  const jids = [
    ...new Set([value, ...(phoneJid ? [phoneJid] : []), ...aliases.map((row) => String(row.jid))]),
  ].filter((jid) => CUSTOMER_JID.test(jid))
  const phone = phoneJid?.split('@')[0] || null
  return {
    jid: value,
    jids,
    name: contact?.name || '',
    phone,
    confirmation: `HAPUS ${phone || value}`,
  }
}

export function validateContactJids(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((jid) => typeof jid !== 'string' || !CUSTOMER_JID.test(jid))
  )
    throw new Error('Target penghapusan pelanggan tidak valid.')
  return [...new Set(value)]
}

export async function contactCleanupPreview(jid: unknown) {
  const target = await contactCleanupTarget(jid)
  const count = async (table: string) =>
    Number(
      (await db.from(table).whereIn('jid', target.jids).count('* as total').first())?.total || 0
    )
  const [messages, memory, orders, carts, media] = await Promise.all([
    count('whatsapp_messages'),
    count('whatsapp_customer_memory'),
    count('whatsapp_orders'),
    count('whatsapp_carts'),
    db
      .from('whatsapp_messages')
      .whereIn('jid', target.jids)
      .where((q) =>
        q
          .whereNotNull('media_url')
          .orWhereNotNull('media_upload_id')
          .orWhereNotNull('thumbnail_url')
      )
      .count('* as total')
      .first(),
  ])
  return {
    ...target,
    counts: { messages, memory, orders, carts, media: Number(media?.total || 0) },
  }
}

/** Enumerate references rather than deleting every file with the workspace prefix. */
export async function contactDataManifest(
  jids: string[],
  mediaFile: (url: unknown) => string | null
) {
  validateContactJids(jids)
  const candidates = new Set<string>()
  const preserved = new Set<string>()
  const collect = (value: unknown, result: Set<string>, key = '') => {
    if (typeof value === 'string') {
      if (key === 'media_upload_id' && value) {
        csMediaPath(value)
        result.add(`upload/${value}`)
      }
      const name = mediaFile(value)
      if (name) result.add(`media/${name}`)
      try {
        const parsed = JSON.parse(value)
        if (typeof parsed === 'object' && parsed) collect(parsed, result)
      } catch {}
      for (const url of value.match(/https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+/g) || []) {
        const nested = mediaFile(url)
        if (nested) result.add(`media/${nested}`)
      }
    } else if (Array.isArray(value)) for (const item of value) collect(item, result)
    else if (value && typeof value === 'object')
      for (const [field, item] of Object.entries(value)) collect(item, result, field)
  }
  for (const table of [...CONTACT_DATA_TABLES, ...CONTACT_ORDER_TABLES]) {
    const byOrder = (CONTACT_ORDER_TABLES as readonly string[]).includes(table)
    const column = byOrder ? 'order_id' : 'jid'
    const orderIds = db.from('whatsapp_orders').whereIn('jid', jids).select('id')
    const keys: Record<string, string[]> = {
      whatsapp_customer_memory: ['jid', 'fact_key'],
      whatsapp_production_signals: ['jid', 'kind', 'policy_version'],
      whatsapp_order_group_parts: ['order_id', 'part_index'],
      whatsapp_order_group_jobs: ['order_id'],
      whatsapp_order_shipping_jobs: ['order_id'],
      whatsapp_order_operations: ['order_id'],
      whatsapp_shipping_notices: ['order_id'],
      whatsapp_carts: ['jid'],
      whatsapp_sync_retries: ['message_id'],
      whatsapp_ai_reviews: ['jid'],
      whatsapp_chat_goals: ['jid'],
      whatsapp_conversation_evaluations: ['jid'],
    }
    // Use SQL paging, including composite-key tables, without loading the entire archive into memory.
    for (const matching of [true, false]) {
      let offset = 0
      while (true) {
        const query = db.from(table).select('*')
        for (const key of keys[table] || ['id']) query.orderBy(key)
        if (byOrder) {
          if (matching) query.whereIn(column, orderIds.clone())
          else query.whereNotIn(column, orderIds.clone())
        } else {
          if (matching) query.whereIn(column, jids)
          else query.whereNotIn(column, jids)
        }
        const rows = await query.offset(offset).limit(250)
        for (const row of rows) collect(row, matching ? candidates : preserved)
        if (rows.length < 250) break
        offset += rows.length
      }
    }
  }
  // Upload UUIDs are not workspace-prefixed. Protect any use by another workspace too.
  const uploads = [...candidates]
    .filter((file) => file.startsWith('upload/'))
    .map((file) => file.slice(7))
  if (uploads.length) {
    const current = workspaceScope()
    for (const row of await db.from('whatsapp_workspaces').whereNot('id', current.id)) {
      const id = Number(row.id)
      await inWorkspace(
        { id, prefix: id === 1 ? '' : `w${id}_`, phone: row.phone, version: '' },
        async () => {
          for (const table of ['whatsapp_messages', 'whatsapp_order_message_evidence']) {
            try {
              for (const item of await db
                .from(table)
                .whereIn('media_upload_id', uploads)
                .select('media_upload_id'))
                preserved.add(`upload/${item.media_upload_id}`)
            } catch (error) {
              if ((error as { code?: string }).code !== 'ER_NO_SUCH_TABLE') throw error
            }
          }
        }
      )
    }
  }
  return [...candidates].filter((file) => !preserved.has(file))
}

/** Executed only after the worker has stopped ingestion and drained all jobs. */
export async function deleteContactData(trx: any, targetJids: unknown, cutoff: Date) {
  const jids = validateContactJids(targetJids)
  const orders = await trx.from('whatsapp_orders').whereIn('jid', jids).select('id')
  const ids = orders.map((row: { id: number }) => row.id)
  for (const table of CONTACT_ORDER_TABLES)
    if (ids.length) await trx.from(table).whereIn('order_id', ids).delete()
  for (const table of CONTACT_DATA_TABLES) await trx.from(table).whereIn('jid', jids).delete()
  await deleteLeanChatData(trx, jids)
  await deleteBeta3ChatData(trx, jids)
  // Keys are opaque hashes and can contain room-specific observations; invalidate the
  // temporary cache, retaining every other customer's durable facts/orders/messages.
  await trx.from('whatsapp_evidence_cache').delete()
  for (const table of ['whatsapp_learning_versions', 'whatsapp_production_changes']) {
    for (const row of await trx.from(table).select('id', 'evidence_json')) {
      const evidence = JSON.parse(row.evidence_json || '[]')
      if (!Array.isArray(evidence)) continue
      const kept = evidence.filter((item) => !jids.includes(item?.jid))
      if (kept.length !== evidence.length)
        await trx
          .from(table)
          .where('id', row.id)
          .update({ evidence_json: JSON.stringify(kept) })
    }
  }
  await trx.from('whatsapp_contacts').whereIn('jid', jids).update({
    activity: null,
    activity_updated_at: null,
    handling_mode: 'ai',
    handoff_reason: null,
    handoff_at: null,
    chat_note: null,
    workspace_read_id: 0,
  })
  for (const jid of jids)
    await trx.table('whatsapp_chat_deletions').insert({ jid, cutoff }).onConflict('jid').merge()
}
