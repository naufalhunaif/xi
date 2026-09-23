import { test } from '@japa/runner'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  diagnosticAuthorized,
  diagnosticStep,
  diagnosticTrace,
} from '#services/diagnostic_contract'
import { collectServerDiagnostics } from '#services/server_diagnostics'
import {
  startWorkerDiagnostics,
  noteDiagnosticTrace,
  readWorkerDiagnostics,
} from '#services/worker_diagnostics'
import { inWorkspace } from '#services/workspace_context'
import { EventEmitter } from 'node:events'
import {
  observeProviderProcess,
  providerProcessDiagnostics,
} from '#services/provider_process_diagnostics'

test('diagnostic bearer must match fixed workspace config and expiry exactly', ({ assert }) => {
  const token = randomBytes(32).toString('base64url')
  const config = {
    tokenHash: createHash('sha256').update(token).digest('hex'),
    workspaceId: 2,
    expiresAt: 200,
  }
  assert.isTrue(diagnosticAuthorized(config, `Bearer ${token}`, 100))
  for (const header of ['', token, `Bearer ${token}extra`, 'Bearer ' + 'a'.repeat(43)])
    assert.isFalse(diagnosticAuthorized(config, header, 100))
  assert.isFalse(diagnosticAuthorized(config, `Bearer ${token}`, 200))
  for (const workspaceId of [0, -1, 1.5, Number.NaN])
    assert.isFalse(diagnosticAuthorized({ ...config, workspaceId }, `Bearer ${token}`, 100))
  assert.isFalse(diagnosticAuthorized({ ...config, tokenHash: 'invalid' }, `Bearer ${token}`, 100))
})

test('provider telemetry captures actual child exit before pipe cleanup and stays workspace scoped', async ({
  assert,
}) => {
  const child = Object.assign(new EventEmitter(), {
    pid: 987654,
    spawnargs: ['PRIVATE_COMMAND'],
    stderr: 'PRIVATE_STDERR',
  })
  await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, () =>
    observeProviderProcess(child as any, 'chatgpt')
  )
  child.emit('spawn')
  assert.equal(providerProcessDiagnostics(2).find((row) => row.pid === child.pid)?.state, 'running')
  assert.isFalse(providerProcessDiagnostics(3).some((row) => row.pid === child.pid))
  child.emit('exit', null, 'SIGKILL')
  const rows = providerProcessDiagnostics(2)
  assert.equal(rows.find((row) => row.pid === child.pid)?.state, 'exited')
  assert.equal(rows.find((row) => row.pid === child.pid)?.signal, 'SIGKILL')
  assert.notInclude(JSON.stringify(rows), 'PRIVATE_')
})

test('diagnostic projection excludes customer content, credentials, free-form errors and MCP results', ({
  assert,
}) => {
  const event = {
    key: 'analysis',
    label: 'PRIVATE_CUSTOMER',
    status: 'failed',
    detail: {
      code: 'AI_OUTPUT_INVALID',
      provider: 'chatgpt',
      message: 'PRIVATE_ERROR',
      arguments: { token: 'PRIVATE_TOKEN' },
      result: 'PRIVATE_RESULT',
      thinking: 'PRIVATE_REASONING',
      usage: { input: 123, output: 4 },
      sections: [{ key: 'skill: cs-cart-order', tokens: 100 }],
    },
  }
  const safe = diagnosticStep(event)
  assert.equal(safe.code, 'AI_OUTPUT_INVALID')
  assert.equal(safe.usage?.input, 123)
  assert.equal(safe.sections?.[0].key, 'skill:cs-cart-order')
  assert.notInclude(JSON.stringify(safe), 'PRIVATE_')
  const trace = diagnosticTrace(
    {
      id: 'id',
      status: 'running',
      jid: 'PRIVATE_JID',
      input_json: 'PRIVATE_INPUT',
      decision_json: 'PRIVATE_DECISION',
      steps_json: JSON.stringify([event]),
      updated_at: new Date(0),
    },
    300_000
  )
  assert.isTrue(trace.updatesStale)
  assert.notInclude(JSON.stringify(trace), 'PRIVATE_')
})

test('pattern diagnostics expose known pattern IDs and cache metrics without source or customer data', ({
  assert,
}) => {
  const cached = diagnosticStep({
    key: 'pattern-cache',
    detail: {
      status: 'hit',
      version: 'patterns-v1',
      policyHash: 'abcdef0123456789',
      patternCount: 11,
      candidateSavingPercent: 39.5,
      source: 'PRIVATE_SOURCE',
      prompt: 'PRIVATE_PROMPT',
      room: 'PRIVATE_ROOM',
    },
  })
  assert.equal(cached.patternCache?.status, 'hit')
  assert.isFalse(cached.patternCache?.customerDataCached)
  const selected = diagnosticStep({
    key: 'analysis:mcp-cache:1',
    detail: {
      tool: 'read_business_skill',
      arguments: {
        patternIds: ['fit', 'catalog-design', 'PRIVATE_DATA'],
        secret: 'PRIVATE_SECRET',
      },
    },
  })
  assert.deepEqual(selected.patternIds, ['fit', 'catalog-design'])
  assert.notInclude(JSON.stringify([cached, selected]), 'PRIVATE_')
})

test('compact diagnostics distinguish activation and missing contracts without exposing policy or customer content', ({
  assert,
}) => {
  const route = diagnosticStep({
    key: 'skill-routing',
    detail: {
      compactPolicy: {
        enabled: true,
        eligible: true,
        reason: 'reviewed_source_hashes',
        source: 'PRIVATE_SOURCE',
      },
    },
  })
  const expansion = diagnosticStep({
    key: 'skill-routing-expand',
    detail: {
      fields: ['cartIntent', 'PRIVATE_CUSTOMER'],
      modules: ['Visual', 'PRIVATE_POLICY'],
      expansionReason: 'visual_analysis_rules_missing',
      retry: 1,
      output: 'PRIVATE_OUTPUT',
    },
  })
  assert.isTrue(route.compactPolicy?.eligible)
  assert.deepEqual(expansion.compactExpansion?.fields, ['cartIntent'])
  assert.deepEqual(expansion.compactExpansion?.modules, ['Visual'])
  assert.equal(expansion.compactExpansion?.reason, 'visual_analysis_rules_missing')
  assert.notInclude(JSON.stringify([route, expansion]), 'PRIVATE_')
})

test('database failure returns independent runtime evidence and sanitized code', async ({
  assert,
}) => {
  const result = await collectServerDiagnostics(2, undefined, async () => {
    throw Object.assign(new Error('PRIVATE_DB_PASSWORD'), { code: 'ECONNREFUSED' })
  })
  assert.equal(result.database.status, 'unavailable')
  assert.equal(result.database.code, 'ECONNREFUSED')
  assert.equal(result.runtime.pid, process.pid)
  assert.include(
    result.evidence.map((row: any) => row.code),
    'DATABASE_PROBE_FAILED'
  )
  assert.notInclude(JSON.stringify(result), 'PRIVATE_DB_PASSWORD')
})

test('worker snapshot survives without DB and exposes only authorized workspace activity', async ({
  assert,
}) => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-diagnostics-'))
  const stop = await startWorkerDiagnostics(directory)
  try {
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, () =>
      noteDiagnosticTrace('trace-own', {
        key: 'analysis',
        status: 'running',
        detail: { message: 'PRIVATE_CUSTOMER' },
      })
    )
    await inWorkspace({ id: 3, prefix: 'w3_', phone: null, version: '' }, () =>
      noteDiagnosticTrace('trace-other', { key: 'analysis', status: 'running' })
    )
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, () => {
      for (let index = 0; index < 40; index++)
        noteDiagnosticTrace('trace-own', { key: `tool-${index}`, status: 'completed' })
    })
    await stop()
    await writeFile(
      join(directory, 'worker-999999.json'),
      JSON.stringify({ seenAt: new Date(Date.now() - 90_000_000).toISOString(), activity: [] })
    )
    const rows: any[] = await readWorkerDiagnostics(directory, 2)
    assert.lengthOf(rows, 1)
    assert.isFalse(rows[0].heartbeatFresh)
    assert.isTrue(rows[0].stopped)
    assert.equal(rows[0].activity[0].id, 'trace-own')
    assert.isTrue(
      rows[0].activity[0].steps.some(
        (step: any) => step.key === 'analysis' && step.status === 'running'
      )
    )
    assert.notInclude(JSON.stringify(rows), 'trace-other')
    assert.notInclude(JSON.stringify(rows), 'PRIVATE_CUSTOMER')
  } finally {
    await stop()
    await rm(directory, { recursive: true, force: true })
  }
})
