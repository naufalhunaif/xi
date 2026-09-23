import { test } from '@japa/runner'
import { diagnosticTrace, diagnosticStep, diagnosticCart } from '#services/diagnostic_contract'
import { collectServerDiagnostics } from '#services/server_diagnostics'

test('completed cart handoff exposes validation code and paused state without private text', ({
  assert,
}) => {
  const result = diagnosticTrace({
    id: 'trace',
    status: 'completed',
    message_id: null,
    decision_json: JSON.stringify({
      decision: 'handoff',
      summary: 'Detail desain katalog tidak cocok dengan permintaan yang disetujui CS.',
      note: 'PRIVATE_NOTE',
    }),
    steps_json: '[]',
    goal_status: 'paused',
    handling_mode: 'ai',
    ai_excluded: 0,
    recovery_json: JSON.stringify({
      status: 'blocked',
      attempts: 1,
      phase: 'delivery',
      owner: 'PRIVATE_OWNER',
    }),
    next_run_at: null,
    cart_items_json: JSON.stringify([
      {
        name: 'PRIVATE_NAME',
        size: 'S',
        modelType: 'catalog',
        modelApproval: 'approved',
        productionDetails: { color: 'PRIVATE_COLOR', lapel: 'PRIVATE_LAPEL' },
        modelConsentEvidence: {
          requestMessageId: 'PRIVATE_REQUEST',
          approvalMessageId: 'PRIVATE_APPROVAL',
        },
      },
    ]),
  })
  assert.equal(result.outcome, 'handoff')
  assert.equal(result.cartValidationCode, 'CATALOG_DESIGN_MISMATCH_LEGACY')
  assert.isFalse(result.replyRecorded)
  assert.equal(result.currentGoal?.status, 'paused')
  assert.equal(result.currentGoal?.handlingMode, 'ai')
  assert.equal(result.currentGoal?.recoveryStatus, 'blocked')
  assert.deepEqual(result.currentCart?.items?.[0].designFieldsPresent, ['color', 'lapel'])
  assert.isTrue(result.currentCart?.items?.[0].consentReferencePresent)
  assert.notInclude(JSON.stringify(result), 'PRIVATE_')
})

test('unknown decisions and private reasons are not echoed; malformed cart remains unknown', ({
  assert,
}) => {
  const result = diagnosticTrace({
    decision_json: JSON.stringify({ decision: 'PRIVATE_DECISION', reason: 'PRIVATE_REASON' }),
    goal_status: 'PRIVATE_STATUS',
    handling_mode: 'PRIVATE_MODE',
    recovery_json: '{bad',
  })
  assert.equal(result.outcome, 'unknown')
  assert.isUndefined(result.cartValidationCode)
  assert.isUndefined(result.currentCart)
  assert.notInclude(JSON.stringify(result), 'PRIVATE_')
  assert.deepEqual(diagnosticCart('{bad', null), { unavailable: true })
  assert.deepEqual(diagnosticCart('[null]', null)?.items?.[0].designFieldsPresent, [])
})

test('cart validation telemetry distinguishes missing detail from wording mismatch', ({
  assert,
}) => {
  for (const [reason, expected] of [
    [
      'Warna lapel yang disebut dalam permintaan belum tersimpan pada detail katalog.',
      'CATALOG_LAPEL_COLOR_MISSING',
    ],
    [
      'Catatan desain katalog memuat detail yang belum cocok dengan permintaan yang disetujui CS.',
      'CATALOG_DESIGN_NOTES_MISMATCH',
    ],
    ['PRIVATE_MESSAGE', undefined],
    ['__proto__', undefined],
  ]) {
    const result = diagnosticStep({ key: 'cart', status: 'completed', detail: { reason } })
    assert.equal(result.cartValidationCode, expected)
    assert.notInclude(JSON.stringify(result), 'PRIVATE_')
  }
})

test('server reads trace and current cart/goal within the requested workspace and trace', async ({
  assert,
}) => {
  const queries: any[] = []
  let destroyed = false
  const result = await collectServerDiagnostics(
    2,
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    async () =>
      ({
        query: async (query: any) => {
          queries.push(query)
          if (query.sql.includes('whatsapp_ai_traces'))
            return [
              [
                {
                  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                  status: 'completed',
                  steps_json: '[]',
                  decision_json: '{"decision":"silent"}',
                  cart_items_json: '[]',
                  goal_status: 'paused',
                },
              ],
            ]
          return [[]]
        },
        destroy: () => {
          destroyed = true
        },
      }) as any
  )
  assert.equal(result.contractVersion, 2)
  assert.equal(result.traces[0].outcome, 'silent')
  assert.equal(result.traces[0].currentCart.itemCount, 0)
  const sql = queries.find((q) => q.sql.includes('whatsapp_ai_traces'))
  for (const table of [
    'whatsapp_ai_traces',
    'whatsapp_carts',
    'whatsapp_chat_goals',
    'whatsapp_contacts',
  ])
    assert.include(sql.sql, `w2_${table}`)
  assert.include(sql.sql, 'WHERE t.id = ?')
  assert.deepEqual(sql.values, ['aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'])
  assert.isTrue(destroyed)
})
