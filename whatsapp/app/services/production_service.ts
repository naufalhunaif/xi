import db from '#services/workspace_database'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import {
  defaultProductionPolicy,
  validateProductionPolicy,
  type ProductionPolicy,
  type ProductionSignal,
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

/** Only called after a fresh, evidence-validated evaluation commits. No customer sends. */
export async function recordProductionSignal(
  jid: string,
  version: string,
  signal: ProductionSignal | null,
  transaction?: TransactionClientContract
) {
  const apply = async (trx: TransactionClientContract) => {
    const row = await trx.from('whatsapp_production_policy').where('id', 1).forUpdate().first()
    if (!row || row.version !== version) return
    const settings = await trx.from('whatsapp_settings').where('id', 1).first()
    if (!settings?.ai_enabled) return
    // A later evaluation may retract earlier observations for the same customer.
    await trx
      .from('whatsapp_production_signals')
      .where('jid', jid)
      .where('policy_version', version)
      .delete()
    if (!signal) return
    const before = decode(row)
    const rule = before.rules[signal.kind]
    if (!rule.enabled) return
    const previous = await trx
      .from('whatsapp_production_signals')
      .where('jid', jid)
      .where('kind', signal.kind)
      .whereNot('policy_version', version)
      .select('evidence_json')
    if (
      previous.some((item) =>
        JSON.parse(item.evidence_json).some((id: string) => signal.evidenceMessageIds.includes(id))
      )
    )
      return
    await trx.rawQuery(
      `INSERT INTO whatsapp_production_signals
      (jid,kind,policy_version,direction,reason,evidence_json,created_at) VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE direction=VALUES(direction),reason=VALUES(reason),evidence_json=VALUES(evidence_json),created_at=VALUES(created_at)`,
      [
        jid,
        signal.kind,
        version,
        signal.direction,
        signal.reason,
        JSON.stringify(signal.evidenceMessageIds),
        new Date(),
      ]
    )
    if (
      !before.autoAdjust ||
      (row.last_adjusted_at && Date.now() - new Date(row.last_adjusted_at).getTime() < 7 * 86400000)
    )
      return
    const voteQuery = () =>
      trx
        .from('whatsapp_production_signals')
        .where('policy_version', version)
        .where('kind', signal.kind)
        .where('created_at', '>=', new Date(Date.now() - 30 * 86400000))
    const counts = await voteQuery().select('direction').count('* as count').groupBy('direction')
    const votes = counts.reduce((total, item) => total + Number(item.count), 0)
    const agreeingCount = Number(
      counts.find((item) => item.direction === signal.direction)?.count || 0
    )
    // At least three independent rooms; mixed evidence requires an 80% majority.
    if (agreeingCount < 3 || agreeingCount / votes < 0.8) return
    const estimate = rule.estimateDays! + (signal.direction === 'shorter' ? -1 : 1)
    if (estimate < rule.minDays! || estimate > rule.maxDays!) return
    const agreeing = await voteQuery()
      .where('direction', signal.direction)
      .orderBy('created_at', 'desc')
      .limit(10)
    const after: ProductionPolicy = {
      ...before,
      version: randomUUID(),
      rules: {
        ...before.rules,
        [signal.kind]: { ...rule, estimateDays: estimate },
      },
    }
    await trx
      .from('whatsapp_production_policy')
      .where('id', 1)
      .update({
        version: after.version,
        policy_json: JSON.stringify(after),
        last_adjusted_at: new Date(),
        updated_at: new Date(),
      })
    await trx.table('whatsapp_production_changes').insert({
      actor: 'ai_eval',
      reason: `${signal.kind}: ${agreeingCount}/${votes} customer observations. ${signal.reason}`,
      before_json: JSON.stringify(before),
      after_json: JSON.stringify(after),
      evidence_json: JSON.stringify(
        agreeing.map((vote) => ({
          jid: vote.jid,
          messageIds: JSON.parse(vote.evidence_json),
          reason: vote.reason,
        }))
      ),
      created_at: new Date(),
    })
  }
  if (transaction) return apply(transaction)
  await db.transaction(apply)
}
