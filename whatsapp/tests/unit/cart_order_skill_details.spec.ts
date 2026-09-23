import { readFile } from 'node:fs/promises'
import { test } from '@japa/runner'
import { normalizeProductionDetails, hasCustomMeasurements } from '#services/order_item_details'
import { groupOrderParts, groupOrderSnapshot } from '#services/order_operations_service'
import { importedSkillInstructions } from '#services/skill_runtime_service'

test.group('Cart skill production detail example', () => {
  test('imported example satisfies the data contract and survives the production brief', async ({
    assert,
  }) => {
    const content = await readFile(
      new URL('../../skills/cs-cart-order/SKILL.md', import.meta.url),
      'utf8'
    )
    const examples = [...content.matchAll(/```json\n([\s\S]*?)\n```/g)]
    assert.lengthOf(examples, 1)
    const details = normalizeProductionDetails(JSON.parse(examples[0][1]))!
    assert.isTrue(hasCustomMeasurements({ measurements: {}, productionDetails: details }))
    assert.equal(details.heightCm, 168)
    assert.equal(details.weightKg, 84)
    assert.deepEqual(details.measurements, [{ name: 'Lingkar pinggang', value: 96, basis: 'body' }])
    assert.equal(details.material, '')

    const prompt = importedSkillInstructions([{ name: 'cs-cart-order', content }])
    assert.include(prompt, content)
    const snapshot = groupOrderSnapshot({
      id: 1,
      order_number: 'INV-SKILL-TEST',
      paid: 100,
      total: 100,
      snapshot_json: JSON.stringify({
        recipient: { name: 'Fixture', address: 'Private address', phone: '6281200000000' },
        items: [
          {
            name: 'Pants Black',
            size: 'custom',
            quantity: 1,
            measurements: {},
            approval: 'pending',
            productionDetails: details,
          },
        ],
      }),
    })
    const text = groupOrderParts(snapshot)
      .map((part) => part.text)
      .join('\n')
    for (const fact of ['168 cm', '84 kg', 'Badan · Lingkar pinggang: 96 cm'])
      assert.include(text, fact)
    for (const privateValue of ['Private address', '6281200000000', ...details.sourceMessageIds])
      assert.notInclude(JSON.stringify(snapshot), privateValue)
  })
})
