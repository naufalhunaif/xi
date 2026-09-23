import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { mkdir, writeFile, rm, access } from 'node:fs/promises'
import { randomBytes, createHash, randomUUID } from 'node:crypto'
import { initializeDatabase } from '#services/init_model'
import db from '#services/workspace_database'
import { inWorkspace } from '#services/workspace_context'

test.group('Read-only remote diagnostics (disposable database)', (group) => {
  const token = randomBytes(32).toString('base64url')
  const path = app.makePath('storage', 'diagnostics', 'access.json')
  let created = false
  const own = randomUUID()
  const other = randomUUID()
  group.setup(async () => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database required')
    if (
      await access(path)
        .then(() => true)
        .catch(() => false)
    )
      throw new Error('Existing diagnostic access must not be overwritten by tests')
    await mkdir(app.makePath('storage', 'diagnostics'), { recursive: true, mode: 0o700 })
    await writeFile(
      path,
      JSON.stringify({
        tokenHash: createHash('sha256').update(token).digest('hex'),
        workspaceId: 2,
        expiresAt: Date.now() + 60_000,
      }),
      { flag: 'wx', mode: 0o600 }
    )
    created = true
    for (const id of [2, 3])
      await inWorkspace({ id, prefix: `w${id}_`, phone: null, version: '' }, async () => {
        await initializeDatabase()
        await db.table('whatsapp_ai_usage').insert({
          provider: 'chatgpt',
          phase: 'evaluation',
          status: 'completed',
          model: 'PRIVATE_MODEL',
          input_tokens: id === 2 ? 100000 : 999999,
          output_tokens: 1200,
          cached_tokens: 80000,
          duration_ms: 30000,
          created_at: new Date(),
        })
        await db.table('whatsapp_ai_traces').insert({
          id: id === 2 ? own : other,
          jid: 'PRIVATE_PHONE',
          status: 'failed',
          input_json: 'PRIVATE_INPUT',
          decision_json: 'PRIVATE_DECISION',
          steps_json: JSON.stringify([
            {
              key: 'analysis',
              status: 'failed',
              detail: {
                code: 'AI_OUTPUT_INVALID',
                message: 'PRIVATE_MESSAGE',
                arguments: { secret: token },
              },
            },
          ]),
          created_at: new Date(),
          updated_at: new Date(),
        })
      })
  })
  group.teardown(async () => {
    if (created) await rm(path)
  })
  test('rejects missing/incorrect credentials even with workspace query override', async ({
    client,
  }) => {
    const guest = await client.get('/api/ops/diagnostics').redirects(0)
    guest.assertStatus(401)
    const wrong = await client
      .get('/api/ops/diagnostics?workspaceId=3')
      .header('Authorization', 'Bearer ' + 'x'.repeat(43))
    wrong.assertStatus(401)
  })
  test('authorized read returns scoped sanitized observations and no customer text', async ({
    client,
    assert,
  }) => {
    const response = await client
      .get('/api/ops/diagnostics?workspaceId=3')
      .header('Authorization', `Bearer ${token}`)
    response.assertStatus(200)
    response.assertHeader('cache-control', 'no-store, private')
    const data = response.body()
    assert.equal(data.workspaceId, 2)
    assert.equal(data.database.status, 'reachable')
    assert.equal(data.traces[0].id, own)
    assert.equal(data.traces[0].steps[0].code, 'AI_OUTPUT_INVALID')
    assert.equal(data.usage.recent[0].phase, 'evaluation')
    assert.equal(data.usage.recent[0].total, 101200)
    assert.equal(data.usage.recent[0].uncachedInput, 20000)
    assert.equal(data.usage.phases[0].runs, 1)
    assert.notInclude(JSON.stringify(data.usage), '999999')
    assert.notInclude(JSON.stringify(data), 'PRIVATE_')
    assert.notInclude(JSON.stringify(data), token)
    assert.notInclude(JSON.stringify(data), other)
  })
  test('trace lookup cannot cross workspaces; invalid identifiers are rejected', async ({
    client,
    assert,
  }) => {
    const response = await client
      .get(`/api/ops/diagnostics?traceId=${other}`)
      .header('Authorization', `Bearer ${token}`)
    response.assertStatus(200)
    assert.deepEqual(response.body().traces, [])
    const invalid = await client
      .get('/api/ops/diagnostics?traceId=invalid')
      .header('Authorization', `Bearer ${token}`)
    invalid.assertStatus(400)
  })
})
