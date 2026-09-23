import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import type { Operations } from '#services/order_operations_service'
import {
  nextProductionStage,
  progressProduction,
  startConfirmedProduction,
} from '#services/order_progress_service'
import { defaultProductionPolicy } from '#services/production_contract'

const now = DateTime.fromISO('2026-09-15T10:00:00+07:00')
const order = {
  paid: 100,
  total: 100,
  snapshot_json: JSON.stringify({
    items: [{ name: 'Custom peak', quantity: 1 }],
    recipient: { name: 'Fixture', phone: '628120000001', address: 'Fixture address' },
    shipping: { service: 'REG' },
  }),
}
const operations = (patch: Partial<Operations> = {}): Operations => ({
  stage: 'queued',
  kind: 'custom',
  estimate: null,
  policyVersion: null,
  eligibleAt: null,
  startedOn: null,
  expectedReadyOn: null,
  shippedOn: null,
  trackingNumber: '',
  carrier: '',
  note: '',
  externalSource: '',
  externalId: '',
  source: 'verified_payment',
  ...patch,
})
const policy = () => {
  const value = defaultProductionPolicy()
  value.version = 'policy-1'
  value.rules.custom = {
    enabled: true,
    minDays: 3,
    maxDays: 10,
    estimateDays: 5,
    dayType: 'calendar',
    startsAfter: 'payment_details',
  }
  return value
}

test.group('One-click order production', () => {
  test('confirmed complete orders start production without an extra queue click', ({ assert }) => {
    for (const kind of ['standard', 'custom', 'preorder'] as const) {
      const result = startConfirmedProduction(operations({ kind }), order, now)
      assert.equal(result.stage, 'production')
      assert.equal(result.startedOn, '2026-09-15')
    }
    assert.equal(startConfirmedProduction(operations(), { ...order, paid: 0 }, now).stage, 'queued')
    assert.equal(
      startConfirmedProduction(operations(), { ...order, snapshot_json: '{}' }, now).stage,
      'queued'
    )
    const before = operations({
      estimate: { ...policy().rules.custom, startsAfter: 'full_payment_details' },
    })
    assert.equal(startConfirmedProduction(before, { ...order, paid: 50 }, now).stage, 'queued')
    assert.equal(startConfirmedProduction(before, order, now).stage, 'production')
    for (const stage of ['ready', 'shipped', 'completed'] as const)
      assert.equal(startConfirmedProduction(operations({ stage }), order, now).stage, stage)
  })
  test('uses a short standard/custom path and never infers shipping from an AWB', ({ assert }) => {
    assert.equal(nextProductionStage(operations({ stage: 'unverified' })), 'queued')
    assert.equal(nextProductionStage(operations({ kind: 'standard' })), 'ready')
    assert.equal(nextProductionStage(operations()), 'production')
    for (const stage of ['production', 'qc'] as const)
      assert.equal(nextProductionStage(operations({ stage })), 'ready')
    for (const stage of ['ready', 'shipped', 'completed'] as const) {
      const before = operations({ stage, trackingNumber: 'TEST-AWB' })
      assert.isNull(nextProductionStage(before))
      assert.throws(() => progressProduction(before, order, policy(), now), /konfirmasi pengiriman/)
    }
  })

  test('adopts enabled settings and records an actual production start on operator action', ({
    assert,
  }) => {
    const before = operations()
    const next = progressProduction(before, order, policy(), now)
    assert.equal(next.stage, 'production')
    assert.equal(next.startedOn, '2026-09-15')
    assert.equal(next.expectedReadyOn, '2026-09-20')
    assert.equal(next.policyVersion, 'policy-1')
    assert.equal(next.source, 'operator')
    assert.isNull(before.startedOn)
    assert.isNull(before.estimate)
  })

  test('preserves an existing estimate and eligibility when current settings change', ({
    assert,
  }) => {
    const before = operations({
      estimate: { ...policy().rules.custom, estimateDays: 7 },
      policyVersion: 'old-policy',
      eligibleAt: '2026-09-12T10:00:00+07:00',
    })
    const next = progressProduction(before, order, policy(), now)
    assert.equal(next.estimate?.estimateDays, 7)
    assert.equal(next.policyVersion, 'old-policy')
    assert.equal(next.expectedReadyOn, '2026-09-19')
    const promised = progressProduction(
      { ...before, expectedReadyOn: '2026-09-25' },
      order,
      policy(),
      now
    )
    assert.equal(promised.expectedReadyOn, '2026-09-25')
  })

  test('does not invent working-day calendars or enable unset rules', ({ assert }) => {
    const working = policy()
    working.rules.custom.dayType = 'working'
    const next = progressProduction(operations(), order, working, now)
    assert.equal(next.estimate?.estimateDays, 5)
    assert.isNull(next.expectedReadyOn)
    const unset = progressProduction(operations(), order, defaultProductionPolicy(), now)
    assert.isNull(unset.estimate)
    assert.isNull(unset.expectedReadyOn)
  })

  test('requires verified payment and required recipient/shipping details', ({ assert }) => {
    assert.throws(
      () => progressProduction(operations(), { ...order, paid: 0 }, policy(), now),
      /Pembayaran/
    )
    for (const key of ['items', 'recipient', 'shipping']) {
      const snapshot = JSON.parse(order.snapshot_json)
      delete snapshot[key]
      assert.throws(
        () =>
          progressProduction(
            operations(),
            { ...order, snapshot_json: JSON.stringify(snapshot) },
            policy(),
            now
          ),
        /Lengkapi/
      )
    }
  })

  test('honours full-payment and approval-start settings', ({ assert }) => {
    const full = policy()
    full.rules.custom.startsAfter = 'full_payment_details'
    assert.throws(
      () => progressProduction(operations(), { ...order, paid: 50 }, full, now),
      /pelunasan/
    )
    full.rules.custom.startsAfter = 'approval'
    const queued = progressProduction(operations({ stage: 'awaiting_details' }), order, full, now)
    assert.isNull(queued.eligibleAt)
    assert.isNull(queued.expectedReadyOn)
    const started = progressProduction(queued, order, full, now)
    assert.isNotNull(started.eligibleAt)
    assert.equal(started.expectedReadyOn, '2026-09-20')
  })
})
