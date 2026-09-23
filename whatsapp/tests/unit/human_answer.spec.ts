import { test } from '@japa/runner'
import { understandHumanAnswer } from '#services/human_answer_service'
import { parseGoal } from '#services/goal_contract'

test('human answer states stay internal and never schedule replies or another handoff', ({
  assert,
}) => {
  for (const status of [
    'waiting_answer',
    'waiting_payment',
    'waiting_approval',
    'completed',
  ] as const) {
    const goal = parseGoal({
      objective: 'Pesanan',
      status,
      waiting_for: 'Informasi berikutnya',
      next_action: 'Tunggu',
      follow_up: null,
    })!
    const decision = understandHumanAnswer({
      decision: 'handoff',
      message: 'Jangan kirim',
      initiative: 'Jangan kirim',
      reason: 'CS lagi',
      note: 'Jawaban dipahami',
      goal,
    })
    assert.equal(decision.decision, 'silent')
    assert.equal(decision.message, '')
    assert.equal(decision.initiative, '')
    assert.equal(decision.handoff_category, 'none')
    assert.equal(decision.goal?.status, status)
    assert.isNull(decision.goal?.follow_up)
  }
})
