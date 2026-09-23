import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'

test.group('Skill download', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })
  test('requires login and returns the exact stored markdown as a private attachment', async ({
    client,
    assert,
  }) => {
    const content = '# Skill uji\r\n\r\nBalas ramah — jangan ubah panduan.\n<script>test</script>\n'
    const [id] = await db.table('whatsapp_skills').insert({
      name: 'download-test',
      description: '',
      content,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const path = `/api/settings/skills/${id}/download`
    const anonymous = await client.get(path).redirects(0)
    anonymous.assertStatus(302)
    assert.notInclude(anonymous.text(), 'jangan ubah panduan')
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Test',
        username: 'test',
      },
    }
    const result = await client.get(path).withSession(session)
    result.assertStatus(200)
    result.assertHeader('content-type', 'text/markdown; charset=utf-8')
    result.assertHeader('content-disposition', 'attachment; filename="download-test.md"')
    result.assertHeader('cache-control', 'private, no-store')
    result.assertHeader('x-content-type-options', 'nosniff')
    assert.equal(result.text(), content)
    const row = await db.from('whatsapp_skills').where('id', id).firstOrFail()
    assert.equal(row.content, content)
    const view = await client.get('/settings').withSession(session)
    view.assertStatus(200)
    assert.include(view.text(), `data-skill-download="${id}"`)
    assert.include(view.text(), `/api/settings/skills/${id}/download`)
    await db.from('whatsapp_skills').where('id', id).delete()
    const removed = await client.get(path).withSession(session)
    removed.assertStatus(404)
    for (const invalid of ['0', '-1', 'abc', '90071992547409999']) {
      const response = await client
        .get(`/api/settings/skills/${invalid}/download`)
        .withSession(session)
      response.assertStatus(404)
    }
  })
})
