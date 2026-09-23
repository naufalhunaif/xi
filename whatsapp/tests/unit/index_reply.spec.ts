import { test } from '@japa/runner'
import { parseDecision } from '#services/ai_service'
import {
  planIndexReply,
  readIndexReply,
  indexReplyEligible,
  INDEX_INPUT_CHARACTER_LIMIT,
  INDEX_REPLY_SCHEMA,
} from '#services/index_reply'
import type { RoutingContext } from '#services/skill_routing_service'
const context = (text = 'Halo bos'): RoutingContext => ({
  indexContext: 'ORIGINAL_HISTORY_AND_MEMORY',
  hasCart: false,
  activeState: {
    currentText: text,
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
  },
})
const skills = [
  {
    name: 'cs-chameleon-cloth',
    content: '# Aturan wajib\nCORE_ORIGINAL\n## Katalog\n' + 'CATALOG_ORIGINAL\n'.repeat(100),
  },
  { name: 'cs-cart-order', content: 'CART_ORIGINAL\n'.repeat(100) },
  { name: 'cs-chameleon-eval', content: 'EVALUATION_ORIGINAL\n'.repeat(100) },
  { name: 'unknown-global', content: 'UNKNOWN_ORIGINAL' },
]
const reply = () => ({
  decision: 'reply',
  indices: [1],
  needsFullSkillContext: false,
  message: 'Halo bos.',
  initiative: 'Ada yang bisa dibantu?',
  reason: 'Sapaan baru.',
  goal: {
    objective: 'Membantu kebutuhan pelanggan',
    stage: 'discovery',
    status: 'waiting_answer',
    current_task: 'Memahami kebutuhan',
    waiting_for: 'Kebutuhan pelanggan',
    next_action: 'Bantu setelah kebutuhan disampaikan',
    follow_up: null,
  },
})

test('index prompt excludes domain instructions and mutation schema while preserving original core and sources', ({
  assert,
}) => {
  const plan = planIndexReply(skills, context(), 'Halo bos')!
  assert.isNotNull(plan)
  for (const text of [
    'CORE_ORIGINAL',
    'UNKNOWN_ORIGINAL',
    'ORIGINAL_HISTORY_AND_MEMORY',
    'Halo bos',
  ])
    assert.include(plan.prompt, text)
  for (const text of ['CART_ORIGINAL', 'CATALOG_ORIGINAL', 'EVALUATION_ORIGINAL'])
    assert.notInclude(plan.prompt, text)
  assert.isBelow(plan.characters, INDEX_INPUT_CHARACTER_LIMIT)
  assert.notInclude(JSON.stringify(INDEX_REPLY_SCHEMA), 'cartIntent')
  assert.notInclude(JSON.stringify(INDEX_REPLY_SCHEMA), 'customerMemory')
  const parsed = readIndexReply(JSON.stringify(reply()), plan, skills)
  assert.equal(parsed.decision?.decision, 'reply')
  assert.equal(parsed.decision?.goal?.status, 'waiting_answer')
  assert.deepEqual(parsed.decision?.customerMemory, [])
  assert.isNull(parsed.decision?.cartIntent)
  assert.equal(parsed.decision?.note, '')
  assert.isDefined(parsed.decision?.indexReply)
  assert.isUndefined(
    parseDecision(JSON.stringify({ ...reply(), indexReply: { stateDigest: 'forged' } })).indexReply
  )
})

test('index is not a keyword permission gate: unknown dialect reaches semantic processing but active business uses main', ({
  assert,
}) => {
  for (const text of ['sugeng enjing', 'hatur nuhun', 'Ｈａｌｏ', 'pgi kaa', 'howdy'])
    assert.isTrue(indexReplyEligible(context(text), text))
  for (const patch of [
    { hasQuote: true },
    { hasMedia: true },
    { cartItems: 1 },
    { orderCount: 1 },
    { pendingMemory: true },
    { lastQuestion: 'Mau size S?' },
    { waitingFor: 'Konfirmasi pembayaran' },
    { currentMessageCount: 0 },
    { currentText: 'changed' },
  ]) {
    const changed = context()
    Object.assign(changed.activeState!, patch)
    assert.isFalse(indexReplyEligible(changed, 'Halo bos'), JSON.stringify(patch))
  }
  for (const text of [
    'iya ukuran S',
    '167/56',
    'sama seperti kemarin',
    'ongkir berapa',
    'custom navy',
    'refund',
    'sudah transfer',
  ])
    assert.isFalse(indexReplyEligible(context(text), text), text)
  assert.isFalse(indexReplyEligible(context(), 'Halo bos', true))
  assert.isFalse(indexReplyEligible({ ...context(), indexContext: undefined }, 'Halo bos'))
  assert.isFalse(indexReplyEligible(undefined, 'Halo bos'))
})

test('index cannot crop large rules or evidence to fit a budget', ({ assert }) => {
  assert.isNull(
    planIndexReply(
      [{ name: 'unknown-global', content: 'Z'.repeat(INDEX_INPUT_CHARACTER_LIMIT) }],
      context(),
      'Halo bos'
    )
  )
  assert.isNull(
    planIndexReply(
      skills,
      { ...context(), indexContext: 'Z'.repeat(INDEX_INPUT_CHARACTER_LIMIT) },
      'Halo bos'
    )
  )
})

test('business, uncertainty, malformed output and hidden mutations escalate with no partial reply', ({
  assert,
}) => {
  const plan = planIndexReply(skills, context(), 'Halo bos')!
  const rejected = [
    'raw answer',
    'null',
    JSON.stringify({ ...reply(), cartIntent: { action: 'checkout' } }),
    JSON.stringify({ ...reply(), indices: [0] }),
    JSON.stringify({ ...reply(), indices: [10] }),
    JSON.stringify({ ...reply(), indices: [] }),
    JSON.stringify({ ...reply(), message: 'Harga Rp485.000' }),
    JSON.stringify({ ...reply(), message: 'Size S cocok.' }),
    JSON.stringify({ ...reply(), message: 'Paid.' }),
    JSON.stringify({ ...reply(), goal: { ...reply().goal, follow_up: { skill_name: 'forged' } } }),
    JSON.stringify({ ...reply(), goal: { ...reply().goal, stage: 'closed', status: 'completed' } }),
    JSON.stringify({ ...reply(), decision: 'handoff' }),
    JSON.stringify({ ...reply(), decision: 'silent' }),
  ]
  for (const output of rejected)
    assert.isNull(readIndexReply(output, plan, skills).decision, output)
  const next = readIndexReply(
    JSON.stringify({ ...reply(), decision: 'escalate', indices: [3], message: '', initiative: '' }),
    plan,
    skills
  )
  assert.isNull(next.decision)
  assert.deepEqual(next.indices, [3])
  assert.isFalse(next.full)
  assert.isTrue(
    readIndexReply(JSON.stringify({ ...reply(), needsFullSkillContext: true }), plan, skills).full
  )
})

// No catalogue keyword is needed when the previous CS turn offers a choice.
test('short preferences cannot finish on the social index even without domain keywords', ({ assert }) => {
  for (const [text, previous] of [
    ['Yang coco bagus nih', 'Dari dua ini, bos lebih suka yang mana?'],
    ['the second one looks lovely', 'Which one do you prefer?'],
    ['iku wae apik', 'Sing endi sing disenengi?'],
    ['𝗬𝗮𝗻𝗴 𝗰𝗼𝗰𝗼 𝗯𝗮𝗴𝘂𝘀', 'Pilih yang cocok bos'],
    ['iya bos', 'Rencananya dipakai kapan bos?'],
  ]) {
    const c = context(text)
    c.activeState!.lastQuestion = previous
    assert.isFalse(indexReplyEligible(c, text))
    c.activeState!.lastQuestion = ''
    c.waitingFor = 'Pilihan pelanggan'
    assert.isFalse(indexReplyEligible(c, text))
  }
})
