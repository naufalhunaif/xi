import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { readSettings, ensureDefaults } from '#services/settings_service'
import { buildTurnContext } from '#services/context_service'
import { readCart, saveCart } from '#services/cart_service'
import { applyAiCartIntent } from '#services/ai_cart_service'
import { verifyBusinessRun } from '#services/skill_runtime_service'
import type { CartIntent } from '#services/cart_contract'
import { createReply } from '#services/ai_service'
import { planIndexReply, readIndexReply } from '#services/index_reply'
import {
  beginGoalTurn,
  invalidateConversationGoal,
  saveGoalDecision,
  alreadyAnalyzedMessage,
  readConversationGoal,
} from '#services/conversation_goal_service'
import { saveCustomerMemory, conversationHistoryTools } from '#services/conversation_memory'
import { inWorkspace } from '#services/workspace_context'
import { resetQuota } from '#services/ai_quota_store'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const goal = {
  objective: 'Permintaan selesai',
  stage: 'closed' as const,
  status: 'completed' as const,
  waiting_for: '',
  next_action: '',
  follow_up: null,
}
async function message(jid: string, body: string, out = false) {
  const id = randomUUID()
  await db.table('whatsapp_messages').insert({
    jid,
    message_id: id,
    body,
    direction: out ? 'out' : 'in',
    sender_type: out ? 'ai' : 'customer',
    status: out ? 'sent' : 'received',
    created_at: new Date(),
  })
  return id
}
async function closedRoom() {
  const jid = `${Math.floor(1e13 + Math.random() * 1e13)}@lid`
  await db.table('whatsapp_contacts').insert({ jid, updated_at: new Date() })
  await readCart(jid)
  const incoming = await message(jid, 'Terima kasih')
  const run = (await beginGoalTurn(jid, incoming))!
  const sent = await message(jid, 'Sama-sama bos.', true)
  const settings = await readSettings(true)
  await saveGoalDecision(
    run,
    { decision: 'reply', message: 'Sama-sama bos.', reason: '', note: '', goal },
    settings.skills
  )
  const ack = await message(jid, 'iya bos')
  await invalidateConversationGoal(jid)
  const next = (await beginGoalTurn(jid, ack))!
  return { jid, sent, ack, run: next, settings }
}

function worker() {
  const instance = Object.assign(Object.create(WhatsappListen.prototype), {
    socket: {},
    stopping: false,
    waitForDeliverySync: async () => true,
    canSendAiReply: async () => true,
    customerTurnContext: buildTurnContext,
    setActivity: async () => {},
  }) as any
  Object.defineProperty(instance, 'logger', { value: { error: () => {}, info: () => {} } })
  return instance
}

test.group('Beta level pipeline: disposable DB, no paid AI or WhatsApp', (group) => {
  group.each.skip(
    process.env.DISCOUNT_DB_TEST !== '1',
    'Use --conversation-levels isolated runner.'
  )
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || ''))
      throw new Error('Disposable database required')
    await initializeDatabase()
    await ensureDefaults()
  })
  test('current-room cart retains a quote through recipient completion without another AI phase', async ({ assert }) => {
    const jid = `recipient-${randomUUID()}@lid`
    await db.table('whatsapp_contacts').insert({ jid, updated_at: new Date() })
    const blank = await readCart(jid)
    const cart = await saveCart(jid, blank.version, {
      items: [{ productId: 'fixture-suit', name: 'Fixture Suit', image: 'https://example.com/fixture.jpg', size: 'S', quantity: 1, unitPrice: 100000, note: '' }],
      recipient: { name: '', phone: '', address: 'Fixture Street 1' },
      shipping: { service: 'REG', cost: 8000, serviceCode: 'REG', destinationCode: 'FIXTURE', weightKg: 1 },
      note: '',
    })
    await message(jid, 'Atas nama siapa bos?', true)
    const incoming = await message(jid, 'Fixture Recipient')
    const context = await buildTurnContext(jid, [incoming])
    assert.deepEqual(context.routing.savedCart, {
      items: cart.items, recipient: cart.recipient, shipping: cart.shipping,
    })
    const intent: CartIntent = {
      action: 'sync', confirmationMessageId: incoming, removeItemIds: [], note: '',
      items: cart.items.map((item) => ({ ...item, measurements: [] })),
      recipient: { ...cart.recipient, name: 'Fixture Recipient' },
      shipping: { ...cart.shipping },
    }
    const run = { text: JSON.stringify({ decision: 'reply', business_lookup_required: false, cartIntent: intent }), toolCalls: [] }
    await verifyBusinessRun(run, [{ slug: 'orion', enabled: true, authenticated: true }], async () => {
      throw new Error('Must not launch another analysis just to keep the saved quote')
    }, undefined, false, context.routing.savedCart)
    await applyAiCartIntent(jid, context.cartVersion, intent, { products: [], shipping: [] })
    const after = await readCart(jid)
    assert.equal(after.recipient.name, 'Fixture Recipient')
    assert.deepEqual(after.shipping, cart.shipping)
    assert.equal(context.routing.savedCart!.recipient.address, 'Fixture Street 1')
    const changed: CartIntent = { ...intent, recipient: { ...intent.recipient, address: 'Fixture Street 2' } }
    await assert.rejects(() => applyAiCartIntent(jid, after.version, changed, { products: [], shipping: [] }), /Ongkir belum cocok/)
    assert.deepEqual((await readCart(jid)).recipient, after.recipient)
    const another = `another-${randomUUID()}@lid`
    await message(another, 'Sama')
    const otherContext = await buildTurnContext(another, [])
    assert.equal(otherContext.routing.savedCart!.shipping.cost, null)
    assert.notInclude(otherContext.prompt, 'Fixture Street 1')
  })
  for (const scenario of ['HELLO', 'ESCALATE', 'MALFORMED', 'FORGED', 'BUSINESS']) {
    test(`compact index ${scenario} uses a small contract or escalates once with original context`, async ({
      assert,
    }) => {
      await resetQuota('chatgpt')
      const jid = `index-${randomUUID()}@lid`
      await db.table('whatsapp_contacts').insert({ jid, updated_at: new Date() })
      const text = scenario === 'BUSINESS' ? 'Harga jas BUSINESS' : `Halo ${scenario}`
      const incoming = await message(jid, text)
      const context = await buildTurnContext(jid, [incoming])
      assert.isDefined(context.routing.indexContext)
      const events: any[] = []
      const settings = {
        aiProvider: 'chatgpt',
        aiFailover: false,
        codexBin: fileURLToPath(new URL('../fixtures/index_reply_provider.mjs', import.meta.url)),
        skills: [
          {
            name: 'cs-chameleon-cloth',
            content:
              '# Aturan wajib\nCORE_INDEX_ORIGINAL\n## Ukuran\nSIZING_DOMAIN_ORIGINAL\n## Pembayaran\n' +
              'PAYMENT_DOMAIN_ORIGINAL\n'.repeat(1500),
          },
          { name: 'cs-cart-order', content: 'CART_DOMAIN_ORIGINAL\n'.repeat(1500) },
        ],
        mcpConnections:
          scenario === 'HELLO'
            ? [
                {
                  slug: 'must-not-connect',
                  url: 'http://127.0.0.1:1',
                  enabled: true,
                  authenticated: true,
                },
              ]
            : [],
        routingContext: {
          ...context.routing,
          indexContext: context.routing.indexContext + '\nSOURCE_CONTEXT_ORIGINAL',
        },
        conversationAccess: context.access,
      }
      const result = await createReply(
        settings,
        text,
        undefined,
        undefined,
        context.prompt + '\nMAIN_CONVERSATION_ORIGINAL',
        [],
        (event) => events.push(event)
      )
      assert.lengthOf(
        events.filter((e) => e.key === 'index-analysis' && e.status === 'running'),
        scenario === 'BUSINESS' ? 0 : 1
      )
      assert.lengthOf(
        events.filter((e) => e.key === 'analysis' && e.status === 'running'),
        scenario === 'HELLO' ? 0 : 1
      )
      assert.isFalse(events.some((e) => e.key === 'skill-routing-fallback'))
      if (scenario === 'HELLO') {
        assert.isDefined(result.indexReply)
        assert.equal(result.message, 'Halo bos.')
        assert.equal(result.goal?.status, 'waiting_answer')
        assert.isTrue(
          events.every((e) => !e.key.includes('mcp-auth') && !e.key.includes('mcp-cache'))
        )
        assert.isBelow(events.find((e) => e.key === 'index-prompt-size').detail.characters, 15000)
      } else {
        assert.isUndefined(result.indexReply)
        assert.equal(result.message, 'Kebutuhan mana yang dimaksud bos?')
        assert.lengthOf(
          events.filter((e) => e.key === 'index-escalation'),
          scenario === 'BUSINESS' ? 0 : 1
        )
      }
      assert.deepEqual(await db.from('whatsapp_orders').where('jid', jid), [])
      const cart = await readCart(jid)
      assert.equal(cart.items.length, 0)
    })
  }
  test('index delivery preserves the note, sends one initiative, then waits without repeating analysis', async ({
    assert,
  }) => {
    const jid = `index-delivery-${randomUUID()}@lid`
    await db.table('whatsapp_contacts').insert({
      jid,
      chat_note: 'ORIGINAL_NOTE',
      updated_at: new Date(),
    })
    const incoming = await message(jid, 'Halo bos')
    const run = (await beginGoalTurn(jid, incoming))!
    const settings = await readSettings(true)
    const context = await buildTurnContext(jid, [incoming])
    const before = await readCart(jid)
    const plan = planIndexReply(settings.skills, context.routing, 'Halo bos')!
    assert.isNotNull(plan)
    const parsed = readIndexReply(
      JSON.stringify({
        decision: 'reply',
        indices: [1],
        needsFullSkillContext: false,
        message: 'Halo bos.',
        initiative: 'Ada yang bisa dibantu?',
        reason: 'Sapaan.',
        goal: {
          objective: 'Membantu kebutuhan pelanggan',
          stage: 'discovery',
          status: 'waiting_answer',
          current_task: 'Memahami kebutuhan',
          waiting_for: 'Kebutuhan pelanggan',
          next_action: 'Bantu setelah kebutuhan disampaikan',
          follow_up: null,
        },
      }),
      plan,
      settings.skills
    )
    assert.isNotNull(parsed.decision)
    const decision = { ...parsed.decision!, cartVersion: context.cartVersion }
    const sent: string[] = []
    const socket = {
      readMessages: async () => {},
      sendPresenceUpdate: async () => {},
      sendMessage: async (_jid: string, payload: { text: string }) => {
        sent.push(payload.text)
        return { key: { id: randomUUID() } }
      },
    }
    await worker().deliverAiDecision(run, socket, settings, decision, [
      { remoteJid: jid, id: incoming, fromMe: false },
    ])
    assert.deepEqual(sent, ['Halo bos.', 'Ada yang bisa dibantu?'])
    assert.deepEqual(await readCart(jid), before)
    const contact = await db.from('whatsapp_contacts').where('jid', jid).first()
    assert.equal(contact.chat_note, 'ORIGINAL_NOTE')
    const saved = await readConversationGoal(jid)
    assert.equal(saved.status, 'waiting_answer')
    assert.isNull(saved.next_run_at)
    assert.isTrue(await alreadyAnalyzedMessage(jid, incoming))
    assert.isNull(await beginGoalTurn(jid, incoming))
    assert.deepEqual(await db.from('whatsapp_orders').where('jid', jid), [])
    assert.deepEqual(await db.from('whatsapp_customer_memory').where('jid', jid), [])
  })
  test('index response is invalidated if active state changes before delivery', async ({
    assert,
  }) => {
    const { jid, ack, run, settings } = await closedRoom()
    const context = await buildTurnContext(jid, [ack])
    const { levelDigest, levelPolicyHash } = await import('#services/conversation_levels')
    const decision = {
      decision: 'reply' as const,
      message: 'Halo bos.',
      reason: '',
      note: '',
      cartVersion: context.cartVersion,
      indexReply: {
        stateDigest: levelDigest(context.routing.activeState),
        policyHash: levelPolicyHash(settings.skills),
      },
    }
    const instance = worker()
    instance.customerTurnContext = async () => ({
      ...context,
      routing: {
        ...context.routing,
        activeState: { ...context.routing.activeState, cartItems: 1 },
      },
    })
    let error: any
    try {
      await instance.deliverAiDecision(run, {}, settings, decision, [{ id: ack }])
    } catch (e) {
      error = e
    }
    assert.equal(error?.detail.code, 'AI_PROCESS_INTERRUPTED')
    assert.isTrue(error?.detail.retryable)
    assert.lengthOf(await db.from('whatsapp_messages').where({ jid, direction: 'out' }), 1)
  })
  test('closed acknowledgment bypasses provider/MCP and consumes exactly one anchor without effects', async ({
    assert,
  }) => {
    const { jid, ack, run, settings } = await closedRoom()
    const context = await buildTurnContext(jid, [ack])
    const events: any[] = []
    const before = await readCart(jid)
    const usageBefore = await db.from('whatsapp_ai_usage').count('* as n').first()
    const decision = await createReply(
      {
        ...settings,
        codexBin: '/nonexistent/no-provider-allowed',
        claudeBin: '/nonexistent/no-provider-allowed',
        routingContext: context.routing,
        mcpConnections: [
          { slug: 'must-not-call', url: 'http://127.0.0.1:1', enabled: true, authenticated: true },
        ],
      },
      'iya bos',
      undefined,
      undefined,
      context.prompt,
      [],
      (event) => events.push(event)
    )
    assert.equal(decision.localResolution, 'closed_ack')
    assert.containSubset(events.at(-1).detail, {
      modelRuns: 0,
      toolCalls: 0,
      modelSkipped: true,
    })
    decision.cartVersion = context.cartVersion
    await worker().deliverAiDecision(run, {}, settings, decision, [{ id: ack }])
    assert.isTrue(await alreadyAnalyzedMessage(jid, ack))
    assert.isNull(await beginGoalTurn(jid, ack))
    assert.deepEqual(await readCart(jid), before)
    const sent = await db.from('whatsapp_messages').where({ jid, direction: 'out' })
    assert.lengthOf(sent, 1)
    assert.deepEqual(await db.from('whatsapp_orders').where('jid', jid), [])
    assert.deepEqual(await db.from('whatsapp_customer_memory').where('jid', jid), [])
    assert.deepEqual(await db.from('whatsapp_ai_usage').count('* as n').first(), usageBefore)
  })
  test('edited closing invalidates a local decision before delivery and stays recoverable', async ({
    assert,
  }) => {
    const { jid, sent, ack, run, settings } = await closedRoom()
    const context = await buildTurnContext(jid, [ack])
    const decision = await createReply({ ...settings, routingContext: context.routing }, 'iya bos')
    assert.equal(decision.localResolution, 'closed_ack')
    decision.cartVersion = context.cartVersion
    await db
      .from('whatsapp_messages')
      .where('message_id', sent)
      .update({ body: 'Ukuran S ya bos?' })
    await assert.rejects(
      () => worker().deliverAiDecision(run, {}, settings, decision, [{ id: ack }]),
      /State berubah/
    )
    const saved = await db.from('whatsapp_chat_goals').where('jid', jid).first()
    assert.notEqual(Number(saved.analyzed_anchor_id), run.anchor_id)
    assert.equal(JSON.parse(saved.recovery_json).phase, 'analysis')
  })
  test('deep memory is smaller initially, retrievable exactly, source-validated and scoped', async ({
    assert,
  }) => {
    const jid = 'level-memory-room@lid'
    await db.table('whatsapp_contacts').insert({ jid, updated_at: new Date() })
    for (let i = 0; i < 20; i++) {
      const id = await message(jid, `Fakta asli ${i}`)
      const source = await db.from('whatsapp_messages').where('message_id', id).first()
      await saveCustomerMemory(jid, source.id, [
        { key: `fact_${i}`, topic: 'recipient', value: `Nilai ${i}`, messageIds: [id] },
      ])
    }
    const current = await message(jid, 'harga jas')
    const context = await buildTurnContext(jid, [current])
    assert.equal(context.efficiency.memoryFacts, 12)
    assert.equal(context.efficiency.memoryDeferred, 8)
    assert.include(context.prompt, 'MEMORI TERTUNDA')
    const history = conversationHistoryTools(context.access)
    const result = await history.callTool({
      name: 'read_customer_memory',
      arguments: { indices: [1] },
    })
    const data = JSON.parse(result.content[0].text)
    assert.equal(data.values[0].fact.value, 'Nilai 0')
    assert.equal(data.values[0].fact.sources[0].text, 'Fakta asli 0')
    assert.isFalse(data.authority)
    await assert.rejects(() =>
      history.callTool({
        name: 'read_customer_memory',
        arguments: { indices: [1], jid: 'other@lid' },
      })
    )
    await assert.rejects(() =>
      history.callTool({
        name: 'read_customer_memory',
        arguments: { indices: Array.from({ length: 17 }, (_, i) => i + 1) },
      })
    )
    for (const indices of [[0], [21], [1.1], ['1'], []])
      await assert.rejects(() =>
        history.callTool({ name: 'read_customer_memory', arguments: { indices } })
      )
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: '' }, async () => {
      await initializeDatabase()
      const empty = await history.callTool({
        name: 'read_customer_memory',
        arguments: { indices: [1] },
      })
      assert.isNull(JSON.parse(empty.content[0].text).values[0].fact)
    })
    const future = await message(jid, 'Koreksi fakta setelah anchor')
    const futureRow = await db.from('whatsapp_messages').where('message_id', future).first()
    await saveCustomerMemory(jid, futureRow.id, [
      { key: 'fact_0', topic: 'recipient', value: 'NEW', messageIds: [future] },
    ])
    const afterUpdate = await history.callTool({
      name: 'read_customer_memory',
      arguments: { indices: [1] },
    })
    assert.isNull(JSON.parse(afterUpdate.content[0].text).values[0].fact)
    const second = await history.callTool({
      name: 'read_customer_memory',
      arguments: { indices: [2] },
    })
    const secondFact = JSON.parse(second.content[0].text).values[0].fact
    assert.isNotNull(secondFact)
    await db.from('whatsapp_messages').where('message_id', secondFact.sources[0].messageId).delete()
    const afterDelete = await history.callTool({
      name: 'read_customer_memory',
      arguments: { indices: [2] },
    })
    assert.isNull(JSON.parse(afterDelete.content[0].text).values[0].fact)
  })
})
