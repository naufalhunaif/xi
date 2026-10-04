import db from '#services/workspace_database'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
async function ensureRouting(trx?: TransactionClientContract) {
  const client = trx || db
  await client.rawQuery(
    'INSERT IGNORE INTO whatsapp_order_routing (id,version,updated_at) VALUES (1,?,?)',
    [randomUUID(), new Date()]
  )
}
async function groupAllowed(jid: unknown, trx?: TransactionClientContract) {
  if (jid === null || jid === '') return null
  if (typeof jid !== 'string' || !/^[0-9-]+@g\.us$/.test(jid))
    throw new Error('Pilih grup yang tersedia.')
  if (
    !(await (trx || db)
      .from('whatsapp_order_groups')
      .where('jid', jid)
      .where('available', true)
      .first())
  )
    throw new Error('Grup belum tersedia. Perbarui daftar grup.')
  return jid
}
const triggerValue = (value: unknown) => {
  if (value !== 'first_payment' && value !== 'fully_paid')
    throw new Error('Pemicu pembayaran tidak valid.')
  return value
}
export async function orderRouting() {
  await initializeDatabase()
  await ensureRouting()
  const row = await db.from('whatsapp_order_routing').where('id', 1).firstOrFail()
  return {
    version: row.version,
    groupJid: row.group_jid,
    paymentTrigger: row.payment_trigger,
    groupsUpdatedAt: row.groups_updated_at,
    refreshRequested: Boolean(row.refresh_requested),
    groups: await db
      .from('whatsapp_order_groups')
      .where('available', true)
      .orderBy('name', 'asc')
      .select('jid', 'name'),
  }
}
export async function saveOrderRouting(input: Record<string, unknown>) {
  await initializeDatabase()
  await ensureRouting()
  const group = await groupAllowed(input.groupJid)
  const trigger = triggerValue(input.paymentTrigger)
  const updated = await db
    .from('whatsapp_order_routing')
    .where('id', 1)
    .where('version', String(input.version))
    .update({
      group_jid: group,
      payment_trigger: trigger,
      version: randomUUID(),
      updated_at: new Date(),
    })
  if (!updated) throw new Error('Pengaturan berubah. Muat ulang terlebih dahulu.')
  return orderRouting()
}
export async function requestOrderGroups() {
  await initializeDatabase()
  await ensureRouting()
  await db.from('whatsapp_order_routing').where('id', 1).update({ refresh_requested: true })
}
export async function cacheOrderGroups(
  groups: Array<{ id: string; subject?: string; isCommunity?: boolean }>
) {
  await db.transaction(async (trx) => {
    await ensureRouting(trx)
    await trx.from('whatsapp_order_groups').update({ available: false })
    for (const group of groups) {
      if (!/^[0-9-]+@g\.us$/.test(group.id) || group.isCommunity) continue
      await trx.rawQuery(
        `INSERT INTO whatsapp_order_groups (jid,name,available,updated_at) VALUES (?,?,1,?)
        ON DUPLICATE KEY UPDATE name=VALUES(name),available=1,updated_at=VALUES(updated_at)`,
        [group.id, String(group.subject || group.id).slice(0, 255), new Date()]
      )
    }
    await trx
      .from('whatsapp_order_routing')
      .where('id', 1)
      .update({ refresh_requested: false, groups_updated_at: new Date() })
  })
}
