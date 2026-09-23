import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults, readSettings } from '#services/settings_service'
import {
  listPaymentMethods,
  savePaymentMethod,
  deletePaymentMethod,
} from '#services/payment_method_service'
import { paymentDataContext, paymentDataSignature } from '#services/payment_context_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const accountSession = {
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Pemilik',
    username: 'owner',
  },
}
const method = {
  name: 'Bank Uji',
  destination: '001234500',
  accountName: 'Pemilik Uji',
  enabled: true,
}

test.group('Payment methods', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    return () => db.rollbackGlobalTransaction()
  })

  test('worker withholds a stale reply if the payment destination changed during processing', async ({
    assert,
  }) => {
    const jid = '10000000884455@lid'
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    await db.table('whatsapp_messages').insert({
      message_id: 'payment-guard-test',
      jid,
      direction: 'in',
      sender_type: 'customer',
      body: 'Bayar ke mana?',
      status: 'received',
      created_at: new Date(),
    })
    const run = (await beginGoalTurn(jid, 'payment-guard-test'))!
    const snapshot = await readSettings(true)
    await savePaymentMethod(method)
    const calls: string[] = []
    const socket = {
      readMessages: async () => calls.push('read'),
      sendPresenceUpdate: async () => calls.push('presence'),
      sendMessage: async () => calls.push('send'),
    }
    const worker = Object.create(WhatsappListen.prototype) as any
    Object.assign(worker, { socketOpen: true, receivedPending: true, syncReadyAt: 0, ingesting: 0 })
    worker.socket = socket
    worker.stopping = false
    await worker.deliverAiDecision(
      run,
      socket,
      snapshot,
      { decision: 'reply', message: 'Tujuan lama', note: '', reason: '' },
      []
    )
    assert.deepEqual(calls, [])
    const goal = await readConversationGoal(jid)
    assert.equal(goal.status, 'paused')
  })

  test('creates, edits, disables and deletes without changing AI, MCP or imported skills', async ({
    assert,
  }) => {
    const before = await readSettings(true)
    const created = await savePaymentMethod(method)
    const row = created.find((item) => item.name === method.name)!
    assert.equal(row.destination, '001234500')
    const updated = await savePaymentMethod(
      { ...method, destination: '000111222', enabled: false },
      row.id
    )
    assert.equal(updated.find((item) => item.id === row.id)!.destination, '000111222')
    assert.notInclude(paymentDataContext(updated), '000111222')
    await savePaymentMethod({ ...method, destination: '000111222', enabled: false }, row.id)
    const after = await readSettings(true)
    assert.equal(after.aiEnabled, before.aiEnabled)
    assert.deepEqual(after.skills, before.skills)
    assert.deepEqual(after.mcpConnections, before.mcpConnections)
    const removed = await deletePaymentMethod(row.id)
    assert.isFalse(removed.some((item) => item.id === row.id))
    await assert.rejects(() => deletePaymentMethod(row.id), /tidak ditemukan/)
  })

  test('validates fields and links, accepts multiple methods and keeps account numbers as strings', async ({
    assert,
  }) => {
    for (const invalid of [
      { name: '' },
      { destination: '' },
      { destination: 1234 },
      { accountName: {} },
      { enabled: 'false' },
      { destination: 'javascript:alert(1)' },
      { destination: 'https://user:pass@example.test/pay' },
      { name: 'a'.repeat(121) },
      { destination: 'bank\nnew instruction' },
    ])
      await assert.rejects(() => savePaymentMethod({ ...method, ...invalid }))
    await assert.rejects(() => savePaymentMethod(method, -1))
    await assert.rejects(
      () => savePaymentMethod(method, Number.MAX_SAFE_INTEGER),
      /tidak ditemukan/
    )
    const before = await listPaymentMethods()
    await savePaymentMethod(method)
    const rows = await savePaymentMethod({
      ...method,
      name: 'Tautan Uji',
      destination: 'https://example.test/pay',
      accountName: '',
    })
    assert.lengthOf(rows, before.length + 2)
  })

  test('provides only active owner destinations as facts, defers behavior to skills, changes signature on edits', ({
    assert,
  }) => {
    const active = { id: 1, ...method }
    const hidden = { id: 2, ...method, enabled: false, destination: 'HIDDEN-ACCOUNT' }
    const context = paymentDataContext([active, hidden])
    assert.include(context, '001234500')
    assert.include(context, 'Pemilik Uji')
    assert.notInclude(context, 'HIDDEN-ACCOUNT')
    assert.include(context, 'keputusan tetap mengikuti skill')
    assert.notEqual(
      paymentDataSignature([active]),
      paymentDataSignature([{ ...active, destination: 'changed' }])
    )
    assert.equal(paymentDataSignature([active, hidden]), paymentDataSignature([active]))
    assert.include(paymentDataContext([]), '[]')
    assert.include(paymentDataContext([]), 'tujuan belum diatur')
  })

  test('API requires authentication and CSRF; owner can manage methods without switching AI', async ({
    client,
    assert,
  }) => {
    const guest = await client.get('/api/settings/payments').redirects(0)
    guest.assertStatus(302)
    const denied = await client
      .post('/api/settings/payments')
      .withSession(accountSession)
      .json(method)
      .redirects(0)
    assert.isAtLeast(denied.status(), 300)
    const created = await client
      .post('/api/settings/payments')
      .withSession(accountSession)
      .withCsrfToken()
      .json(method)
    created.assertStatus(200)
    const id = created
      .body()
      .paymentMethods.find((item: { name: string }) => item.name === method.name).id
    const edited = await client
      .put(`/api/settings/payments/${id}`)
      .withSession(accountSession)
      .withCsrfToken()
      .json({ ...method, enabled: false })
    edited.assertStatus(200)
    const result = await client.get('/api/settings/payments').withSession(accountSession)
    result.assertStatus(200)
    result.assertHeader('cache-control', 'no-store')
    assert.isFalse(
      result.body().paymentMethods.find((item: { id: number }) => item.id === id).enabled
    )
    const removed = await client
      .delete(`/api/settings/payments/${id}`)
      .withSession(accountSession)
      .withCsrfToken()
    removed.assertStatus(200)
  })
})
