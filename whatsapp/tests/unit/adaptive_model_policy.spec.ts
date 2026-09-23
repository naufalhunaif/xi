import { test } from '@japa/runner'
import {
  adaptiveRoute,
  selectModelProfile,
  reducedOutputNeedsPrimary,
} from '#services/adaptive_model_policy'
import { conversationLevelTrace } from '#services/conversation_level_trace'
import { planConversationLevel } from '#services/conversation_levels'
import { redactTrace } from '#services/trace_service'
import { diagnosticStep } from '#services/diagnostic_contract'

const primary = { model: 'gpt-6-astra', reasoning: 'high', speed: 'fast' }
const state = {
  currentText: 'harga jas',
  currentMessageCount: 1,
  hasMedia: false,
  hasQuote: false,
  cartVersion: 'v1',
  cartItems: 0,
  orderCount: 0,
  pendingMemory: false,
  lastMessageId: '',
  lastMessageDigest: '',
  lastSender: '',
  previousExternalId: 0,
  lastQuestion: '',
  waitingFor: '',
  checkpoint: null,
}
const route = (tier: 'light' | 'standard' | 'complex') => ({
  enabled: true,
  tier,
  reason: 'fixture',
})

test('profile defaults, overrides and disabled routing preserve the primary fallback', ({
  assert,
}) => {
  assert.containSubset(selectModelProfile('chatgpt', route('light'), primary), {
    model: 'gpt-5.6-luna',
    reasoning: 'low',
    speed: 'standard',
    tier: 'light',
  })
  assert.containSubset(selectModelProfile('chatgpt', route('standard'), primary), {
    model: 'gpt-5.6-terra',
    reasoning: 'medium',
    speed: 'standard',
  })
  assert.containSubset(
    selectModelProfile('chatgpt', route('light'), primary, {
      light: { model: 'gpt-5.5', reasoning: 'low' },
    }),
    { model: 'gpt-5.5', reasoning: 'low' }
  )
  assert.containSubset(
    selectModelProfile('chatgpt', { ...route('light'), enabled: false }, primary),
    primary
  )
  assert.containSubset(selectModelProfile('chatgpt', route('light'), primary, {}, true), {
    ...primary,
    tier: 'complex',
  })
  assert.containSubset(
    selectModelProfile('claude', route('light'), {
      model: 'opus',
      reasoning: 'high',
      speed: 'fast',
    }),
    { model: 'haiku', reasoning: 'auto', speed: 'standard' }
  )
})

test('complex effort increases on promotion but never reduces the owner effort or invents support', ({
  assert,
}) => {
  const promoted = { ...route('complex'), reason: 'promoted_to_primary' }
  assert.equal(selectModelProfile('chatgpt', promoted, primary).reasoning, 'xhigh')
  assert.equal(
    selectModelProfile('chatgpt', promoted, { ...primary, reasoning: 'ultra' }).reasoning,
    'ultra'
  )
  assert.equal(
    selectModelProfile('chatgpt', promoted, {
      ...primary,
      model: 'custom-model',
      reasoning: 'auto',
    }).reasoning,
    'auto'
  )
  assert.equal(
    selectModelProfile('chatgpt', route('complex'), { ...primary, reasoning: 'low' }).reasoning,
    'high'
  )
})

test('business state and ambiguous meaning cannot be downrouted by short messages or catalogue keywords', ({
  assert,
}) => {
  const input = {
    enabled: true,
    index: false,
    level: 2 as const,
    indices: [2 as const],
    hasVisual: false,
    state,
  }
  assert.equal(adaptiveRoute(input).tier, 'standard')
  for (const change of [
    { cartItems: 1 },
    { orderCount: 1 },
    { pendingMemory: true },
    { hasQuote: true },
    { hasMedia: true },
    { currentMessageCount: 2 },
  ])
    assert.equal(adaptiveRoute({ ...input, state: { ...state, ...change } }).tier, 'complex')
  for (const id of [0, 3, 4, 5, 6, 7, 8, 9] as const)
    assert.equal(adaptiveRoute({ ...input, indices: [2, id] }).tier, 'complex')
  assert.equal(adaptiveRoute({ ...input, state: undefined }).tier, 'complex')
  assert.equal(adaptiveRoute({ ...input, level: 3 }).tier, 'complex')
  assert.equal(adaptiveRoute({ ...input, hasVisual: true }).tier, 'complex')
  assert.equal(adaptiveRoute({ ...input, index: true }).tier, 'light')
})

test('reduced catalogue results requiring any mutation, approval, uncertainty or malformed output escalate', ({
  assert,
}) => {
  const base = {
    decision: 'reply',
    message: 'Fixture',
    cartIntent: null,
    customerMemory: [],
    handoff_category: 'none',
    goal: { follow_up: null },
  }
  assert.isFalse(reducedOutputNeedsPrimary(JSON.stringify(base)))
  for (const change of [
    { requiresDeepReasoning: true },
    { needsFullSkillContext: true },
    { decision: 'handoff' },
    { cartIntent: { action: 'sync' } },
    { approvalWait: 'model' },
    { checkoutContinuity: {} },
    { customSizeQuestion: {} },
    { needsVisualInspection: true },
    { customerMemory: [{}] },
    { goal: { follow_up: {} } },
    { goal: { status: 'waiting_payment' } },
  ])
    assert.isTrue(reducedOutputNeedsPrimary(JSON.stringify({ ...base, ...change })))
  assert.isTrue(reducedOutputNeedsPrimary('invalid'))
})

test('trace separates provider cached tokens from MCP hits and exposes effort enums without reasoning text', ({
  assert,
}) => {
  const events: any[] = []
  const t = conversationLevelTrace(planConversationLevel('harga jas'), (e) => events.push(e))
  t.emit({ key: 'analysis', label: 'AI', status: 'running' })
  const usage = {
    key: 'analysis',
    label: 'AI',
    status: 'completed' as const,
    detail: { usage: { input: 10000, cached: 8000 } },
  }
  t.emit(usage)
  t.emit(usage)
  t.finish('completed')
  const exported = diagnosticStep({ ...events.at(-1), detail: redactTrace(events.at(-1).detail) })
  assert.containSubset(exported.processingLevel, {
    cacheHits: 0,
    providerInputTokens: 10000,
    providerCachedInputTokens: 8000,
  })
  const detail = redactTrace({
    modelSelection: {
      model: 'gpt-5.5',
      tier: 'light',
      reasoning: 'low',
      reason: 'bounded_social_index',
    },
    reasoningText: 'PRIVATE',
    secret: 'PRIVATE',
  })
  assert.containSubset(diagnosticStep({ key: 'analysis', detail }).modelSelection, {
    model: 'gpt-5.5',
    tier: 'light',
    reasoning: 'low',
  })
  assert.notInclude(JSON.stringify(detail), 'PRIVATE')
})
