import { test } from '@japa/runner'
import {
  isProductCombinationQuestion,
  productRoutingInstructions,
} from '#services/product_routing_service'
import { needsBusinessVerification, verifyBusinessRun } from '#services/skill_runtime_service'

const connections = [{ slug: 'chameleon-cloth', enabled: true, authenticated: true }]
const run = (decision: string, category = 'human_authorization') => ({
  text: JSON.stringify({ decision, handoff_category: category }),
  toolCalls: [{ server: 'business_chameleon-cloth', tool: 'get_product' }],
})

test.group('Product combination routing', () => {
  test('recognizes current combination price questions without hardcoding a color', ({
    assert,
  }) => {
    for (const text of [
      'Kalo yang sage sama celana berapa?',
      'Jas navy plus rompi harganya berapa?',
      'Harga setelan berapa?',
      'Beskap dengan celana brp?',
    ])
      assert.isTrue(isProductCombinationQuestion(text), text)
    for (const text of [
      '',
      'Terima kasih',
      'Sage seperti apa?',
      'Custom jas sama celana berapa?',
      'Mau bicara sama CS, jas sama celana berapa?',
      'Grosir jas sama celana berapa?',
      'Komplain paket jas sama celana, berapa lama refund?',
    ])
      assert.isFalse(isProductCombinationQuestion(text), text)
  })

  test('does not accept an authorization label or unrelated lookup as a reason to abandon shopping', async ({
    assert,
  }) => {
    for (const category of ['human_authorization', 'verified_data_unavailable']) {
      assert.isTrue(
        needsBusinessVerification(run('handoff', category), connections, undefined, true)
      )
    }
    assert.isTrue(needsBusinessVerification(run('silent'), connections, undefined, true))
    let attempts = 0
    const checked = await verifyBusinessRun(
      run('handoff'),
      connections,
      async () => {
        attempts++
        return run('reply')
      },
      undefined,
      true
    )
    assert.equal(attempts, 1)
    assert.equal(JSON.parse(checked.text).decision, 'reply')
    await assert.rejects(
      () =>
        verifyBusinessRun(run('handoff'), connections, async () => run('handoff'), undefined, true),
      /Balasan ditahan/
    )
  })

  test('preserves actual human requests and normal silent turns outside shopping routing', ({
    assert,
  }) => {
    assert.isFalse(needsBusinessVerification(run('handoff'), connections))
    assert.isFalse(needsBusinessVerification(run('silent'), connections))
    assert.equal(productRoutingInstructions(false), '')
    const instructions = productRoutingInstructions(true)
    assert.include(instructions, 'get_product')
    assert.include(instructions, 'bukan sumber harga')
    assert.include(instructions, 'persetujuan pelanggan')
    assert.include(instructions, 'skill terimpor')
  })
})
