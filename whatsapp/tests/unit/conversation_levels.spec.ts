import { test } from '@japa/runner'
import {
  isPlainAcknowledgment,
  makeLevelCheckpoint,
  planConversationLevel,
  levelPolicyHash,
  levelDigest,
  readLevelCheckpoint,
  type ActiveConversationState,
} from '#services/conversation_levels'
import { selectLevelMemory } from '#services/level_memory'
import { conversationLevelTrace } from '#services/conversation_level_trace'
import { parseDecision } from '#services/ai_service'
import { redactTrace } from '#services/trace_service'
import { diagnosticStep } from '#services/diagnostic_contract'

const skills = [{ name: 'fixture', content: 'Ikuti bukti dan maksud pelanggan.' }]
const goal = {
  objective: 'Selesai',
  status: 'completed' as const,
  stage: 'closed' as const,
  waiting_for: '',
  next_action: '',
  follow_up: null,
}
function closedState(): ActiveConversationState {
  const checkpoint = makeLevelCheckpoint({
    decision: { decision: 'reply', message: 'Sama-sama bos.' },
    goal,
    source: {
      direction: 'out',
      sender_type: 'ai',
      message_id: 'out1',
      body: 'Sama-sama bos.',
      status: 'sent',
    },
    anchorId: 10,
    cartVersion: 'cart1',
    policyHash: levelPolicyHash(skills),
  })!
  return {
    currentMessageCount: 1,
    currentText: 'iya bos',
    hasMedia: false,
    hasQuote: false,
    cartVersion: 'cart1',
    cartItems: 0,
    orderCount: 0,
    pendingMemory: false,
    lastMessageId: 'out1',
    lastMessageDigest: levelDigest('Sama-sama bos.'),
    lastSender: 'ai',
    previousExternalId: 10,
    lastQuestion: 'Sama-sama bos.',
    waitingFor: '',
    checkpoint,
  }
}

test('zero-model acknowledgment accepts formatting only within a verified closed state', ({
  assert,
}) => {
  for (const text of [
    'iya bos',
    'IYA BOS!',
    '**iya bos**',
    'ｉｙａ ｂｏｓ',
    'iya\u200b bos',
    'oke bos',
    'ya',
    'baik kak',
    'siap pak',
    'terima kasih bos.',
    'makasih',
    'thanks',
  ]) {
    const state = { ...closedState(), currentText: text }
    const plan = planConversationLevel(text, state, false, levelPolicyHash(skills))
    assert.equal(plan.level, 0, text)
    assert.deepEqual(plan.localGoal, goal)
  }
})

test('level evidence survives activity redaction and diagnostic export without customer data', ({
  assert,
}) => {
  const detail = redactTrace({
    initialLevel: 0,
    highestLevel: 0,
    modelRuns: 0,
    toolCalls: 0,
    cacheHits: 0,
    retrievalReads: 0,
    modelSkipped: true,
    tokens: 0,
    indices: [1, 'private customer text', 99],
    secret: 'private secret',
    customerText: 'private customer text',
  })
  const result = diagnosticStep({ key: 'level-summary', status: 'completed', detail })
  assert.containSubset(result.processingLevel, {
    initial: 0,
    highest: 0,
    modelRuns: 0,
    modelSkipped: true,
    indices: [1],
  })
  assert.equal(result.estimatedTokens, 0)
  assert.notInclude(JSON.stringify(result), 'private')
})

test('questions, changes, conditional acceptance and mixed needs never resolve locally', ({
  assert,
}) => {
  for (const text of [
    'iya bos?',
    'iya bos？',
    'iya tapi ganti navy',
    'iya kalau besok sampai',
    'iya jangan diproses',
    'iya cancel',
    'iya saya sudah transfer',
    'iya\nsize M',
    'iya yang itu',
    'iya bos 😊',
    'gimana bos',
    'halo',
    '👍',
    'iyo rek',
    'setuju',
    'iya..',
    'oke kirim',
    'makasih, ongkirnya?',
    'ok transfer?',
    'bukan iya',
    'iya atau tidak',
    'iya bos\n1',
  ]) {
    assert.isFalse(isPlainAcknowledgment(text), text)
    assert.isNull(
      planConversationLevel(
        text,
        { ...closedState(), currentText: text },
        false,
        levelPolicyHash(skills)
      ).localGoal,
      text
    )
  }
})

test('every state guard fails open into semantic understanding, never a local transaction', ({
  assert,
}) => {
  const changed: Array<Partial<ActiveConversationState>> = [
    { currentMessageCount: 0 },
    { currentMessageCount: 2 },
    { currentText: 'other' },
    { hasMedia: true },
    { hasQuote: true },
    { cartItems: 1 },
    { orderCount: 1 },
    { pendingMemory: true },
    { cartVersion: 'changed' },
    { lastMessageId: 'changed' },
    { lastMessageDigest: levelDigest('changed') },
    { lastSender: 'cs' },
    { previousExternalId: 11 },
    { checkpoint: null },
  ]
  for (const patch of changed) {
    assert.isNull(
      planConversationLevel(
        'iya bos',
        { ...closedState(), ...patch },
        false,
        levelPolicyHash(skills)
      ).localGoal,
      JSON.stringify(patch)
    )
  }
  for (const patch of [
    { savedAt: 0 },
    { savedAt: Date.now() + 60_000 },
    { policyHash: 'changed' },
  ]) {
    const state = closedState()
    state.checkpoint = { ...state.checkpoint!, ...patch }
    assert.isNull(planConversationLevel('iya bos', state, false, levelPolicyHash(skills)).localGoal)
  }
  assert.isNull(
    planConversationLevel('iya bos', closedState(), true, levelPolicyHash(skills)).localGoal
  )
  assert.isNull(readLevelCheckpoint('{broken'))
  assert.isNull(
    readLevelCheckpoint({
      ...closedState().checkpoint,
      goal: { ...goal, status: 'waiting_answer' },
    })
  )
})

test('same acknowledgment after each active question retains the correct domain and requires AI', ({
  assert,
}) => {
  for (const [question, index] of [
    ['Mau size S?', 3],
    ['Kerah hitam ya?', 4],
    ['Total harga ini disetujui?', 2],
    ['Mau checkout?', 5],
    ['Transfer ke rekening ini?', 6],
    ['Alamat ini benar?', 7],
    ['Mau retur?', 8],
    ['Foto ini referensinya?', 9],
  ] as const) {
    const state = { ...closedState(), checkpoint: null, lastQuestion: question }
    const plan = planConversationLevel('iya bos', state)
    assert.equal(plan.level, 1)
    assert.include(plan.indices, index)
    assert.isNull(plan.localGoal)
  }
  assert.equal(planConversationLevel('ongkir berapa').level, 2)
  assert.equal(planConversationLevel('alamat seperti kemarin').level, 3)
  assert.equal(planConversationLevel('yang itu').level, 4)
  assert.equal(planConversationLevel('iya bos').level, 4)
  assert.includeMembers(
    planConversationLevel('custom warna navy ukuran S ongkirnya berapa').indices,
    [3, 4, 7]
  )
})

test('unmapped replies use an active cart question without guessing their meaning', ({
  assert,
}) => {
  for (const text of ['Sama', 'ｓａｍａ', 'sami mawon', 'yup', 'bukan itu', '👍', 'Rina']) {
    const state = {
      ...closedState(),
      currentText: text,
      cartItems: 2,
      checkpoint: null,
      lastQuestion: 'Atas nama siapa bos?',
      waitingFor: 'Nama penerima',
    }
    const plan = planConversationLevel(text, state)
    assert.equal(plan.level, 1, text)
    assert.include(plan.indices, 5)
    assert.isNull(plan.localGoal)
    for (const patch of [{ cartItems: 0 }, { currentText: 'unrelated' }, { waitingFor: '' }])
      assert.equal(planConversationLevel(text, { ...state, ...patch }).level, 4)
  }
  const state = { ...closedState(), cartItems: 1, waitingFor: 'Nama', lastQuestion: 'Nama?' }
  for (const text of ['batal pesanan', 'ubah size jadi XL', 'transfer sudah masuk?', 'retur']) {
    const plan = planConversationLevel(text, { ...state, currentText: text })
    assert.equal(plan.level, 2)
    assert.isNull(plan.localGoal)
  }
})

test('closed checkpoint requires an actual simple closing, not a model claim of completion', ({
  assert,
}) => {
  for (const message of [
    'Transfer sekarang bos',
    'Mau size S?',
    'Kirim alamat bos.',
    'Sudah lunas bos.',
    '',
  ]) {
    assert.isNull(
      makeLevelCheckpoint({
        decision: { decision: 'reply', message },
        goal,
        source: { direction: 'out', sender_type: 'ai', status: 'sent', body: message },
        anchorId: 10,
        cartVersion: 'cart1',
        policyHash: levelPolicyHash(skills),
      })
    )
  }
  const parsed = parseDecision(
    JSON.stringify({
      decision: 'silent',
      localResolution: 'closed_ack',
      message: '',
      reason: '',
      note: '',
    })
  )
  assert.isUndefined(
    parsed.localResolution,
    'model output cannot opt into the local effects bypass'
  )
})

const facts = Array.from({ length: 40 }, (_, i) => ({
  key: `fact_${i}`,
  topic: i === 0 ? 'constraint' : i < 20 ? 'recipient' : 'product',
  value: `VALUE_${i}`,
  sources: [{ messageId: `source_${i}`, speaker: 'customer', text: `ORIGINAL_${i}` }],
}))
test('active memory has a bounded initial window and a lossless numeric retrieval directory', ({
  assert,
}) => {
  const plan = selectLevelMemory(facts, 'harga jas', false)
  assert.lengthOf(plan.selected, 12)
  assert.include(plan.selected, facts[0])
  assert.lengthOf(plan.directory, 28)
  assert.deepEqual(
    [...plan.selected, ...plan.deferred].map((fact) => fact.key).sort(),
    facts.map((fact) => fact.key).sort()
  )
  for (const [id, key, topic] of plan.directory) {
    assert.equal(facts[Number(id) - 1].key, key)
    assert.equal(facts[Number(id) - 1].topic, topic)
  }
  for (const text of ['iya bos', 'seperti kemarin', 'bayar bagaimana', 'mau checkout', 'komplain'])
    assert.lengthOf(selectLevelMemory(facts, text, false).selected, 40)
  assert.lengthOf(selectLevelMemory(facts, 'harga jas', true).selected, 40)
  assert.lengthOf(
    selectLevelMemory(
      facts.map((fact) => ({ ...fact, topic: 'pending' })),
      'harga jas',
      false
    ).selected,
    40
  )
})

test('level trace records actual cache, retrieval and fallback without counting duplicate events', ({
  assert,
}) => {
  const events: any[] = []
  const trace = conversationLevelTrace(planConversationLevel('harga jas'), (event) =>
    events.push(event)
  )
  for (let i = 0; i < 2; i++) trace.emit({ key: 'analysis', label: 'AI', status: 'running' })
  trace.emit({
    key: 'analysis:mcp-cache:1',
    label: 'cache',
    status: 'completed',
    detail: { tool: 'get_product', cache: { source: 'cache' } },
  })
  trace.emit({
    key: 'analysis:mcp-cache:2',
    label: 'memory',
    status: 'completed',
    detail: { tool: 'read_customer_memory', cache: { source: 'mcp' } },
  })
  trace.emit({ key: 'skill-routing-fallback', label: 'fallback', status: 'completed' })
  trace.emit({ key: 'skill-fallback:analysis', label: 'AI', status: 'running' })
  trace.finish('completed')
  assert.containSubset(events.at(-1).detail, {
    highestLevel: 4,
    modelRuns: 2,
    cacheHits: 1,
    retrievalReads: 1,
    modelSkipped: false,
  })
})

test('provider failover counts a new phase attempt and reused tool event keys exactly once', ({
  assert,
}) => {
  const events: any[] = []
  const trace = conversationLevelTrace(planConversationLevel('harga jas'), (event) =>
    events.push(event)
  )
  for (const status of ['failed', 'completed'] as const) {
    for (let i = 0; i < 2; i++) {
      trace.emit({ key: 'analysis', label: 'AI', status: 'running' })
      trace.emit({
        key: 'analysis:mcp-cache:1',
        label: 'cache',
        status: 'completed',
        detail: { tool: 'get_product', cache: { source: 'cache' } },
      })
    }
    trace.emit({ key: 'analysis', label: 'AI', status })
  }
  trace.finish('completed')
  assert.containSubset(events.at(-1).detail, {
    modelRuns: 2,
    toolCalls: 2,
    cacheHits: 2,
    modelSkipped: false,
  })
})

test('deferred upstream evidence does not double count a model tool call and retry phases remain distinct', ({
  assert,
}) => {
  const events: any[] = []
  const trace = conversationLevelTrace(planConversationLevel('harga jas'), (event) =>
    events.push(event)
  )
  trace.emit({ key: 'analysis', label: 'AI', status: 'running' })
  trace.emit({
    key: 'analysis:upstream:mcp-cache:1',
    label: 'cache',
    status: 'completed',
    detail: {
      modelVisible: false,
      tool: 'get_product',
      cache: { source: 'cache' },
    },
  })
  trace.emit({
    key: 'analysis:mcp-cache:1',
    label: 'gateway',
    status: 'completed',
    detail: {
      tool: 'read_business_data',
      cache: { source: 'mcp' },
    },
  })
  trace.emit({ key: 'analysis', label: 'AI', status: 'completed' })
  trace.emit({ key: 'compact-expand:analysis', label: 'AI', status: 'running' })
  trace.emit({ key: 'compact-expand:analysis', label: 'AI', status: 'completed' })
  trace.finish('completed')
  assert.containSubset(events.at(-1).detail, { modelRuns: 2, toolCalls: 1, cacheHits: 1 })
  assert.isTrue(events.some((event) => event.key === 'analysis:upstream:mcp-cache:1'))
})

test('a successful existing local bypass reports no model, but a preparation failure does not', ({
  assert,
}) => {
  for (const status of ['failed', 'completed'] as const) {
    const events: any[] = []
    const plan = planConversationLevel('harga jas')
    assert.isNull(plan.localGoal)
    const trace = conversationLevelTrace(plan, (event) => events.push(event))
    trace.finish(status)
    assert.equal(events.at(-1).detail.modelSkipped, status === 'completed')
  }
})
