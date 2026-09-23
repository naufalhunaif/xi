import { test } from '@japa/runner'
import env from '#start/env'
import db from '#services/workspace_database'
import app from '@adonisjs/core/services/app'
import { ensureDefaults, readSettings } from '#services/settings_service'
import {
  activeWorkspace,
  activateWorkspace,
  archiveWorkspace,
  clearWorkspaceSession,
  ensureWorkspaceRegistry,
  workspaceState,
  registerWorkspaceWorker,
  workspaceWorkerReady,
} from '#services/workspace_service'
import { EMPTY_WORKSPACE, inWorkspace, type WorkspaceScope } from '#services/workspace_context'
import { workspaceSocket } from '#services/workspace_socket'
import { databaseAuthState } from '#services/baileys_auth_service'
import { codexOAuthArguments, codexOAuthEnv } from '#services/workspace_oauth'
import { claudeOAuthEnv } from '#services/claude_oauth_service'
import { mkdir, writeFile, unlink } from 'node:fs/promises'

const phoneA = '628000001111'
const phoneB = '628000002222'
const jid = '100000009999@lid'
const session = () => ({
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Test',
    username: 'test',
  },
})
let a: WorkspaceScope
let b: WorkspaceScope
async function connect(phone: string) {
  await db.from('whatsapp_connection').where('id', 1).update({ desired_connected: true })
  const state = await workspaceState()
  return activateWorkspace(phone, state.auth_version)
}
test.group('Phone archives (isolated database only)', (group) => {
  group.setup(async () => {
    if (!/^whatsapp_workspace_test_[a-z0-9_]+$/.test(env.get('DB_DATABASE')))
      throw new Error(
        'Use a dedicated whatsapp_workspace_test_* database; never run this against live data.'
      )
    await ensureDefaults()
    await db
      .from('whatsapp_connection')
      .where('id', 1)
      .update({ phone: phoneA, desired_connected: true })
    await ensureWorkspaceRegistry()
    a = await activeWorkspace()
    b = await connect(phoneB)
    await inWorkspace(EMPTY_WORKSPACE, () => ensureDefaults())
    a = await connect(phoneA)
  })
  test('isolates builder joins, raw SQL, transactions and all settings; archive + restore keeps IDs', async ({
    assert,
    client,
  }) => {
    assert.equal(a.prefix, '') // Existing installation is adopted without copying/deleting data.
    await inWorkspace(a, async () => {
      await db.table('whatsapp_skills').insert({
        name: 'Only A',
        content: 'Skill A',
        created_at: new Date(),
        updated_at: new Date(),
      })
      await db.table('whatsapp_payment_methods').insert({
        name: 'Bank A',
        destination: '1111',
        account_name: 'A',
        enabled: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      await db
        .from('whatsapp_mcp_connections')
        .where('slug', 'store')
        .update({ enabled: true, chatgpt_authenticated: true })
      await db.rawQuery(
        'INSERT INTO whatsapp_messages (message_id,jid,direction,sender_type,body,status,created_at) VALUES (?,?,?,?,?,?,?)',
        ['same-id', jid, 'in', 'customer', 'whatsapp_messages', 'received', new Date()]
      )
      await db.table('whatsapp_contacts').insert({ jid, name: 'Account A', updated_at: new Date() })
      await db.table('whatsapp_carts').insert({
        jid,
        version: 'cart-a',
        items_json: '[]',
        recipient_json: '{}',
        shipping_json: '{}',
        note: '',
        updated_at: new Date(),
      })
      await db.table('whatsapp_orders').insert({
        jid,
        snapshot_json: '{}',
        total: 100,
        paid: 20,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      })
    })
    await archiveWorkspace()
    const current = await activeWorkspace()
    const archived = await db.from('whatsapp_workspaces').where('id', a.id).firstOrFail()
    assert.equal(current.id, 0)
    assert.isNotNull(archived.archived_at)
    const empty = await client.get('/api/contacts').withSession(session())
    empty.assertStatus(200)
    assert.deepEqual(empty.body().contacts, [])
    await clearWorkspaceSession()
    b = await connect(phoneB)
    await inWorkspace(b, async () => {
      const settings = await readSettings(true)
      assert.isFalse(settings.aiEnabled)
      assert.deepEqual(settings.skills, [])
      assert.deepEqual(settings.paymentMethods, [])
      assert.isTrue(settings.mcpConnections.every((item) => !item.authenticated && !item.enabled))
      for (const table of [
        'whatsapp_messages',
        'whatsapp_contacts',
        'whatsapp_carts',
        'whatsapp_orders',
        'whatsapp_customer_balance_entries',
        'whatsapp_chat_goals',
        'whatsapp_ai_usage',
        'whatsapp_order_routing',
      ])
        assert.lengthOf(await db.from(table), 0, table)
      await db.transaction(async (trx) => {
        await trx.rawQuery(
          'INSERT INTO whatsapp_messages (message_id,jid,direction,sender_type,body,status,created_at) VALUES (?,?,?,?,?,?,?)',
          ['same-id', jid, 'in', 'customer', 'Account B', 'received', new Date()]
        )
        await trx
          .table('whatsapp_contacts')
          .insert({ jid, name: 'Account B', updated_at: new Date() })
      })
      const row = await db
        .from('whatsapp_messages')
        .join('whatsapp_contacts', 'whatsapp_contacts.jid', 'whatsapp_messages.jid')
        .select('whatsapp_messages.body', 'whatsapp_contacts.name')
        .firstOrFail()
      assert.equal(row.body, 'Account B')
      assert.equal(row.name, 'Account B')
      const trx = await db.transaction()
      await trx.rawQuery('UPDATE whatsapp_messages SET body = ? WHERE message_id = ?', [
        'rollback',
        'same-id',
      ])
      await trx.rollback()
      const message = await db.from('whatsapp_messages').firstOrFail()
      assert.equal(message.body, 'Account B')
    })
    const response = await client.get('/api/messages').qs({ jid }).withSession(session())
    response.assertStatus(200)
    assert.equal(response.body().messages[0].body, 'Account B')
    await archiveWorkspace()
    await clearWorkspaceSession()
    a = await connect(phoneA)
    await inWorkspace(a, async () => {
      const settings = await readSettings(true)
      assert.isTrue(settings.aiEnabled)
      assert.equal(settings.skills[0].name, 'Only A')
      assert.equal(settings.paymentMethods[0].name, 'Bank A')
      const message = await db.from('whatsapp_messages').firstOrFail()
      const order = await db.from('whatsapp_orders').firstOrFail()
      assert.equal(message.body, 'whatsapp_messages')
      assert.equal(order.id, 1)
    })
  })
  test('rejects stale browser mutations and stale socket sends without sending anything', async ({
    assert,
    client,
  }) => {
    const response = await client
      .post('/api/contacts/mode')
      .withSession(session())
      .withCsrfToken()
      .header('X-WhatsApp-Workspace', b.version)
      .json({ jid, mode: 'cs' })
    response.assertStatus(409)
    assert.equal(response.header('x-whatsapp-workspace'), a.version)
    const missing = await client
      .post('/api/contacts/mode')
      .withSession(session())
      .withCsrfToken()
      .json({ jid, mode: 'cs' })
    missing.assertStatus(409)
    let calls = 0
    const socket = workspaceSocket({
      sendMessage: async () => {
        calls++
        return {}
      },
    } as any)
    await assert.rejects(() =>
      inWorkspace(b, () => socket.sendMessage(jid, { text: 'Never sent' }))
    )
    assert.equal(calls, 0)
    await inWorkspace(a, () => socket.sendMessage(jid, { text: 'Fake only' }))
    assert.equal(calls, 1)
  })
  test('fences delayed credential saves after logout', async ({ assert }) => {
    const auth = await databaseAuthState()
    await archiveWorkspace()
    await clearWorkspaceSession()
    await auth.saveCreds()
    assert.lengthOf(await db.from('baileys_auth'), 0)
    a = await connect(phoneA)
  })
  test('new-number provider directories and credentials are separate; parent env stays unchanged', ({
    assert,
  }) => {
    const before = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR }
    inWorkspace(b, () => {
      assert.include(codexOAuthEnv().CODEX_HOME!, `whatsapp-workspaces/${b.id}/codex`)
      assert.include(claudeOAuthEnv().CLAUDE_CONFIG_DIR!, `whatsapp-workspaces/${b.id}/claude`)
      assert.include(codexOAuthArguments(), 'cli_auth_credentials_store="file"')
      assert.isUndefined(codexOAuthEnv().OPENAI_API_KEY)
      assert.isUndefined(claudeOAuthEnv().CLAUDE_CODE_OAUTH_TOKEN)
    })
    assert.deepEqual(
      { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR },
      before
    )
  })
  test('serves media only for active authenticated number, including range requests', async ({
    assert,
    client,
  }) => {
    const name = `${b.prefix}workspace-test.txt`
    const path = app.publicPath('media', name)
    await mkdir(app.publicPath('media'), { recursive: true })
    await writeFile(path, 'media-fixture', { flag: 'wx' })
    try {
      const denied = await client.get(`/media/${name}`).withSession(session())
      denied.assertStatus(404)
      b = await connect(phoneB)
      const response = await client
        .get(`/media/${name}`)
        .withSession(session())
        .header('Range', 'bytes=0-4')
      response.assertStatus(206)
      assert.equal(response.text(), 'media')
      assert.include(response.header('cache-control'), 'no-store')
      const anonymous = await client.get(`/media/${name}`).redirects(0)
      anonymous.assertStatus(302)
      a = await connect(phoneA)
    } finally {
      await unlink(path)
    }
  })
  test('renders workspace marker and permits current-tab updates only in its own namespace', async ({
    assert,
    client,
  }) => {
    const page = await client.get('/').withSession(session())
    page.assertStatus(200)
    assert.include(page.text(), `name="whatsapp-workspace" content="${a.version}"`)
    assert.include(page.text(), '/assets/workspace.js')
    const update = await client
      .post('/api/contacts/mode')
      .withSession(session())
      .withCsrfToken()
      .header('X-WhatsApp-Workspace', a.version)
      .json({ jid, mode: 'cs' })
    update.assertStatus(200)
    await inWorkspace(a, async () => {
      const row = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(row.handling_mode, 'cs')
    })
    await inWorkspace(b, async () => {
      const row = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(row.handling_mode, 'ai')
    })
  })
  test('blocks switching with a pre-upgrade worker, then allows the scoped worker', async ({
    assert,
    client,
  }) => {
    const headers = { 'X-WhatsApp-Workspace': a.version }
    const blocked = await client
      .post('/api/disconnect')
      .withSession(session())
      .withCsrfToken()
      .headers(headers)
    blocked.assertStatus(503)
    const before = await activeWorkspace()
    assert.equal(before.id, a.id)
    await db
      .from('whatsapp_connection')
      .where('id', 1)
      .update({ worker_id: 'new-worker', worker_heartbeat_at: new Date() })
    await registerWorkspaceWorker('new-worker')
    assert.isTrue(await workspaceWorkerReady())
    const disconnected = await client
      .post('/api/disconnect')
      .withSession(session())
      .withCsrfToken()
      .headers(headers)
    disconnected.assertStatus(200)
    const empty = await activeWorkspace()
    assert.equal(empty.id, 0)
    assert.equal(disconnected.header('x-whatsapp-workspace'), empty.version)
    const closing = await client
      .post('/api/connect')
      .withSession(session())
      .withCsrfToken()
      .header('X-WhatsApp-Workspace', empty.version)
    closing.assertStatus(409)
    await clearWorkspaceSession()
    a = await connect(phoneA)
  })
})
