import { test } from '@japa/runner'
import {
  businessDataInstructions,
  needsBusinessVerification,
  verifyBusinessRun,
  importedSkillInstructions,
  skillSections,
  CUSTOMER_MESSAGE_CONTRACT,
} from '#services/skill_runtime_service'
import { DECISION_SCHEMA, parseDecision } from '#services/ai_service'

const connections = [{ slug: 'store', enabled: true, authenticated: true }]
const draft = (fields: Record<string, unknown>) => ({
  text: JSON.stringify(fields),
  toolCalls: [] as Array<{ server: string; tool: string }>,
})

test.group('Business data first', () => {
  test('reuses only byte-identical skill bodies and keeps distinct policies in order', ({
    assert,
  }) => {
    const content = 'Kebijakan lengkap wajib diikuti.\n'.repeat(150)
    const skills = [
      { name: 'original', content },
      { name: 'different', content: `${content}Syarat tambahan wajib.` },
      { name: 'copy', content },
    ]
    const prompt = importedSkillInstructions(skills)
    assert.include(prompt, skills[1].content)
    assert.include(prompt, '=== SKILL: copy ===')
    assert.include(prompt, 'seluruh isinya berlaku juga di posisi ini')
    assert.isBelow(prompt.length, content.length * 3)
    const sections = new Map(skillSections(skills))
    assert.isBelow(sections.get('skill: copy')!, sections.get('skill: original')!)
    assert.isAbove(sections.get('skill: different')!, content.length)
  })
  test('provides all imported skills in full without requiring shell reads', ({ assert }) => {
    const skills = [
      {
        name: 'gaya',
        content: 'Gaya balasan dari pengguna.\n' + 'isi lengkap\n'.repeat(2500) + 'ATURAN TERAKHIR',
      },
      { name: 'inisiatif', content: 'Pilih tool dan ambil inisiatif sesuai aturan ini.' },
    ]
    const instructions = importedSkillInstructions(skills)
    for (const skill of skills) assert.include(instructions, skill.content)
    assert.isBelow(
      instructions.indexOf('=== SKILL: gaya'),
      instructions.indexOf('=== SKILL: inisiatif')
    )
    assert.notInclude(instructions, 'visual-product-match')
    assert.notInclude(instructions, 'Siap bos')
    assert.equal(DECISION_SCHEMA.properties.message.description, CUSTOMER_MESSAGE_CONTRACT)
  })
  test('allows a skill to decide not to reply without inventing a message', ({ assert }) => {
    assert.include(DECISION_SCHEMA.properties.decision.enum, 'silent')
    assert.deepEqual(
      parseDecision(
        JSON.stringify({
          decision: 'silent',
          message: 'ignored',
          reason: 'Sesuai skill',
          note: 'Selesai',
        })
      ),
      {
        decision: 'silent',
        message: '',
        reason: 'Sesuai skill',
        note: 'Selesai',
      }
    )
    assert.isFalse(
      needsBusinessVerification(
        draft({ decision: 'silent', business_lookup_required: false }),
        connections
      )
    )
    assert.throws(
      () => parseDecision(JSON.stringify({ decision: 'reply', message: '' })),
      /Balasan AI kosong/
    )
  })
  test('requires actual lookup before missing data handoff, even if marked not required', ({
    assert,
  }) => {
    assert.isTrue(
      needsBusinessVerification(
        draft({
          decision: 'handoff',
          handoff_category: 'verified_data_unavailable',
          business_lookup_required: false,
        }),
        connections
      )
    )
    assert.isTrue(
      needsBusinessVerification(
        draft({ decision: 'reply', business_lookup_required: true }),
        connections
      )
    )
    assert.isFalse(
      needsBusinessVerification(
        draft({ decision: 'reply', business_lookup_required: false }),
        connections
      )
    )
    assert.isFalse(
      needsBusinessVerification(
        draft({ decision: 'handoff', handoff_category: 'human_authorization' }),
        connections
      )
    )
    assert.isFalse(
      needsBusinessVerification(
        draft({ decision: 'handoff', handoff_category: 'human_complaint' }),
        connections
      )
    )
    assert.isFalse(needsBusinessVerification(draft({ decision: 'reply' }), []))
    assert.isTrue(
      needsBusinessVerification(
        {
          ...draft({ decision: 'reply', business_lookup_required: true }),
          toolCalls: [{ server: 'business_store', tool: 'list_business_resources' }],
        },
        connections
      )
    )
  })
  test('retries an unverified draft and uses the checked result', async ({ assert }) => {
    let retries = 0
    const first = draft({ decision: 'handoff', business_lookup_required: true })
    const checked = {
      ...draft({ decision: 'reply', message: 'Data terverifikasi' }),
      toolCalls: [{ server: 'business_store', tool: 'list_records' }],
    }
    const result = await verifyBusinessRun(first, connections, async () => {
      retries++
      return checked
    })
    assert.strictEqual(result, checked)
    assert.equal(retries, 1)
    await verifyBusinessRun(checked, connections, async () => {
      retries++
      return first
    })
    assert.equal(retries, 1)
  })
  test('rechecks cart shipping even when AI claims lookup is unnecessary, accepting real service aliases', async ({
    assert,
  }) => {
    const first = draft({
      decision: 'silent',
      business_lookup_required: false,
      cartIntent: { action: 'sync', shipping: { service: 'YES', cost: 9000 } },
    })
    assert.isTrue(needsBusinessVerification(first, connections))
    assert.isTrue(
      needsBusinessVerification(
        { ...first, toolCalls: [{ server: 'business_store', tool: 'get_product' }] },
        connections
      )
    )
    const checked = {
      ...first,
      toolCalls: [
        {
          server: 'business_orion',
          tool: 'check_shipping_rates',
          arguments: { weight_kg: 1.15 },
          result: {
            structured_content: { prices: [{ service: 'YES23', name: 'YES', price: 9000 }] },
          },
        },
      ],
    }
    assert.isFalse(needsBusinessVerification(checked, connections))
    let attempts = 0
    const verified = await verifyBusinessRun(first, connections, async () => {
      attempts++
      return checked
    })
    assert.strictEqual(verified, checked)
    assert.equal(attempts, 1)
    assert.isTrue(
      needsBusinessVerification(
        {
          ...checked,
          text: JSON.stringify({
            decision: 'silent',
            cartIntent: { action: 'sync', shipping: { service: 'YES', cost: 1 } },
          }),
        },
        connections
      )
    )
  })
  test('withholds lazy CS handoff after bounded retry instead of pretending lookup succeeded', async ({
    assert,
  }) => {
    const first = draft({
      decision: 'handoff',
      handoff_category: 'verified_data_unavailable',
      business_lookup_required: true,
    })
    await assert.rejects(
      () => verifyBusinessRun(first, connections, async () => first),
      /Balasan ditahan/
    )
  })
  test('recipient updates retain saved shipping without a second model run; changed quotes still retry', async ({ assert }) => {
    const saved = {
      items: [{ id: 'item-1', productId: 'peak', name: 'Peak', size: 'S', quantity: 1, measurements: {}, note: '' }],
      recipient: { name: '', phone: '', address: 'Fixture Street 1' },
      shipping: { service: 'REG', cost: 8000 },
    }
    const intent = {
      ...structuredClone(saved), action: 'sync',
      recipient: { ...saved.recipient, name: 'Fixture Recipient', phone: '0812000000' },
    }
    const first = draft({ decision: 'reply', business_lookup_required: false, cartIntent: intent })
    let retries = 0
    const result = await verifyBusinessRun(first, connections, async () => {
      retries++
      throw new Error('Unnecessary paid phase')
    }, undefined, false, saved)
    assert.strictEqual(result, first)
    assert.equal(retries, 0)
    assert.isTrue(needsBusinessVerification(first, connections))
    for (const patch of [
      { shipping: { service: 'YES', cost: 8000 } },
      { shipping: { service: 'REG', cost: 9000 } },
      { recipient: { ...intent.recipient, address: 'Another destination' } },
      { items: [{ ...saved.items[0], quantity: 2 }] },
      { items: [{ ...saved.items[0], size: 'L' }] },
      { items: [{ ...saved.items[0], productId: 'another' }] },
      { items: [] },
      { items: null },
      { recipient: null },
    ]) {
      assert.isTrue(needsBusinessVerification(draft({
        decision: 'reply', business_lookup_required: false, cartIntent: { ...intent, ...patch },
      }), connections, undefined, false, saved), JSON.stringify(patch))
    }
    assert.isTrue(needsBusinessVerification(draft({
      decision: 'reply', business_lookup_required: true, cartIntent: intent,
    }), connections, undefined, false, saved), 'Other required evidence must still be read')
    assert.equal(saved.recipient.name, '')
  })
  test('provides active MCP capabilities without adding business or style instructions', ({
    assert,
  }) => {
    const instructions = businessDataInstructions([
      ...connections,
      { slug: 'disabled', enabled: false, authenticated: true },
    ])
    assert.include(instructions, 'business_store')
    assert.notInclude(instructions, 'business_disabled')
    assert.include(instructions, 'discovery/search')
    assert.include(instructions, 'Isi skill terimpor menentukan')
    assert.include(instructions, 'dibatasi baca')
    assert.notInclude(instructions, 'kode pos')
    assert.notInclude(instructions, 'ongkir')
  })
})
