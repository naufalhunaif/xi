import { test } from '@japa/runner'
import type { AiDecision } from '#services/ai_service'
import {
  verifyVisualDecision,
  visualResultTrace,
  VISUAL_MATCH_SCHEMA,
  VISUAL_MATCH_INSTRUCTIONS,
} from '#services/visual_match_contract'
import { redactTrace } from '#services/trace_service'

const candidates = [{ id: 'suit', server: 'business_fixture' }]
function decision(): AiDecision {
  return {
    decision: 'reply',
    message: 'Fixture',
    note: '',
    reason: '',
    visualMatch: {
      targetImage: 1,
      status: 'matched',
      productId: 'suit',
      server: 'business_fixture',
      findings: [
        {
          feature: 'lapel',
          customer: 'Notch terlihat',
          catalog: 'Notch terlihat',
          relation: 'match',
        },
        {
          feature: 'buttons',
          customer: 'Satu kancing depan',
          catalog: 'Satu kancing depan',
          relation: 'match',
        },
      ],
    },
  }
}
test.group('Visual identity evidence gate', () => {
  test('detailed observations distinguish hidden features and remain visible without raw reasoning', ({
    assert,
  }) => {
    for (const term of [
      'lapel',
      'trim',
      'buttons',
      'pockets',
      'sleeves',
      'fabric',
      'back',
      'visibility',
    ])
      assert.include(JSON.stringify(VISUAL_MATCH_SCHEMA), term)
    assert.include(VISUAL_MATCH_INSTRUCTIONS, 'tidak terlihat')
    assert.include(VISUAL_MATCH_INSTRUCTIONS, 'needsVisualInspection=true')
    const findings = Array.from({ length: 24 }, (_, index) => ({
      feature: 'buttons',
      customer: `detail ${index}`,
      catalog: 'tidak terlihat',
      relation: 'unknown',
      reasoning: 'PRIVATE',
      access_token: 'SECRET',
    }))
    const safe = redactTrace({ findings }) as any
    assert.lengthOf(safe.findings, 24)
    assert.notInclude(JSON.stringify(safe), 'PRIVATE')
    assert.notInclude(JSON.stringify(safe), 'SECRET')
    const value = decision()
    value.visualMatch!.findings.push({
      feature: 'back',
      customer: 'tidak terlihat',
      catalog: 'dua vent terlihat',
      relation: 'unknown',
    })
    assert.equal(verifyVisualDecision(value, candidates).visualMatch?.status, 'matched')
    value.visualMatch!.findings[0].relation = 'unknown'
    assert.throws(() => verifyVisualDecision(value, candidates), /belum cukup/)
  })
  test('accepts independently described identifying features from an attached candidate', ({
    assert,
  }) => {
    assert.equal(verifyVisualDecision(decision(), candidates).visualMatch?.status, 'matched')
  })
  test('rejects matching the catalog image instead of the latest customer reference', ({
    assert,
  }) => {
    const value = decision()
    value.visualMatch!.targetImage = 2
    assert.throws(() => verifyVisualDecision(value, candidates), /terbaru/)
  })
  test('rejects an unprepared product and same ID from a different MCP', ({ assert }) => {
    assert.throws(() => verifyVisualDecision(decision(), []), /belum dibandingkan/)
    assert.throws(
      () => verifyVisualDecision(decision(), [{ id: 'suit', server: 'other' }]),
      /belum dibandingkan/
    )
  })
  test('color and duplicate features are not enough evidence', ({ assert }) => {
    const value = decision()
    value.visualMatch!.findings[1].feature = 'color'
    assert.throws(() => verifyVisualDecision(value, candidates), /belum cukup/)
    value.visualMatch!.findings[1].feature = 'lapel'
    assert.throws(() => verifyVisualDecision(value, candidates), /belum cukup/)
  })
  test('contradicting trim and hidden buttons cannot be treated as matched', ({ assert }) => {
    const value = decision()
    value.visualMatch!.findings.push({
      feature: 'trim',
      customer: 'List kontras',
      catalog: 'Tanpa list',
      relation: 'different',
    })
    assert.throws(() => verifyVisualDecision(value, candidates), /bertentangan/)
    value.visualMatch!.findings.pop()
    value.visualMatch!.findings[1].relation = 'unknown'
    assert.throws(() => verifyVisualDecision(value, candidates), /belum cukup/)
  })
  test('unmatched images cannot send substitute catalog photos or update the cart', ({
    assert,
  }) => {
    const value = decision()
    value.visualMatch!.status = 'no_match'
    assert.equal(verifyVisualDecision(value, candidates).visualMatch?.productId, '')
    value.images = [{ url: 'https://example.test/other.jpg', caption: 'Ini produknya' }]
    assert.throws(() => verifyVisualDecision(value, candidates), /penggantian/)
    value.images = []
    value.cartIntent = {
      action: 'sync',
      items: [{ modelType: 'catalog', productId: 'suit' }],
    } as any
    assert.throws(() => verifyVisualDecision(value, candidates), /penggantian/)
  })
  test('only an unpriced custom draft bound to the latest reference is allowed', ({ assert }) => {
    const value = decision()
    value.visualMatch!.status = 'no_match'
    value.cartIntent = {
      action: 'sync',
      items: [{ modelType: 'custom', referenceMessageId: 'latest', unitPrice: null }],
    } as any
    assert.equal(verifyVisualDecision(value, candidates, 'latest').cartIntent, value.cartIntent)
    assert.throws(() => verifyVisualDecision(value, candidates, 'different-image'), /penggantian/)
  })
  test('missing candidate images mean uncertain, not confirmed absence', ({ assert }) => {
    const value = decision()
    value.visualMatch!.status = 'no_match'
    assert.throws(() => verifyVisualDecision(value, []), /Belum ada foto kandidat/)
    value.visualMatch!.status = 'uncertain'
    assert.equal(verifyVisualDecision(value, []).visualMatch?.server, '')
  })
  for (const status of ['no_match', 'uncertain'] as const)
    test(`allows evidenced ready and PO companions with a separate custom reference: ${status}`, ({
      assert,
    }) => {
      const value = decision()
      value.visualMatch!.status = status
      const custom = { modelType: 'custom', referenceMessageId: 'latest', unitPrice: null }
      const ready = {
        productId: 'pants',
        name: 'Pants',
        modelType: 'catalog',
        fulfillment: 'ready',
      }
      const po = { productId: 'vest', name: 'Vest', modelType: 'catalog', fulfillment: 'preorder' }
      value.cartIntent = { action: 'sync', items: [custom, ready, po] } as any
      const sources = [ready, po]
      const result = verifyVisualDecision(value, candidates, 'latest', sources)
      assert.deepEqual(result.cartIntent!.items, [custom, ready, po])
      assert.equal(result.visualMatch!.productId, '')
      // Comparison candidates alone do not prove independently selected companions.
      assert.throws(() => verifyVisualDecision(value, candidates, 'latest'), /penggantian/)
      assert.throws(() => verifyVisualDecision(value, candidates, 'latest', [ready]), /penggantian/)
      assert.throws(() => verifyVisualDecision(value, candidates, 'other', sources), /penggantian/)
      ready.name = 'Different pants'
      assert.throws(
        () =>
          verifyVisualDecision(value, candidates, 'latest', [
            { productId: 'pants', name: 'Pants' },
            po,
          ]),
        /penggantian/
      )
    })
  test('mixed-cart permission does not price the unmatched photo or replace it with catalog goods', ({
    assert,
  }) => {
    const value = decision()
    value.visualMatch!.status = 'no_match'
    const ready = { productId: 'pants', name: 'Pants', modelType: 'catalog' }
    const custom = { modelType: 'custom', referenceMessageId: 'latest', unitPrice: 500000 }
    value.cartIntent = { action: 'sync', items: [custom, ready] } as any
    assert.throws(() => verifyVisualDecision(value, candidates, 'latest', [ready]), /penggantian/)
    value.cartIntent!.items = [ready] as any
    assert.throws(() => verifyVisualDecision(value, candidates, 'latest', [ready]), /penggantian/)
    value.cartIntent!.items = [
      { ...custom, unitPrice: null },
      { ...ready, referenceMessageId: 'latest' },
    ] as any
    assert.throws(() => verifyVisualDecision(value, candidates, 'latest', [ready]), /penggantian/)
  })
  test('non-product media still supports normal receipt handling', ({ assert }) => {
    const value = decision()
    value.visualMatch!.status = 'not_product'
    value.visualMatch!.productId = ''
    value.visualMatch!.server = ''
    value.visualMatch!.findings = []
    value.cartIntent = { action: 'report_payment', items: [] } as any
    assert.equal(verifyVisualDecision(value, []), value)
  })
  for (const status of ['no_match', 'uncertain', 'matched'] as const) {
    test(`trace separates completed processing from a selected product: ${status}`, ({
      assert,
    }) => {
      const value = decision()
      value.visualMatch!.status = status
      const checked = verifyVisualDecision(value, candidates)
      const event = visualResultTrace(checked.visualMatch!, 'latest-image', 1)
      assert.equal(event.status, 'completed')
      assert.equal(event.detail.result, status)
      assert.equal(event.detail.candidatesCompared, 1)
      assert.equal(event.detail.referenceMessageId, 'latest-image')
      assert.lengthOf(event.detail.matchedProducts, status === 'matched' ? 1 : 0)
      if (status === 'no_match') {
        assert.equal(event.label, 'Tidak ada kandidat yang cocok')
        assert.equal(checked.visualMatch!.productId, '')
        assert.equal(checked.visualMatch!.server, '')
      }
      if (status === 'uncertain')
        assert.equal(event.label, 'Kecocokan produk belum dapat dipastikan')
    })
  }
})
