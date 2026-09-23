import { test } from '@japa/runner'
import { createRequire } from 'node:module'
import env from '#start/env'
import db from '#services/workspace_database'
import { inWorkspace, type WorkspaceScope } from '#services/workspace_context'
import { ensureDefaults } from '#services/settings_service'
import { ensureWorkspaceRegistry, workspaceState } from '#services/workspace_service'
import {
  requestChatCleanup,
  filterDeletedChatHistory,
  chatCleanupStatus,
  executeChatCleanup,
  acceptsChatTimestamp,
  chatMediaFile,
  withChatMutationLock,
} from '#services/chat_cleanup_service'
import { contactCleanupPreview, contactCleanupTarget } from '#services/contact_cleanup_service'
import { orderMessages } from '#services/order_message_evidence'
import { workspaceSocket } from '#services/workspace_socket'
import { RESET_DATA_TABLES, resetDataManifest } from '#services/data_reset_service'

const a: WorkspaceScope = { id: 2, prefix: 'w2_', phone: '628000000002', version: 'cleanup-test' }
const b: WorkspaceScope = { id: 3, prefix: 'w3_', phone: '628000000003', version: 'other-test' }
const jid = '628000000001@s.whatsapp.net'
const old = new Date(Date.now() - 60000)
const base = env.get('APP_BASE_PATH')
test.group('Chat cleanup (isolated database, no external services)', (group) => {
  group.setup(async () => {
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable database only')
    await ensureWorkspaceRegistry()
    for (const scope of [a, b])
      await db
        .table('whatsapp_workspaces')
        .insert({ id: scope.id, phone: scope.phone, legacy: false, created_at: new Date() })
    await inWorkspace(a, () => ensureDefaults())
    await inWorkspace(b, () => ensureDefaults())
  })
  group.each.setup(async () => {
    await db
      .from('whatsapp_workspace_state')
      .where('id', 1)
      .update({ active_id: a.id, version: a.version, cleanup_workspace_id: null })
    await inWorkspace(a, async () => {
      for (const table of [
        'whatsapp_chat_cleanup',
        'whatsapp_messages',
        'whatsapp_order_message_evidence',
        'whatsapp_orders',
        'whatsapp_carts',
        'whatsapp_cart_events',
      ])
        await db.from(table).delete()
    })
  })
  test('confirmation and workspace identity are mandatory; concurrent mutations are excluded', async ({
    assert,
  }) => {
    await inWorkspace(a, async () => {
      await assert.rejects(() => requestChatCleanup('no'), 'Konfirmasi penghapusan tidak valid.')
      assert.isNull((await workspaceState()).cleanup_workspace_id)
      await withChatMutationLock(async () => {
        await assert.rejects(() => withChatMutationLock(async () => {}), 'CHAT_MUTATION_BUSY')
      })
      await inWorkspace({ ...a, version: 'stale' }, async () => {
        await assert.rejects(
          () => requestChatCleanup('DELETE'),
          'Workspace berubah. Muat ulang halaman.'
        )
      })
    })
  })
  test('HTTP endpoint requires login, current workspace, capable worker, and blocks mutations during cleanup', async ({
    client,
  }) => {
    const session = () => ({
      account: { sub: 'a'.repeat(64), sessionToken: 'b'.repeat(43), checkedAt: Date.now() },
    })
    const Tokens = createRequire(import.meta.url)('csrf')
    const tokens = new Tokens()
    const secret = tokens.secretSync()
    const authenticated = (path: string) =>
      client
        .post(path)
        .withSession({ ...session(), 'csrf-secret': secret })
        .header('x-csrf-token', tokens.create(secret))
        .header('Accept', 'application/json')
    const anonymous = await client.get('/api/chats/cleanup').header('Accept', 'application/json')
    anonymous.assertStatus(401)
    const stale = await authenticated('/api/chats/cleanup')
      .header('X-WhatsApp-Workspace', 'stale')
      .json({ confirmation: 'DELETE' })
    stale.assertStatus(409)
    const oldWorker = await authenticated('/api/chats/cleanup')
      .header('X-WhatsApp-Workspace', a.version)
      .json({ confirmation: 'DELETE' })
    oldWorker.assertStatus(409)
    await inWorkspace(a, async () => {
      await requestChatCleanup('DELETE')
    })
    const blocked = await authenticated('/api/contacts/mode')
      .header('X-WhatsApp-Workspace', a.version)
      .json({ jid, mode: 'cs' })
    blocked.assertStatus(423)
    const status = await client.get('/api/chats/cleanup').withSession(session())
    status.assertStatus(200)
    status.assertBodyContains({ status: 'pending' })
  })
  test('deletes old chat/media only, preserves settings, order evidence, another number and new arrivals', async ({
    assert,
  }) => {
    const insert = (id: string, extra: any = {}) =>
      db.table('whatsapp_messages').insert({
        message_id: id,
        jid,
        direction: 'in',
        body: 'Fixture chat',
        status: 'received',
        created_at: old,
        ...extra,
      })
    await inWorkspace(b, async () => {
      await insert('other-number')
    })
    await inWorkspace(a, async () => {
      await insert('delete-photo', {
        media_url: `${base}/media/w2_fixture.jpg`,
        thumbnail_url: `${base}/media/w2_thumb.jpg`,
      })
      await insert('order-photo', { media_url: `${base}/media/w2_order.jpg`, media_type: 'image' })
      await insert('ordinary-text')
      await db
        .table('whatsapp_customer_memory')
        .insert({
          jid,
          fact_key: 'fixture',
          topic: 'preference',
          value: 'Private fixture',
          sources_json: '[]',
          source_id: 1,
          anchor_id: 1,
          updated_at: old,
        })
      await db
        .table('whatsapp_evidence_cache')
        .insert({
          cache_key: 'a'.repeat(64),
          result_json: '{}',
          stored_at: Date.now(),
          expires_at: Date.now() + 60000,
        })
      await db.table('whatsapp_orders').insert({
        jid,
        snapshot_json: JSON.stringify({ referenceMessageId: 'order-photo' }),
        total: 705000,
        paid: 200000,
        status: 'active',
        created_at: old,
        updated_at: old,
      })
      await db.table('whatsapp_carts').insert({
        jid,
        version: 'fixture',
        items_json: '[]',
        recipient_json: '{}',
        shipping_json: '{}',
        note: '',
        updated_at: old,
      })
      await db
        .table('whatsapp_customer_balance_entries')
        .insert({ jid, order_id: 1, amount: 50000, reason: 'fixture', created_at: old })
      await db
        .table('baileys_auth')
        .insert({ category: 'fixture', auth_key: 'main', payload: '{"fixture":true}' })
        .onConflict(['category', 'auth_key'])
        .ignore()
      const before: any = {}
      const kept = [
        'whatsapp_settings',
        'whatsapp_skills',
        'whatsapp_mcp_connections',
        'whatsapp_payment_methods',
        'whatsapp_orders',
        'whatsapp_carts',
        'whatsapp_customer_balance_entries',
        'baileys_auth',
        'whatsapp_connection',
      ]
      for (const table of kept) before[table] = await db.from(table).select('*')
      const authVersion = (await workspaceState()).auth_version
      await requestChatCleanup('DELETE')
      let sent = false
      const socket = workspaceSocket({
        sendMessage: async () => {
          sent = true
        },
      } as any)
      await assert.rejects(() => socket.sendMessage(jid, { text: 'Must not send' }))
      assert.isFalse(sent)
      await insert('new-arrival', { created_at: new Date() })
      const removed: string[] = []
      await executeChatCleanup(async (path) => {
        removed.push(path)
      })
      assert.lengthOf(removed, 2)
      assert.lengthOf(await db.from('whatsapp_customer_memory'), 0)
      assert.lengthOf(await db.from('whatsapp_evidence_cache'), 0)
      assert.isTrue(removed.some((path) => path.endsWith('/media/w2_fixture.jpg')))
      assert.deepEqual(
        (await db.from('whatsapp_messages')).map((row) => row.message_id),
        ['new-arrival']
      )
      assert.equal(
        (await orderMessages().where('message_id', 'order-photo').first()).media_type,
        'image'
      )
      assert.equal(
        (await db.from('whatsapp_order_message_evidence').first()).message_id,
        'order-photo'
      )
      for (const table of kept)
        assert.deepEqual(await db.from(table).select('*'), before[table], table)
      assert.equal((await workspaceState()).auth_version, authVersion)
      assert.isNull((await workspaceState()).cleanup_workspace_id)
      assert.notEqual((await workspaceState()).version, a.version)
      await executeChatCleanup(async () => {
        throw new Error('Must not repeat')
      })
    })
    await inWorkspace(b, async () =>
      assert.equal((await db.from('whatsapp_messages').first()).message_id, 'other-number')
    )
  })
  test('file failure retains manifest and retries without falsely reporting completion', async ({
    assert,
  }) => {
    await inWorkspace(a, async () => {
      await db.table('whatsapp_messages').insert({
        message_id: 'failure-photo',
        jid,
        direction: 'in',
        body: '',
        status: 'received',
        created_at: old,
        media_url: `${base}/media/w2_failure.jpg`,
      })
      await requestChatCleanup('DELETE')
      await assert.rejects(
        () =>
          executeChatCleanup(async () => {
            throw new Error('permission fixture')
          }),
        'permission fixture'
      )
      assert.equal((await db.from('whatsapp_chat_cleanup').first()).status, 'deleting')
      assert.equal((await workspaceState()).cleanup_workspace_id, a.id)
      await executeChatCleanup(async () => {
        throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      })
      assert.equal((await db.from('whatsapp_chat_cleanup').first()).status, 'completed')
      assert.lengthOf(await db.from('whatsapp_messages'), 0)
    })
  })
  test('file targets and history cutoff reject other numbers, traversal, external hosts and old replay', async ({
    assert,
  }) => {
    await inWorkspace(a, async () => {
      assert.equal(chatMediaFile(`${base}/media/w2_valid.jpg`), 'w2_valid.jpg')
      for (const value of [
        `${base}/media/w3_other.jpg`,
        `${base}/media/profiles/w2_avatar.jpg`,
        `${base}/media/w2_guide-help.mp4`,
        `${base}/media/../.env`,
        'https://external.test/media/w2_valid.jpg',
      ])
        assert.isNull(chatMediaFile(value))
      assert.isFalse(acceptsChatTimestamp(100, new Date(200000), true))
      assert.isTrue(acceptsChatTimestamp(200, new Date(200000), true))
      assert.isFalse(acceptsChatTimestamp(undefined, new Date(), true))
      assert.isTrue(acceptsChatTimestamp(undefined, new Date(), false))
    })
  })
  test('full reset requires a distinct confirmation and a reset-capable worker', async ({
    assert,
  }) => {
    await inWorkspace(a, async () => {
      await assert.rejects(
        () => requestChatCleanup('DELETE', 'all'),
        'Konfirmasi penghapusan tidak valid.'
      )
      await assert.rejects(
        () => requestChatCleanup('RESET ALL', 'unknown'),
        'Konfirmasi penghapusan tidak valid.'
      )
      await db
        .from('whatsapp_workspace_state')
        .where('id', 1)
        .update({ worker_id: 'new', reset_worker_id: 'old' })
      await assert.rejects(
        () => requestChatCleanup('RESET ALL', 'all'),
        'Restart WEB dan WORKER versi terbaru sebelum reset data.'
      )
      assert.isNull((await workspaceState()).cleanup_workspace_id)
      await db.from('whatsapp_workspace_state').where('id', 1).update({ reset_worker_id: 'new' })
      await inWorkspace({ ...a, version: 'stale' }, () =>
        assert.rejects(
          () => requestChatCleanup('RESET ALL', 'all'),
          'Workspace berubah. Muat ulang halaman.'
        )
      )
      await requestChatCleanup('RESET ALL', 'all')
      assert.equal((await db.from('whatsapp_chat_cleanup').first()).mode, 'all')
    })
  })
  test('full reset removes orders, balances, memory and pending work, preserving configuration and other numbers', async ({
    assert,
  }) => {
    const uploadId = '00000000-0000-4000-8000-000000000001'
    const protectedTables = [
      'whatsapp_settings',
      'whatsapp_skills',
      'whatsapp_mcp_connections',
      'whatsapp_payment_methods',
      'whatsapp_production_policy',
      'whatsapp_order_routing',
      'whatsapp_order_groups',
      'baileys_auth',
      'whatsapp_connection',
      'whatsapp_ai_quota',
      'whatsapp_ai_usage',
    ]
    let otherBefore: Record<string, any[]> = {}
    await inWorkspace(b, async () => {
      await db
        .table('whatsapp_orders')
        .insert({ jid, snapshot_json: '{}', total: 999, paid: 0, created_at: old, updated_at: old })
      for (const table of RESET_DATA_TABLES) otherBefore[table] = await db.from(table)
    })
    await inWorkspace(a, async () => {
      await db
        .from('whatsapp_workspace_state')
        .where('id', 1)
        .update({ worker_id: 'reset-test', reset_worker_id: 'reset-test' })
      const [orderId] = await db
        .table('whatsapp_orders')
        .insert({
          jid,
          snapshot_json: '{"address":"private"}',
          total: 714000,
          paid: 714000,
          created_at: old,
          updated_at: old,
        })
      await db
        .table('whatsapp_order_payments')
        .insert({
          order_id: orderId,
          request_key: 'reset-payment',
          amount: 714000,
          method_id: 1,
          method_json: '{}',
          confirmed_by: 'fixture',
          created_at: old,
        })
      await db
        .table('whatsapp_customer_balance_entries')
        .insert({ jid, order_id: orderId, amount: 40000, reason: 'fixture', created_at: old })
      await db
        .table('whatsapp_order_operations')
        .insert({
          order_id: orderId,
          version: 'fixture',
          data_json: '{"stage":"ready_to_ship"}',
          updated_at: old,
        })
      await db
        .table('whatsapp_order_shipping_jobs')
        .insert({
          order_id: orderId,
          request_key: 'reset-awb',
          status: 'queued',
          next_attempt_at: old,
          created_at: old,
          updated_at: old,
        })
      await db
        .table('whatsapp_order_group_jobs')
        .insert({
          order_id: orderId,
          group_jid: 'fixture@g.us',
          snapshot_json: '{}',
          status: 'queued',
          created_at: old,
          updated_at: old,
        })
      await db
        .table('whatsapp_chat_goals')
        .insert({
          jid,
          version: 'fixture',
          anchor_id: 1,
          status: 'waiting',
          objective: 'Old order',
          waiting_for: '',
          next_action: '',
          created_at: old,
          updated_at: old,
        })
      await db
        .table('whatsapp_contacts')
        .insert({
          jid,
          name: 'Fixture',
          ai_excluded: true,
          handling_mode: 'cs',
          handoff_reason: 'Old issue',
          chat_note: 'Old summary',
          updated_at: old,
        })
        .onConflict('jid')
        .merge()
      await db
        .table('whatsapp_customer_memory')
        .insert({
          jid,
          fact_key: 'address',
          topic: 'recipient',
          value: 'Old address',
          sources_json: '[]',
          source_id: 1,
          anchor_id: 1,
          updated_at: old,
        })
        .onConflict(['jid', 'fact_key'])
        .merge()
      await db
        .table('whatsapp_order_message_evidence')
        .insert({
          message_id: 'proof-reset',
          jid,
          direction: 'in',
          body: 'Evidence',
          status: 'received',
          created_at: old,
          media_upload_id: uploadId,
        })
      const protectedBefore: Record<string, any[]> = {}
      for (const table of protectedTables) protectedBefore[table] = await db.from(table)
      const authVersion = (await workspaceState()).auth_version
      await requestChatCleanup('RESET ALL', 'all')
      // Even data ingested during the drain cannot survive the full reset.
      await db
        .table('whatsapp_messages')
        .insert({
          message_id: 'during-reset',
          jid,
          direction: 'in',
          body: 'Old in-flight data',
          status: 'received',
          created_at: new Date(),
        })
      const fakeMedia = async () =>
        [
          'w2_chat.jpg',
          'w2_proof.jpg',
          'w2_guide-help.mp4',
          'w3_other.jpg',
          'legacy.jpg',
          'profiles',
        ].map((name) => ({ name, isFile: () => name !== 'profiles' })) as any
      const manifest = await resetDataManifest(fakeMedia)
      assert.sameMembers(manifest, [
        'media/w2_chat.jpg',
        'media/w2_proof.jpg',
        `upload/${uploadId}`,
      ])
      const removed: string[] = []
      let fail = true
      const remove = async (path: string) => {
        if (fail) {
          fail = false
          throw new Error('fixture permission error')
        }
        removed.push(path)
      }
      await assert.rejects(
        () => executeChatCleanup(remove, async () => manifest),
        'fixture permission error'
      )
      assert.isNotNull(await db.from('whatsapp_orders').where('id', orderId).first())
      assert.equal((await workspaceState()).cleanup_workspace_id, a.id)
      await executeChatCleanup(remove, async () => {
        throw new Error('Manifest must be reused')
      })
      assert.lengthOf(removed, 3)
      for (const table of RESET_DATA_TABLES) assert.lengthOf(await db.from(table), 0, table)
      for (const table of protectedTables)
        assert.deepEqual(await db.from(table), protectedBefore[table], table)
      const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(contact.name, 'Fixture')
      assert.equal(Number(contact.ai_excluded), 1)
      assert.isNull(contact.handoff_reason)
      assert.isNull(contact.chat_note)
      assert.equal(contact.handling_mode, 'ai')
      assert.equal((await workspaceState()).auth_version, authVersion)
      assert.isNull((await workspaceState()).cleanup_workspace_id)
      const cleanup = await db.from('whatsapp_chat_cleanup').firstOrFail()
      assert.equal(cleanup.status, 'completed')
      assert.isFalse(acceptsChatTimestamp(Math.floor(old.getTime() / 1000), cleanup.cutoff, true))
      await executeChatCleanup(async () => {
        throw new Error('Must not execute twice')
      })
    })
    await inWorkspace(b, async () => {
      for (const table of RESET_DATA_TABLES)
        assert.deepEqual(await db.from(table), otherBefore[table], table)
    })
  })
  test('contact cleanup deletes aliases, orders and private media while preserving other customers; retries safely', async ({ assert }) => {
    const phone = '628111111111@s.whatsapp.net', lid = '181111111111@lid', other = '628222222222@s.whatsapp.net'
    const upload = '10000000-0000-4000-8000-000000000001'
    const sharedUpload = '10000000-0000-4000-8000-000000000002'
    const message = (id: string, room: string, extra: any = {}) => db.table('whatsapp_messages').insert({
      message_id: id, jid: room, direction: 'in', body: 'Synthetic fixture', status: 'received', created_at: old, ...extra,
    })
    await inWorkspace(b, async () => { await message('cross-workspace-upload', other, { media_upload_id: sharedUpload }) })
    await inWorkspace(a, async () => {
      await db.from('whatsapp_workspace_state').where('id', 1).update({ worker_id: 'contact-worker', contact_cleanup_worker_id: null })
      for (const room of [phone, lid, other]) await db.table('whatsapp_contacts').insert({
        jid: room, name: 'Same name', phone_jid: room === lid ? phone : room, updated_at: old,
      }).onConflict('jid').merge()
      await message('private-phone', phone, { media_url: `${base}/media/w2_private.jpg`, media_upload_id: upload })
      await message('private-lid', lid, { media_url: `${base}/media/w2_shared.jpg`, media_upload_id: sharedUpload })
      await message('other-customer', other, { media_url: `${base}/media/w2_shared.jpg` })
      await message('guide-reference', lid, { media_url: `${base}/media/w2_guide-keep.jpg` })
      for (const room of [lid, other]) {
        await db.table('whatsapp_customer_memory').insert({ jid: room, fact_key: 'cleanup-test', topic: 'preference', value: 'Fixture', sources_json: '[]', source_id: 1, anchor_id: 1, updated_at: old })
        await db.table('whatsapp_carts').insert({ jid: room, version: 'fixture', items_json: '[]', recipient_json: '{}', shipping_json: '{}', note: '', updated_at: old })
      }
      const [orderId] = await db.table('whatsapp_orders').insert({ jid: lid, snapshot_json: JSON.stringify({ photo: `${base}/media/w2_order-only.jpg` }), total: 100, paid: 25, created_at: old, updated_at: old })
      const [otherOrder] = await db.table('whatsapp_orders').insert({ jid: other, snapshot_json: '{}', total: 200, paid: 0, created_at: old, updated_at: old })
      await db.table('whatsapp_order_payments').insert({ order_id: orderId, request_key: 'contact-payment', amount: 25, method_id: 1, method_json: '{}', confirmed_by: 'fixture', created_at: old })
      await db.table('whatsapp_customer_balance_entries').insert({ jid: lid, order_id: orderId, amount: 10, reason: 'fixture', created_at: old })
      await assert.rejects(() => contactCleanupTarget('12345@g.us'))
      await assert.rejects(() => contactCleanupTarget('628999999999@s.whatsapp.net'))
      const preview = await contactCleanupPreview(lid)
      assert.sameMembers(preview.jids, [phone, lid])
      assert.deepEqual(preview.counts, { messages: 3, memory: 1, orders: 1, carts: 1, media: 3 })
      await assert.rejects(() => requestChatCleanup('DELETE', 'contact', lid), 'Konfirmasi penghapusan tidak valid.')
      await assert.rejects(() => requestChatCleanup(preview.confirmation, 'contact', lid), 'Restart WEB dan WORKER versi terbaru sebelum menghapus data pelanggan.')
      await db.from('whatsapp_workspace_state').where('id', 1).update({ contact_cleanup_worker_id: 'contact-worker' })
      const requestId = await requestChatCleanup(preview.confirmation, 'contact', lid)
      assert.equal((await chatCleanupStatus()).requestId, requestId)
      await assert.rejects(() => requestChatCleanup(preview.confirmation, 'contact', lid), 'Penghapusan lain sedang berjalan.')
      await assert.rejects(() => executeChatCleanup(async () => { throw new Error('fixture cannot unlink') }), 'fixture cannot unlink')
      assert.isNotNull(await db.from('whatsapp_orders').where('id', orderId).first())
      const removed: string[] = []
      await executeChatCleanup(async path => { removed.push(path) })
      assert.lengthOf(removed, 3)
      assert.isTrue(removed.some(path => path.endsWith('/media/w2_private.jpg')))
      assert.isTrue(removed.some(path => path.endsWith('/media/w2_order-only.jpg')))
      assert.isTrue(removed.some(path => path.endsWith(`/cs-media/${upload}.bin`)))
      assert.isFalse(removed.some(path => /shared|guide-/.test(path) || path.includes(sharedUpload)))
      assert.lengthOf(await db.from('whatsapp_messages').whereIn('jid', [phone, lid]), 0)
      assert.lengthOf(await db.from('whatsapp_customer_memory').where('jid', lid), 0)
      assert.lengthOf(await db.from('whatsapp_carts').where('jid', lid), 0)
      assert.lengthOf(await db.from('whatsapp_order_payments').where('order_id', orderId), 0)
      assert.lengthOf(await db.from('whatsapp_customer_balance_entries').where('jid', lid), 0)
      assert.isNull(await db.from('whatsapp_orders').where('id', orderId).first())
      assert.isNotNull(await db.from('whatsapp_orders').where('id', otherOrder).first())
      assert.lengthOf(await db.from('whatsapp_messages').where('jid', other), 1)
      assert.lengthOf(await db.from('whatsapp_customer_memory').where('jid', other), 1)
      assert.lengthOf(await db.from('whatsapp_carts').where('jid', other), 1)
      assert.equal((await db.from('whatsapp_contacts').where('jid', lid).first()).phone_jid, phone)
      const historic = (room: string, timestamp = Math.floor(old.getTime() / 1000)) => ({ key: { remoteJid: room }, messageTimestamp: timestamp })
      const future = historic(lid, Math.ceil(Date.now() / 1000) + 5)
      const remaining = await filterDeletedChatHistory([historic(lid), historic(phone), historic(other), future, { key: { remoteJid: '199999999999@lid', remoteJidAlt: phone }, messageTimestamp: Math.floor(old.getTime() / 1000) }], true)
      assert.deepEqual(remaining, [historic(other), future])
      await executeChatCleanup(async () => { throw new Error('Must not execute twice') })
    })
    await inWorkspace(b, async () => assert.isNotNull(await db.from('whatsapp_messages').where('message_id', 'cross-workspace-upload').first()))
  })
  test('contact deletion preserves the preceding global history cutoff and other contact tombstones', async ({ assert }) => {
    await inWorkspace(a, async () => {
      const room = '628333333333@s.whatsapp.net'
      await db.table('whatsapp_contacts').insert({ jid: room, name: 'Fixture', updated_at: old })
      const globalCutoff = new Date(Date.now() - 120000)
      await db.table('whatsapp_chat_cleanup').insert({ id: 1, mode: 'chat', status: 'completed', cutoff: globalCutoff, updated_at: old })
      await requestChatCleanup('HAPUS 628333333333', 'contact', room)
      await executeChatCleanup(async () => {})
      const messages = [
        { key: { remoteJid: '628444444444@s.whatsapp.net' }, messageTimestamp: Math.floor(globalCutoff.getTime() / 1000) - 1 },
        { key: { remoteJid: '628444444444@s.whatsapp.net' }, messageTimestamp: Math.floor(old.getTime() / 1000) },
        { key: { remoteJid: '628111111111@s.whatsapp.net' }, messageTimestamp: Math.floor(old.getTime() / 1000) },
      ]
      assert.deepEqual(await filterDeletedChatHistory(messages, true), [messages[1]])
    })
  })

  test('contact preview requires authentication and cannot resolve another workspace customer', async ({ client }) => {
    const session = { account: { sub: 'a'.repeat(64), sessionToken: 'b'.repeat(43), checkedAt: Date.now() } }
    const room = '628555555555@s.whatsapp.net'
    await inWorkspace(b, async () => {
      await db.table('whatsapp_contacts').insert({ jid: room, name: 'Other workspace only', updated_at: old })
    })
    const path = `/api/chats/cleanup/contact?jid=${encodeURIComponent(room)}`
    ;(await client.get(path).header('Accept', 'application/json')).assertStatus(401)
    ;(await client.get(path).withSession(session).header('Accept', 'application/json')).assertStatus(400)
    ;(await client.get('/api/chats/cleanup/contact?jid=12345%40g.us').withSession(session).header('Accept', 'application/json')).assertStatus(400)
    const preview = await client.get('/api/chats/cleanup/contact?jid=628333333333%40s.whatsapp.net').withSession(session).header('Accept', 'application/json')
    preview.assertStatus(200)
    preview.assertBodyContains({ confirmation: 'HAPUS 628333333333' })
  })

})
