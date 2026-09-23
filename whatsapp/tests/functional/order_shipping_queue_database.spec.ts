import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import {
  initialOperations,
  saveOrderOperations,
  operationalOrders,
} from '#services/order_operations_service'
import {
  recoverOrderShippingQueue,
  queueOrderShipment,
  shippingStatesForOrders,
} from '#services/order_shipping_queue'
import { inWorkspace } from '#services/workspace_context'
import { processNextShipment as executeShipment } from '#services/order_shipping_service'
import type { ShipmentAgentFactory } from '#services/shipment_agent_contract'
import { deliverShippingNotice, dueShippingNotices } from '#services/shipping_notice_service'
import type { OrionCall } from '#services/orion_shipping_contract'
import { orderNumber } from '#services/order_number'
import { AiProcessFailure } from '#services/ai_failure_service'

// Model responses are deterministic fixtures; no AI account or real MCP is invoked.
const testAgent: ShipmentAgentFactory = async () => ({
  allowed: async () => true,
  emit: () => {},
  finish: async () => {},
  decide: async (state) => ({
    tool: state.observations.some((item: any) => item.error)
      ? 'wait'
      : state.awb
        ? 'track_awb'
        : !state.checked
          ? 'list_orion_data'
          : state.uncertain
            ? 'wait'
            : !state.prepared
              ? 'prepare_awb'
              : 'create_awb',
    reason: 'Fixture evidence',
    waitingFor: 'Fixture waiting condition',
    nextAction: 'Fixture next action',
  }),
})
const processNextShipment = (adapter: Parameters<typeof executeShipment>[0]) =>
  executeShipment(adapter, testAgent)

test.group('Durable shipment intents (isolated database, no external calls)', (group) => {
  group.each.skip(process.env.SHIPPING_QUEUE_DB_TEST !== '1', 'Disposable database only.')
  group.setup(async () => {
    if (process.env.SHIPPING_QUEUE_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable database only.')
    await initializeDatabase()
    await db.table('whatsapp_settings').insert({ id: 1, ai_enabled: true, updated_at: new Date() })
  })
  group.each.setup(async () => {
    if (process.env.SHIPPING_QUEUE_DB_TEST !== '1') return
    for (const table of [
      'whatsapp_shipping_notices',
      'whatsapp_order_shipping_jobs',
      'whatsapp_order_operations',
      'whatsapp_order_operation_events',
      'whatsapp_orders',
    ])
      await db.from(table).delete()
  })
  async function fixture(stage = 'production', status = 'active', trackingNumber = '') {
    const cart = {
      items: [{ name: 'Fixture', size: 'M', quantity: 1 }],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture address' },
      shipping: {
        service: 'REG',
        serviceCode: 'REG',
        destinationCode: 'FIXTURE',
        weightKg: 1,
        cost: 8000,
      },
    }
    const now = new Date()
    const [id] = await db.table('whatsapp_orders').insert({
      jid: `${randomUUID()}@lid`,
      snapshot_json: JSON.stringify(cart),
      total: 108000,
      paid: 108000,
      status,
      created_at: now,
      updated_at: now,
    })
    const operations = { ...initialOperations(cart), stage, trackingNumber }
    const version = randomUUID()
    await db.table('whatsapp_order_operations').insert({
      order_id: id,
      version,
      data_json: JSON.stringify(operations),
      updated_at: now,
    })
    return { id: Number(id), status, operations, version }
  }
  const job = (id: number) => db.from('whatsapp_order_shipping_jobs').where('order_id', id).first()
  test('AI wait persists the pending requirement and invokes no Orion tool or message', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const mock = transport()
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async () => ({
        tool: 'wait',
        reason: 'Customer requested an address correction',
        waitingFor: 'address approval',
        nextAction: 'Review confirmed address',
      }),
    }))
    assert.lengthOf(mock.calls, 0)
    const saved = await job(f.id)
    assert.equal(saved.status, 'retry')
    assert.equal(JSON.parse(saved.agent_state_json).waitingFor, 'address approval')
    assert.isNull(saved.create_started_at)
    assert.lengthOf(await db.from('whatsapp_shipping_notices'), 0)
  })
  test('model cannot bypass preflight or loop without a bound', async ({ assert }) => {
    const f = await fixture('ready')
    const mock = transport()
    let decisions = 0
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async () => {
        decisions++
        return { tool: 'create_awb', reason: '', waitingFor: '', nextAction: '' }
      },
    }))
    assert.equal(decisions, 6)
    assert.lengthOf(mock.calls, 0)
    assert.isNull((await job(f.id)).create_started_at)
    assert.equal((await job(f.id)).last_error_code, 'SHIPPING_PREFLIGHT_REQUIRED')
  })
  test('a model create request cannot reset an uncertain old attempt', async ({ assert }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({ status: 'reconciling', create_started_at: new Date() })
    const mock = transport()
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async () => ({
        tool: 'create_awb',
        reason: 'Unsafe fixture',
        waitingFor: '',
        nextAction: '',
      }),
    }))
    assert.lengthOf(mock.calls, 0)
    assert.equal((await job(f.id)).status, 'reconciling')
  })
  test('changed conversation or AI eligibility cancels the in-flight decision before tools', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const mock = transport()
    let allowed = true
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      allowed: async () => allowed,
      decide: async () => {
        allowed = false
        return { tool: 'list_orion_data', reason: '', waitingFor: '', nextAction: '' }
      },
    }))
    assert.lengthOf(mock.calls, 0)
    assert.equal((await job(f.id)).last_error_code, 'SHIPPING_CONTEXT_CHANGED')
  })
  test('no eligible AI never falls back to autonomous shipment execution', async ({ assert }) => {
    const f = await fixture('ready')
    const mock = transport()
    assert.isFalse(await executeShipment(mock.adapter, async () => null))
    assert.lengthOf(mock.calls, 0)
    assert.isNull((await job(f.id)).create_started_at)
  })
  test('provider usage limits remain identifiable and never invoke a shipping write', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const mock = transport()
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async () => {
        throw new AiProcessFailure({
          stage: 'provider',
          provider: 'chatgpt',
          code: 'USAGE_LIMIT',
          message: 'Limit reached',
          action: 'Wait',
          retryable: true,
        })
      },
    }))
    assert.lengthOf(mock.calls, 0)
    assert.equal((await job(f.id)).last_error_code, 'USAGE_LIMIT')
  })
  const response = (data: any) => ({ structuredContent: data })
  function transport(overrides: Partial<Record<string, (args: any) => any>> = {}) {
    const calls: Array<{ name: string; args: any; phase?: string }> = []
    const defaults: Record<string, (args: any) => any> = {
      list_orion_data: () => response({ records: [], has_more: false }),
      get_orion_data: () =>
        response({ code: 'FIXTURE', zip_code: '53264', full_address: 'Fixture region' }),
      check_shipping_rates: () => response({ rates: [{ service_code: 'REG', price: 8000 }] }),
      create_awb: () => response({ awb: 'FIXTURE123456' }),
      track_awb: () =>
        response({
          awb: 'FIXTURE123456',
          history: [{ status: 'booked', date: new Date().toISOString() }],
        }),
      ...overrides,
    }
    const call: OrionCall = async (name, args) => {
      const active = await db
        .from('whatsapp_order_shipping_jobs')
        .where('status', 'processing')
        .first()
      calls.push({ name, args, phase: active?.progress_phase })
      return defaults[name](args)
    }
    const adapter = async <T>(action: (call: OrionCall, slug: string) => Promise<T>) =>
      action(call, 'orion')
    return { calls, adapter }
  }
  async function due(id: number) {
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', id)
      .update({ next_attempt_at: new Date(0), lease_until: null })
  }

  test('shipped orders resume tracking after restart, complete once, and move to completed tab', async ({
    assert,
  }) => {
    const f = await fixture('shipped', 'active', 'FIXTURE123456')
    const pickedUp = new Date(Date.now() + 1000).toISOString()
    const delivered = new Date(Date.now() + 2000).toISOString()
    const history = [{ status: 'picked_up', timestamp: pickedUp }]
    const mock = transport({ track_awb: () => response({ awb: 'FIXTURE123456', history }) })
    await processNextShipment(mock.adapter)
    assert.equal((await job(f.id)).status, 'shipped')
    assert.deepEqual(
      mock.calls.map((call) => call.name),
      ['track_awb']
    )
    assert.equal((await operationalOrders({ tab: 'active' })).total, 1)
    assert.equal((await operationalOrders({ tab: 'completed' })).total, 0)
    await due(f.id)
    history.push({ status: 'delivered', timestamp: delivered })
    await processNextShipment(mock.adapter)
    const op = await db.from('whatsapp_order_operations').where('order_id', f.id).firstOrFail()
    const operations = JSON.parse(op.data_json)
    assert.equal(operations.stage, 'completed')
    assert.equal(operations.deliveredAt, delivered)
    assert.equal((await job(f.id)).status, 'completed')
    assert.equal((await operationalOrders({ tab: 'active' })).total, 0)
    assert.equal((await operationalOrders({ tab: 'completed' })).total, 1)
    assert.equal((await operationalOrders({ tab: 'completed', query: 'not-present' })).total, 0)
    const events = await db.from('whatsapp_order_operation_events').where('order_id', f.id)
    await due(f.id)
    await processNextShipment(mock.adapter)
    assert.lengthOf(mock.calls, 2)
    assert.lengthOf(
      await db.from('whatsapp_order_operation_events').where('order_id', f.id),
      events.length
    )
    assert.equal(
      (await db.from('whatsapp_shipping_notices').where('order_id', f.id).first()).status,
      'cancelled'
    )
  })

  test('ready transition atomically queues once and keeps the same request key', async ({
    assert,
  }) => {
    const f = await fixture()
    await saveOrderOperations(f.id, { version: f.version, advance: true }, 'fixture')
    const queued = await job(f.id)
    assert.equal(queued.status, 'queued')
    assert.match(queued.request_key, /^[a-f0-9-]{36}$/)
    await recoverOrderShippingQueue()
    assert.equal((await job(f.id)).request_key, queued.request_key)
    const rows = await db.from('whatsapp_order_shipping_jobs').where('order_id', f.id)
    assert.lengthOf(rows, 1)
  })

  test('recovery excludes cancelled/non-ready orders and concurrent workers do not duplicate', async ({
    assert,
  }) => {
    const ready = await fixture('ready')
    const cancelled = await fixture('ready', 'cancelled')
    const production = await fixture()
    await Promise.all([recoverOrderShippingQueue(), recoverOrderShippingQueue()])
    assert.equal((await job(ready.id)).status, 'queued')
    assert.isNull(await job(cancelled.id))
    assert.isNull(await job(production.id))
    assert.lengthOf(await db.from('whatsapp_order_shipping_jobs').where('order_id', ready.id), 1)
  })

  test('known AWB and uncertain previous attempts are preserved for reconciliation', async ({
    assert,
  }) => {
    const ready = await fixture('ready', 'active', 'FIXTURE-AWB')
    await recoverOrderShippingQueue()
    const original = await job(ready.id)
    assert.equal(original.status, 'reconciling')
    assert.equal(original.tracking_number, 'FIXTURE-AWB')
    await db.from('whatsapp_order_shipping_jobs').where('order_id', ready.id).update({
      attempts: 3,
      create_started_at: new Date(),
      last_error_code: 'TIMEOUT',
    })
    await recoverOrderShippingQueue()
    const reloaded = await job(ready.id)
    assert.equal(reloaded.request_key, original.request_key)
    assert.equal(reloaded.attempts, 3)
    assert.equal(reloaded.last_error_code, 'TIMEOUT')
    assert.equal(reloaded.status, 'reconciling')
  })

  test('a failed transaction leaves no shipment intent behind', async ({ assert }) => {
    const f = await fixture('ready')
    await assert.rejects(
      () =>
        db.transaction(async (trx) => {
          await trx.from('whatsapp_orders').where('id', f.id).forUpdate().first()
          await queueOrderShipment(f, f.operations, trx)
          throw new Error('fixture rollback')
        }),
      'fixture rollback'
    )
    assert.isNull(await job(f.id))
  })

  test('different WhatsApp numbers have independent job storage', async ({ assert }) => {
    const legacy = await fixture('ready')
    await recoverOrderShippingQueue()
    const before = await job(legacy.id)
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: 'fixture' }, async () => {
      await initializeDatabase()
      assert.lengthOf(await db.from('whatsapp_order_shipping_jobs'), 0)
      const separate = await fixture('ready')
      await recoverOrderShippingQueue()
      assert.equal((await job(separate.id)).status, 'queued')
      assert.notEqual((await job(separate.id)).request_key, before.request_key)
    })
    assert.equal((await job(legacy.id)).request_key, before.request_key)
  })
  test('known AWB tracks immediately without invoking another AI decision', async ({ assert }) => {
    const f = await fixture('ready', 'active', 'FIXTURE123456')
    const mock = transport()
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async () => {
        throw new Error('must not invoke model for known AWB')
      },
    }))
    assert.deepEqual(
      mock.calls.map((call) => call.name),
      ['track_awb']
    )
    assert.equal((await job(f.id)).status, 'waiting_pickup')
  })
  test('not-yet-indexed AWB clears old failure and waits without recreation or notification', async ({
    assert,
  }) => {
    const f = await fixture('ready', 'active', 'FIXTURE123456')
    await recoverOrderShippingQueue()
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({
        status: 'waiting_pickup',
        attempts: 28,
        last_error_code: 'ORION_RESPONSE_INVALID',
        next_attempt_at: new Date(0),
      })
    const mock = transport({
      track_awb: () =>
        response({
          awb: 'FIXTURE123456',
          tracking: {
            awb: 'FIXTURE123456',
            status: null,
            data: { error: 'Cnote No. Not Found.', status: false },
          },
        }),
    })
    const outcomes: string[] = []
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      finish: async (status) => {
        outcomes.push(status)
      },
    }))
    const saved = await job(f.id)
    assert.equal(saved.status, 'waiting_pickup')
    assert.equal(saved.tracking_number, 'FIXTURE123456')
    assert.isNull(saved.last_error_code)
    assert.equal(JSON.parse(saved.agent_state_json).waitingFor, 'shipping_update')
    assert.isAbove(new Date(saved.next_attempt_at).getTime(), Date.now())
    assert.deepEqual(
      mock.calls.map((call) => call.name),
      ['track_awb']
    )
    assert.deepEqual(outcomes, ['completed'])
    assert.lengthOf(await db.from('whatsapp_shipping_notices'), 0)
    const op = await db.from('whatsapp_order_operations').where('order_id', f.id).first()
    assert.equal(JSON.parse(op.data_json).stage, 'ready')
  })
  test('create continues to tracking before a model can choose wait', async ({ assert }) => {
    const f = await fixture('ready')
    let decisions = 0
    const mock = transport()
    await executeShipment(mock.adapter, async (claimed) => ({
      ...(await testAgent(claimed))!,
      decide: async (state) => {
        decisions++
        if (state.awb) throw new Error('tracking must not wait for AI')
        return (await testAgent(claimed))!.decide(state)
      },
    }))
    assert.equal(decisions, 3)
    assert.equal(mock.calls.at(-1)?.name, 'track_awb')
    assert.equal((await job(f.id)).status, 'waiting_pickup')
  })
  test('tracking failure preserves the AWB and retries later only once per run', async ({
    assert,
  }) => {
    const f = await fixture('ready', 'active', 'FIXTURE123456')
    const mock = transport({
      track_awb: () => {
        throw new Error('timeout')
      },
    })
    await processNextShipment(mock.adapter)
    assert.equal(mock.calls.filter((call) => call.name === 'track_awb').length, 1)
    const saved = await job(f.id)
    assert.equal(saved.tracking_number, 'FIXTURE123456')
    assert.equal(saved.status, 'waiting_pickup')
    assert.isTrue(new Date(saved.next_attempt_at).getTime() > Date.now())
    assert.isFalse(mock.calls.some((call) => call.name === 'create_awb'))
  })
  test('creates from verified destination/rate and waits silently until actual movement', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const mock = transport()
    await processNextShipment(mock.adapter)
    const saved = await job(f.id)
    assert.equal(saved.status, 'waiting_pickup')
    assert.deepEqual(
      mock.calls.map((call) => call.phase),
      ['lookup', 'lookup', 'destination', 'rates', 'creating', 'tracking']
    )
    assert.isNull(saved.progress_phase)
    const visible = (await shippingStatesForOrders([f.id])).get(f.id)
    assert.equal(visible.attempts, 1)
    assert.isNull(visible.phase)
    assert.isDefined(visible.nextAttemptAt)
    assert.isFalse(visible.workerActive)
    assert.notProperty(visible, 'request_key')
    assert.notProperty(visible, 'lease_token')
    const selected = await operationalOrders({ orderId: f.id })
    assert.deepEqual(
      selected.orders.map((order) => order.id),
      [f.id]
    )
    assert.equal(selected.orders[0].shipment.status, 'waiting_pickup')
    assert.lengthOf((await operationalOrders({ orderId: Number.NaN })).orders, 0)
    assert.equal(saved.tracking_number, 'FIXTURE123456')
    const payload = mock.calls.find((call) => call.name === 'create_awb')!.args.data
    assert.equal(payload.order_id, orderNumber({ id: f.id }))
    assert.notEqual(payload.order_id, saved.request_key)
    assert.equal(payload.zip_code, '53264')
    assert.equal(payload.street, 'Fixture address')
    assert.equal(payload.address, 'Fixture region')
    assert.equal(payload.weight, 1000)
    assert.equal(payload.cod_flag, 'N')
    assert.lengthOf(await db.from('whatsapp_shipping_notices'), 0)
    const op = await db.from('whatsapp_order_operations').where('order_id', f.id).first()
    assert.equal(JSON.parse(op.data_json).stage, 'ready')
    await due(f.id)
    const moving = transport({
      track_awb: () =>
        response({
          awb: 'FIXTURE123456',
          history: [{ status: 'picked_up', timestamp: new Date().toISOString() }],
        }),
    })
    await processNextShipment(moving.adapter)
    assert.equal((await job(f.id)).status, 'shipped')
    assert.isFalse(moving.calls.some((c) => c.name === 'create_awb'))
    assert.lengthOf(await db.from('whatsapp_shipping_notices'), 1)
    const moved = await db.from('whatsapp_order_operations').where('order_id', f.id).first()
    assert.equal(JSON.parse(moved.data_json).stage, 'shipped')
  })
  test('a proven weight rejection recovers once and reads the nested Orion AWB response', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    const original = await job(f.id)
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({ create_started_at: new Date(), status: 'reconciling' })
    const mock = transport({
      list_orion_data: ({ resource }) =>
        response({
          records:
            resource === 'mcp_activity'
              ? [
                  {
                    id: 'REJECTION-FIXTURE',
                    tool_name: 'create_awb',
                    status: 'failed',
                    result_json: null,
                    error_message: 'Weight must be greater than zero.',
                    completed_at: new Date().toISOString(),
                    arguments_json: JSON.stringify({
                      data: {
                        order_id: original.request_key,
                        phone: '628000000001',
                        code: 'FIXTURE',
                        weight: 1,
                      },
                    }),
                  },
                ]
              : [],
          has_more: false,
        }),
      create_awb: ({ data }) =>
        response({ id: 'FIXTURE-ROW', awb: { order_id: data.order_id, awb: 'FIXTURE123456' } }),
    })
    await processNextShipment(mock.adapter)
    const saved = await job(f.id)
    assert.equal(saved.status, 'waiting_pickup')
    assert.equal(saved.tracking_number, 'FIXTURE123456')
    assert.deepEqual(JSON.parse(saved.rejected_attempt_ids_json), ['REJECTION-FIXTURE'])
    assert.equal(mock.calls.find((call) => call.name === 'create_awb')!.args.data.weight, 1000)
  })
  test('old rejection evidence cannot unlock a later uncertain create again', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    const original = await job(f.id)
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({ create_started_at: new Date(), status: 'reconciling' })
    const mock = transport({
      list_orion_data: ({ resource }) =>
        response({
          records:
            resource === 'mcp_activity'
              ? [
                  {
                    id: 'REJECTION-FIXTURE',
                    tool_name: 'create_awb',
                    status: 'failed',
                    result_json: null,
                    error_message: 'Weight must be greater than zero.',
                    completed_at: new Date().toISOString(),
                    arguments_json: JSON.stringify({
                      data: {
                        order_id: original.request_key,
                        phone: '628000000001',
                        code: 'FIXTURE',
                        weight: 1,
                      },
                    }),
                  },
                ]
              : [],
          has_more: false,
        }),
      create_awb: () => {
        throw new Error('timeout')
      },
    })
    await processNextShipment(mock.adapter)
    await due(f.id)
    await processNextShipment(mock.adapter)
    assert.equal(mock.calls.filter((call) => call.name === 'create_awb').length, 1)
    assert.equal((await job(f.id)).status, 'reconciling')
  })
  test('new AWB uses the stored WhatsApp invoice number, not the private request UUID', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const invoice = 'INV-20260915-a1b2c3d'
    await db.from('whatsapp_orders').where('id', f.id).update({ order_number: invoice })
    const mock = transport({
      create_awb: ({ data }) => response({ order_id: data.order_id, awb: 'FIXTURE123456' }),
    })
    await processNextShipment(mock.adapter)
    assert.equal(mock.calls.find((call) => call.name === 'create_awb')!.args.data.order_id, invoice)
    assert.equal((await job(f.id)).status, 'waiting_pickup')
  })
  test('an uncertain invoice-based attempt recovers its AWB without another create', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const invoice = 'INV-20260915-b1c2d3e'
    await db.from('whatsapp_orders').where('id', f.id).update({ order_number: invoice })
    await recoverOrderShippingQueue()
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({ status: 'reconciling', create_started_at: new Date() })
    const mock = transport({
      list_orion_data: ({ query }) =>
        response({
          records: query === invoice ? [{ order_id: invoice, awb: 'FIXTURE123456' }] : [],
          has_more: false,
        }),
    })
    await processNextShipment(mock.adapter)
    assert.equal((await job(f.id)).tracking_number, 'FIXTURE123456')
    assert.isFalse(mock.calls.some((call) => call.name === 'create_awb'))
  })
  test('conflicting invoice and old UUID references cannot select an arbitrary AWB', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    const original = await job(f.id)
    const mock = transport({
      list_orion_data: ({ query }) =>
        response({
          records: [
            {
              order_id: query,
              awb: query === original.request_key ? 'OTHER123456' : 'FIXTURE123456',
            },
          ],
          has_more: false,
        }),
    })
    await processNextShipment(mock.adapter)
    assert.equal((await job(f.id)).last_error_code, 'MULTIPLE_AWBS')
    assert.isFalse(mock.calls.some((call) => ['create_awb', 'track_awb'].includes(call.name)))
  })
  test('timeout after create reconciles instead of creating again across retries', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    const timeout = transport({
      create_awb: () => {
        throw new Error('timeout with secret diagnostic')
      },
    })
    await processNextShipment(timeout.adapter)
    const saved = await job(f.id)
    assert.equal(saved.status, 'reconciling')
    assert.notInclude(JSON.stringify(saved), 'secret')
    await due(f.id)
    const absent = transport()
    await processNextShipment(absent.adapter)
    assert.isFalse(absent.calls.some((c) => c.name === 'create_awb'))
    await due(f.id)
    const found = transport({
      list_orion_data: () =>
        response({
          records: [{ order_id: saved.request_key, awb: 'FIXTURE123456' }],
          has_more: false,
        }),
    })
    await processNextShipment(found.adapter)
    assert.equal((await job(f.id)).tracking_number, 'FIXTURE123456')
    assert.isFalse(found.calls.some((c) => c.name === 'create_awb'))
  })
  test('parallel workers make one create attempt and recover an expired pre-create lease', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({ status: 'processing', lease_token: randomUUID(), lease_until: new Date(0) })
    const mock = transport()
    await Promise.all([processNextShipment(mock.adapter), processNextShipment(mock.adapter)])
    assert.lengthOf(
      mock.calls.filter((call) => call.name === 'create_awb'),
      1
    )
  })
  test('changed rates and missing weight never create a shipment', async ({ assert }) => {
    const f = await fixture('ready')
    const rates = transport({
      check_shipping_rates: () => response({ rates: [{ service_code: 'REG', price: 9000 }] }),
    })
    await processNextShipment(rates.adapter)
    assert.equal((await job(f.id)).last_error_code, 'SHIPPING_RATE_CHANGED')
    assert.isFalse(rates.calls.some((c) => c.name === 'create_awb'))
    await due(f.id)
    const order = await db.from('whatsapp_orders').where('id', f.id).first()
    const cart = JSON.parse(order.snapshot_json)
    delete cart.shipping.weightKg
    await db
      .from('whatsapp_orders')
      .where('id', f.id)
      .update({ snapshot_json: JSON.stringify(cart) })
    const missing = transport()
    await processNextShipment(missing.adapter)
    assert.equal((await job(f.id)).last_error_code, 'SHIPPING_WEIGHT_REQUIRED')
    assert.isFalse(missing.calls.some((c) => c.name === 'create_awb'))
  })
  test('cancellation during preflight prevents creation', async ({ assert }) => {
    const f = await fixture('ready')
    const mock = transport({
      check_shipping_rates: async () => {
        await db.from('whatsapp_orders').where('id', f.id).update({ status: 'cancelled' })
        return response({ rates: [{ service_code: 'REG', price: 8000 }] })
      },
    })
    await processNextShipment(mock.adapter)
    assert.isFalse(mock.calls.some((c) => c.name === 'create_awb'))
  })
  test('shipment notice is one-time, respects AI off, and uncertain transport is not repeated', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await processNextShipment(
      transport({
        track_awb: () =>
          response({
            awb: 'FIXTURE123456',
            history: [{ status: 'in_transit', timestamp: new Date().toISOString() }],
          }),
      }).adapter
    )
    const text = async () => 'Fixture shipment notice'
    let sent = 0
    const send = async (
      _notice: any,
      canSend: () => Promise<boolean>,
      reserve: (id: string) => Promise<boolean>
    ) => {
      assert.isTrue(await canSend())
      if (!(await reserve('FIXTURE-MESSAGE'))) return null
      sent++
      return 'FIXTURE-MESSAGE'
    }
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    assert.isFalse(await deliverShippingNotice(f.id, send, () => true, text))
    assert.equal(sent, 0)
    assert.lengthOf(await dueShippingNotices(), 0)
    const deferred = await db.from('whatsapp_shipping_notices').where('order_id', f.id).first()
    assert.isTrue(new Date(deferred.next_attempt_at).getTime() > Date.now())
    await db
      .from('whatsapp_shipping_notices')
      .where('order_id', f.id)
      .update({ next_attempt_at: new Date(0) })
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const orderRow = await db.from('whatsapp_orders').where('id', f.id).first()
    await db
      .table('whatsapp_contacts')
      .insert({ jid: orderRow.jid, ai_excluded: true, handling_mode: 'ai', updated_at: new Date() })
    assert.isFalse(await deliverShippingNotice(f.id, send, () => true, text))
    await db
      .from('whatsapp_contacts')
      .where('jid', orderRow.jid)
      .update({ ai_excluded: false, handling_mode: 'cs' })
    assert.isFalse(await deliverShippingNotice(f.id, send, () => true, text))
    await db.from('whatsapp_contacts').where('jid', orderRow.jid).update({ handling_mode: 'ai' })
    assert.isTrue(await deliverShippingNotice(f.id, send, () => true, text))
    assert.isFalse(await deliverShippingNotice(f.id, send, () => true, text))
    assert.equal(sent, 1)
    await db
      .from('whatsapp_shipping_notices')
      .where('order_id', f.id)
      .update({ status: 'sending', updated_at: new Date(0) })
    await dueShippingNotices()
    const notice = await db.from('whatsapp_shipping_notices').where('order_id', f.id).first()
    assert.equal(notice.status, 'uncertain')
    assert.isFalse(await deliverShippingNotice(f.id, send, () => true, text))
    assert.equal(sent, 1)
  })
  test('a restarted uncertain creation never repeats the side effect even with an empty lookup', async ({
    assert,
  }) => {
    const f = await fixture('ready')
    await recoverOrderShippingQueue()
    await db
      .from('whatsapp_order_shipping_jobs')
      .where('order_id', f.id)
      .update({
        status: 'processing',
        lease_token: randomUUID(),
        lease_until: new Date(0),
        create_started_at: new Date(0),
      })
    const mock = transport()
    await processNextShipment(mock.adapter)
    assert.isFalse(mock.calls.some((c) => c.name === 'create_awb'))
    assert.equal((await job(f.id)).status, 'reconciling')
  })
})
