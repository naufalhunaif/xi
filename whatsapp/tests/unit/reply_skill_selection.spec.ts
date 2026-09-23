import { test } from '@japa/runner'
import { selectReplySkills, selectEvaluationSkills } from '#services/reply_skill_selection'

const names = [
  'cs-chameleon-cloth',
  'cs-chameleon-konteks',
  'cs-chameleon-media',
  'cs-chameleon-batas',
  'cs-chameleon-eval',
]
const modules = names.map((name) => ({ name, content: `CURRENT ${name}` }))
const status =
  '# STATUS DAN PRIORITAS SKILL\nBerkas ini **bukan acuan aktif** bila skill modular tersedia. Jangan muat atau terapkan berkas ini bersamaan dengan skill modular. Gunakan skill modular yang sesuai kebutuhan.'
const bundle = { name: 'chameleon-cs-gabungan-2', content: `OLD CUSTOM SURCHARGE\n${status}` }

test('explicitly retired bundles yield to complete modular replacements without rewriting them', ({
  assert,
}) => {
  const input = [bundle, ...modules, { name: 'unknown', content: 'UNKNOWN MUST STAY' }]
  const original = structuredClone(input)
  const result = selectReplySkills(input)
  assert.deepEqual(result.skills, input.slice(1))
  assert.deepEqual(input, original)
  assert.deepEqual(result.detail.excluded[0].replacements, names)
  assert.equal(result.detail.excluded[0].reason, 'superseded_by_available_modules')
  result.skills[0].content = 'changed snapshot'
  assert.deepEqual(input, original)
})

test('bundle remains if any replacement is missing or empty', ({ assert }) => {
  for (const name of names) {
    for (const replacements of [
      modules.filter((skill) => skill.name !== name),
      modules.map((skill) => (skill.name === name ? { ...skill, content: '  ' } : skill)),
    ]) {
      assert.deepEqual(selectReplySkills([bundle, ...replacements]).skills, [
        bundle,
        ...replacements,
      ])
      assert.include(
        selectReplySkills([bundle, ...replacements]).detail.retainedBundles[0].missing,
        name
      )
    }
  }
})

test('bundle names or duplicate-looking text alone never retire policy', ({ assert }) => {
  const input = [
    { ...bundle, content: 'CURRENT UNIQUE RULES' },
    ...modules,
    { ...bundle, name: 'unknown-bundle' },
  ]
  assert.deepEqual(selectReplySkills(input).skills, input)
  assert.equal(
    selectReplySkills(input).detail.retainedBundles[0].reason,
    'retirement_declaration_not_found'
  )
})

test('additional attributed modules must also be available', ({ assert }) => {
  const extended = { ...bundle, content: `(asal: skill \`special-rule\`)\n${bundle.content}` }
  assert.deepEqual(selectReplySkills([extended, ...modules]).skills, [extended, ...modules])
  const replacements = [...modules, { name: 'special-rule', content: 'SPECIAL ORIGINAL' }]
  assert.deepEqual(selectReplySkills([extended, ...replacements]).skills, replacements)
})

test('legacy status spelling and CRLF are recognized conservatively', ({ assert }) => {
  const legacy = {
    name: 'chameleon-cs-gabungan',
    content:
      '# STATUS SKILL\r\nBerkas ini **tidak dipakai sebagai acuan aktif**. Jangan muat atau terapkan bersama skill modular. Gunakan skill modular yang sesuai kebutuhan.',
  }
  assert.deepEqual(selectReplySkills([legacy, ...modules]).skills, modules)
})

test('only the explicitly scoped offline evaluation guide is excluded from replies', ({
  assert,
}) => {
  const guide = {
    name: 'cs-chameleon-eval',
    content:
      '---\ndescription: "Pakai setiap kali skill CS diubah, saat evaluasi bulanan, atau saat konversi turun."\n---\n# EVALUASI & PEMBELAJARAN CS CHAMELEON CLOTH\n## Kapan dijalankan\nOFFLINE ORIGINAL',
  }
  assert.deepEqual(selectReplySkills([guide]).skills, [])
  assert.equal(selectReplySkills([guide]).detail.excluded[0].reason, 'offline_evaluation_scope')
  const other = [
    { ...guide, name: 'another-eval' },
    { name: guide.name, content: 'CUSTOMER RULES' },
  ]
  assert.deepEqual(selectReplySkills(other).skills, other)
})

test('evaluation removes retired snapshots but preserves its full rubric and unknown policies', ({
  assert,
}) => {
  const rubric = {
    name: 'cs-chameleon-eval',
    content:
      '# EVALUASI & PEMBELAJARAN CS CHAMELEON CLOTH\n## Kapan dijalankan\nPakai setiap kali skill CS diubah, saat evaluasi bulanan, atau saat konversi turun.\nRUBRIC ORIGINAL',
  }
  const active = [
    ...modules.filter((skill) => skill.name !== rubric.name),
    rubric,
    { name: 'owner-policy', content: 'OWNER ORIGINAL' },
  ]
  const input = [bundle, ...active]
  assert.deepEqual(selectEvaluationSkills(input).skills, active)
  assert.include(
    selectEvaluationSkills(input).skills.find((skill) => skill.name === rubric.name)!.content,
    'RUBRIC ORIGINAL'
  )
  assert.isFalse(selectReplySkills(input).skills.some((skill) => skill.name === rubric.name))
  const missing = input.filter((skill) => skill.name !== 'cs-chameleon-batas')
  assert.deepEqual(selectEvaluationSkills(missing).skills, missing)
})
