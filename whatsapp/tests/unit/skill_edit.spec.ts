import { test } from '@japa/runner'
import { applySkillEditPlan, SKILL_EDIT_INSTRUCTIONS } from '#services/skill_edit_contract'
const skill = {
  id: 5,
  name: 'language',
  description: 'Reply style',
  content: 'Friendly.\nTotal in one line.\nAlways verify payment.',
}
const change = {
  skillId: 5,
  name: 'language',
  description: 'Reply style',
  before: 'Total in one line.',
  after: 'Show verified components as 100 + 100 = 200; use actual values.',
}
test.group('Owner skill edit contract', () => {
  test('patches only the matched passage and retains previous content for audit', ({ assert }) => {
    const plan = applySkillEditPlan({ summary: 'Updated format', changes: [change] }, [skill])
    assert.equal(plan.changes[0].content, `Friendly.\n${change.after}\nAlways verify payment.`)
    assert.equal(plan.changes[0].before, skill.content)
    assert.match(SKILL_EDIT_INSTRUCTIONS, /presentation only/)
  })
  test('creates plain Markdown without mandatory frontmatter', ({ assert }) => {
    const plan = applySkillEditPlan(
      {
        summary: 'Created',
        changes: [
          {
            skillId: null,
            name: 'totals',
            description: '',
            before: '',
            after: '# Totals\nUse actual verified values.',
          },
        ],
      },
      []
    )
    assert.isNull(plan.changes[0].id)
    assert.match(plan.changes[0].content, /^# Totals/)
  })
  test('allows a no-op instead of unnecessary edits', ({ assert }) => {
    assert.lengthOf(
      applySkillEditPlan({ summary: 'Already covered', changes: [] }, [skill]).changes,
      0
    )
  })
  test('rejects missing or ambiguous anchors, unknown targets, empty replacements and duplicate edits', ({
    assert,
  }) => {
    for (const patch of [
      { before: 'Not here' },
      { skillId: 999 },
      { after: '' },
      { name: 'renamed' },
    ])
      assert.throws(() =>
        applySkillEditPlan({ summary: '', changes: [{ ...change, ...patch }] }, [skill])
      )
    assert.throws(() => applySkillEditPlan({ summary: '', changes: [change, change] }, [skill]))
    assert.throws(() =>
      applySkillEditPlan({ summary: '', changes: [change] }, [
        { ...skill, content: skill.content + skill.content },
      ])
    )
  })
  test('rejects duplicate new names and unsafe names', ({ assert }) => {
    for (const name of ['language', '../new', 'UPPER', ''])
      assert.throws(() =>
        applySkillEditPlan(
          { summary: '', changes: [{ ...change, skillId: null, before: '', name }] },
          [skill]
        )
      )
  })
  test('append preserves all existing guidance', ({ assert }) => {
    assert.equal(
      applySkillEditPlan({ summary: '', changes: [{ ...change, before: '' }] }, [skill]).changes[0]
        .content,
      `${skill.content}\n\n${change.after}`
    )
  })
})
