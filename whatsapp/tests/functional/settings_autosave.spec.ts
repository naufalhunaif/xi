import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults, saveSettings, readSettings } from '#services/settings_service'

test.group('Partial settings autosave', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })
  test('saving one scalar leaves AI, sweep, and provider untouched', async ({ assert }) => {
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_enabled: true, sweep_enabled: true, ai_provider: 'claude' })
    const settings = await saveSettings({ historyLimit: 75 })
    assert.equal(settings.historyLimit, 75)
    assert.isTrue(settings.aiEnabled)
    assert.isTrue(settings.sweepEnabled)
    assert.equal(settings.aiProvider, 'claude')
    const off = await saveSettings({ aiEnabled: false })
    assert.isFalse(off.aiEnabled)
    assert.isTrue(off.sweepEnabled)
    await assert.rejects(() => saveSettings({ aiEnabled: 'false' }), /Status AI/)
  })
  test('one MCP switch does not disable other connections', async ({ assert }) => {
    await db.from('whatsapp_mcp_connections').update({ enabled: true })
    const rows = await db.from('whatsapp_mcp_connections').select('slug')
    assert.isAbove(rows.length, 1)
    await saveSettings({ mcpConnections: { [rows[0].slug]: false } })
    const stored = await db.from('whatsapp_mcp_connections')
    assert.isFalse(Boolean(stored.find((row) => row.slug === rows[0].slug).enabled))
    assert.isTrue(
      stored.filter((row) => row.slug !== rows[0].slug).every((row) => Boolean(row.enabled))
    )
  })
  test('invalid numbers leave the stored value untouched; skill-only import preserves AI', async ({
    assert,
  }) => {
    const before = await readSettings(false)
    await assert.rejects(() => saveSettings({ historyLimit: 999 }), /riwayat/)
    const unchanged = await readSettings(false)
    assert.equal(unchanged.historyLimit, before.historyLimit)
    assert.equal(unchanged.aiEnabled, before.aiEnabled)
    const imported = await saveSettings({
      skills: [{ fileName: 'autosave-fixture.md', content: 'Jawab singkat sesuai data.' }],
    })
    assert.equal(imported.aiEnabled, before.aiEnabled)
    assert.isTrue(imported.skills.some((skill) => skill.name.startsWith('autosave-fixture')))
  })
})
