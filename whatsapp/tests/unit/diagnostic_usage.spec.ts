import { test } from '@japa/runner'
import { diagnosticUsage } from '#services/diagnostic_usage'

test('diagnostic usage separates cached input without double counting or leaking raw fields', ({
  assert,
}) => {
  const row = {
    phase: 'analysis',
    status: 'completed',
    input_tokens: '406634',
    output_tokens: '2478',
    cached_tokens: '326272',
    duration_ms: 49894,
    created_at: new Date('2026-09-20T13:33:20Z'),
    body: 'PRIVATE_BODY',
    jid: 'PRIVATE_ROOM',
  }
  const usage = diagnosticUsage(
    [row],
    [{ ...row, runs: '2', measured_runs: '1', failed_runs: '1' }]
  )
  assert.equal(usage.recent[0].total, 409112)
  assert.equal(usage.recent[0].uncachedInput, 80362)
  assert.equal(usage.phases[0].measuredRuns, 1)
  assert.notInclude(JSON.stringify(usage), 'PRIVATE_')
})

test('unmeasured usage stays unknown and unexpected text fields are not exported', ({ assert }) => {
  const usage = diagnosticUsage(
    [{ phase: 'PRIVATE_PHASE', status: 'PRIVATE_STATUS', input_tokens: null, output_tokens: null }],
    []
  )
  assert.isNull(usage.recent[0].total)
  assert.isNull(usage.recent[0].uncachedInput)
  assert.notInclude(JSON.stringify(usage), 'PRIVATE_')
})
