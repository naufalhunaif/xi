import { test } from '@japa/runner'
import {
  incompleteCartSelection,
  conversationOnlyCartRecovery,
  CartSelectionIncompleteError,
} from '#services/cart_selection_recovery'
import type { AiDecision } from '#services/ai_service'
import type { CartIntent } from '#services/cart_contract'

test('preflight distinguishes missing size from confirmed standard or custom sizing', ({
  assert,
}) => {
  for (const size of ['S', '30', 'custom', 'custom 38'])
    assert.deepEqual(
      incompleteCartSelection({ action: 'sync', items: [{ size }] } as CartIntent),
      []
    )
  assert.lengthOf(
    incompleteCartSelection({
      action: 'sync',
      items: [{ id: '', productId: '', size: '  ', referenceMessageId: 'photo' }],
    } as CartIntent),
    1
  )
  assert.deepEqual(incompleteCartSelection(null), [])
  assert.deepEqual(
    incompleteCartSelection({ action: 'cancel', items: [] } as unknown as CartIntent),
    []
  )
})

test('conversation repair cannot sneak through cart, payment or approval side effects', ({
  assert,
}) => {
  const original = { cartVersion: 'original-version' } as AiDecision
  const repaired = {
    decision: 'reply',
    message: 'Warnanya mau mengikuti foto, bos?',
    initiative: '',
    goal: { status: 'waiting_answer' },
  } as AiDecision
  assert.equal(conversationOnlyCartRecovery(original, repaired).cartVersion, 'original-version')
  for (const patch of [
    { cartIntent: {} },
    { checkoutContinuity: {} },
    { approvalWait: 'model' },
    { customSizeQuestion: {} },
    { localResolution: 'closed_ack' },
    { indexReply: {} },
    { goal: null },
    { decision: 'silent' },
    { message: '' },
  ])
    assert.throws(
      () => conversationOnlyCartRecovery(original, { ...repaired, ...patch } as AiDecision),
      CartSelectionIncompleteError
    )
})
