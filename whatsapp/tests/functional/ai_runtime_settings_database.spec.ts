import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { ensureDefaults, readSettings, saveSettings } from '#services/settings_service'
import { inWorkspace } from '#services/workspace_context'

test.group('AI runtime settings isolated database', (group) => {
  group.setup(async () => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database required')
    await ensureDefaults()
  })
  test('fresh settings persist reasoning separately without enabling Fast', async ({ assert }) => {
    const initial = await readSettings()
    assert.equal(initial.chatgptReasoning, 'auto')
    assert.equal(initial.chatgptSpeed, 'standard')
    assert.equal(initial.claudeReasoning, 'auto')
    assert.equal(initial.claudeSpeed, 'standard')
    await saveSettings({
      chatgptReasoning: 'high',
      chatgptModel: 'gpt-6-astra',
      claudeModel: 'opus',
      claudeReasoning: 'max',
    })
    await saveSettings({ chatgptSpeed: 'fast', claudeSpeed: 'fast' })
    const stored = await readSettings()
    assert.equal(stored.chatgptReasoning, 'high')
    assert.equal(stored.claudeReasoning, 'max')
    assert.equal(stored.claudeSpeed, 'fast')
    await assert.rejects(() => saveSettings({ claudeModel: 'sonnet' }), /Standard/)
    assert.equal((await readSettings()).claudeModel, 'opus')
    await saveSettings({ claudeSpeed: 'standard' })
    await saveSettings({ claudeModel: 'sonnet', chatgptSpeed: 'low' })
    const legacyTab = await readSettings()
    assert.equal(legacyTab.chatgptReasoning, 'low')
    assert.equal(legacyTab.chatgptSpeed, 'standard')
    assert.equal(legacyTab.claudeReasoning, 'max')
    await saveSettings({ chatgptModel: 'custom-model-v2' })
    assert.equal((await readSettings()).chatgptModel, 'custom-model-v2')
    assert.isFalse((await readSettings()).aiEnabled)
  })
  test('init upgrades real legacy table and does not erase explicit settings on repeat initialization', async ({
    assert,
  }) => {
    await db.rawQuery('CREATE TABLE w17_whatsapp_settings LIKE whatsapp_settings')
    await db.rawQuery(
      'ALTER TABLE w17_whatsapp_settings DROP COLUMN chatgpt_reasoning, DROP COLUMN claude_reasoning'
    )
    await db
      .table('w17_whatsapp_settings')
      .insert({ id: 1, chatgpt_speed: 'high', claude_speed: 'medium', updated_at: new Date() })
    await inWorkspace({ id: 17, prefix: 'w17_', phone: null, version: '' }, async () => {
      await initializeDatabase()
      const converted = await readSettings()
      assert.equal(converted.chatgptReasoning, 'high')
      assert.equal(converted.claudeReasoning, 'medium')
      assert.equal(converted.chatgptSpeed, 'standard')
      assert.equal(converted.claudeSpeed, 'standard')
      await saveSettings({ claudeModel: 'opus', claudeSpeed: 'fast' })
      // A fresh module instance simulates another WEB/WORKER process starting.
      const restartModule = '../../app/services/init_model.js?restart-fixture'
      const module = await import(restartModule)
      await module.initializeDatabase()
      assert.equal((await readSettings()).claudeSpeed, 'fast')
      assert.equal((await readSettings()).claudeReasoning, 'medium')
    })
  })
})
