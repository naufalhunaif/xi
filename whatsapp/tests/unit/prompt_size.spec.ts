import { test } from '@japa/runner'
import { estimateTokens, promptBreakdown, payloadChars } from '#services/prompt_size_service'

test.group('Prompt size accounting', () => {
  test('estimates from length and accepts an already counted size', ({ assert }) => {
    assert.equal(estimateTokens('x'.repeat(370)), 100)
    assert.equal(estimateTokens(370), 100)
    assert.equal(estimateTokens(''), 0)
    assert.equal(estimateTokens(-50), 0)
    assert.equal(estimateTokens(undefined as unknown as string), 0)
  })

  test('ranks sections by cost and drops empty ones', ({ assert }) => {
    const breakdown = promptBreakdown([
      ['riwayat', 'a'.repeat(370)],
      ['skill: besar', 'b'.repeat(3700)],
      ['kosong', ''],
      ['sudah-dihitung', 740],
      ['nol', 0],
    ])
    assert.deepEqual(
      breakdown.sections.map((section) => section.key),
      ['skill: besar', 'sudah-dihitung', 'riwayat']
    )
    assert.deepEqual(breakdown.sections[0], { key: 'skill: besar', chars: 3700, tokens: 1000 })
    assert.equal(breakdown.chars, 4810)
    assert.equal(breakdown.tokens, 1300)
    assert.isTrue(breakdown.estimated)
  })

  test('caps the reported list so a long prompt cannot flood the trace', ({ assert }) => {
    const many = Array.from(
      { length: 60 },
      (_, index) => [`bagian-${index}`, index + 1] as [string, number]
    )
    const breakdown = promptBreakdown(many)
    assert.lengthOf(breakdown.sections, 40)
    // The totals still cover every section, not only the ones listed.
    assert.equal(breakdown.chars, (60 * 61) / 2)
  })

  test('measures what crosses the wire, not the object in memory', ({ assert }) => {
    assert.equal(payloadChars('halo'), 4)
    assert.equal(payloadChars({ a: 1 }), 7)
    assert.equal(payloadChars(null), 0)
    assert.equal(payloadChars(undefined), 0)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    assert.equal(payloadChars(cyclic), 0)
  })
})
