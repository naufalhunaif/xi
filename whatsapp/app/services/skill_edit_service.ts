import db from '#services/workspace_database'
import { readSettings, ensureDefaults } from '#services/settings_service'
import { workspaceScope } from '#services/workspace_context'
import { proposeSkillEdit } from '#services/ai_service'
import {
  applySkillEditPlan,
  SkillEditError,
  type EditableSkill,
} from '#services/skill_edit_contract'
import { AiProcessFailure } from '#services/ai_failure_service'
import { WAIT_NOTICE_SKILL, parseWaitNoticePolicy } from '#services/wait_notice_skill'
import logger from '@adonisjs/core/services/logger'

const validId = (id: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)
const snapshot = (rows: any[]): EditableSkill[] =>
  rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    description: row.description || '',
    content: row.content,
  }))
async function active(client: any) {
  const state = await client.from('whatsapp_workspace_state').where('id', 1).forUpdate().first()
  if (
    !workspaceScope().id ||
    Number(state?.active_id) !== workspaceScope().id ||
    state?.version !== workspaceScope().version
  )
    throw new SkillEditError('Workspace berubah. Muat ulang halaman.')
}
export async function startSkillEdit(
  id: string,
  instruction: string,
  actor: string,
  launch = true
) {
  if (!validId(id) || !instruction.trim() || instruction.length > 8000)
    throw new SkillEditError('Instruksi skill wajib diisi, maksimal 8000 karakter.')
  await ensureDefaults()
  const created = await db.transaction(async (trx) => {
    await active(trx)
    await trx.from('whatsapp_settings').where('id', 1).forUpdate().firstOrFail()
    const existing = await trx.from('whatsapp_skill_edits').where('id', id).first()
    if (existing) {
      if (existing.instruction !== instruction.trim() || existing.actor !== actor)
        throw new SkillEditError('ID permintaan sudah digunakan.')
      return false
    }
    if (
      await trx
        .from('whatsapp_skill_edits')
        .whereIn('status', ['pending', 'running'])
        .where('expires_at', '>', new Date())
        .first()
    )
      throw new SkillEditError('Pembaruan skill masih berjalan.')
    const skills = snapshot(await trx.from('whatsapp_skills').orderBy('id', 'asc').forUpdate())
    await trx
      .table('whatsapp_skill_edits')
      .insert({
        id,
        actor,
        instruction: instruction.trim(),
        status: 'pending',
        snapshot_json: JSON.stringify(skills),
        expires_at: new Date(Date.now() + 15 * 60000),
        created_at: new Date(),
        updated_at: new Date(),
      })
    return true
  })
  // Do not keep an HTTP request / MySQL transaction open during a provider run.
  if (created && launch)
    void processSkillEdit(id).catch(() => logger.warn('Pembaruan skill belum selesai.'))
  return skillEditStatus(id)
}

export async function processSkillEdit(id: string, editor = proposeSkillEdit) {
  const claimed = await db
    .from('whatsapp_skill_edits')
    .where('id', id)
    .where('status', 'pending')
    .where('expires_at', '>', new Date())
    .update({ status: 'running', updated_at: new Date() })
  if (!Number(claimed)) return
  try {
    const job = await db.from('whatsapp_skill_edits').where('id', id).firstOrFail()
    const settings = await readSettings(true)
    const original = JSON.parse(job.snapshot_json) as EditableSkill[]
    const plan = applySkillEditPlan(await editor(settings, job.instruction, original), original)
    for (const change of plan.changes)
      if (change.name === WAIT_NOTICE_SKILL) parseWaitNoticePolicy(change.content)
    await db.transaction(async (trx) => {
      await active(trx)
      await trx.from('whatsapp_settings').where('id', 1).forUpdate().firstOrFail()
      const locked = await trx
        .from('whatsapp_skill_edits')
        .where('id', id)
        .forUpdate()
        .firstOrFail()
      if (locked.status !== 'running' || new Date(locked.expires_at).getTime() <= Date.now())
        throw new SkillEditError('Pembaruan skill kedaluwarsa. Coba lagi.')
      const current = snapshot(await trx.from('whatsapp_skills').orderBy('id', 'asc').forUpdate())
      if (JSON.stringify(current) !== job.snapshot_json)
        throw new SkillEditError('Skill berubah selama proses. Periksa lalu coba lagi.')
      for (const change of plan.changes) {
        const values = {
          name: change.name,
          description: change.description,
          content: change.content,
          updated_at: new Date(),
        }
        if (change.id) await trx.from('whatsapp_skills').where('id', change.id).update(values)
        else await trx.table('whatsapp_skills').insert({ ...values, created_at: new Date() })
      }
      await trx
        .from('whatsapp_skill_edits')
        .where('id', id)
        .update({
          status: 'completed',
          summary: plan.summary,
          changes_json: JSON.stringify(plan.changes),
          updated_at: new Date(),
        })
    })
  } catch (error) {
    await db
      .from('whatsapp_skill_edits')
      .where('id', id)
      .where('status', 'running')
      .update({
        status: 'failed',
        error_code: error instanceof AiProcessFailure ? error.detail.code : 'SKILL_EDIT_FAILED',
        summary:
          error instanceof AiProcessFailure
            ? error.detail.message
            : error instanceof SkillEditError
              ? error.message
              : 'Pembaruan skill gagal. Skill sebelumnya tetap digunakan.',
        updated_at: new Date(),
      })
  }
}

export async function skillEditStatus(id: string) {
  if (!validId(id)) throw new SkillEditError('ID permintaan tidak valid.')
  await ensureDefaults()
  const job = await db.from('whatsapp_skill_edits').where('id', id).first()
  if (!job) throw new SkillEditError('Pembaruan skill tidak ditemukan.')
  const expired =
    ['pending', 'running'].includes(job.status) && new Date(job.expires_at).getTime() <= Date.now()
  return {
    id,
    status: expired ? 'failed' : job.status,
    summary: expired ? 'Pembaruan skill kedaluwarsa. Coba lagi.' : job.summary || '',
    errorCode: expired ? 'SKILL_EDIT_EXPIRED' : job.error_code,
    changes: job.changes_json
      ? JSON.parse(job.changes_json).map((change: any) => ({
          name: change.name,
          action: change.id ? 'updated' : 'created',
        }))
      : [],
    ...(job.status === 'completed' ? { skills: (await readSettings(false)).skills } : {}),
  }
}
