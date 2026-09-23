import { test } from '@japa/runner'
import {
  aiFailureDetail,
  AiProcessFailure,
  providerFailure,
  traceAiOperation,
  updateProviderFailure,
} from '#services/ai_failure_service'
import {
  redactTrace,
  traceInterruption,
  traceProviderEvents,
  type TraceEvent,
} from '#services/trace_service'
import { switchableFailure } from '#services/ai_provider_failover'
import { CartSelectionIncompleteError } from '#services/cart_selection_recovery'

test('cart validation inside a transaction is not mistaken for database downtime', ({ assert }) => {
  for (const error of [new CartSelectionIncompleteError(), new Error('Size belum valid.')]) {
    error.stack =
      'at normalizeItem (cart_service.ts:1)\n at /app/node_modules/@adonisjs/lucid/src/transaction.js:2'
    const detail = aiFailureDetail(error, { stage: 'processing', provider: 'chatgpt' })
    assert.equal(detail.code, 'CART_SELECTION_INCOMPLETE')
    assert.isFalse(detail.retryable)
  }
  const businessError = new Error('Jumlah tidak valid.')
  businessError.stack = 'at /app/node_modules/knex/lib/transaction.js:2'
  assert.notEqual(
    aiFailureDetail(businessError, { stage: 'processing' }).code,
    'DATABASE_UNAVAILABLE'
  )
})

test('stale audit means missing updates, not a confirmed provider or MCP failure', ({ assert }) => {
  const now = Date.now()
  assert.isNull(traceInterruption('running', new Date(now - 240_000), now))
  assert.isNull(traceInterruption('completed', new Date(now - 500_000), now))
  assert.isNull(traceInterruption('failed', new Date(now - 500_000), now))
  assert.isNull(traceInterruption('running', 'invalid', now))
  const diagnostic = traceInterruption('running', new Date(now - 240_001), now)
  assert.equal(diagnostic?.code, 'TRACE_UPDATES_STALE')
  assert.include(diagnostic!.message, 'belum terkonfirmasi')
  assert.equal(diagnostic?.lastUpdatedAt, new Date(now - 240_001).toISOString())
})

test('prompt accounting preserves all 40 reported sections while still redacting secrets', ({
  assert,
}) => {
  const safe = redactTrace({
    sections: Array.from({ length: 45 }, (_, index) => ({
      key: `section-${index}`,
      tokens: index,
      access_token: 'private',
    })),
  }) as any
  assert.lengthOf(safe.sections, 40)
  assert.equal(safe.sections[39].tokens, 39)
  assert.equal(safe.sections[39].access_token, '[disembunyikan]')
})

test('local AI deadline is explicit and does not trigger a second provider run', ({ assert }) => {
  for (const name of ['ChatGPT', 'Claude']) {
    const detail = aiFailureDetail(new Error(`${name} terlalu lama merespons.`), {
      stage: 'provider',
    })
    assert.equal(detail.code, 'AI_TIMEOUT')
    assert.include(detail.message, '180 detik')
    assert.isFalse(switchableFailure(detail.code))
  }
})

test('MySQL pool and connection failures are identified without exposing SQL or confusing provider networking', ({
  assert,
}) => {
  for (const text of [
    'Knex: Timeout acquiring a connection. The pool is probably full.',
    'connect ECONNRESET 127.0.0.1:3306',
    'Acquire connection error: operation timed out',
  ]) {
    assert.equal(
      aiFailureDetail(new Error(text), { stage: 'processing' }).code,
      'DATABASE_UNAVAILABLE'
    )
  }
  const error = new Error('connect ETIMEDOUT')
  error.stack = 'at Connection.handleTimeout (/app/node_modules/mysql2/lib/connection.js:1)'
  assert.equal(aiFailureDetail(error, { stage: 'processing' }).code, 'DATABASE_UNAVAILABLE')
  assert.equal(
    aiFailureDetail(new Error('connect ETIMEDOUT'), { stage: 'provider' }).code,
    'AI_UNAVAILABLE'
  )
})

test('trace preserves numeric accounting without exposing token credentials', ({ assert }) => {
  const safe = redactTrace({
    tokens: 1000,
    estimatedTokens: 900,
    savedTokens: 100,
    sections: [{ tokens: 700, chars: 2590 }],
    token: 1234,
    access_token: 'secret',
    refresh_token: 'secret',
    nested: { tokens: 'secret', estimatedTokens: Infinity, savedTokens: -1 },
  }) as any
  assert.equal(safe.tokens, 1000)
  assert.equal(safe.estimatedTokens, 900)
  assert.equal(safe.savedTokens, 100)
  assert.equal(safe.sections[0].tokens, 700)
  for (const key of ['token', 'access_token', 'refresh_token'])
    assert.equal(safe[key], '[disembunyikan]')
  for (const value of Object.values(safe.nested)) assert.equal(value, '[disembunyikan]')
})

test('legacy cart photo validation is not reported as a provider failure', ({ assert }) => {
  const failure = aiFailureDetail(
    new Error('Foto referensi model khusus belum tersedia di room ini.'),
    { stage: 'processing', provider: 'chatgpt' }
  )
  assert.equal(failure.code, 'CART_REFERENCE_UNAVAILABLE')
  assert.isFalse(failure.retryable)
})

test('ChatGPT usage limits are detected from terminal messages and structured codes', ({
  assert,
}) => {
  for (const event of [
    { type: 'turn.failed', error: { code: 'usage_limit_reached' } },
    { type: 'turn.failed', error: { message: 'You have hit your usage limit' } },
    { type: 'error', error: { code: 'rate_limit_exceeded' } },
    { type: 'error', message: '429 Too many requests' },
  ]) {
    const failure = providerFailure('chatgpt', event)
    assert.equal(failure?.provider, 'chatgpt')
    assert.equal(failure?.code, 'USAGE_LIMIT')
    assert.isUndefined(updateProviderFailure(failure, 'chatgpt', { type: 'turn.completed' }))
  }
})

test('MCP auth failure identifies the failing source without exposing OAuth output', async ({
  assert,
}) => {
  const events: TraceEvent[] = []
  let caught: unknown
  try {
    await traceAiOperation(
      (event) => events.push(event),
      'analysis:mcp-auth:fit',
      'Memeriksa akses MCP · fit',
      { stage: 'mcp_auth', provider: 'claude', source: 'fit' },
      async () => {
        throw new Error(
          'invalid_grant access_token=fixture-secret https://example.invalid?code=secret'
        )
      }
    )
  } catch (error) {
    caught = error
  }
  assert.instanceOf(caught, AiProcessFailure)
  assert.deepEqual(
    events.map((event) => event.status),
    ['running', 'failed']
  )
  const failure = aiFailureDetail(caught, { stage: 'provider', provider: 'claude' })
  assert.equal(failure.source, 'fit')
  assert.equal(failure.stage, 'mcp_auth')
  assert.equal(failure.code, 'MCP_AUTH_REQUIRED')
  assert.isFalse(failure.retryable)
  assert.notInclude(JSON.stringify(events), 'fixture-secret')
  assert.notInclude(JSON.stringify(failure), 'example.invalid')
})

test('Claude structured usage limits survive a generic exit and do not confuse allowed warnings with rejection', ({
  assert,
}) => {
  const failure = updateProviderFailure(undefined, 'claude', {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected' },
  })
  assert.equal(failure?.code, 'USAGE_LIMIT')
  assert.equal(
    updateProviderFailure(failure, 'claude', { type: 'result', is_error: true, errors: [] })?.code,
    'USAGE_LIMIT'
  )
  assert.equal(
    providerFailure('claude', { type: 'assistant', error: 'rate_limit', message: { content: [] } })
      ?.code,
    'USAGE_LIMIT'
  )
  for (const status of ['allowed', 'allowed_warning'])
    assert.isUndefined(
      providerFailure('claude', {
        type: 'rate_limit_event',
        rate_limit_info: { status, overageStatus: 'rejected' },
      })
    )
  assert.isUndefined(updateProviderFailure(failure, 'claude', { type: 'result', is_error: false }))
})

test('MCP transient failure is distinct from lost authorization and never silently retried', async ({
  assert,
}) => {
  let attempts = 0
  const events: TraceEvent[] = []
  await assert.rejects(() =>
    traceAiOperation(
      (event) => events.push(event),
      'auth',
      'MCP',
      { stage: 'mcp_auth', source: 'store' },
      async () => {
        attempts++
        throw new Error('Koneksi MCP sementara tidak tersedia. Coba lagi.')
      }
    )
  )
  assert.equal(attempts, 1)
  assert.equal((events.at(-1)!.detail as any).code, 'MCP_UNAVAILABLE')
  assert.isTrue((events.at(-1)!.detail as any).retryable)
})

test('successful MCP readiness closes its step without saving the token', async ({ assert }) => {
  const events: TraceEvent[] = []
  const token = await traceAiOperation(
    (event) => events.push(event),
    'auth',
    'MCP',
    { stage: 'mcp_auth', source: 'store' },
    async () => 'fixture-secret'
  )
  assert.equal(token, 'fixture-secret')
  assert.deepEqual(
    events.map((event) => event.status),
    ['running', 'completed']
  )
  assert.notInclude(JSON.stringify(events), token)
})

test('worker diagnostics categorize process, model, limit, network and invalid output safely', ({
  assert,
}) => {
  for (const [input, code] of [
    ['spawn codex ENOENT', 'AI_PROCESS_MISSING'],
    ['EACCES permission denied', 'AI_PERMISSION_DENIED'],
    ['unexpected argument --bad', 'AI_CONFIG_INVALID'],
    ['429 usage limit reached', 'USAGE_LIMIT'],
    ['fetch failed', 'AI_UNAVAILABLE'],
    ['JSON invalid', 'AI_OUTPUT_INVALID'],
    ['Balasan ditahan: pemeriksaan data bisnis', 'BUSINESS_EVIDENCE_MISSING'],
    ['ER_LOCK_DEADLOCK', 'DATABASE_UNAVAILABLE'],
    ['server_error', 'AI_PROCESS_FAILED'],
  ]) {
    const result = aiFailureDetail(new Error(`${input}\nBearer fixture-secret`), {
      stage: 'provider',
      provider: 'chatgpt',
    })
    assert.equal(result.code, code)
    assert.notInclude(JSON.stringify(result), 'fixture-secret')
  }
})

test('terminal provider failures carry safe details while recoverable tool events stay independent', ({
  assert,
}) => {
  const events: TraceEvent[] = []
  const sink = traceProviderEvents((event) => events.push(event), 'analysis')
  sink('chatgpt', {
    type: 'turn.failed',
    error: { message: '429 usage limit token=fixture-secret' },
  })
  assert.equal(events[0].key, 'analysis')
  assert.equal(events[0].status, 'failed')
  assert.equal((events[0].detail as any).code, 'USAGE_LIMIT')
  sink('claude', { type: 'result', is_error: true, errors: ['Unauthorized fixture-secret'] })
  assert.equal((events[1].detail as any).code, 'AI_AUTH_REQUIRED')
  assert.isUndefined(providerFailure('claude', { type: 'result', is_error: false, result: 'Done' }))
  assert.isUndefined(providerFailure('chatgpt', { type: 'error', message: 'Retrying transport' }))
  assert.isUndefined(
    providerFailure('chatgpt', {
      type: 'item.completed',
      item: { type: 'mcp_tool_call', result: { isError: true } },
    })
  )
  assert.notInclude(JSON.stringify(events), 'fixture-secret')
})

test('provider schema rejection is distinct from malformed model output and cannot fail over', ({
  assert,
}) => {
  for (const message of [
    "Invalid schema for response_format 'reply': 'required' must include every key in properties. Missing 'needsFullSkillContext'.",
    'HTTP 400 invalid_json_schema: secret-sensitive-content',
    'invalid_schema: additionalProperties must be false',
  ]) {
    const failure = aiFailureDetail(new Error(message), { stage: 'provider', provider: 'chatgpt' })
    assert.equal(failure.code, 'AI_SCHEMA_INVALID')
    assert.isFalse(failure.retryable)
    assert.isFalse(switchableFailure(failure.code))
    assert.notInclude(JSON.stringify(failure), 'secret-sensitive-content')
  }
  assert.equal(
    aiFailureDetail(new Error('Balasan AI kosong.'), { stage: 'provider' }).code,
    'AI_OUTPUT_INVALID'
  )
})

test('explicit request errors survive generic exits but clear after a recovered turn', ({
  assert,
}) => {
  for (const [message, code] of [
    ['Invalid schema for response_format: secret-fixture', 'AI_SCHEMA_INVALID'],
    ['context_length_exceeded: JSON input exceeds limit secret-fixture', 'AI_CONTEXT_LIMIT'],
    ['invalid model: secret-fixture', 'AI_CONFIG_INVALID'],
  ]) {
    const first = updateProviderFailure(undefined, 'chatgpt', { type: 'error', message })
    assert.equal(first?.code, code)
    const last = updateProviderFailure(first, 'chatgpt', {
      type: 'turn.failed',
      error: { message: 'ChatGPT tidak menghasilkan balasan.' },
    })
    assert.equal(last?.code, code)
    assert.notInclude(JSON.stringify(last), 'secret-fixture')
    assert.isUndefined(updateProviderFailure(first, 'chatgpt', { type: 'turn.completed' }))
    assert.isFalse(switchableFailure(code))
  }
  assert.equal(
    aiFailureDetail(new Error('ChatGPT tidak menghasilkan balasan.'), { stage: 'provider' }).code,
    'AI_OUTPUT_EMPTY'
  )
})
