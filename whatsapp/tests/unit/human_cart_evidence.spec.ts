import { test } from '@japa/runner'
import {
  humanBundleQuote,
  validBundlePriceRequest,
  validModelConsentRequest,
} from '#services/human_cart_evidence'
import type { CartItem } from '#services/cart_service'
import { parseCartIntent } from '#services/cart_contract'

test.group('Human cart evidence protocol', () => {
  const items = [
    { name: 'Custom notch — jas', quantity: 1 },
    { name: 'Pants Navy', quantity: 1 },
  ] as CartItem[]
  test('recognizes one explicit package amount and all included garment kinds', ({ assert }) => {
    for (const body of [
      'Jas, Celana 705.000 bosku',
      'Jas + celana Rp705.000',
      'jas celana 705rb',
      'jas celana 705k',
    ])
      assert.isTrue(humanBundleQuote(body, 705000, items), body)
    for (const body of [
      'Jas 705.000',
      'Jas celana rompi 705.000',
      'Jas celana 705.000 termasuk ongkir',
      'Jas celana diskon 705.000',
      'Jas celana belum bisa 705.000',
      'Jas celana 705.000?',
      'Jas 485.000 celana 220.000',
      'Jas celana 700rb',
    ])
      assert.isFalse(humanBundleQuote(body, 705000, items), body)
    assert.isFalse(
      humanBundleQuote('Jas celana 705.000', 705000, [{ ...items[0], quantity: 2 }, items[1]])
    )
  })
  test('requires original message identifiers and a valid total', ({ assert }) => {
    assert.isTrue(
      validBundlePriceRequest({
        messageId: 'CS-1',
        confirmationMessageId: 'CUSTOMER-2',
        total: 705000,
      })
    )
    assert.isFalse(
      validBundlePriceRequest({ messageId: '', confirmationMessageId: 'CUSTOMER-2', total: 705000 })
    )
    assert.isFalse(
      validBundlePriceRequest({ messageId: 'CS-1', confirmationMessageId: 'CUSTOMER-2', total: -1 })
    )
    assert.isTrue(
      validModelConsentRequest({ requestMessageId: 'CUSTOMER-1', approvalMessageId: 'CS-2' })
    )
    assert.isFalse(validModelConsentRequest({ approved: true }))
    assert.throws(() => parseCartIntent({ action: 'sync', bundlePrice: { total: 705000 } }))
  })
})
