import { test } from '@japa/runner'
import { planSkillRouting, SkillContextIncomplete } from '#services/skill_routing_service'
import { needsBusinessVerification } from '#services/skill_runtime_service'
import { planConversationLevel } from '#services/conversation_levels'

const block = (label: string) => `${label}: aturan asli harus tetap utuh.\n`.repeat(100)
const bundle = {
  name: 'chameleon-cs-gabungan-2',
  content: `---\nname: chameleon-cs-gabungan-2\n---\n# Kebijakan\nCORE ORIGINAL\n## Katalog\n${block('CATALOG')}## Pembayaran\nPAYMENT PARENT\n### Transfer\n${block('PAYMENT')}## Pengiriman\n${block('SHIPPING')}## Ukuran\n${block('SIZING')}## Aturan wajib\nMANDATORY ORIGINAL\n## Tidak dikenal\nUNKNOWN ORIGINAL\n`,
}
const skills = [
  bundle,
  { name: 'cs-format-jawaban', content: 'STYLE ORIGINAL' },
  { name: 'unknown-policy', content: 'UNMAPPED ORIGINAL' },
]
const answer = (fields = {}) =>
  JSON.stringify({ decision: 'reply', message: 'Harga produk sesuai data.', ...fields })

test('numeric intent indices select sizing rules without bypassing transaction coverage', ({
  assert,
}) => {
  const level = planConversationLevel('167/56')
  assert.include(level.indices, 3)
  const plan = planSkillRouting(skills, '167/56', undefined, false, false, level.indices)
  const prompt = plan.skills.map((skill) => skill.content).join('\n')
  assert.includeMembers(plan.detail.routes, ['sizing', 'catalog'])
  assert.include(prompt, block('SIZING'))
  assert.include(prompt, block('CATALOG'))
  assert.include(prompt, 'CORE ORIGINAL')
  assert.notInclude(prompt, block('PAYMENT'))
  assert.notInclude(prompt, block('SHIPPING'))
  assert.isBelow(plan.detail.charsAfter, plan.detail.charsBefore)
  assert.throws(
    () => plan.phase().assertCovered(answer({ cartIntent: { action: 'sync' } })),
    SkillContextIncomplete
  )
  const union = planSkillRouting(skills, 'bayar transfer', undefined, false, false, level.indices)
  assert.includeMembers(union.detail.routes, ['sizing', 'payment'])
  assert.deepEqual(
    planSkillRouting(skills, '167/56', undefined, false, true, level.indices).skills,
    skills
  )
})

test('level four loads full policy even when a keyword would permit a narrower route', ({
  assert,
}) => {
  const plan = planSkillRouting(skills, 'harga jas', undefined, false, true)
  assert.deepEqual(plan.skills, skills)
  assert.equal(plan.detail.delivery, 'full-content')
  assert.doesNotThrow(() => plan.phase().assertCovered(answer({ cartIntent: { action: 'sync' } })))
})

test('catalog routing preserves common and unknown rules verbatim while reducing initial input', ({
  assert,
}) => {
  const plan = planSkillRouting(skills, 'Berapa harga jas?')
  const prompt = plan.skills.map((skill) => skill.content).join('\n')
  for (const text of [
    'CORE ORIGINAL',
    block('CATALOG'),
    'MANDATORY ORIGINAL',
    'UNKNOWN ORIGINAL',
    'STYLE ORIGINAL',
    'UNMAPPED ORIGINAL',
  ])
    assert.include(prompt, text)
  assert.notInclude(prompt, block('PAYMENT'))
  assert.isBelow(plan.detail.charsAfter, plan.detail.charsBefore)
  assert.equal(plan.detail.delivery, 'routed')
  assert.include(plan.instructions, 'Pembayaran')
  assert.doesNotThrow(() => plan.phase().assertCovered(answer()))
})

test('ambiguous requests keep all policies, including with an existing cart', ({ assert }) => {
  for (const context of [undefined, { hasCart: true }]) {
    const plan = planSkillRouting(skills, 'iya yang itu', context)
    assert.deepEqual(plan.skills, skills)
    assert.equal(plan.detail.reason, 'ambiguous_input')
  }
})

test('multiple needs and short followups use prior question without replacing current intent', ({
  assert,
}) => {
  const mixed = planSkillRouting(skills, 'harga jas ukuran XL dan ongkir?')
  assert.includeMembers(mixed.detail.routes, ['catalog', 'sizing', 'shipping', 'cart'])
  const confirmation = planSkillRouting(skills, 'iya', {
    lastQuestion: 'Mau bayar transfer atau DP?',
  })
  assert.includeMembers(confirmation.detail.routes, ['payment', 'cart'])
  assert.include(confirmation.skills[0].content, block('PAYMENT'))
  const changed = planSkillRouting(skills, 'foto jas', { lastQuestion: 'Pembayaran transfer?' })
  assert.includeMembers(changed.detail.routes, ['visual', 'catalog', 'payment'])
})

test('active cart and new visual input include dependent policies', ({ assert }) => {
  const plan = planSkillRouting(skills, 'berapa harga?', { hasCart: true }, true)
  assert.includeMembers(plan.detail.routes, [
    'visual',
    'cart',
    'custom',
    'sizing',
    'payment',
    'shipping',
  ])
  assert.include(plan.skills[0].content, block('PAYMENT'))
})

test('late transactional decisions and explicit uncertainty require full-context fallback', ({
  assert,
}) => {
  const phase = planSkillRouting(skills, 'harga jas').phase()
  for (const fields of [
    { cartIntent: { action: 'sync' } },
    { message: 'Bayar melalui transfer.' },
    { initiative: 'Kirim ke alamat mana?' },
    { decision: 'handoff' },
    { needsFullSkillContext: true },
    { goal: { status: 'waiting_payment' } },
    { goal: { follow_up: { skill_name: bundle.name } } },
  ])
    assert.throws(() => phase.assertCovered(answer(fields)), SkillContextIncomplete)
  assert.throws(() => phase.assertCovered('not JSON'), SkillContextIncomplete)
})

test('on-demand reading preserves exact text and ancestor policy, but never counts as business evidence', async ({
  assert,
}) => {
  const plan = planSkillRouting(skills, 'harga jas')
  const phase = plan.phase()
  const index = JSON.parse(plan.instructions.split('BAGIAN TERSEDIA: ')[1])
  const transfer = (Object.values(index).flat() as string[][]).find(
    (section) => section[1] === 'Transfer'
  )!
  const result = await phase.tools!.callTool({
    name: 'read_business_skill',
    arguments: { sectionIds: [transfer[0]] },
  })
  const returned = JSON.parse(result.content[0].text)
  assert.isTrue(
    returned.some((section: any) => section.content === `### Transfer\n${block('PAYMENT')}`)
  )
  assert.isTrue(returned.some((section: any) => section.content.includes('PAYMENT PARENT')))
  assert.isTrue(
    needsBusinessVerification(
      {
        text: answer({ business_lookup_required: true }),
        toolCalls: [{ server: 'business_skill_library', tool: 'read_business_skill', result }],
      },
      [{ slug: 'store', enabled: true, authenticated: true }]
    )
  )
  await phase.tools!.callTool({ name: 'read_business_skill', arguments: { all: true } })
  assert.doesNotThrow(() => phase.assertCovered(answer({ cartIntent: { action: 'sync' } })))
  // A fresh provider phase cannot rely on reads performed by another process.
  assert.throws(
    () => plan.phase().assertCovered(answer({ cartIntent: { action: 'sync' } })),
    SkillContextIncomplete
  )
})

test('full library reconstructs originals exactly and cannot read outside this snapshot', async ({
  assert,
}) => {
  const source = skills.map((skill) => ({ ...skill }))
  const phase = planSkillRouting(source, 'harga jas').phase()
  source[0].content = 'MODIFIED AFTER START'
  const result = await phase.tools!.callTool({
    name: 'read_business_skill',
    arguments: { all: true },
  })
  const returned = JSON.parse(result.content[0].text)
  assert.equal(
    returned
      .filter((part: any) => part.skill === bundle.name)
      .map((part: any) => part.content)
      .join(''),
    bundle.content
  )
  for (const args of [
    { sectionIds: ['../../secret'] },
    { sectionIds: ['0:999'] },
    { jid: 'another-room', all: true },
    { all: 'true' },
    {},
  ])
    await assert.rejects(() =>
      phase.tools!.callTool({ name: 'read_business_skill', arguments: args })
    )
})

test('headings inside code fences stay in their original policy section', async ({ assert }) => {
  const fenced = {
    name: bundle.name,
    content: `# Root\n## Katalog\n\`\`\`markdown\n## Pembayaran\nCODE ORIGINAL\n\`\`\`\n${block('CATALOG')}## Pembayaran\n${block('PAYMENT')}`,
  }
  const plan = planSkillRouting([fenced], 'harga jas')
  assert.include(plan.skills[0].content, '## Pembayaran\nCODE ORIGINAL')
  assert.notInclude(plan.skills[0].content, block('PAYMENT'))
  const result = await plan
    .phase()
    .tools!.callTool({ name: 'read_business_skill', arguments: { all: true } })
  assert.equal(
    JSON.parse(result.content[0].text)
      .map((part: any) => part.content)
      .join(''),
    fenced.content
  )
})

test('visual module is complete when relevant and small libraries stay full if routing costs more', ({
  assert,
}) => {
  const visual = { name: 'cs-detail-visual', content: block('VISUAL') }
  assert.deepEqual(planSkillRouting([visual], 'lihat foto ini', undefined, true).skills, [visual])
  const tiny = [{ name: 'cs-detail-visual', content: 'Tiny rules' }]
  assert.deepEqual(planSkillRouting(tiny, 'harga jas').skills, tiny)
  assert.equal(planSkillRouting(tiny, 'harga jas').instructions, '')
})

test('Indonesian possessive endings still select the relevant route', ({ assert }) => {
  assert.includeMembers(planSkillRouting(skills, 'harganya dan ukurannya?').detail.routes, [
    'catalog',
    'sizing',
  ])
})

test('small savings start with full policy and cannot trigger a second skill analysis', ({
  assert,
}) => {
  const source = [
    { name: 'core-policy', content: block('CORE').repeat(20) },
    { name: 'cs-detail-visual', content: block('VISUAL') },
  ]
  const plan = planSkillRouting(source, 'harga jas')
  assert.equal(plan.detail.reason, 'small_saving_full_context')
  assert.equal(plan.detail.delivery, 'full-content')
  assert.isBelow(plan.detail.candidateSavingPercent, 25)
  assert.deepEqual(plan.skills, source)
  assert.equal(plan.instructions, '')
  assert.isUndefined(plan.phase().tools)
  assert.doesNotThrow(() => plan.phase().assertCovered(answer({ needsFullSkillContext: true })))
})
