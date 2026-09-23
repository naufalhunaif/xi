import { readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import db from '#services/workspace_database'

export const WAIT_NOTICE_SKILL = 'waiting-notices'
export const WAIT_NOTICE_ONE_MINUTE_REVISION = 'waiting-notices-one-minute-v1'
export type WaitNoticePolicy = {
  version: 1
  delay_seconds: number
  payment: { enabled: boolean; text: string }
  approval: { enabled: boolean; model: string; size: string; model_size: string }
}

export function parseWaitNoticePolicy(content: string): WaitNoticePolicy {
  const blocks = [...content.matchAll(/```wait-notice-policy\s*\n([\s\S]*?)\n```/g)]
  if (blocks.length !== 1)
    throw new Error('Skill waiting-notices harus memiliki satu blok wait-notice-policy.')
  const policy = JSON.parse(blocks[0][1]) as WaitNoticePolicy
  const validText = (value: unknown) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= 320
  if (
    !policy ||
    policy.version !== 1 ||
    !Number.isInteger(policy.delay_seconds) ||
    policy.delay_seconds < 60 ||
    policy.delay_seconds > 3600 ||
    typeof policy.payment?.enabled !== 'boolean' ||
    typeof policy.approval?.enabled !== 'boolean' ||
    ![
      policy.payment?.text,
      policy.approval?.model,
      policy.approval?.size,
      policy.approval?.model_size,
    ].every(validText)
  )
    throw new Error(
      'Konfigurasi waiting-notices tidak valid (waktu 60–3600 detik dan pesan maksimal 320 karakter).'
    )
  return policy
}

/** Change only the old delay; preserve wording, switches and all other skill content. */
export function oneMinuteWaitNoticeContent(content: string) {
  try {
    if (parseWaitNoticePolicy(content).delay_seconds !== 180) return content
  } catch {
    return content
  }
  return content.replace(/(```wait-notice-policy\s*\n)([\s\S]*?)(\n```)/, (_block, start, json, end) =>
    start + json.replace(/("delay_seconds"\s*:\s*)180\b/, (_match: string, prefix: string) => prefix + '60') + end
  )
}

async function upgradeWaitNoticeDelay() {
  if (await db.from('whatsapp_skill_defaults').where('name', WAIT_NOTICE_ONE_MINUTE_REVISION).first()) return
  await db.transaction(async (trx) => {
    const [marker] = await trx.rawQuery(
      'INSERT IGNORE INTO whatsapp_skill_defaults (name,created_at) VALUES (?,?)',
      [WAIT_NOTICE_ONE_MINUTE_REVISION, new Date()]
    )
    if (!marker.affectedRows) return
    const skill = await trx.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).forUpdate().first()
    if (!skill) return // A deleted skill must stay deleted.
    const content = oneMinuteWaitNoticeContent(String(skill.content))
    if (content === skill.content) return
    await trx.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).update({ content, updated_at: new Date() })
    for (const table of ['whatsapp_payment_wait_notices', 'whatsapp_approval_wait_episodes']) {
      // Only unsent old three-minute notices change; sent/uncertain episodes never reopen.
      await trx.rawQuery(
        `UPDATE ${table} SET due_at = DATE_ADD(created_at, INTERVAL 60 SECOND), updated_at = ?
         WHERE status = 'pending' AND TIMESTAMPDIFF(SECOND, created_at, due_at) = 180`,
        [new Date()]
      )
    }
  })
}

/** Seed once; apply the scoped delay revision once without restoring deleted skills. */
export async function ensureWaitNoticeSkill() {
  if (await db.from('whatsapp_skill_defaults').where('name', WAIT_NOTICE_SKILL).first()) {
    await upgradeWaitNoticeDelay()
    return
  }
  const content = await readFile(app.makePath('resources/skills/waiting-notices/SKILL.md'), 'utf8')
  parseWaitNoticePolicy(content)
  await db.transaction(async (trx) => {
    const [marker] = await trx.rawQuery(
      'INSERT IGNORE INTO whatsapp_skill_defaults (name,created_at) VALUES (?,?)',
      [WAIT_NOTICE_SKILL, new Date()]
    )
    // Only the transaction creating the marker seeds; concurrent restarts cannot restore deletion.
    if (!marker.affectedRows) return
    await trx.rawQuery(
      'INSERT IGNORE INTO whatsapp_skills (name,description,content,created_at,updated_at) VALUES (?,?,?,?,?)',
      [
        WAIT_NOTICE_SKILL,
        'Pemberitahuan tertunda untuk pembayaran dan persetujuan model/ukuran.',
        content,
        new Date(),
        new Date(),
      ]
    )
  })
  await upgradeWaitNoticeDelay()
}

export async function readWaitNoticePolicy() {
  const skill = await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).first()
  if (!skill) return null
  try {
    return parseWaitNoticePolicy(String(skill.content))
  } catch {
    return null
  }
}
