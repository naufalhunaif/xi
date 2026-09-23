import { createHash, randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { readSettings } from '#services/settings_service'
import { workspaceScope } from '#services/workspace_context'
import { replayLearningWithAi } from '#services/ai_service'
import { evaluationSignature } from '#services/conversation_evaluation_service'
import { evaluationSkills } from '#services/evaluation_contract'
import { aiFailureDetail } from '#services/ai_failure_service'
import { LEARNING_RULES, LEARNING_SKILL, aggregateLearning, learningContent, scoreLearningReplay, learningImproves, type LearningRule } from '#services/learning_contract'

type Settings = Awaited<ReturnType<typeof readSettings>>
export class LearningConflict extends Error {}
const parseRules = (value: string): LearningRule[] => {
  const rules = JSON.parse(value)
  if (!Array.isArray(rules) || rules.some(rule => !Object.hasOwn(LEARNING_RULES, rule))) throw new LearningConflict('Versi pembelajaran tidak valid.')
  return rules
}
export function learningSignature(settings: Settings) {
  return createHash('sha256').update(JSON.stringify([
    evaluationSignature(settings), settings.chatgptReasoning, settings.claudeReasoning,
    settings.chatgptSpeed, settings.claudeSpeed,
  ])).digest('hex')
}
async function initializeLearning() {
  await initializeDatabase()
  await db.rawQuery(`INSERT IGNORE INTO whatsapp_learning_state (id,enabled,revision,rules_json,updated_at) VALUES (1,0,?,'[]',?)`, [randomUUID(), new Date()])
}
async function assertWorkspace(trx: any) {
  const state = await trx.from('whatsapp_workspace_state').where('id', 1).forUpdate().first()
  if (!workspaceScope().id || Number(state?.active_id) !== workspaceScope().id || state?.version !== workspaceScope().version)
    throw new LearningConflict('Workspace berubah. Muat ulang halaman.')
}
async function findings(settings: Settings) {
  const [rows] = await db.rawQuery(`SELECT e.jid, e.result_json FROM whatsapp_conversation_evaluations e
    WHERE e.status='completed' AND e.skill_signature=? AND e.updated_at>=?
      AND EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.id=e.anchor_id AND m.jid=e.jid)
      AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.jid=e.jid AND m.id>e.anchor_id AND m.status NOT IN ('queued','failed'))
      AND NOT EXISTS (SELECT 1 FROM whatsapp_cart_events c WHERE c.jid=e.jid AND c.id>e.event_id)
    ORDER BY e.updated_at DESC LIMIT 500`, [evaluationSignature(settings), new Date(Date.now() - 30 * 86400_000)])
  return aggregateLearning(rows)
}
async function managedSkill(trx: any, state: any) {
  const skill = await trx.from('whatsapp_skills').where('name', LEARNING_SKILL).forUpdate().first()
  const rules = parseRules(state.rules_json)
  if (state.skill_id) {
    if (!skill || Number(skill.id) !== Number(state.skill_id) || skill.content !== learningContent(rules))
      throw new LearningConflict('Skill pembelajaran diubah manual; perubahan otomatis ditahan.')
  } else if (skill) throw new LearningConflict('Nama conversation-learning sudah digunakan; tidak ditimpa.')
  return skill
}
async function writeRules(trx: any, state: any, rules: LearningRule[]) {
  const skill = await managedSkill(trx, state)
  const values = { name: LEARNING_SKILL, description: 'Pembelajaran percakapan teruji; kebijakan utama tetap berlaku.', content: learningContent(rules), updated_at: new Date() }
  if (skill) {
    await trx.from('whatsapp_skills').where('id', skill.id).update(values)
    return Number(skill.id)
  }
  const [id] = await trx.table('whatsapp_skills').insert({ ...values, created_at: new Date() })
  return Number(id)
}

export async function setLearningEnabled(enabled: boolean, revision: string) {
  await initializeLearning()
  await db.transaction(async trx => {
    await assertWorkspace(trx)
    const state = await trx.from('whatsapp_learning_state').where('id', 1).forUpdate().firstOrFail()
    if (state.revision !== revision) throw new LearningConflict('Pengaturan berubah. Muat ulang halaman.')
    await trx.from('whatsapp_learning_state').where('id', 1).update({ enabled, revision: randomUUID(), updated_at: new Date() })
  })
}

/** Called only by the worker's idle evaluation pass. Two replay calls, max once/day/workspace. */
export async function runConversationLearning(settings: Settings, replay = replayLearningWithAi) {
  if (!settings.aiEnabled || !evaluationSkills(settings.skills).length) return false
  await initializeLearning()
  // Failed/crashed tests must never be interpreted as permission to activate a skill.
  await db.from('whatsapp_learning_versions').where('status', 'testing')
    .where('updated_at', '<', new Date(Date.now() - 30 * 60_000))
    .update({ status: 'failed', error: 'Simulasi terputus; skill tidak diubah.', updated_at: new Date() })
  const state = await db.from('whatsapp_learning_state').where('id', 1).firstOrFail()
  if (!state.enabled || (state.next_run_at && new Date(state.next_run_at) > new Date())) return false
  const supplement = settings.skills.find(skill => skill.name === LEARNING_SKILL)
  if (state.skill_id ? !supplement || supplement.id !== Number(state.skill_id) || supplement.content !== learningContent(parseRules(state.rules_json)) : Boolean(supplement)) return false
  const patterns = await findings(settings)
  const active = parseRules(state.rules_json)
  const signature = learningSignature(settings)
  const versions = await db.from('whatsapp_learning_versions').select('rule_key', 'base_signature', 'status')
  const candidate = patterns.find(pattern => pattern.eligible && !active.includes(pattern.kind as LearningRule) &&
    !versions.some(row => row.rule_key === pattern.kind && (row.status === 'rolled_back' || (row.base_signature === signature && row.status !== 'failed'))) &&
    versions.filter(row => row.rule_key === pattern.kind && row.base_signature === signature && row.status === 'failed').length < 3)
  if (!candidate) return false
  const claimed = await db.transaction(async trx => {
    await assertWorkspace(trx)
    const config = await trx.from('whatsapp_settings').where('id', 1).forUpdate().firstOrFail()
    const locked = await trx.from('whatsapp_learning_state').where('id', 1).forUpdate().firstOrFail()
    if (!locked.enabled || locked.revision !== state.revision || (locked.next_run_at && new Date(locked.next_run_at) > new Date())) return null
    await managedSkill(trx, locked)
    const after = [...active, candidate.kind as LearningRule]
    const [id] = await trx.table('whatsapp_learning_versions').insert({
      rule_key: candidate.kind, status: 'testing', base_signature: signature, state_revision: locked.revision,
      before_rules_json: JSON.stringify(active), after_rules_json: JSON.stringify(after),
      evidence_json: JSON.stringify(candidate.evidence), created_at: new Date(), updated_at: new Date(),
    })
    await trx.from('whatsapp_learning_state').where('id', 1).update({ next_run_at: new Date(Date.now() + 86400_000) })
    return { id: Number(id), after, config: JSON.stringify(config) }
  })
  if (!claimed) return false
  try {
    if (learningSignature(await readSettings(true)) !== signature) throw new LearningConflict('Skill atau model berubah saat simulasi.')
    const before = scoreLearningReplay(await replay(settings))
    // Same model/options, existing skills intact. Only the reviewed learning supplement differs.
    const current = await readSettings(true)
    if (learningSignature(current) !== signature) throw new LearningConflict('Skill atau model berubah saat simulasi.')
    const candidateSettings = { ...settings, skills: [
      ...settings.skills.filter(skill => skill.name !== LEARNING_SKILL),
      { id: Number(state.skill_id || 0), name: LEARNING_SKILL, content: learningContent(claimed.after), description: '', updatedAt: '', updatedAtLabel: '' },
    ] }
    const after = scoreLearningReplay(await replay(candidateSettings))
    const fresh = await readSettings(true)
    const freshPattern = (await findings(fresh)).find(pattern => pattern.kind === candidate.kind)
    if (!freshPattern?.eligible) throw new LearningConflict('Bukti percakapan berubah; kandidat tidak diterapkan.')
    const eligible = learningImproves(before, after)
    await db.transaction(async trx => {
      await assertWorkspace(trx)
      // Serialize with manual skill edits and normal settings saves.
      const lockedConfig = await trx.from('whatsapp_settings').where('id', 1).forUpdate().firstOrFail()
      const locked = await trx.from('whatsapp_learning_state').where('id', 1).forUpdate().firstOrFail()
      const job = await trx.from('whatsapp_learning_versions').where('id', claimed.id).forUpdate().firstOrFail()
      const skills = await trx.from('whatsapp_skills').orderBy('id', 'asc').forUpdate()
      const liveSkills = skills.map(skill => [Number(skill.id), skill.name, String(skill.content || '')])
      const expectedSkills = fresh.skills.map(skill => [skill.id, skill.name, skill.content])
      if (job.status !== 'testing' || !locked.enabled || locked.revision !== state.revision ||
        !fresh.aiEnabled || learningSignature(fresh) !== signature || JSON.stringify(lockedConfig) !== claimed.config ||
        JSON.stringify(liveSkills) !== JSON.stringify(expectedSkills))
        throw new LearningConflict('Konteks pembelajaran berubah; kandidat tidak diterapkan.')
      await managedSkill(trx, locked)
      if (eligible) {
        const skillId = await writeRules(trx, locked, claimed.after)
        await trx.from('whatsapp_learning_state').where('id', 1).update({
          active_version: claimed.id, skill_id: skillId, rules_json: JSON.stringify(claimed.after), revision: randomUUID(), updated_at: new Date(),
        })
      }
      await trx.from('whatsapp_learning_versions').where('id', claimed.id).update({
        status: eligible ? 'applied' : 'rejected', tests_json: JSON.stringify({ before, after, kind: 'synthetic_replay', provesConversionLift: false }),
        error: eligible ? null : 'Belum mengungguli versi lama atau uji pengaman belum lolos.', updated_at: new Date(),
      })
    })
    return eligible
  } catch (error) {
    await db.from('whatsapp_learning_versions').where('id', claimed.id).where('status', 'testing').update({
      status: 'failed', error: error instanceof LearningConflict ? error.message : aiFailureDetail(error, { stage: 'provider', provider: settings.aiProvider === 'claude' ? 'claude' : 'chatgpt' }).message, updated_at: new Date(),
    })
    return false
  }
}

/** Roll back the latest applied version only; never overwrite unrelated/manual skill edits. */
export async function rollbackLearning(id: number, revision: string, actor: string) {
  await initializeLearning()
  await db.transaction(async trx => {
    await assertWorkspace(trx)
    await trx.from('whatsapp_settings').where('id', 1).forUpdate().firstOrFail()
    const state = await trx.from('whatsapp_learning_state').where('id', 1).forUpdate().firstOrFail()
    if (state.revision !== revision || Number(state.active_version) !== id) throw new LearningConflict('Versi aktif berubah. Muat ulang halaman.')
    const version = await trx.from('whatsapp_learning_versions').where('id', id).forUpdate().firstOrFail()
    if (version.status !== 'applied') throw new LearningConflict('Versi ini tidak dapat dikembalikan.')
    const rules = parseRules(version.before_rules_json)
    await writeRules(trx, state, rules)
    const previous = await trx.from('whatsapp_learning_versions').where('status', 'applied').where('id', '<', id).orderBy('id', 'desc').first()
    await trx.from('whatsapp_learning_versions').where('id', id).update({ status: 'rolled_back', actor: actor.slice(0, 190), updated_at: new Date() })
    await trx.from('whatsapp_learning_state').where('id', 1).update({
      enabled: false, active_version: previous?.id || null, rules_json: JSON.stringify(rules), revision: randomUUID(), updated_at: new Date(),
    })
  })
}

export async function learningOverview() {
  await initializeLearning()
  const settings = await readSettings(true)
  const state = await db.from('whatsapp_learning_state').where('id', 1).firstOrFail()
  const patterns = await findings(settings)
  const versions = await db.from('whatsapp_learning_versions').orderBy('id', 'desc').limit(30)
  const skill = settings.skills.find(item => item.name === LEARNING_SKILL)
  const blocked = state.skill_id
    ? (!skill || skill.id !== Number(state.skill_id) || skill.content !== learningContent(parseRules(state.rules_json)))
    : Boolean(skill)
  return {
    enabled: Boolean(state.enabled), revision: state.revision, activeVersion: Number(state.active_version) || null,
    ready: settings.aiEnabled && evaluationSkills(settings.skills).length > 0, blocked,
    nextRunAt: state.next_run_at ? new Date(state.next_run_at).toISOString() : null,
    patterns: patterns.map(({ evidence, ...pattern }) => ({ ...pattern,
      label: pattern.kind === 'protected_business' ? 'Kebijakan bisnis — tinjauan manusia' : LEARNING_RULES[pattern.kind].label,
      proposal: pattern.kind === 'protected_business' ? '' : LEARNING_RULES[pattern.kind].text,
    })),
    versions: versions.map(version => ({
      id: Number(version.id), status: version.status,
      kind: version.rule_key,
      label: LEARNING_RULES[version.rule_key as LearningRule]?.label || version.rule_key,
      proposal: learningContent(parseRules(version.after_rules_json)),
      tests: version.tests_json ? JSON.parse(version.tests_json) : null,
      error: version.error, updatedAt: new Date(version.updated_at).toISOString(),
      customers: JSON.parse(version.evidence_json).length,
      canRollback: Number(state.active_version) === Number(version.id) && version.status === 'applied',
    })),
  }
}
