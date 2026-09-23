import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { inWorkspace } from '#services/workspace_context'
import { planSkillRouting, SkillContextIncomplete } from '#services/skill_routing_service'
import { PatternPlanCache } from '#services/pattern_plan_cache'
import { needsBusinessVerification } from '#services/skill_runtime_service'
import { PATTERN_IDS, patternProcedures, validPatternIds } from '#services/conversation_patterns'

const source = () => [
  {
    name: 'cs-chameleon-cloth',
    content: `# Aturan wajib\nCORE_${randomUUID()}\n## Katalog\nCATALOG_ORIGINAL\n## Ukuran\n${'SIZE_ORIGINAL\n'.repeat(400)}## Pembayaran\n${'PAYMENT_ORIGINAL\n'.repeat(400)}## Pengiriman\n${'SHIPPING_ORIGINAL\n'.repeat(400)}`,
  },
  { name: 'unknown-rule', content: 'UNKNOWN_ORIGINAL' },
  { name: 'cs-cart-order', content: 'CART_ORIGINAL\n'.repeat(400) },
]
const plan = (skills: ReturnType<typeof source>, text: string, context?: any) =>
  planSkillRouting(skills, text, context, false, false, [], false, true)
const cache = (value: ReturnType<typeof plan>) => (value.detail as any).patternCache
const checkout = JSON.stringify({ decision: 'reply', cartIntent: { action: 'sync' } })

test('same route reuses policy across different details without caching customer values', ({
  assert,
}) => {
  const skills = source()
  const first = plan(skills, 'Harga jas navy S untuk ALICE_SECRET?')
  const second = plan(skills, 'Harga jas maroon XL untuk BOB_SECRET?')
  assert.equal(cache(first).status, 'miss')
  assert.equal(cache(second).status, 'hit')
  assert.equal(cache(first).key, cache(second).key)
  assert.isFalse(cache(second).customerDataCached)
  for (const value of ['ALICE_SECRET', 'BOB_SECRET', 'maroon', 'navy'])
    assert.notInclude(JSON.stringify(second), value)
  first.skills[0].content = 'POISONED'
  first.detail.routes.push('payment')
  const third = plan(skills, 'Harga jas putih M?')
  assert.notInclude(JSON.stringify(third), 'POISONED')
  assert.deepEqual(third.detail.routes, ['catalog'])
  assert.include(third.skills.map((s) => s.content).join(''), 'UNKNOWN_ORIGINAL')
})

test('policy, workspace and active question changes invalidate incompatible plans', ({
  assert,
}) => {
  const skills = source()
  const base = plan(skills, 'harga jas')
  const changed = plan(
    [{ ...skills[0], content: skills[0].content + '\nNEW_POLICY' }, ...skills.slice(1)],
    'harga jas'
  )
  assert.notEqual(cache(base).key, cache(changed).key)
  assert.equal(cache(changed).status, 'miss')
  const other = inWorkspace({ id: 88, prefix: 'w88_', phone: null, version: 'v1' }, () =>
    plan(skills, 'harga jas')
  )
  const rotated = inWorkspace({ id: 88, prefix: 'w88_', phone: null, version: 'v2' }, () =>
    plan(skills, 'harga jas')
  )
  assert.notEqual(cache(other).key, cache(base).key)
  assert.notEqual(cache(other).key, cache(rotated).key)
  const size = plan(skills, 'iya', { lastQuestion: 'Ukuran S?' })
  const payment = plan(skills, 'iya', { lastQuestion: 'Bayar transfer?' })
  assert.notEqual(cache(size).key, cache(payment).key)
  assert.include(size.detail.routes, 'sizing')
  assert.include(payment.detail.routes, 'payment')
  assert.equal(plan(skills, 'iya yang itu').detail.delivery, 'full-content')
  const ambiguous = planSkillRouting(
    skills,
    'ungkapan tanpa kata domain',
    undefined,
    false,
    true,
    [],
    false,
    true
  )
  assert.deepEqual(ambiguous.skills, skills)
  assert.include(ambiguous.instructions, 'Pilih pola secara semantik')
  assert.isDefined(ambiguous.phase().tools)
  assert.equal(plan(skills, 'harga jas', { hasCart: true }).detail.delivery, 'full-content')
})

test('pattern reads load original dependencies without carrying read authorization into another turn', async ({
  assert,
}) => {
  const skills = source()
  const first = plan(skills, 'harga jas')
  const phase = first.phase()
  assert.throws(() => phase.assertCovered(checkout), SkillContextIncomplete)
  const response = await phase.tools!.callTool({
    name: 'read_business_skill',
    arguments: { patternIds: ['catalog-design', 'fit'] },
  })
  const data = JSON.parse(response.content[0].text)
  assert.isTrue(
    needsBusinessVerification(
      {
        text: JSON.stringify({ decision: 'reply', business_lookup_required: true }),
        toolCalls: [
          { server: 'business_skill_library', tool: 'read_business_skill', result: response },
        ],
      },
      [{ slug: 'store', enabled: true, authenticated: true }]
    )
  )
  assert.deepEqual(
    data.procedures.map((p: any) => p.id),
    ['fit', 'catalog-design']
  )
  assert.include(JSON.stringify(data.policy), 'CART_ORIGINAL')
  assert.include(JSON.stringify(data.policy), 'PAYMENT_ORIGINAL')
  assert.include(JSON.stringify(data.procedures), 'ukuran yang tidak diubah tetap disimpan')
  assert.doesNotThrow(() => phase.assertCovered(checkout))
  const repeated = await phase.tools!.callTool({
    name: 'read_business_skill',
    arguments: { patternIds: ['catalog-design'] },
  })
  const again = JSON.parse(repeated.content[0].text)
  assert.isTrue(again.alreadyLoaded)
  assert.deepEqual(again.policy, [])
  const next = plan(skills, 'harga jas beda')
  assert.equal(cache(next).status, 'hit')
  assert.throws(() => next.phase().assertCovered(checkout), SkillContextIncomplete)
  const original = await phase.tools!.callTool({
    name: 'read_business_skill',
    arguments: { all: true },
  })
  const pieces = JSON.parse(original.content[0].text)
  for (const skill of skills)
    assert.equal(
      pieces
        .filter((p: any) => p.skill === skill.name)
        .map((p: any) => p.content)
        .join(''),
      skill.content
    )
})

test('active cart can defer visual modules and schedule from its complete policy', async ({ assert }) => {
  const skills = [
    { name: 'cs-chameleon-cloth', content: '# Prosedur\n' + 'BASE_RULE\n'.repeat(1200) + '## Gambar\nVISUAL_BASE_RULE\n' },
    { name: 'unknown-rule', content: 'UNKNOWN_ORIGINAL' },
    { name: 'cs-detail-visual', content: 'VISUAL_INSPECTION_RULE\n'.repeat(200) },
  ]
  const savedCart = { items: [], recipient: { address: 'PRIVATE_ADDRESS' }, shipping: { service: 'REG', cost: 8000 } }
  const routed = planSkillRouting(skills, 'Sama', { hasCart: true, savedCart }, false, false, [5], false, true)
  assert.equal(routed.detail.delivery, 'routed')
  assert.isBelow(routed.detail.candidateSavingPercent, 25)
  assert.equal(routed.skills[0].content, skills[0].content)
  assert.notInclude(JSON.stringify(routed.skills), 'VISUAL_INSPECTION_RULE')
  assert.notInclude(JSON.stringify(routed), 'PRIVATE_ADDRESS')
  const next = planSkillRouting(skills, 'Sama', {
    hasCart: true, savedCart: { ...savedCart, recipient: { address: 'OTHER_PRIVATE_ADDRESS' } },
  }, false, false, [5], false, true)
  assert.equal(cache(next).status, 'hit')
  assert.notInclude(JSON.stringify(next), 'OTHER_PRIVATE_ADDRESS')
  const phase = routed.phase()
  const followup = { goal: { status: 'waiting_answer', follow_up: { skill_name: 'cs-chameleon-cloth' } } }
  assert.doesNotThrow(() => phase.assertCovered(JSON.stringify({ decision: 'reply', ...followup })))
  assert.throws(() => phase.assertCovered(JSON.stringify({
    decision: 'reply', goal: { follow_up: { skill_name: 'cs-detail-visual' } },
  })), SkillContextIncomplete)
  for (const fields of [{ images: ['image'] }, { needsVisualInspection: true }, { decision: 'handoff' }])
    assert.throws(() => phase.assertCovered(JSON.stringify({ decision: 'reply', ...fields })), SkillContextIncomplete)
  await phase.tools!.callTool({ name: 'read_business_skill', arguments: { patternIds: ['reference-design'] } })
  assert.doesNotThrow(() => phase.assertCovered(JSON.stringify({ decision: 'reply', needsVisualInspection: true })))
})

test('unknown patterns, foreign arguments and mutations are rejected before authorization', async ({
  assert,
}) => {
  const phase = plan(source(), 'harga jas').phase()
  for (const args of [
    { patternIds: ['../../secret'] },
    { patternIds: [] },
    { patternIds: 'payment' },
    { patternIds: ['payment'], jid: 'other-room' },
    { patternIds: ['payment'], approved: true },
    { patternIds: ['fit'], sectionIds: ['missing'] },
    { all: true, patternIds: ['unknown'] },
    { patternIds: Array(12).fill('fit') },
  ])
    await assert.rejects(() =>
      phase.tools!.callTool({ name: 'read_business_skill', arguments: args })
    )
  await assert.rejects(() =>
    phase.tools!.callTool({ name: 'checkout', arguments: { patternIds: ['payment'] } })
  )
  assert.throws(() => phase.assertCovered(checkout), SkillContextIncomplete)
})

test('workflow definitions carry variable dependencies without cached answers or approvals', ({
  assert,
}) => {
  assert.isTrue(validPatternIds(PATTERN_IDS))
  const procedures = patternProcedures(PATTERN_IDS)
  assert.lengthOf(procedures, 11)
  for (const p of procedures) {
    assert.isAbove(p.recheck.length, 20)
    assert.isAbove(p.variables.length, 10)
    assert.notProperty(p, 'message')
    assert.notProperty(p, 'approved')
  }
})

test('compiled cache expires and evicts least recently used profiles', ({ assert }) => {
  let now = 0
  const store = new PatternPlanCache<number>(2, 10, () => now)
  assert.equal(store.read('a', () => 1).status, 'miss')
  store.read('b', () => 2)
  assert.equal(store.read('a', () => 999).value, 1)
  store.read('c', () => 3)
  assert.equal(store.read('b', () => 4).status, 'miss')
  now = 10
  assert.equal(store.read('b', () => 5).status, 'miss')
  assert.throws(() => new PatternPlanCache(0))
})
