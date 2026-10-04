import db from '#services/workspace_database'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import {
  defaultProductionPolicy,
  validateProductionPolicy,
  type ProductionPolicy,
} from '#services/production_contract'

type Row = { version: string; policy_json: string; last_adjusted_at: Date | string | null }
function decode(row?: Row): ProductionPolicy {
  return row
    ? { ...validateProductionPolicy(JSON.parse(row.policy_json)), version: row.version }
    : defaultProductionPolicy()
}
export async function readProductionPolicy() {
  await initializeDatabase()
  return decode(await db.from('whatsapp_production_policy').where('id', 1).first())
}
export async function productionOverview() {
  const policy = await readProductionPolicy()
  const settings = await db.from('whatsapp_settings').where('id', 1).first()
  const skills = await db.from('whatsapp_skills').select('name')
  const evaluationReady =
    Boolean(settings?.ai_enabled) &&
    skills.some((skill) => /(?:^|[-_\s])(eval|evaluation|evaluasi)(?:$|[-_\s])/i.test(skill.name))
  const history = await db.from('whatsapp_production_changes').orderBy('id', 'desc').limit(20)
  const signals = await db
    .from('whatsapp_production_signals')
    .where('policy_version', policy.version)
    .where('created_at', '>=', new Date(Date.now() - 30 * 86400000))
    .select('kind', 'direction')
    .countDistinct('jid as customers')
    .groupBy('kind', 'direction')
  return {
    policy,
    evaluationReady,
    history: history.map((row) => ({
      id: row.id,
      actor: row.actor,
      reason: row.reason,
      before: JSON.parse(row.before_json),
      after: JSON.parse(row.after_json),
      evidence: JSON.parse(row.evidence_json),
      createdAt: new Date(row.created_at).toISOString(),
    })),
    signals,
  }
}
export async function saveProductionPolicy(input: unknown) {
  const next = validateProductionPolicy(input)
  await initializeDatabase()
  await db.transaction(async (trx) => {
    const initial = defaultProductionPolicy()
    await trx.rawQuery(
      'INSERT IGNORE INTO whatsapp_production_policy (id,version,policy_json,updated_at) VALUES (1,?,?,?)',
      [initial.version, JSON.stringify(initial), new Date()]
    )
    const row = await trx
      .from('whatsapp_production_policy')
      .where('id', 1)
      .forUpdate()
      .firstOrFail()
    if (row.version !== next.version)
      throw new Error('Production settings changed. Reload before editing.')
    const before = decode(row)
    if (JSON.stringify(before) === JSON.stringify(next)) return
    const after = { ...next, version: randomUUID() }
    await trx
      .from('whatsapp_production_policy')
      .where('id', 1)
      .update({
        version: after.version,
        policy_json: JSON.stringify(after),
        updated_at: new Date(),
      })
    await trx.table('whatsapp_production_changes').insert({
      actor: 'owner',
      reason: 'Settings updated',
      before_json: JSON.stringify(before),
      after_json: JSON.stringify(after),
      evidence_json: '[]',
      created_at: new Date(),
    })
  })
  return productionOverview()
}
