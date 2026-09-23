import { test } from '@japa/runner'
import {
  applySalesProgress,
  parseSalesProgress,
  salesProgressTrace,
  type SalesProgress,
} from '#services/sales_progress_contract'
import { parseDecision } from '#services/ai_service'

const progress = (patch: Partial<SalesProgress> = {}): SalesProgress => ({
  step: 'selection',
  delivery: 'initiative',
  text: 'Mau pre-order Choco size S, bos?',
  waitReason: 'none',
  ...patch,
})

test('chosen Choco needs a useful next step, preserving the model wording without another call', ({
  assert,
}) => {
  const result = parseDecision(
    JSON.stringify({
      decision: 'reply',
      message: 'Choco yang dipilih ya bos. Size S sedang kosong.',
      initiative: '',
      salesProgress: progress(),
    })
  )
  assert.equal(result.initiative, 'Mau pre-order Choco size S, bos?')
  assert.equal(salesProgressTrace(result).detail.extraAiCalls, 0)
  assert.equal(salesProgressTrace(result).detail.hasInitiative, true)
  assert.equal(result.message, 'Choco yang dipilih ya bos. Size S sedang kosong.')
})

test('semantic next step supports different language, one message, and does not duplicate text', ({
  assert,
}) => {
  const text = 'Would you like to pre-order this size?'
  assert.equal(
    applySalesProgress({
      decision: 'reply',
      message: 'Brown is selected.',
      initiative: '',
      salesProgress: progress({ text }),
    }).initiative,
    text
  )
  const only = parseDecision(
    JSON.stringify({
      decision: 'reply',
      message: '',
      salesProgress: progress({ delivery: 'message', text }),
    })
  )
  assert.equal(only.message, text)
  assert.isUndefined(only.initiative)
  const already = applySalesProgress({
    decision: 'reply',
    message: `Brown is selected. ${text}`,
    initiative: '',
    salesProgress: progress({ text }),
  })
  assert.equal(already.initiative, '')
})

test('missing initiative never comes from a goal note or overrides a valid reply', ({ assert }) => {
  const base = {
    decision: 'reply',
    message: 'Jawaban',
    initiative: 'Pilihan yang sudah ditulis?',
    salesProgress: progress(),
  }
  assert.equal(applySalesProgress(base).initiative, base.initiative)
  const legacy = parseDecision(
    JSON.stringify({ decision: 'reply', message: 'Iya bos.', goal: null })
  )
  assert.isUndefined(legacy.initiative)
  assert.isUndefined(parseSalesProgress({ delivery: 'initiative', text: 'Unsafe missing fields' }))
})

test('waiting, refusal, unanswered questions, handoff and uncertain images cannot gain a sales nudge', ({
  assert,
}) => {
  for (const waitReason of [
    'already_asked',
    'customer_paused',
    'answer_incomplete',
    'human_required',
    'scheduled',
    'finished',
    'no_relevant_step',
  ] as const) {
    const result = applySalesProgress({
      decision: 'reply',
      message: 'Jawaban',
      initiative: '',
      salesProgress: progress({ waitReason }),
    })
    assert.equal(result.initiative, '')
  }
  for (const decision of ['silent', 'handoff']) {
    const result = applySalesProgress({
      decision,
      message: '',
      initiative: '',
      salesProgress: progress(),
    })
    assert.equal(result.initiative, '')
  }
  for (const status of ['uncertain', 'no_match']) {
    const result = applySalesProgress({
      decision: 'reply',
      message: 'Belum jelas',
      initiative: '',
      salesProgress: progress(),
      visualMatch: { status },
    })
    assert.equal(result.initiative, '')
  }
})
