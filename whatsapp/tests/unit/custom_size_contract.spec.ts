import { test } from '@japa/runner'
import {
  normalizeProductionDetails,
  productionFingerprint,
  measurementKey,
} from '#services/order_item_details'
import { parseCartIntent } from '#services/cart_contract'
import { parseCustomSizeQuestion, scopedCustomSizeQuestion } from '#services/custom_size_question'
import { resolveCartIssues } from '#services/ai_cart_service'

const details = (name = 'Panjang lengan', value = 60, basis = 'garment') => ({
  heightCm: null,
  weightKg: null,
  fit: '',
  color: '',
  material: '',
  lapel: '',
  buttons: '',
  measurements: [{ name, value, basis }],
  notes: '',
  pending: [],
  sourceMessageIds: ['customer-1'],
})
const item = () => ({
  id: 'sleeve-1',
  productId: 'suit',
  size: 'custom',
  measurements: {},
  productionDetails: null,
})
const question = (text = 'Panjang lengannya berapa cm, bos?') => ({
  itemId: 'sleeve-1',
  productId: 'suit',
  measurementName: 'Panjang lengan',
  basis: 'garment' as const,
  kind: 'missing_value' as const,
  question: text,
})

test.group('Custom size storage and scoped semantic questions', () => {
  for (const label of [
    'Panjang lengan',
    ' PANJANG LENGAN ',
    'panjang   lengan',
    'Panjang\tlengan',
    'Ｐａｎｊａｎｇ ｌｅｎｇａｎ',
    'Panjang\u00a0lengan',
  ]) {
    test(`typography preserves measurement identity: ${JSON.stringify(label)}`, ({ assert }) => {
      assert.equal(measurementKey(label), 'panjang lengan')
      assert.deepEqual(
        productionFingerprint(normalizeProductionDetails(details(label))),
        productionFingerprint(normalizeProductionDetails(details()))
      )
      assert.throws(
        () =>
          normalizeProductionDetails({
            ...details(),
            measurements: [details().measurements[0], details(label, 58).measurements[0]],
          }),
        /duplikat/
      )
    })
  }
  for (const value of [0, -1, 401, Infinity, Number.NaN, '60', '60 cm', null])
    test(`invalid structured measurement cannot become an approved fact: ${String(value)}`, ({
      assert,
    }) => {
      assert.throws(() => normalizeProductionDetails(details('Panjang lengan', value as any)))
    })
  test('body and garment remain separate, and corrections change the approval facts', ({
    assert,
  }) => {
    const mixed = normalizeProductionDetails({
      ...details(),
      measurements: [
        details('Lingkar dada', 96, 'body').measurements[0],
        details('Lingkar dada', 100, 'garment').measurements[0],
      ],
    })!
    assert.lengthOf(mixed.measurements, 2)
    assert.notDeepEqual(
      productionFingerprint(normalizeProductionDetails(details())),
      productionFingerprint(normalizeProductionDetails(details('Panjang lengan', 58)))
    )
    assert.notDeepEqual(
      productionFingerprint(normalizeProductionDetails(details())),
      productionFingerprint(normalizeProductionDetails(details('Panjang lengan', 60, 'body')))
    )
  })
  for (const label of ['', ' ', '__proto__', 'Constructor', 'PROTOTYPE'])
    test(`invalid dimension label is rejected: ${JSON.stringify(label)}`, ({ assert }) => {
      assert.throws(() => normalizeProductionDetails(details(label)))
    })
  test('null item is a protocol error rather than an unhandled property access', ({ assert }) => {
    assert.throws(
      () =>
        parseCartIntent({
          action: 'sync',
          confirmationMessageId: 'customer-1',
          items: [null],
          removeItemIds: [],
          recipient: { name: '', phone: '', address: '' },
          shipping: { service: '', cost: null },
          note: '',
        }),
      /Format cart AI/
    )
  })
  for (const text of [
    'Panjang lengannya berapa cm, bos?',
    'Lengan jasnya mau sepanjang apa, bos?',
    'Bisa tolong dibantu ukur panjang lengan jasnya dalam cm, bos?',
    'Biar saya cocokin ukurannya, bisa dibantu panjang lengan jasnya dalam cm, bos?',
    'Dawané lengen jas pinten sentimeter, Mas?',
    'How long should the jacket sleeve be?',
    'Panjang leungeunna sabaraha, Kang?',
    'Ｐａｎｊａｎｇ ｌｅｎｇａｎｎｙａ ｂｅｒａｐａ ｃｍ？',
  ])
    test(`semantic slot allows different wording: ${text}`, ({ assert }) => {
      const q = parseCustomSizeQuestion(question(text))!
      assert.equal(scopedCustomSizeQuestion(q, [text], [item()]), text)
    })
  test('known values are not requested again, while an unclear change can be clarified', ({
    assert,
  }) => {
    const known = { ...item(), productionDetails: normalizeProductionDetails(details()) }
    assert.isNull(scopedCustomSizeQuestion(question(), [question().question], [known]))
    const q = { ...question('Mau dikurangi berapa cm, bos?'), kind: 'unclear_change' as const }
    assert.equal(scopedCustomSizeQuestion(q, [q.question], [known]), q.question)
    assert.equal(known.productionDetails!.measurements[0].value, 60)
  })
  for (const scope of ['wrong-item', 'wrong-product', 'two-wearers', 'standard-size', 'not-output'])
    test(`question does not bypass item scope: ${scope}`, ({ assert }) => {
      const q = question()
      let items = [item()]
      let messages = [q.question]
      if (scope === 'wrong-item') q.itemId = 'other'
      if (scope === 'wrong-product') q.productId = 'other'
      if (scope === 'two-wearers') {
        q.itemId = ''
        items.push({ ...item(), id: 'sleeve-2' })
      }
      if (scope === 'standard-size') items[0].size = 'S'
      if (scope === 'not-output') messages = ['Another question?']
      assert.isNull(scopedCustomSizeQuestion(q, messages, items))
    })
  for (const text of [
    'Harga gratis, panjang lengan berapa?',
    'Transfer dulu, panjang lengan berapa?',
    'Rp 500000 ya, panjang lengan berapa?',
    'Lengan ６０ cm saja ya?',
    'Panjang lengan berapa? Bayar sekarang.',
    'Lengan berapa? Bahu berapa?',
    'Lihat https://example.test dulu?',
  ])
    test(`incomplete price never releases a quote or combined message: ${text}`, ({ assert }) => {
      assert.isNull(scopedCustomSizeQuestion(question(text), [text], [item()]))
    })
  test('natural clarification may reference the recorded value but never invent another value', ({
    assert,
  }) => {
    const known = { ...item(), productionDetails: normalizeProductionDetails(details()) }
    const text = 'Lengan jas bos mau dipendekkan berapa cm dari ukuran sebelumnya 60 cm?'
    const q = { ...question(text), kind: 'unclear_change' as const }
    assert.equal(scopedCustomSizeQuestion(q, [text], [known]), text)
    const invented = { ...q, question: text.replace('60', '58') }
    assert.isNull(scopedCustomSizeQuestion(invented, [invented.question], [known]))
    const reference = {
      ...question('Data ukuran lama belum ada di sini. Bisa kirim catatan ukurannya, bos?'),
      kind: 'unclear_reference' as const,
    }
    assert.equal(
      scopedCustomSizeQuestion(reference, [reference.question], [item()]),
      reference.question
    )
  })
  test('an invalid semantic target cannot fall back to a legacy waist keyword match', ({
    assert,
  }) => {
    const q = {
      ...question('Lingkar pinggangnya berapa cm, bos?'),
      itemId: 'wrong-item',
      measurementName: 'Lingkar pinggang',
    }
    const decision: any = {
      decision: 'reply',
      message: q.question,
      initiative: '',
      reason: '',
      note: '',
      customSizeQuestion: q,
      goal: { status: 'waiting_answer', follow_up: null },
    }
    const cart: any = {
      items: [{ ...item(), name: 'Pants Uji' }],
      issues: ['Harga belum sah'],
      onlyPendingCustomPrices: true,
    }
    assert.equal(resolveCartIssues(decision, cart).decision, 'handoff')
  })
  test('only the scoped question survives an unverified price; internal reviews stay silent', ({
    assert,
  }) => {
    const q = question()
    const decision: any = {
      decision: 'reply',
      message: 'Harga Rp500000, bayar sekarang',
      initiative: q.question,
      customSizeQuestion: q,
      reason: '',
      note: '',
      goal: { status: 'waiting_answer', follow_up: null },
    }
    const cart: any = {
      items: [item()],
      issues: ['Harga custom belum sah'],
      onlyPendingCustomPrices: true,
    }
    const allowed = resolveCartIssues(decision, cart)
    assert.equal(allowed.message, q.question)
    assert.equal(allowed.initiative, '')
    assert.equal(allowed.decision, 'reply')
    assert.isNull(allowed.cartIntent)
    assert.equal(resolveCartIssues(decision, cart, true).decision, 'silent')
    assert.equal(
      resolveCartIssues(decision, { ...cart, onlyPendingCustomPrices: false }).decision,
      'handoff'
    )
  })
})
