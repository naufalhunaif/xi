import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import db from '#services/workspace_database'
import { ensureDefaults, readSettings } from '#services/settings_service'
import { ensureWorkspaceRegistry } from '#services/workspace_service'
import { inWorkspace } from '#services/workspace_context'
import { startSkillEdit, processSkillEdit, skillEditStatus } from '#services/skill_edit_service'
import { AiProcessFailure } from '#services/ai_failure_service'

const scope = { id: 1, prefix: '', version: randomUUID(), phone: null }
const original = 'Friendly wording.\nTotal in one line.\nPayment must be checked by a human.'
const plan = async (_settings: any, _instruction: string, skills: any[]) => {
  const skill = skills.find((item) => item.name === 'language')
  return {
    summary: 'Updated total format',
    changes: [
      {
        skillId: skill.id,
        name: skill.name,
        description: skill.description,
        before: 'Total in one line.',
        after: 'Total: verified amount + shipping - discount - credit = amount due.',
      },
    ],
  }
}
test.group('Isolated owner skill updates (no AI or WhatsApp calls)', (group) => {
  group.setup(async () => {
    await ensureDefaults()
    await ensureWorkspaceRegistry()
  })
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    await db
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({ active_id: 1, version: scope.version })
    await db
      .table('whatsapp_skills')
      .insert({
        name: 'language',
        description: 'Style',
        content: original,
        created_at: new Date(),
        updated_at: new Date(),
      })
    return () => db.rollbackGlobalTransaction()
  })
  const run = (action: () => Promise<void>) => inWorkspace(scope, action)

  test('updates relevant skill and audits its previous version, even with auto-reply off', ({
    assert,
  }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Tampilkan total sebagai penjumlahan', 'owner', false)
      await processSkillEdit(id, async (...args) => {
          assert.isFalse((await readSettings()).aiEnabled)
        return plan(...args)
      })
      const result = await skillEditStatus(id)
      assert.equal(result.status, 'completed')
      assert.deepEqual(result.changes, [{ name: 'language', action: 'updated' }])
      const skill = await db.from('whatsapp_skills').where('name', 'language').firstOrFail()
      assert.include(skill.content, 'Friendly wording.')
      assert.include(skill.content, 'Payment must be checked by a human.')
      const audit = await db.from('whatsapp_skill_edits').where('id', id).firstOrFail()
      assert.equal(JSON.parse(audit.changes_json)[0].before, original)
      assert.isFalse((await readSettings()).aiEnabled)
      assert.notProperty(result, 'snapshot_json')
      assert.notProperty(result, 'instruction')
      assert.lengthOf(await db.from('whatsapp_messages'), 0)
    }))
  test('creates a skill when none applies and does not overwrite existing ones', ({ assert }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Tambah panduan format', 'owner', false)
      await processSkillEdit(id, async () => ({
        summary: 'Created totals',
        changes: [
          {
            skillId: null,
            name: 'totals',
            description: '',
            before: '',
            after: '# Totals\nShow verified components.',
          },
        ],
      }))
      assert.equal((await skillEditStatus(id)).status, 'completed')
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'language').firstOrFail()).content,
        original
      )
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'totals').firstOrFail()).content,
        '# Totals\nShow verified components.'
      )
    }))
  test('double-submit and reprocessing apply only once', ({ assert }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Format total', 'owner', false)
      await startSkillEdit(id, 'Format total', 'owner', false)
      await assert.rejects(() => startSkillEdit(id, 'Different', 'owner', false), /ID permintaan/)
      await assert.rejects(
        () => startSkillEdit(randomUUID(), 'Second job', 'owner', false),
        /masih berjalan/
      )
      let calls = 0
      const editor = async (...args: Parameters<typeof plan>) => {
        calls++
        return plan(...args)
      }
      await processSkillEdit(id, editor)
      await processSkillEdit(id, editor)
      assert.equal(calls, 1)
      assert.lengthOf(await db.from('whatsapp_skill_edits'), 1)
    }))
  test('concurrent edits and workspace changes cannot overwrite skills', ({ assert }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Format total', 'owner', false)
      await processSkillEdit(id, async (...args) => {
        await db
          .from('whatsapp_skills')
          .where('name', 'language')
          .update({ content: 'Manual update' })
        return plan(...args)
      })
      assert.equal((await skillEditStatus(id)).status, 'failed')
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'language').firstOrFail()).content,
        'Manual update'
      )
      await db.from('whatsapp_skills').where('name', 'language').update({ content: original })
      const next = randomUUID()
      await startSkillEdit(next, 'Format total', 'owner', false)
      await processSkillEdit(next, async (...args) => {
        await db.from('whatsapp_workspace_state').where('id', 1).update({ version: randomUUID() })
        return plan(...args)
      })
      assert.equal((await skillEditStatus(next)).status, 'failed')
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'language').firstOrFail()).content,
        original
      )
    }))
  test('provider limits and malformed output leave old guidance intact', ({ assert }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Format total', 'owner', false)
      await processSkillEdit(id, async () => {
        throw new AiProcessFailure({
          stage: 'provider',
          provider: 'claude',
          code: 'USAGE_LIMIT',
          message: 'Batas pemakaian layanan tercapai.',
          action: 'Wait',
          retryable: true,
        })
      })
      assert.equal((await skillEditStatus(id)).errorCode, 'USAGE_LIMIT')
      const next = randomUUID()
      await startSkillEdit(next, 'Format total', 'owner', false)
      await processSkillEdit(next, async () => ({
        summary: '',
        changes: [{ skillId: 999999, name: 'x', description: '', before: '', after: 'Wrong' }],
      }))
      assert.equal((await skillEditStatus(next)).status, 'failed')
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'language').firstOrFail()).content,
        original
      )
    }))
  test('an expired request never applies late output and permits a fresh request', ({ assert }) =>
    run(async () => {
      const id = randomUUID()
      await startSkillEdit(id, 'Format total', 'owner', false)
      await processSkillEdit(id, async (...args) => {
        await db
          .from('whatsapp_skill_edits')
          .where('id', id)
          .update({ expires_at: new Date(Date.now() - 1000) })
        return plan(...args)
      })
      assert.equal((await skillEditStatus(id)).status, 'failed')
      assert.equal(
        (await db.from('whatsapp_skills').where('name', 'language').firstOrFail()).content,
        original
      )
      await startSkillEdit(randomUUID(), 'Try again', 'owner', false)
    }))
})
