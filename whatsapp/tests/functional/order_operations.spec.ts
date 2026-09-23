/* eslint-disable @unicorn/no-await-expression-member -- Transactional snapshot assertions. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { ensureDefaults } from '#services/settings_service'
import {
  readCart,
  saveCart,
  reportPayment,
  confirmPayment,
  approveCustom,
  listOrders,
  cancelOrder,
} from '#services/cart_service'
import {
  cacheOrderGroups,
  orderRouting,
  saveOrderRouting,
  operationalOrders,
  saveOrderOperations,
  groupOrderSnapshot,
  groupOrderParts,
} from '#services/order_operations_service'
import {
  deliverNextOrderGroup,
  retryOrderGroup,
  acknowledgeOrderGroup,
} from '#services/order_group_delivery_service'
import { readProductionPolicy, saveProductionPolicy } from '#services/production_service'

const jid = '10000000889977@lid'
const groupJid = '120363999888777@g.us'
async function routing(trigger = 'first_payment') {
  await cacheOrderGroups([{ id: groupJid, subject: 'Produksi Uji' }])
  const current = await orderRouting()
  return saveOrderRouting({ ...current, groupJid, paymentTrigger: trigger })
}
async function pay(custom = false, amount = 100000) {
  let cart = await readCart(jid)
  cart = await saveCart(jid, cart.version, {
    items: [
      {
        productId: 'suit',
        name: 'Custom peak — jas',
        image: 'https://example.com/garment.jpg',
        size: custom ? 'custom' : 'S',
        quantity: 1,
        unitPrice: 300000,
        measurements: custom ? { 'Lingkar pinggang': 80 } : {},
        note: 'Alamat rahasia: Jl. Pribadi 99. Telepon 081234567890',
      },
    ],
    recipient: { name: 'Pelanggan Test', phone: '081234567890', address: 'Jl. Pribadi 99' },
    shipping: { service: 'REG', cost: 0 },
    note: 'Jangan bagikan alamat',
  })
  if (custom) cart = await approveCustom(jid, cart.version, cart.items[0].id, true, '', 'owner')
  cart = await reportPayment(jid, cart.version, undefined, 'owner')
  const [methodId] = await db.table('whatsapp_payment_methods').insert({
    name: 'TEST BANK',
    destination: '00001',
    account_name: 'TEST',
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  })
  const input = {
    version: cart.version,
    verified: true,
    amount,
    methodId,
    reference: randomUUID(),
    requestKey: randomUUID(),
  }
  return { input, order: await confirmPayment(jid, input, 'owner') }
}
test.group('Order operations and private production group delivery', (group) => {
  group.setup(() => ensureDefaults())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    for (const table of [
      'whatsapp_order_group_parts',
      'whatsapp_order_group_jobs',
      'whatsapp_order_operation_events',
      'whatsapp_order_operations',
      'whatsapp_order_routing',
      'whatsapp_order_groups',
    ])
      await db.from(table).delete()
    return () => db.rollbackGlobalTransaction()
  })
  test('order APIs require Account authentication and CSRF', async ({ client, assert }) => {
    const anonymous = await client.get('/api/orders').redirects(0)
    anonymous.assertStatus(302)
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Owner',
        username: 'owner',
      },
    }
    const before = await orderRouting()
    const denied = await client
      .put('/api/orders/routing')
      .withSession(session)
      .header('accept', 'application/json')
      .json({ ...before, groupJid: '120363999888777@g.us' })
      .redirects(0)
    denied.assertStatus(302)
    assert.equal((await orderRouting()).version, before.version)
    const allowed = await client.get('/api/orders').withSession(session)
    allowed.assertStatus(200)
  })
  test('verified first payment queues once; group snapshot strips address, phone, notes and payment receipt', async ({
    assert,
  }) => {
    await routing()
    const { order, input } = await pay()
    await confirmPayment(jid, input, 'owner')
    const jobs = await db.from('whatsapp_order_group_jobs').where('order_id', order.id)
    assert.lengthOf(jobs, 1)
    const snapshot = JSON.parse(jobs[0].snapshot_json)
    assert.equal(snapshot.customerName, 'Pelanggan Test')
    assert.equal(snapshot.payment, 'DP terverifikasi')
    const parts = groupOrderParts(snapshot)
    assert.lengthOf(parts, 2)
    assert.equal(parts[1].image, 'https://example.com/garment.jpg')
    const text = parts.map((p) => p.text).join('\n')
    assert.notInclude(text, 'Pribadi')
    assert.notInclude(text, '081234567890')
    assert.notInclude(text, 'http')
    assert.notProperty(snapshot, 'recipient')
    assert.notProperty(snapshot, 'shipping')
    assert.notProperty(snapshot, 'proofMessageId')
    assert.equal(
      (await operationalOrders({ query: order.number })).orders[0].operations.stage,
      'production'
    )
  })
  test('fully-paid routing waits through DP and never queues another brief on repeated payment', async ({
    assert,
  }) => {
    await routing('fully_paid')
    const { order, input } = await pay()
    assert.lengthOf(await db.from('whatsapp_order_group_jobs'), 0)
    const full = {
      ...input,
      orderId: order.id,
      amount: 200000,
      reference: randomUUID(),
      requestKey: randomUUID(),
    }
    await confirmPayment(jid, full, 'owner')
    await confirmPayment(jid, full, 'owner')
    assert.lengthOf(await db.from('whatsapp_order_group_jobs'), 1)
    assert.equal(
      JSON.parse((await db.from('whatsapp_order_group_jobs').firstOrFail()).snapshot_json).payment,
      'Lunas terverifikasi'
    )
  })
  test('unavailable configured group does not undo receipt confirmation; old orders are not sent by setting a default', async ({
    assert,
  }) => {
    await routing()
    await db.from('whatsapp_order_groups').update({ available: false })
    const { order } = await pay()
    assert.equal(order.paid, 100000)
    assert.lengthOf(await db.from('whatsapp_order_group_jobs'), 0)
    await routing()
    assert.lengthOf(await db.from('whatsapp_order_group_jobs'), 0)
  })
  test('legacy order requires explicit assignment and verified start; operations remain separate from payment', async ({
    assert,
  }) => {
    const { order } = await pay()
    await db.from('whatsapp_order_operations').where('order_id', order.id).delete()
    const row = (await operationalOrders({ query: order.number })).orders[0]
    assert.equal(row.operations.stage, 'unverified')
    const future = { ...row.operations, stage: 'production', startedOn: '2099-01-01' }
    await assert.rejects(
      () => saveOrderOperations(order.id, { version: '', operations: future }, 'owner'),
      /masa depan/
    )
    await routing()
    await saveOrderOperations(
      order.id,
      {
        version: '',
        groupJid,
        paymentTrigger: 'first_payment',
        operations: {
          ...row.operations,
          stage: 'production',
          startedOn: '2026-09-01',
          expectedReadyOn: '2026-09-20',
        },
      },
      'owner'
    )
    const saved = (await listOrders(jid)).find((o) => o.id === order.id)!
    assert.equal(saved.operations.stage, 'production')
    assert.equal(saved.paid, 100000)
    assert.equal(saved.operations.source, 'operator')
    assert.lengthOf(await db.from('whatsapp_order_group_jobs'), 1)
    await assert.rejects(
      () => saveOrderOperations(order.id, { version: '', groupJid }, 'owner'),
      /berubah/
    )
  })
  test('production estimate is captured at payment and does not change when the global policy changes', async ({
    assert,
  }) => {
    const initial = await readProductionPolicy()
    const policy = (
      await saveProductionPolicy({
        ...initial,
        rules: {
          ...initial.rules,
          custom: {
            enabled: true,
            minDays: 5,
            maxDays: 20,
            estimateDays: 10,
            dayType: 'working',
            startsAfter: 'payment_details',
          },
        },
      })
    ).policy
    const { order } = await pay(true)
    const operations = (await listOrders(jid)).find((o) => o.id === order.id)!.operations
    assert.equal(operations.estimate.estimateDays, 10)
    assert.isNotNull(operations.eligibleAt)
    assert.isNull(operations.startedOn)
    assert.isNull(operations.expectedReadyOn)
    await saveProductionPolicy({
      ...policy,
      rules: { ...policy.rules, custom: { ...policy.rules.custom, estimateDays: 8 } },
    })
    assert.equal(
      (await listOrders(jid)).find((o) => o.id === order.id)!.operations.estimate.estimateDays,
      10
    )
  })
  test('sends a text brief and real image bytes once, using the persisted destination and message IDs', async ({
    assert,
  }) => {
    await routing()
    await pay()
    const sent: any[] = []
    const transport = {
      validateGroup: async (id: string) => {
        assert.equal(id, groupJid)
      },
      send: async (id: string, payload: any, messageId: string) => {
        sent.push({ id, payload, messageId })
        return messageId
      },
    }
    assert.isTrue(await deliverNextOrderGroup(transport, async () => Buffer.from('image')))
    assert.isTrue(await deliverNextOrderGroup(transport, async () => Buffer.from('image')))
    assert.isFalse(await deliverNextOrderGroup(transport))
    assert.lengthOf(sent, 2)
    assert.isTrue(Buffer.isBuffer(sent[1].payload.image))
    assert.notInclude(sent[1].payload.caption, 'http')
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'sent')
  })
  test('retries preparation only; a failed image never resends the successful text', async ({
    assert,
  }) => {
    await routing()
    const { order } = await pay()
    const sent: any[] = []
    const transport = {
      validateGroup: async () => {},
      send: async (_: string, payload: any, id: string) => {
        sent.push(payload)
        return id
      },
    }
    await deliverNextOrderGroup(transport)
    for (let i = 0; i < 3; i++) {
      await db
        .from('whatsapp_order_group_parts')
        .where('status', 'queued')
        .update({ next_attempt_at: new Date(0) })
      await deliverNextOrderGroup(transport, async () => {
        throw new Error('Download failed')
      })
    }
    assert.lengthOf(sent, 1)
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'failed')
    await retryOrderGroup(order.id, false, 'owner')
    await deliverNextOrderGroup(transport, async () => Buffer.from('image'))
    assert.lengthOf(sent, 2)
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'sent')
  })
  test('uncertain transport never auto-retries; owner can acknowledge the visible part without resending it', async ({
    assert,
  }) => {
    await routing()
    const { order } = await pay()
    let sends = 0
    const transport = {
      validateGroup: async () => {},
      send: async () => {
        sends++
        throw new Error('Connection closed after send')
      },
    }
    await deliverNextOrderGroup(transport)
    await deliverNextOrderGroup(transport)
    assert.equal(sends, 1)
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'uncertain')
    await assert.rejects(() => retryOrderGroup(order.id, false, 'owner'), /Periksa grup/)
    await assert.rejects(() => acknowledgeOrderGroup(order.id, false, 'owner'), /Periksa/)
    await acknowledgeOrderGroup(order.id, true, 'owner')
    await deliverNextOrderGroup(
      {
        validateGroup: async () => {},
        send: async (_jid, payload, id) => {
          assert.property(payload, 'image')
          sends++
          return id
        },
      },
      async () => Buffer.from('image')
    )
    assert.equal(sends, 2)
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'sent')
  })
  test('cancelled orders are not dispatched and busy/sent destinations cannot be replaced', async ({
    assert,
  }) => {
    await routing()
    const { order } = await pay()
    const row = (await operationalOrders({ query: order.number })).orders[0]
    await cacheOrderGroups([{ id: groupJid }, { id: '120363999888778@g.us' }])
    await assert.rejects(
      () =>
        saveOrderOperations(
          order.id,
          { version: row.version, groupJid: '120363999888778@g.us' },
          'owner'
        ),
      /tidak dapat diganti/
    )
    await cancelOrder(jid, order.id, 'owner')
    assert.isFalse(
      await deliverNextOrderGroup({
        validateGroup: async () => {},
        send: async () => {
          throw new Error('Must not send')
        },
      })
    )
    assert.equal((await db.from('whatsapp_order_group_jobs').firstOrFail()).status, 'cancelled')
  })
  test('privacy allowlist redacts recipient details embedded in allowed product fields', ({
    assert,
  }) => {
    const order = {
      id: 47,
      paid: 1,
      total: 2,
      snapshot_json: JSON.stringify({
        recipient: { name: 'Test', phone: '081234567890', address: 'Jl. Rahasia 17' },
        items: [
          {
            name: 'Jas Jl. Rahasia 17 081234567890',
            size: 'S',
            quantity: 1,
            measurements: { 'Jl. Rahasia 17': 80 },
            note: 'secret',
          },
        ],
      }),
    }
    const serialized = JSON.stringify(groupOrderSnapshot(order))
    assert.notInclude(serialized, 'Rahasia')
    assert.notInclude(serialized, '081234567890')
    assert.notInclude(serialized, 'secret')
  })
})
