import { test } from '@japa/runner'
import { currentFitRequest } from '#services/fit_routing_service'
import { needsBusinessVerification, verifyBusinessRun } from '#services/skill_runtime_service'

const text = 'Gan kalo tinggi 168 berat 84 bagusnya celana pake no berapa ya'
const request = { type: 'pants', height: 168, weight: 84 }
const connections = [{ slug: 'fit', enabled: true, authenticated: true }]
const handoff = {
  decision: 'handoff',
  handoff_category: 'human_authorization',
  business_lookup_required: false,
}
const call = {
  server: 'business_fit',
  tool: 'fit_advisor',
  arguments: request,
  result: {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: { recommended_pants_no: 38, preference_question: 'Slim fit atau regular?' },
        }),
      },
    ],
  },
}
const run = (decision: Record<string, unknown>, toolCalls: any[] = []) => ({
  text: JSON.stringify(decision),
  toolCalls,
})

test.group('Current fit need cannot be swallowed by an old handoff', () => {
  test('recognizes the customer question without guessing age or style', ({ assert }) => {
    assert.deepEqual(currentFitRequest(text), request)
    assert.deepEqual(currentFitRequest('TB: 168 BB: 84,5, celana size berapa?'), {
      ...request,
      weight: 84.5,
    })
    assert.deepEqual(currentFitRequest('168 cm 84 kg cocok celana no berapa?'), request)
    for (const other of [
      'Kapan order custom dikirim?',
      'Celana saya ukuran 38 TB 168 BB 84',
      '',
      'TB 168 BB 84 ukuran celana berapa? Saya mau bicara CS',
    ])
      assert.isUndefined(currentFitRequest(other))
  })
  test('requires Fit even for human authorization, unrelated tools, errors or wrong measurements', ({
    assert,
  }) => {
    for (const tools of [
      [],
      [{ server: 'business_store', tool: 'list_records' }],
      [{ ...call, arguments: { ...request, weight: 70 } }],
      [{ ...call, result: { isError: true } }],
    ]) {
      assert.isTrue(needsBusinessVerification(run(handoff, tools), connections, request))
    }
    assert.isTrue(needsBusinessVerification(run(handoff, [call]), connections, request))
    assert.isTrue(
      needsBusinessVerification(
        run({ decision: 'reply', message: 'Modelnya apa?' }, [call]),
        connections,
        request
      )
    )
    assert.isFalse(needsBusinessVerification(run(handoff), connections))
  })
  test('accepts verified advice while retaining the separate old approval need', async ({
    assert,
  }) => {
    const checked = run(
      {
        decision: 'reply',
        message: 'Estimasi regular nomor 38.',
        goal: { status: 'waiting_approval', waiting_for: 'Status produksi dari owner' },
      },
      [call]
    )
    let attempts = 0
    assert.deepEqual(
      await verifyBusinessRun(
        run(handoff),
        connections,
        async () => {
          attempts++
          return checked
        },
        request
      ),
      checked
    )
    assert.equal(attempts, 1)
    assert.isFalse(
      needsBusinessVerification(
        run({ decision: 'reply', message: 'Lebih suka slim fit atau regular?' }, [call]),
        connections,
        request
      )
    )
    await assert.rejects(
      () => verifyBusinessRun(run(handoff), connections, async () => run(handoff), request),
      /Balasan ditahan/
    )
  })
  test('an out-of-range tool result may still need human help', ({ assert }) => {
    const unsupported = {
      ...call,
      result: { structured_content: { ok: true, data: { recommended_pants_no: null } } },
    }
    assert.isFalse(needsBusinessVerification(run(handoff, [unsupported]), connections, request))
  })
})
