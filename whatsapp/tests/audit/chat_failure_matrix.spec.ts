// Synthetic, de-identified conversations based on archive patterns and the user's
// reported Casual Suit exchange. These are contract/fault tests, NOT LLM answers.
// Deliberately separate from the normal suite: unmet expectations stay red.
import { test } from '@japa/runner'
import { renderContext, type MessageRow } from '#services/context_service'
import { currentFitRequest } from '#services/fit_routing_service'
import { isProductCombinationQuestion } from '#services/product_routing_service'
import { needsBusinessVerification, verifyBusinessRun } from '#services/skill_runtime_service'
import { parseDecision, extractCatalogProducts, prepareVisualInputs } from '#services/ai_service'
import { cartSize, parseCartIntent } from '#services/cart_contract'
import { parseReceipt } from '#services/payment_receipt_contract'
import { receiptAssessment } from '#services/payment_review_service'
import {
  shippingEvidence,
  matchShippingQuote,
  shippingContentsChanged,
} from '#services/shipping_evidence_service'
import { understandHumanAnswer } from '#services/human_answer_service'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import { sendPreparedReply } from '#services/reply_presence_service'
import { downloadOutgoingImage } from '#services/outgoing_image_service'
import { traceProviderEvents, type TraceEvent } from '#services/trace_service'
import {
  defaultProductionPolicy,
  validateProductionPolicy,
  productionDataContext,
  parseProductionSignal,
} from '#services/production_contract'

const connections = [{ slug: 'chameleon-cloth', enabled: true, authenticated: true }]
const mcp = (
  result: any = { structured_content: { id: 'casual', img: '/casual.jpg' } },
  server = 'business_chameleon-cloth'
) => ({ server, tool: 'get_product', arguments: { id: 'casual' }, result })
const draft = (fields: Record<string, unknown> = {}, calls: any[] = []) => ({
  text: JSON.stringify({
    decision: 'reply',
    message: 'Foto Casual Suit.',
    business_lookup_required: true,
    ...fields,
  }),
  toolCalls: calls,
})
const row = (
  id: string,
  body: string,
  outgoing = false,
  quoted: string | null = null
): MessageRow => ({
  message_id: id,
  direction: outgoing ? 'out' : 'in',
  sender_type: outgoing ? 'cs' : 'customer',
  body,
  media_type: null,
  reply_to_message_id: quoted,
  created_at: new Date('2026-09-14T01:00:00Z'),
})
const context = (rows: MessageRow[], known = rows) =>
  renderContext({
    jid: 'audit@lid',
    rows,
    known: new Map(known.map((r) => [r.message_id, r])),
    currentIds: new Set([rows.at(-1)!.message_id]),
    note: null,
    now: new Date('2026-09-14T01:01:00Z'),
  })

test.group('Archive pattern: short replies and retained context', () => {
  test('C01 Casual selection retains the human product list', ({ assert }) => {
    const out = context([
      row('a', 'Ada model apa saja?'),
      row('b', 'Basic Suit; Casual Suit; Peak Suit', true),
      row('c', 'Yang casual'),
    ])
    assert.include(out, 'CS: Basic Suit; Casual Suit; Peak Suit')
    assert.include(out, 'PELANGGAN: Yang casual')
  })
  test('C02 long product list retains the item chosen at the end', ({ assert }) => {
    assert.include(
      context([
        row('a', 'Daftar model. '.repeat(55) + 'Casual Suit Black', true),
        row('b', 'Yang casual'),
      ]),
      'Casual Suit Black'
    )
  })
  test('C03 an old quoted specification retains its final measurement', ({ assert }) => {
    const quoted = row('old', 'Detail model. '.repeat(55) + 'Lingkar pinggang 92 cm', true)
    assert.include(
      context([row('new', 'Sesuai ini', false, 'old')], [quoted]),
      'Lingkar pinggang 92 cm'
    )
  })
  test('C04 an unavailable quote is marked unknown, not reconstructed', ({ assert }) => {
    assert.include(context([row('new', 'Yang itu', false, 'missing')]), 'tidak tersedia')
  })
  test('C05 measurement messages remain in chronological conversation context', ({ assert }) => {
    const out = context([row('a', 'Celana ukuran berapa?'), row('b', 'TB 168'), row('c', 'BB 84')])
    assert.include(out, 'TB 168')
    assert.include(out, 'BB 84')
    assert.isBelow(out.indexOf('TB 168'), out.indexOf('BB 84'))
  })
})

test.group('Routing guard coverage (a missing guard does not prove the LLM fails)', () => {
  for (const [id, text] of [
    ['F01', 'Tinggi 168 berat 84 celana bagusnya nomor berapa?'],
    ['F02', 'TB 168 BB 84,5 celana size apa?'],
    ['F03', '168 cm 84 kg celana cocok nomor berapa?'],
  ])
    test(`${id} recognizes fit need: ${text}`, ({ assert }) =>
      assert.exists(currentFitRequest(text)))
  test('F04 does not invent the garment type when not present in this turn', ({ assert }) => {
    assert.isUndefined(currentFitRequest('TB 168 BB 84 ukuran apa?'))
  })
  test('F05 does not guess the meaning/order of unlabelled slash measurements', ({ assert }) => {
    assert.isUndefined(currentFitRequest('Celana size berapa buat 168/84?'))
  })
  test('F06 explicit human request is not overridden by Fit', ({ assert }) => {
    assert.isUndefined(currentFitRequest('TB 168 BB 84 celana ukuran apa? Mau bicara CS'))
  })
  test('P01 a combination price query receives additional product validation', ({ assert }) => {
    assert.isTrue(isProductCombinationQuestion('Kalau sage sama celana berapa?'))
  })
  test('P02 a short model choice cannot bypass lookup with a generic human-authorization label', ({
    assert,
  }) => {
    const choice = 'Yang casual'
    assert.isTrue(
      needsBusinessVerification(
        draft({ decision: 'handoff', handoff_category: 'human_authorization' }),
        connections,
        undefined,
        isProductCombinationQuestion(choice)
      )
    )
  })
})

test.group('MCP evidence and failure injection', () => {
  for (const [id, calls] of [
    [
      'B01 tool failed',
      [mcp({ isError: true, content: [{ type: 'text', text: 'Unauthorized' }] })],
    ],
    ['B02 tool returned no result', [mcp(null)]],
    ['B03 tool from unconfigured source', [mcp(undefined, 'business_other')]],
    [
      'B04 unrelated tool used as product evidence',
      [{ server: 'business_chameleon-cloth', tool: 'get_store_hours', result: { open: true } }],
    ],
  ] as const)
    test(`${id} must not validate a product answer`, ({ assert }) => {
      assert.isTrue(needsBusinessVerification(draft({}, [...calls]), connections))
    })
  test('B05 valid product evidence passes the generic gate', ({ assert }) => {
    assert.isFalse(needsBusinessVerification(draft({}, [mcp()]), connections))
  })
  test('B06 discovery alone is not product evidence', ({ assert }) => {
    assert.isTrue(
      needsBusinessVerification(
        draft({}, [{ server: 'business_chameleon-cloth', tool: 'list_tools' }]),
        connections
      )
    )
  })
  test('B07 product-required response is held when all MCPs are offline', ({ assert }) => {
    assert.isTrue(needsBusinessVerification(draft(), [{ ...connections[0], authenticated: false }]))
  })
  test('B08 greeting with lookup unnecessary is allowed', ({ assert }) => {
    assert.isFalse(
      needsBusinessVerification(
        draft({ message: 'Halo', business_lookup_required: false }),
        connections
      )
    )
  })
  test('B09 missing evidence is retried once, not infinitely', async ({ assert }) => {
    let retries = 0
    await assert.rejects(
      () =>
        verifyBusinessRun(draft(), connections, async () => {
          retries++
          return draft()
        }),
      /Balasan ditahan/
    )
    assert.equal(retries, 1)
  })
  test('B10 transient failure during evidence retry is exposed, not silently called success', async ({
    assert,
  }) => {
    await assert.rejects(
      () =>
        verifyBusinessRun(draft(), connections, async () => {
          throw new Error('fixture: MCP 503')
        }),
      /MCP 503/
    )
  })
  test('B11 a successful evidence retry unblocks the answer', async ({ assert }) => {
    const result = await verifyBusinessRun(draft(), connections, async () => draft({}, [mcp()]))
    assert.lengthOf(result.toolCalls, 1)
  })
})

test.group('Provider output and catalog images', () => {
  for (const [id, output] of [
    ['J01 truncated JSON', '{"decision":"reply","message":"Casual'],
    ['J02 plain provider diagnostic', 'Error: provider unavailable'],
    [
      'J03 unknown decision',
      JSON.stringify({ decision: 'broken', message: 'Unvalidated content' }),
    ],
  ])
    test(`${id} must not become a customer message`, ({ assert }) =>
      assert.throws(() => parseDecision(output)))
  test('J04 empty reply is rejected', ({ assert }) =>
    assert.throws(() => parseDecision('{"decision":"reply","message":""}')))
  test('J05 handoff never sends its explanatory message', ({ assert }) => {
    assert.equal(
      parseDecision('{"decision":"handoff","message":"Saya teruskan ke CS"}').message,
      ''
    )
  })
  test('I01 snake-case structured product supplies image evidence', ({ assert }) =>
    assert.lengthOf(extractCatalogProducts([mcp()]), 1))
  test('I02 camel-case structured product also supplies image evidence', ({ assert }) => {
    assert.lengthOf(
      extractCatalogProducts([mcp({ structuredContent: { id: 'casual', img: '/casual.jpg' } })]),
      1
    )
  })
  test('I03 failed result cannot supply product image evidence', ({ assert }) => {
    assert.lengthOf(
      extractCatalogProducts([
        mcp({ isError: true, structured_content: { id: 'casual', img: '/casual.jpg' } }),
      ]),
      0
    )
  })
  test('I04 missing media returns no pixels, not a fake image', async ({ assert }) => {
    assert.deepEqual(
      await prepareVisualInputs({ type: 'image', path: null }, '/nonexistent/audit'),
      []
    )
  })
  test('I05 HTML login page cannot be sent as a product image', async ({ assert }) => {
    await assert.rejects(
      () =>
        downloadOutgoingImage(
          'https://fixture.invalid/image',
          (async () =>
            new Response('<html>Login</html>', {
              headers: { 'content-type': 'text/html' },
            })) as typeof fetch
        ),
      /File gambar tidak tersedia/
    )
  })
})

test.group('Cart, shipping and payment contracts', () => {
  test('K01 custom number 38 is not converted to 38 cm', ({ assert }) =>
    assert.deepEqual(cartSize('custom 38'), { size: 'custom', requestedSize: '38' }))
  test('K02 inconsistent custom labels are rejected', ({ assert }) =>
    assert.throws(() => cartSize('custom 38', '40')))
  test('K03 cart without a confirmation message cannot be persisted through the contract', ({
    assert,
  }) => assert.throws(() => parseCartIntent({ action: 'sync', confirmationMessageId: '' })))
  test('S01 a failed shipping quote is not evidence', ({ assert }) => {
    assert.deepEqual(
      shippingEvidence([
        {
          tool: 'check_shipping_rates',
          result: { isError: true, structuredContent: { service: 'REG', cost: 8000 } },
        },
      ]),
      []
    )
  })
  test('S02 an unquoted service/price cannot be selected', ({ assert }) => {
    assert.isUndefined(matchShippingQuote([{ service: 'REG', cost: 8000 }], 'YES', 8000))
  })
  test('S03 destination change invalidates old shipping contents', ({ assert }) => {
    assert.isTrue(
      shippingContentsChanged(
        { items: [], recipient: { address: 'Kota A' } },
        { items: [], recipient: { address: 'Kota B' } }
      )
    )
  })
  const receipt = {
    isReceipt: true,
    status: 'success' as const,
    amount: 8000,
    currency: 'IDR',
    recipientBank: 'BRI',
    recipientAccount: '1234567890',
    reference: 'fixture-ref',
  }
  const methods = [
    { id: 1, name: 'BRI', destination: '1234567890', accountName: 'Test', enabled: true },
  ]
  test('M01 exact recipient bank/account matches one payment method', ({ assert }) =>
    assert.isEmpty(receiptAssessment(receipt, methods).issues))
  test('M02 wrong destination is held for review', ({ assert }) =>
    assert.isNotEmpty(
      receiptAssessment({ ...receipt, recipientAccount: '0000000000' }, methods).issues
    ))
  test('M03 pending transfer is not accepted as successful', ({ assert }) =>
    assert.isNotEmpty(receiptAssessment({ ...receipt, status: 'pending' }, methods).issues))
  test('M04 unreadable amount cannot pass receipt parsing', ({ assert }) =>
    assert.throws(() => parseReceipt({ ...receipt, amount: '8000' })))
  test('M05 duplicate configured accounts do not silently choose one', ({ assert }) =>
    assert.isNull(receiptAssessment(receipt, [...methods, { ...methods[0], id: 2 }]).method))
})

test.group('CS handoff, race conditions, delivery and traces', () => {
  const reply = {
    decision: 'reply' as const,
    message: 'Jawaban',
    initiative: 'Pertanyaan berikutnya',
    reason: '',
    note: '',
  }
  test('D01 understanding a CS answer does not hand back to CS or send another answer', ({
    assert,
  }) => {
    const result = understandHumanAnswer({ ...reply, decision: 'handoff' })
    assert.equal(result.decision, 'silent')
    assert.equal(result.message, '')
    assert.isNull(result.goal?.follow_up)
  })
  test('D02 a newer customer message cancels the next initiative bubble', async ({ assert }) => {
    let allowed = true
    const sent: string[] = []
    const done = await sendAiMessageSequence(
      reply,
      false,
      async () => allowed,
      async (body) => {
        sent.push(body)
        allowed = false
        return true
      }
    )
    assert.isFalse(done)
    assert.deepEqual(sent, ['Jawaban'])
  })
  test('D03 handoff sends zero bubbles', async ({ assert }) => {
    let sent = 0
    await sendAiMessageSequence(
      { ...reply, decision: 'handoff' },
      false,
      async () => true,
      async () => {
        sent++
        return true
      }
    )
    assert.equal(sent, 0)
  })
  test('D04 failed read receipt prevents sending (an operational hold)', async ({ assert }) => {
    let sent = 0
    const socket = {
      readMessages: async () => {
        throw new Error('fixture read timeout')
      },
      sendPresenceUpdate: async () => {},
    }
    await assert.rejects(
      () =>
        sendPreparedReply(
          socket,
          'audit@lid',
          [{ id: 'a', remoteJid: 'audit@lid', fromMe: false }],
          async () => {
            sent++
          },
          { canSend: async () => true, wait: async () => {} }
        ),
      /read timeout/
    )
    assert.equal(sent, 0)
  })
  test('T01 failed MCP tool is explicitly marked failed in trace', ({ assert }) => {
    const events: TraceEvent[] = []
    traceProviderEvents((event) => events.push(event), 'audit')('chatgpt', {
      type: 'item.completed',
      item: {
        id: 'a',
        type: 'mcp_tool_call',
        server: 'business_chameleon-cloth',
        tool: 'get_product',
        result: { isError: true },
      },
    })
    assert.equal(events[0].status, 'failed')
  })
  test('T02 provider turn failure emits an actionable failed trace event', ({ assert }) => {
    const events: TraceEvent[] = []
    traceProviderEvents((event) => events.push(event), 'audit')('chatgpt', {
      type: 'turn.failed',
      error: { message: 'fixture provider unavailable' },
    })
    assert.isTrue(events.some((event) => event.status === 'failed'))
  })
})

test.group('Local production policy without live orders', () => {
  test('O01 enabled production cannot have an unknown lead time', ({ assert }) => {
    const policy = defaultProductionPolicy()
    policy.rules.custom.enabled = true
    assert.throws(() => validateProductionPolicy(policy))
  })
  test('O02 production estimates come from the explicit local settings source', ({ assert }) => {
    const policy = defaultProductionPolicy()
    policy.rules.custom = {
      enabled: true,
      minDays: 7,
      maxDays: 21,
      estimateDays: 14,
      dayType: 'working',
      startsAfter: 'approval',
    }
    const prompt = productionDataContext(validateProductionPolicy(policy))
    assert.include(prompt, 'bukan MCP')
    assert.include(prompt, '"estimateDays":14')
  })
  test('O03 evaluation cannot adjust production without evidence identifiers', ({ assert }) => {
    assert.throws(() =>
      parseProductionSignal({
        kind: 'custom',
        direction: 'shorter',
        reason: 'fixture',
        evidenceMessageIds: [],
      })
    )
  })
})
