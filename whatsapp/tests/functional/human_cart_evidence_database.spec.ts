import { test } from '@japa/runner'
import { randomUUID, createHash } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import {
  readCart,
  saveCart,
  cancelCart,
  approveModel,
  checkoutFromBalance,
  recordBalanceRecap,
  tryConfirmedBalanceCheckout,
  reportPayment,
  confirmPayment,
} from '#services/cart_service'
import { applyAiCartIntent } from '#services/ai_cart_service'
import type { CartIntent } from '#services/cart_contract'
import { beginApprovalWait, pendingApprovalKind } from '#services/approval_wait_service'
import { ensureWaitNoticeSkill } from '#services/wait_notice_skill'
import { CheckoutConsentError } from '#services/checkout_consent_service'
import {
  checkoutContinuityContext,
  recordCheckoutContinuity,
  type CheckoutContinuity,
} from '#services/checkout_continuity'
import {
  cacheOrderGroups,
  orderRouting,
  saveOrderRouting,
  recoverOrderGroupQueue,
} from '#services/order_operations_service'
import { deliverNextOrderGroup } from '#services/order_group_delivery_service'
import { readSettings } from '#services/settings_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import { startTrace } from '#services/trace_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

test.group('Human package price and model consent', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Disposable database only.')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable DB only')
    await initializeDatabase()
    await ensureWaitNoticeSkill()
  })
  async function fixture() {
    const jid = `${randomUUID()}@lid`
    const ids = {
      photo: randomUUID(),
      quote: randomUUID(),
      accepted: randomUUID(),
      request: randomUUID(),
      approval: randomUUID(),
      latest: randomUUID(),
    }
    const rows = [
      {
        message_id: ids.photo,
        body: 'Model gini',
        media_type: 'image',
        media_url: '/whatsapp/media/fixture.jpg',
      },
      {
        message_id: ids.quote,
        body: 'Jas, Celana 705.000 bosku',
        direction: 'out',
        sender_type: 'cs',
        status: 'read',
      },
      { message_id: ids.accepted, body: 'Oke' },
      {
        message_id: ids.request,
        body: 'Model gini tapi warna navy bisa gak ya?',
        reply_to_message_id: ids.photo,
      },
      {
        message_id: ids.approval,
        body: 'iya bisa bos',
        direction: 'out',
        sender_type: 'cs',
        status: 'read',
        reply_to_message_id: ids.request,
      },
      { message_id: ids.latest, body: 'Yes aja' },
    ]
    const start = Math.floor(Date.now() / 1000) * 1000 - 20000
    for (const [index, row] of rows.entries())
      await db.table('whatsapp_messages').insert({
        jid,
        direction: 'in',
        sender_type: 'customer',
        status: 'received',
        created_at: new Date(start + index * 2000),
        ...row,
      })
    const details = {
      heightCm: null,
      weightKg: null,
      fit: '',
      color: 'Navy',
      material: '',
      lapel: 'Notch lapel dengan list',
      buttons: '2',
      notes: '',
      measurements: [],
      pending: [],
      sourceMessageIds: [ids.photo, ids.request],
    }
    const empty = await readCart(jid)
    const cart = await saveCart(jid, empty.version, {
      items: [
        {
          productId: `custom:${ids.photo}`,
          name: 'Custom notch — jas',
          image: '/whatsapp/media/fixture.jpg',
          size: 'S',
          quantity: 1,
          unitPrice: null,
          modelType: 'custom',
          referenceMessageId: ids.photo,
          measurements: {},
          productionDetails: details,
          note: '',
        },
        {
          productId: 'pants-navy',
          name: 'Pants Navy',
          image: 'https://example.com/pants.jpg',
          size: '30',
          quantity: 1,
          unitPrice: 220000,
          modelType: 'catalog',
          measurements: {},
          note: '',
        },
      ],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture address' },
      shipping: { service: 'YES', cost: 9000 },
      note: '',
    })
    const intent: CartIntent = {
      action: 'sync',
      confirmationMessageId: ids.latest,
      bundlePrice: { messageId: ids.quote, confirmationMessageId: ids.accepted, total: 705000 },
      items: cart.items.map((i, index) => ({
        ...i,
        measurements: [],
        unitPrice: index ? 220000 : 485000,
        priceMessageId: index ? '' : ids.quote,
        modelConsent: index
          ? null
          : { requestMessageId: ids.request, approvalMessageId: ids.approval },
      })),
      recipient: cart.recipient,
      shipping: cart.shipping,
      note: '',
      removeItemIds: [],
    }
    const evidence = {
      products: [
        {
          id: 'pants-navy',
          name: 'Pants Navy',
          imageUrls: ['https://example.com/pants.jpg'],
          sizes: [{ size_name: '30', price: 220000, stock: 10 }],
        },
      ],
      shipping: [{ service: 'YES', cost: 9000 }],
    }
    return { jid, ids, cart, intent, evidence }
  }

  async function catalogColorFixture() {
    const f = await fixture()
    await db.from('whatsapp_carts').where('jid', f.jid).update({ items_json: '[]' })
    await db.from('whatsapp_messages').where('message_id', f.ids.photo).update({
      body: 'Peak Suit Black harga 485.000 bos',
      direction: 'out',
      sender_type: 'ai',
      status: 'sent',
      media_type: null,
      media_url: null,
    })
    await db.from('whatsapp_messages').where('message_id', f.ids.quote).update({
      body: 'Ini kalo custom bisa gak ya?',
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      reply_to_message_id: f.ids.photo,
    })
    await db.from('whatsapp_messages').where('message_id', f.ids.accepted).update({
      body: 'Custom ukurannya saja atau modelnya juga mau diubah bos?',
      direction: 'out',
      sender_type: 'ai',
      status: 'sent',
    })
    await db.from('whatsapp_messages').where('message_id', f.ids.request).update({
      body: 'Warnanya jadi navy bisa jadi kombinasi kerahnya tetep hitam',
      reply_to_message_id: null,
    })
    await db.from('whatsapp_messages').where('message_id', f.ids.approval).update({
      reply_to_message_id: null,
    })
    f.intent.bundlePrice = null
    Object.assign(f.intent.items[0], {
      id: '',
      productId: 'peak-black',
      name: 'Peak Suit - Black',
      modelType: 'catalog',
      image: 'https://example.com/peak.jpg',
      referenceMessageId: '',
      priceMessageId: '',
      productionDetails: {
        ...f.intent.items[0].productionDetails,
        color: 'navy',
        lapel: 'hitam',
        buttons: '',
        sourceMessageIds: [f.ids.request],
      },
    })
    f.intent.items[1].id = ''
    f.evidence.products.push({
      id: 'peak-black',
      name: 'Peak Suit - Black',
      imageUrls: ['https://example.com/peak.jpg'],
      sizes: [{ size_name: 'S', price: 485000, stock: 10 }],
    })
    return f
  }

  test('catalog navy body and black lapel accepts the original CS consent without customer photo', async ({
    assert,
  }) => {
    const f = await catalogColorFixture()
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(saved.items[0].modelType, 'catalog')
    assert.equal(saved.items[0].modelApprovedBy, `cs-message:${f.ids.approval}`)
    assert.equal(saved.items[0].referenceMessageId, '')
    assert.equal(saved.items[0].image, 'https://example.com/peak.jpg')
    assert.equal(saved.items[0].unitPrice, 485000)
    assert.equal(saved.items[0].size, 'S')
    assert.equal(saved.items[1].size, '30')
    assert.isNull(pendingApprovalKind(saved.items))
    assert.isEmpty(saved.issues || [])
    const again = {
      ...f.intent,
      items: saved.items.map((i) => ({ ...i, measurements: [], modelConsent: null })),
    }
    const retained = await applyAiCartIntent(f.jid, saved.version, again, f.evidence)
    assert.deepEqual(retained.items[0].modelConsentEvidence, saved.items[0].modelConsentEvidence)
    assert.equal(retained.items[0].modelApproval, 'approved')
  })

  test('changing only sizing retains approved catalog colors without granting size or price approval', async ({
    assert,
  }) => {
    const f = await catalogColorFixture()
    let saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    const designConsent = saved.items[0].modelConsentEvidence
    const alteration = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: alteration,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      body: 'Dasar S, lengan jas dibuat 58 cm. Badan navy dan lapel hitam tetap.',
      created_at: new Date(),
    })
    const next: CartIntent = {
      ...f.intent,
      confirmationMessageId: alteration,
      shipping: { service: saved.shipping.service, cost: null },
      items: saved.items.map((item) => ({ ...item, measurements: [], modelConsent: null })),
    }
    next.items[0].size = 'custom'
    next.items[0].requestedSize = 'S'
    next.items[0].productionDetails!.measurements = [
      { name: 'Panjang lengan', value: 58, basis: 'garment' },
    ]
    next.items[0].productionDetails!.sourceMessageIds.push(alteration)
    saved = await applyAiCartIntent(f.jid, saved.version, next, f.evidence)
    assert.equal(saved.items[0].modelApproval, 'approved')
    assert.deepEqual(saved.items[0].modelConsentEvidence, designConsent)
    assert.equal(saved.items[0].approval, 'pending')
    assert.equal(pendingApprovalKind(saved.items), 'size')
    assert.isNull(saved.items[0].unitPrice)
    assert.equal(saved.items[0].productionDetails?.color, 'navy')
    assert.equal(saved.items[0].productionDetails?.lapel, 'hitam')
    assert.equal(saved.items[1].size, '30')

    const standard = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: standard,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      body: 'Jangan ubah panjang lengan. S standar saja, warna badan dan lapel tetap.',
      created_at: new Date(),
    })
    next.confirmationMessageId = standard
    next.items[0].size = 'S'
    next.items[0].requestedSize = ''
    next.items[0].unitPrice = 485000
    next.items[0].productionDetails!.measurements = []
    next.items[0].productionDetails!.sourceMessageIds.push(standard)
    saved = await applyAiCartIntent(f.jid, saved.version, next, f.evidence)
    assert.equal(saved.items[0].modelApproval, 'approved')
    assert.deepEqual(saved.items[0].modelConsentEvidence, designConsent)
    assert.equal(saved.items[0].approval, 'standard')
    assert.isNull(pendingApprovalKind(saved.items))
    assert.equal(saved.items[0].unitPrice, 485000)
    assert.equal(saved.items[0].productionDetails?.color, 'navy')
    assert.equal(saved.items[0].productionDetails?.lapel, 'hitam')
    assert.equal(saved.items[1].size, '30')
  })

  for (const variant of ['repaired', 'unavailable', 'ambiguous', 'invalid', 'stale'])
    test(`cart notes repair ${variant}: keeps pants, validates jacket and never loops`, async ({ assert }) => {
      const f = await catalogColorFixture()
      const pants = await applyAiCartIntent(f.jid, f.cart.version, { ...f.intent, items: [f.intent.items[1]] }, f.evidence)
      f.intent.items[1].id = pants.items[0].id
      f.intent.items[0].productionDetails!.notes = 'Peak Suit model dasar katalog akan dibuat dengan badan navy dan lapel hitam.'
      const writes: string[] = []
      let calls = 0
      const socket = { readMessages: async () => {}, sendPresenceUpdate: async () => {},
        sendMessage: async (_jid: string, value: any) => { writes.push(value.text); return { key: { id: randomUUID() } } } }
      const worker = Object.assign(Object.create(WhatsappListen.prototype), {
        socket, socketOpen: true, receivedPending: true, syncReadyAt: 0, ingesting: 0, stopping: false,
        canSendAiReply: async () => true,
        repairCartDesignNotes: async (_settings: any, input: any) => {
          calls++
          assert.lengthOf(input, 1)
          assert.equal(input[0].details.lapel, 'hitam')
          if (variant === 'unavailable') throw new Error('Fixture unavailable')
          if (variant === 'stale') {
            const next = randomUUID()
            await db.table('whatsapp_messages').insert({ jid: f.jid, message_id: next, direction: 'in', sender_type: 'customer', body: 'Ganti pilihan', status: 'received', created_at: new Date() })
            await beginGoalTurn(f.jid, next)
          }
          return { items: [{ index: 0, equivalent: variant !== 'ambiguous', notes: variant === 'invalid' ? 'badan hitam; lapel navy' : 'warna badan navy; lapel hitam' }] }
        },
      }) as any
      const decision: any = { decision: 'reply', message: 'Kecamatan tujuan pengirimannya mana bos?', initiative: '', images: [], reason: 'Melanjutkan pesanan', note: '',
        cartIntent: f.intent, cartVersion: pants.version, cartEvidence: f.evidence,
        goal: { objective: 'Melengkapi tujuan', status: 'waiting_answer', waiting_for: 'Kecamatan', next_action: 'Tunggu kecamatan', follow_up: null } }
      const run = await beginGoalTurn(f.jid, f.ids.latest)
      const trace = await startTrace(f.jid, {})
      await worker.deliverAiDecision(run, socket, await readSettings(), decision, [], false, trace)
      assert.equal(calls, 1)
      const saved = await readCart(f.jid)
      assert.equal(saved.items.length, variant === 'repaired' ? 2 : 1)
      assert.deepEqual(writes, variant === 'repaired' ? [decision.message] : [])
      if (variant === 'repaired') {
        const jacket = saved.items.find((i) => i.productId === 'peak-black')!
        assert.equal(jacket.modelApproval, 'approved')
        assert.equal(jacket.size, 'S')
        assert.equal(jacket.productionDetails?.color, 'navy')
        assert.equal(jacket.productionDetails?.lapel, 'hitam')
        assert.equal(saved.items.find((i) => i.productId === 'pants-navy')?.size, '30')
        assert.equal((await readConversationGoal(f.jid)).status, 'waiting_answer')
      }
    }).timeout(15000)

  test('catalog consent rejects unrelated products, unapproved details, wrong room and customer size confirmation', async ({
    assert,
  }) => {
    for (const variant of [
      'product',
      'color',
      'lapel',
      'swapped-lapel',
      'material',
      'material-from-color',
      'buttons-from-color',
      'missing-body-color',
      'missing-lapel-color',
      'ai',
      'customer',
      'room',
      'quote',
      'conditional',
    ]) {
      const f = await catalogColorFixture()
      if (variant === 'product')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.photo)
          .update({ body: 'Basic Suit Black harga 485.000 bos' })
      if (variant === 'color') f.intent.items[0].productionDetails!.color = 'merah'
      if (variant === 'lapel') f.intent.items[0].productionDetails!.lapel = 'putih'
      if (variant === 'swapped-lapel') f.intent.items[0].productionDetails!.lapel = 'navy'
      if (variant === 'material') f.intent.items[0].productionDetails!.material = 'wool'
      if (variant === 'material-from-color') f.intent.items[0].productionDetails!.material = 'navy'
      if (variant === 'buttons-from-color') f.intent.items[0].productionDetails!.buttons = 'hitam'
      if (variant === 'missing-body-color') f.intent.items[0].productionDetails!.color = ''
      if (variant === 'missing-lapel-color') f.intent.items[0].productionDetails!.lapel = ''
      if (variant === 'ai')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.approval)
          .update({ sender_type: 'ai' })
      if (variant === 'customer') f.intent.items[0].modelConsent!.approvalMessageId = f.ids.latest
      if (variant === 'room')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.approval)
          .update({ jid: `${randomUUID()}@lid` })
      if (variant === 'quote')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.approval)
          .update({ reply_to_message_id: f.ids.latest })
      if (variant === 'conditional')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.approval)
          .update({ body: 'Bisa kalau produksi setuju' })
      await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
      const unchanged = await readCart(f.jid)
      assert.equal(unchanged.version, f.cart.version)
    }
  })

  test('catalog color consent accepts equivalent production wording without requiring an exact customer quote', async ({
    assert,
  }) => {
    for (const notes of [
      'Custom warna badan jas navy dengan lapel tetap hitam.',
      'Badan jas menjadi navy; kerah berwarna black.',
      'Warna badan navy, warna kerah tetap hitam.',
      'Custom warna navy kombinasi kerah hitam sesuai persetujuan CS.',
    ]) {
      const f = await catalogColorFixture()
      f.intent.items[0].productionDetails!.notes = notes
      const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      assert.equal(saved.items[0].modelApproval, 'approved', notes)
      assert.equal(saved.items[0].productionDetails?.notes, notes)
      assert.isEmpty(saved.issues || [])
    }
  })

  test('color aliases reach saved cart consent while nearby shades and negations stay unapproved', async ({
    assert,
  }) => {
    for (const [customer, stored, accepted] of [
      ['ｂｗ', 'Broken White', true],
      ['putih gading', 'Ivory', true],
      ['abu-abu', 'Gray', true],
      ['biru dongker', 'Navy Blue', true],
      ['putih gading', 'BW', false],
      ['cream', 'BW', false],
      ['bukan BW', 'BW', false],
    ] as const) {
      const f = await catalogColorFixture()
      await db
        .from('whatsapp_messages')
        .where('message_id', f.ids.request)
        .update({ body: `Badan ${customer}, kerah hitam` })
      f.intent.items[0].productionDetails!.color = stored
      f.intent.items[0].productionDetails!.notes = `Badan ${stored}; lapel hitam`
      if (!accepted) {
        await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
        continue
      }
      const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      assert.equal(saved.items[0].productionDetails?.color, stored)
      assert.equal(saved.items[0].modelApproval, 'approved')
      assert.equal(saved.items[0].modelApprovedBy, `cs-message:${f.ids.approval}`)
      assert.equal(saved.items[0].productId, 'peak-black')
    }
  })

  test('equivalent-word handling does not approve conflicting or additional design instructions', async ({
    assert,
  }) => {
    for (const notes of [
      'Badan hitam dan lapel navy',
      'Badan navy dan lapel bukan hitam',
      'Badan navy dan lapel hitam satin',
      'Badan navy dan lapel hitam dengan bahan wool',
      'Badan navy dan lapel hitam dengan 2 kancing',
    ]) {
      const f = await catalogColorFixture()
      f.intent.items[0].productionDetails!.notes = notes
      await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
    }
  })

  test('verified catalog consent survives rephrased notes and field labels on a later turn', async ({
    assert,
  }) => {
    const f = await catalogColorFixture()
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    const next = {
      ...f.intent,
      items: saved.items.map((item) => ({ ...item, measurements: [], modelConsent: null })),
    }
    Object.assign(next.items[0].productionDetails!, {
      color: 'Badan jas navy',
      lapel: 'Kerah tetap black',
      notes: 'Custom warna badan navy dengan lapel hitam.',
    })
    const continued = await applyAiCartIntent(f.jid, saved.version, next, f.evidence)
    assert.equal(continued.items[0].modelApproval, 'approved')
    assert.equal(continued.items[0].modelConsentEvidence?.approvalMessageId, f.ids.approval)
    assert.isNull(pendingApprovalKind(continued.items))
    const changed = {
      ...next,
      items: continued.items.map((item) => ({ ...item, measurements: [], modelConsent: null })),
    }
    changed.items[0].productionDetails!.lapel = 'navy'
    changed.items[0].productionDetails!.notes = 'Badan navy dengan lapel navy'
    const unapproved = await applyAiCartIntent(f.jid, continued.version, changed, f.evidence)
    assert.notEqual(unapproved.items[0].modelApproval, 'approved')
  })

  test('material and buttons require their own explicit facts, while one design approval may cover them together', async ({
    assert,
  }) => {
    const f = await catalogColorFixture()
    const body = 'Badan navy, lapel hitam, bahan wool, kancing 2'
    await db.from('whatsapp_messages').where('message_id', f.ids.request).update({ body })
    await db
      .from('whatsapp_messages')
      .where('message_id', f.ids.approval)
      .update({ body: `Bisa bos, ${body}` })
    Object.assign(f.intent.items[0].productionDetails!, {
      material: 'wool',
      buttons: '2',
      notes: body,
    })
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(saved.items[0].modelApproval, 'approved')
    assert.equal(saved.items[0].productionDetails?.material, 'wool')
    assert.equal(saved.items[0].productionDetails?.buttons, '2')
    assert.equal(saved.paymentStatus, 'none')
  })

  test('catalog design consent does not approve custom measurements or survive changed design replay', async ({
    assert,
  }) => {
    const f = await catalogColorFixture()
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    f.intent.items[0].productionDetails!.lapel = 'navy'
    await assert.rejects(() => applyAiCartIntent(f.jid, saved.version, f.intent, f.evidence))
    const customSize = {
      ...f.intent,
      items: saved.items.map((i, index) => ({
        ...i,
        size: index ? i.size : 'custom',
        requestedSize: '',
        unitPrice: index ? i.unitPrice : null,
        measurements: index ? [] : [{ name: 'Lingkar dada', value: 96 }],
        modelConsent: null,
      })),
    }
    const resized = await applyAiCartIntent(f.jid, saved.version, customSize, f.evidence)
    assert.equal(resized.items[0].modelApproval, 'approved')
    assert.equal(resized.items[0].approval, 'pending')
    assert.isNull(resized.items[0].approvedBy)
    assert.isNull(resized.items[0].unitPrice)
  })

  test('explicit CS design restatement accepts the same intent but cannot approve changed colors or checkout', async ({
    assert,
  }) => {
    for (const [body, accepted] of [
      ['Bisa bos, badan navy dengan kerah hitam.', true],
      ['Boleh kak, navy untuk badan, hitam untuk kerah.', true],
      ['Bisa bos, badan hitam lapel navy.', false],
      ['Bisa bos, tapi lapel navy.', false],
      ['Bisa bos, sudah lunas.', false],
      ['Iya', false],
      ['Bisa kalau bahan ada', false],
    ] as const) {
      const f = await catalogColorFixture()
      await db.from('whatsapp_messages').where('message_id', f.ids.approval).update({ body })
      if (!accepted) {
        await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
        continue
      }
      const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      assert.equal(saved.items[0].modelApproval, 'approved')
      assert.equal(saved.paymentStatus, 'none')
      assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
    }
  })

  test('a short CS answer after another AI question needs the correct quote; explicit design confirmation is sufficient', async ({
    assert,
  }) => {
    for (const variant of ['unquoted', 'quoted', 'restated']) {
      const f = await catalogColorFixture()
      const question = await db.from('whatsapp_messages').where('message_id', f.ids.request).first()
      await db.table('whatsapp_messages').insert({
        jid: f.jid,
        message_id: randomUUID(),
        direction: 'out',
        sender_type: 'ai',
        status: 'sent',
        body: 'Size custom dan harga baru ini bisa bos?',
        created_at: new Date(new Date(question.created_at).getTime() + 1000),
      })
      await db
        .from('whatsapp_messages')
        .where('message_id', f.ids.approval)
        .update({
          reply_to_message_id: variant === 'quoted' ? f.ids.request : null,
          body: variant === 'restated' ? 'Bisa bos, badan navy lapel hitam' : 'iya bisa bos',
        })
      if (variant === 'unquoted') {
        await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
      } else {
        const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
        assert.equal(saved.items[0].modelApproval, 'approved')
      }
    }
  })

  test('705000 package computes 485000 custom component, approves only model, closes wait notice and totals 714000', async ({
    assert,
  }) => {
    const f = await fixture()
    const episode = await beginApprovalWait(f.jid, 'model')
    assert.isNotNull(episode)
    const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(cart.items[0].unitPrice, 485000)
    assert.equal(cart.items[0].modelApproval, 'approved')
    assert.equal(cart.items[0].modelApprovedBy, `cs-message:${f.ids.approval}`)
    assert.equal(cart.items[0].bundlePriceEvidence?.messageId, f.ids.quote)
    assert.equal(cart.items[0].modelConsentEvidence?.requestMessageId, f.ids.request)
    assert.equal(cart.subtotal, 705000)
    assert.equal(cart.total, 714000)
    assert.isTrue(cart.totalComplete)
    assert.isUndefined(cart.issues)
    assert.isNull(pendingApprovalKind(cart.items))
    assert.equal(cart.paymentStatus, 'none')
    const wait = await db.from('whatsapp_approval_wait_episodes').where('id', episode).firstOrFail()
    assert.equal(wait.status, 'cancelled')
    assert.isFalse(Boolean(wait.is_open))
    const reloaded = await readCart(f.jid)
    const next = {
      ...f.intent,
      bundlePrice: null,
      items: reloaded.items.map((i) => ({ ...i, measurements: [], modelConsent: null })),
      shipping: { service: 'REG', cost: 8000 },
    }
    const again = await applyAiCartIntent(f.jid, reloaded.version, next, {
      ...f.evidence,
      shipping: [{ service: 'REG', cost: 8000 }],
    })
    assert.equal(again.total, 713000)
    assert.equal(again.items[0].modelApproval, 'approved')
    assert.isNull(await beginApprovalWait(f.jid, 'model'))
  })

  test('new draft verifies the catalog component before deriving the custom price', async ({
    assert,
  }) => {
    const f = await fixture()
    await db.from('whatsapp_carts').where('jid', f.jid).update({ items_json: '[]' })
    f.intent.items.forEach((item) => {
      item.id = ''
    })
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(saved.items[0].unitPrice, 485000)
    assert.equal(saved.total, 714000)
    assert.equal(saved.items[0].modelApproval, 'approved')
  })
  test('model consent never approves custom body measurements', async ({ assert }) => {
    const f = await fixture()
    f.intent.items[0].size = 'custom'
    f.intent.items[0].measurements = [{ name: 'Lingkar dada', value: 96 }]
    const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.equal(saved.items[0].modelApproval, 'approved')
    assert.equal(saved.items[0].approval, 'pending')
    assert.isNull(saved.items[0].approvedBy)
    assert.equal(pendingApprovalKind(saved.items), 'size')
  })
  test('package cannot use AI/customer/failed quotes, another room, a request, or a total including shipping', async ({
    assert,
  }) => {
    for (const changes of [
      { sender_type: 'ai' },
      { direction: 'in' },
      { status: 'failed' },
      { jid: `${randomUUID()}@lid` },
      { body: 'Jas celana 705.000 boleh?' },
      { body: 'Jas celana 705.000 termasuk ongkir' },
      { body: 'Jas 485.000 celana 220.000' },
    ]) {
      const f = await fixture()
      await db.from('whatsapp_messages').where('message_id', f.ids.quote).update(changes)
      await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
      assert.equal((await readCart(f.jid)).version, f.cart.version)
    }
  })

  test('bare yes about another topic, conditional agreement, AI approval and wrong color cannot approve a model', async ({
    assert,
  }) => {
    for (const [target, changes] of [
      ['request', { body: 'Ongkir navy bisa gak?' }],
      ['request', { body: 'Model ini warna black bisa?' }],
      ['approval', { body: 'iya bisa kalau produksi setuju' }],
      ['approval', { body: 'iya' }],
      ['approval', { sender_type: 'ai' }],
      ['approval', { reply_to_message_id: randomUUID() }],
    ] as const) {
      const f = await fixture()
      await db.from('whatsapp_messages').where('message_id', f.ids[target]).update(changes)
      await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
      assert.equal((await readCart(f.jid)).items[0].modelApproval, 'pending')
    }
  })

  test('changed quantities/design or old cancelled-order evidence cannot reuse previous consent', async ({
    assert,
  }) => {
    for (const change of ['quantity', 'design', 'cancel']) {
      const f = await fixture()
      const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      const next = structuredClone(f.intent)
      next.items = cart.items.map((i, index) => ({ ...next.items[index], ...i, measurements: [] }))
      if (change === 'quantity') next.items[1].quantity = 2
      if (change === 'design') next.items[0].productionDetails!.buttons = '3'
      if (change === 'cancel') {
        await cancelCart(f.jid, cart.version, 'fixture-cs')
        next.items.forEach((i) => {
          i.id = ''
        })
      }
      const current = await readCart(f.jid)
      await assert.rejects(() => applyAiCartIntent(f.jid, current.version, next, f.evidence))
    }
  })

  test('missing custom price is an issue even without a proposed price, so an unverified total cannot be published', async ({
    assert,
  }) => {
    const f = await fixture()
    f.intent.bundlePrice = null
    f.intent.items[0].unitPrice = null
    f.intent.items[0].priceMessageId = ''
    const result = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.isFalse(result.totalComplete)
    assert.isAbove(result.issues!.length, 0)
    assert.equal(result.items[0].modelApproval, 'approved')
    assert.isNull(pendingApprovalKind(result.items))
  })
  test('catalog price patterns cannot authorize a custom price or custom size', async ({
    assert,
  }) => {
    for (const size of ['S', 'custom']) {
      const f = await fixture()
      f.intent.bundlePrice = null
      Object.assign(f.intent.items[0], {
        size,
        unitPrice: 535000,
        priceMessageId: '',
        modelConsent: null,
      })
      f.evidence.products.push(
        ...['navy', 'bw', 'black'].map((color) => ({
          id: `double-${color}`,
          name: `Tuxedo Double Breasted - ${color}`,
          imageUrls: ['https://example.com/double.jpg'],
          sizes: [{ size_name: 'S', price: 535000, stock: 3 }],
        }))
      )
      const saved = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      assert.isNull(saved.items[0].unitPrice)
      assert.equal(saved.items[0].priceMessageId, '')
      assert.isFalse(saved.totalComplete)
      assert.notEqual(saved.items[0].modelApproval, 'approved')
      if (size === 'custom') assert.equal(saved.items[0].approval, 'pending')
    }
  })

  test('a later operator rejection cannot be undone by replaying old CS evidence', async ({
    assert,
  }) => {
    const f = await fixture()
    const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    const rejected = await approveModel(
      f.jid,
      cart.version,
      cart.items[0].id,
      false,
      'Model perlu diubah',
      'fixture-cs'
    )
    await assert.rejects(() => applyAiCartIntent(f.jid, rejected.version, f.intent, f.evidence))
    assert.equal((await readCart(f.jid)).items[0].modelApproval, 'rejected')
  })
  test('missing catalog evidence or another reference image cannot back a package allocation', async ({
    assert,
  }) => {
    for (const variant of ['catalog', 'photo', 'acceptance']) {
      const f = await fixture()
      if (variant === 'catalog') {
        f.intent.items[1].unitPrice = 210000
        f.evidence.products = []
      }
      if (variant === 'photo') {
        const reference = await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.photo)
          .firstOrFail()
        await db.table('whatsapp_messages').insert({
          jid: f.jid,
          message_id: randomUUID(),
          direction: 'in',
          sender_type: 'customer',
          body: '',
          status: 'received',
          media_type: 'image',
          created_at: new Date(new Date(reference.created_at).getTime() + 1000),
        })
      }
      if (variant === 'acceptance')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.ids.accepted)
          .update({ body: 'Belum, saya pikir dulu' })
      await assert.rejects(() => applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence))
    }
  })
  test('history retains the scope of approval after an intervening edit removes current evidence', async ({
    assert,
  }) => {
    const f = await fixture()
    const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    const changed = await saveCart(
      f.jid,
      cart.version,
      {
        ...cart,
        items: cart.items.map((i, index) =>
          index ? i : { ...i, productionDetails: { ...i.productionDetails, buttons: '3' } }
        ),
      },
      'fixture-cs'
    )
    assert.equal(changed.items[0].modelApproval, 'pending')
    assert.isUndefined(changed.items[0].modelConsentEvidence)
    f.intent.items[0].productionDetails!.buttons = '3'
    await assert.rejects(() => applyAiCartIntent(f.jid, changed.version, f.intent, f.evidence))
    assert.equal((await readCart(f.jid)).items[0].modelApproval, 'pending')
  })

  test('display name and price explanation changes preserve approval, including legacy fingerprints', async ({
    assert,
  }) => {
    for (const legacy of [false, true]) {
      const f = await fixture()
      const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
      if (legacy) {
        const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
        const canonical = (v: unknown) =>
          String(v || '')
            .toLowerCase()
            .trim()
            .replace(/\s+/g, ' ')
        const model = (i: any) =>
          hash([
            i.productId,
            canonical(i.name),
            i.referenceMessageId,
            i.image,
            i.modelType,
            canonical(i.note),
            ...['color', 'material', 'lapel', 'buttons', 'notes'].map((key) =>
              canonical(i.productionDetails?.[key])
            ),
          ])
        cart.items[0].modelConsentEvidence!.fingerprint = model(cart.items[0])
        cart.items[0].bundlePriceEvidence!.fingerprint = hash(
          cart.items
            .map((i) => [
              i.productId,
              i.name,
              i.size,
              i.requestedSize || '',
              i.quantity,
              i.unitPrice,
              model(i),
            ])
            .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        )
        await db
          .from('whatsapp_carts')
          .where('jid', f.jid)
          .update({ items_json: JSON.stringify(cart.items) })
      }
      f.intent.items[0].name = 'Custom notch lapel list — jas navy dua kancing'
      f.intent.items[0].note = 'Harga komponen dari paket CS dikurangi celana terverifikasi.'
      const saved = await applyAiCartIntent(f.jid, cart.version, f.intent, f.evidence)
      assert.equal(saved.total, 714000)
      assert.equal(saved.items[0].modelApproval, 'approved')
      assert.isTrue(saved.items[0].bundlePriceEvidence!.fingerprint.startsWith('v2:'))
      assert.isTrue(saved.items[0].modelConsentEvidence!.fingerprint.startsWith('v2:'))
      assert.isUndefined(saved.issues)
    }
  })

  async function checkoutFixture(balance = 938000) {
    const f = await fixture()
    const cart = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    const recapId = randomUUID(),
      confirmationId = randomUUID()
    const body =
      'Rincian pesanannya, bos:\n\n1. Jas custom navy dua kancing - S\n2. Pants Navy - 30\n\nHarga jas + celana: Rp705.000\nPengiriman: YES\nOngkir: Rp9.000\n\nTotal: Rp714.000\n\nSudah benar bos?'
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: recapId,
      direction: 'out',
      sender_type: 'ai',
      status: 'read',
      body,
      created_at: new Date(),
    })
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: confirmationId,
      direction: 'in',
      sender_type: 'customer',
      status: 'received',
      body: 'Udah benar bos',
      reply_to_message_id: recapId,
      created_at: new Date(),
    })
    await db.table('whatsapp_customer_balance_entries').insert({
      jid: f.jid,
      order_id: 999999,
      payment_id: null,
      amount: balance,
      reason: 'overpayment',
      created_at: new Date(),
    })
    return { ...f, cart, recapId, confirmationId, body }
  }

  test('accepted recap creates paid order from 938000 credit, leaves 224000 and retries only once', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    const [first, retry] = await Promise.all(
      [1, 2].map(() => checkoutFromBalance(f.jid, f.cart.version, f.confirmationId, f.recapId))
    )
    assert.equal(first.id, retry.id)
    assert.equal(first.paid, 714000)
    assert.equal(first.balanceApplied, 714000)
    assert.equal(first.cashPaid, 0)
    assert.equal(first.balance, 0)
    const cart = await readCart(f.jid)
    assert.isEmpty(cart.items)
    assert.equal(cart.paymentQuote.availableBalance, 224000)
    assert.lengthOf(await db.from('whatsapp_orders').where('jid', f.jid), 1)
    assert.lengthOf(
      await db
        .from('whatsapp_customer_balance_entries')
        .where('jid', f.jid)
        .where('amount', '<', 0),
      1
    )
    assert.isEmpty(await db.from('whatsapp_order_payments').where('order_id', first.id))
    assert.exists(await db.from('whatsapp_order_operations').where('order_id', first.id).first())
  })

  test('sync after explicit recap acceptance settles automatically without another approval request', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    f.intent.confirmationMessageId = f.confirmationId
    f.intent.items[0].note = 'Harga jas dihitung dari harga paket yang disetujui CS.'
    const result = await applyAiCartIntent(f.jid, f.cart.version, f.intent, f.evidence)
    assert.exists(result.settledOrder)
    assert.equal(result.settledOrder!.balanceApplied, 714000)
    assert.equal(result.paymentQuote.availableBalance, 224000)
    assert.isEmpty(result.items)
  })

  test('pending approval, insufficient credit, different recap and unrelated agreement cannot spend', async ({
    assert,
  }) => {
    for (const variant of [
      'pending',
      'funds',
      'amount',
      'size',
      'question',
      'other-room',
      'version',
      'recipient-change',
      'newer-message',
    ]) {
      const f = await checkoutFixture(variant === 'funds' ? 700000 : 938000)
      if (variant === 'pending') {
        f.cart.items[0].modelApproval = 'pending'
        await db
          .from('whatsapp_carts')
          .where('jid', f.jid)
          .update({ items_json: JSON.stringify(f.cart.items) })
      }
      if (variant === 'amount' || variant === 'size')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.recapId)
          .update({
            body:
              variant === 'amount'
                ? f.body.replace('Total: Rp714.000', 'Total: Rp705.000')
                : f.body.replace(' - S', ' - XL'),
          })
      if (variant === 'question')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.confirmationId)
          .update({ body: 'Oke, oh iya saya ingin tau omsetmu berapa' })
      if (variant === 'other-room')
        await db
          .from('whatsapp_messages')
          .where('message_id', f.confirmationId)
          .update({ jid: `${randomUUID()}@lid` })
      if (variant === 'newer-message')
        await db.table('whatsapp_messages').insert({
          jid: f.jid,
          message_id: randomUUID(),
          direction: 'in',
          sender_type: 'customer',
          status: 'received',
          body: 'Batal dulu bos',
          created_at: new Date(),
        })
      if (variant === 'recipient-change') {
        await recordBalanceRecap(f.jid, f.cart.version, f.recapId, f.body)
        await db
          .from('whatsapp_carts')
          .where('jid', f.jid)
          .update({
            recipient_json: JSON.stringify({ ...f.cart.recipient, address: 'Different address' }),
          })
      }
      await assert.rejects(() =>
        checkoutFromBalance(
          f.jid,
          variant === 'version' ? randomUUID() : f.cart.version,
          f.confirmationId,
          f.recapId
        )
      )
      assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
      assert.isEmpty(
        await db
          .from('whatsapp_customer_balance_entries')
          .where('jid', f.jid)
          .where('amount', '<', 0)
      )
    }
  })

  test('older unpaid orders reserve credit; no draft checkout or extra transfer verification', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    await db.table('whatsapp_orders').insert({
      jid: f.jid,
      order_number: `TEST-${randomUUID().slice(0, 8)}`,
      snapshot_json: JSON.stringify(f.cart),
      total: 300000,
      paid: 0,
      status: 'active',
      created_at: new Date(),
      updated_at: new Date(),
    })
    await assert.rejects(() =>
      checkoutFromBalance(f.jid, f.cart.version, f.confirmationId, f.recapId)
    )
    assert.equal((await readCart(f.jid)).paymentQuote.amountDue, 76000)
    assert.isEmpty(
      await db.from('whatsapp_customer_balance_entries').where('jid', f.jid).where('amount', '<', 0)
    )
  })

  async function chat(jid: string, body: string, direction = 'in') {
    const message_id = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id,
      body,
      direction,
      sender_type: direction === 'in' ? 'customer' : 'ai',
      status: direction === 'in' ? 'received' : 'sent',
      created_at: new Date(),
    })
    return message_id
  }

  async function vestCheckoutFixture(balance = 224000) {
    const jid = `${randomUUID()}@lid`
    const empty = await readCart(jid)
    const cart = await saveCart(jid, empty.version, {
      items: [
        {
          productId: 'vest-black',
          name: 'Vest Black',
          image: 'https://example.com/vest-black.jpg',
          size: 'S',
          quantity: 1,
          unitPrice: 175000,
          modelType: 'catalog',
          measurements: {},
          note: '',
        },
      ],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture address' },
      shipping: { service: 'YES', cost: 9000 },
      note: '',
    })
    const body =
      'Ini detail ordernya ya bos:\n1. Vest Black - S, Rp175.000\nPenerima: Fixture\nNo. telp: 628000000001\nAlamat: Fixture address\nPengiriman: YES\nOngkir: Rp9.000\nEstimasi: 1 hari\nHitungannya:\n- Vest Black: Rp175.000\n- Ongkir: Rp9.000\nTotal: Rp184.000\nKelebihan pembayaran sebelumnya yang akan dipakai: Rp184.000\nSisa pembayaran: Rp0\nMasih ada lebihan pembayaran: Rp40.000\nUdah bener bos?'
    const recapId = await chat(jid, body, 'out')
    await db.table('whatsapp_customer_balance_entries').insert({
      jid,
      order_id: 999999,
      payment_id: null,
      amount: balance,
      reason: 'overpayment',
      created_at: new Date(),
    })
    return { jid, cart, recapId, body }
  }

  test('vest Oke → Gimana → quoted Udah bener → Gimana settles exact recap even if AI picks the nudge', async ({
    assert,
  }) => {
    const f = await vestCheckoutFixture()
    await chat(f.jid, 'Oke')
    await chat(f.jid, 'Gimana')
    const accepted = await chat(f.jid, 'Udah bener')
    await db
      .from('whatsapp_messages')
      .where('message_id', accepted)
      .update({ reply_to_message_id: f.recapId })
    const nudge = await chat(f.jid, 'Gimana')
    const order = await checkoutFromBalance(f.jid, f.cart.version, nudge, f.recapId)
    assert.equal(order.total, 184000)
    assert.equal(order.paid, 184000)
    assert.equal(order.balanceApplied, 184000)
    assert.equal(order.cart.checkoutEvidence.confirmationMessageId, accepted)
    assert.equal(order.cart.checkoutEvidence.recapMessageId, f.recapId)
    const latest = await readCart(f.jid)
    assert.equal(latest.paymentQuote.availableBalance, 40000)
    assert.isEmpty(latest.items)
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, latest.version))
    assert.lengthOf(await db.from('whatsapp_orders').where('jid', f.jid), 1)
    assert.lengthOf(
      await db
        .from('whatsapp_customer_balance_entries')
        .where('jid', f.jid)
        .where('amount', '<', 0),
      1
    )
  })

  test('unquoted Oke survives later status nudges without needing a second approval', async ({
    assert,
  }) => {
    const f = await vestCheckoutFixture()
    const accepted = await chat(f.jid, 'Oke')
    await chat(f.jid, 'Gimana bos?')
    await chat(f.jid, 'Bagaimana kelanjutannya?')
    const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    assert.exists(result)
    assert.equal(result!.settledOrder.cart.checkoutEvidence.confirmationMessageId, accepted)
    assert.equal(result!.paymentQuote.availableBalance, 40000)
  })

  test('a status nudge alone never authorizes spending the balance', async ({ assert }) => {
    const f = await vestCheckoutFixture()
    const nudge = await chat(f.jid, 'Gimana')
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version))
    await assert.rejects(() => checkoutFromBalance(f.jid, f.cart.version, nudge, f.recapId))
    assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
    assert.equal((await readCart(f.jid)).paymentQuote.availableBalance, 224000)
  })

  async function semanticReview(
    f: Awaited<ReturnType<typeof vestCheckoutFixture>>,
    messageIds: string[]
  ): Promise<CheckoutContinuity> {
    const rows = await db.from('whatsapp_messages').where('jid', f.jid)
    const context = checkoutContinuityContext(f.cart, rows)!
    return {
      fingerprint: context.fingerprint,
      recapMessageId: f.recapId,
      messages: context.messages
        .filter((m) => messageIds.includes(m.messageId))
        .map(({ messageId, digest }) => ({
          messageId,
          digest,
          meaning: 'status_followup' as const,
        })),
    }
  }

  test('semantic follow-ups preserve established consent across varied wording without another AI request', async ({
    assert,
  }) => {
    const f = await vestCheckoutFixture()
    const accepted = await chat(f.jid, 'Oke')
    const a = await chat(f.jid, 'Ada perkembangan, kak?')
    const b = await chat(f.jid, 'Persis seperti yang disampaikan tadi, bosku')
    const review = await semanticReview(f, [a, b])
    review.messages[1].meaning = 'acknowledgment'
    assert.equal(await recordCheckoutContinuity(f.cart, review), 2)
    const order = await checkoutFromBalance(f.jid, f.cart.version, b, f.recapId)
    assert.equal(order.cart.checkoutEvidence.confirmationMessageId, accepted)
    assert.equal(order.paid, 184000)
    assert.equal((await readCart(f.jid)).paymentQuote.availableBalance, 40000)
    assert.lengthOf(await db.from('whatsapp_orders').where('jid', f.jid), 1)
  })

  test('semantic review never supplies initial consent or trusts altered, foreign, ambiguous or changed evidence', async ({
    assert,
  }) => {
    for (const variant of [
      'no-consent',
      'change',
      'amount',
      'forged',
      'wrong-room',
      'unclear',
      'negative',
      'other-topic',
      'edited',
    ]) {
      const f = await vestCheckoutFixture()
      if (variant !== 'no-consent') await chat(f.jid, 'Oke')
      const body =
        variant === 'change'
          ? 'Ganti alamat ya'
          : variant === 'amount'
            ? 'Diskon 5000 ya'
            : 'Ada perkembangan, kak?'
      const messageId = await chat(f.jid, body)
      if (variant === 'other-topic')
        await db
          .from('whatsapp_messages')
          .where('message_id', messageId)
          .update({ reply_to_message_id: randomUUID() })
      const review: CheckoutContinuity = await semanticReview(f, [messageId])
      if (variant === 'forged') review.messages[0].digest = 'a'.repeat(64)
      if (variant === 'wrong-room')
        await db
          .from('whatsapp_messages')
          .where('message_id', messageId)
          .update({ jid: `${randomUUID()}@lid` })
      if (variant === 'unclear') review.messages[0].meaning = 'unclear'
      if (variant === 'negative') review.messages[0].meaning = 'order_change'
      await recordCheckoutContinuity(f.cart, review)
      if (variant === 'wrong-room')
        await db.from('whatsapp_messages').where('message_id', messageId).update({ jid: f.jid })
      if (variant === 'edited')
        await db
          .from('whatsapp_messages')
          .where('message_id', messageId)
          .update({ body: 'Batal dulu ya' })
      assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version), variant)
      assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid), variant)
      assert.equal((await readCart(f.jid)).paymentQuote.availableBalance, 224000)
    }
  })

  test('semantic continuity is scoped to unchanged cart and cannot survive a recipient edit', async ({
    assert,
  }) => {
    const f = await vestCheckoutFixture(100000)
    await chat(f.jid, 'Oke')
    const messageId = await chat(f.jid, 'Ada perkembangan, kak?')
    const review = await semanticReview(f, [messageId])
    await recordCheckoutContinuity(f.cart, review)
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version))
    const changed = await saveCart(
      f.jid,
      f.cart.version,
      { ...f.cart, recipient: { ...f.cart.recipient, address: 'Changed address' } },
      'fixture'
    )
    assert.equal(await recordCheckoutContinuity(changed, review), 0)
    await db.table('whatsapp_customer_balance_entries').insert({
      jid: f.jid,
      order_id: 999999,
      payment_id: null,
      amount: 124000,
      reason: 'overpayment',
      created_at: new Date(),
    })
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, changed.version))
    assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
  })

  test('persisted colloquial consent survives status turns, but not changes or cancellation', async ({
    assert,
  }) => {
    for (const change of [
      '',
      'Gimana kalau diganti M?',
      'Gimana? Jangan diproses dulu',
      'Udah bener tapi alamat ganti',
    ]) {
      const f = await vestCheckoutFixture(100000)
      await chat(f.jid, 'Udah bener')
      assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version))
      assert.lengthOf(
        await db.from('whatsapp_cart_events').where({ jid: f.jid, action: 'checkout_accepted' }),
        1
      )
      await chat(f.jid, 'Gimana')
      if (change) await chat(f.jid, change)
      await db.table('whatsapp_customer_balance_entries').insert({
        jid: f.jid,
        order_id: 999999,
        payment_id: null,
        amount: 124000,
        reason: 'overpayment',
        created_at: new Date(),
      })
      const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
      if (change) {
        assert.isNull(result, change)
        assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
        assert.equal((await readCart(f.jid)).paymentQuote.availableBalance, 224000)
      } else {
        assert.equal(result!.settledOrder.paid, 184000)
        assert.equal(result!.paymentQuote.availableBalance, 40000)
      }
    }
  })

  test('payment explanation → Oke siap → Kapan di kirim → Iya creates an order without an AI cart action', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    await db.from('whatsapp_messages').where('message_id', f.confirmationId).update({
      body: 'Jadi pembayaran sama kah ke rekening sbelumnya?',
      reply_to_message_id: null,
    })
    await chat(
      f.jid,
      'Iya bos, rekeningnya tetap BRI. Tapi untuk pesanan ini gak perlu transfer lagi. Kelebihan pembayaran sebelumnya yang dipakai Rp714.000, jadi sisa tagihannya Rp0.',
      'out'
    )
    const accepted = await chat(f.jid, 'Oke siap')
    await chat(f.jid, 'Kapan di kirim')
    await chat(
      f.jid,
      'Estimasi siap dikirim 7–14 hari kerja setelah pembayaran terverifikasi.',
      'out'
    )
    await chat(f.jid, 'Iya')
    const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    assert.exists(result)
    assert.equal(result!.settledOrder.paid, 714000)
    assert.equal(result!.paymentQuote.availableBalance, 224000)
    assert.equal(result!.settledOrder.cart.checkoutEvidence.confirmationMessageId, accepted)
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, result!.version))
    assert.lengthOf(await db.from('whatsapp_orders').where('jid', f.jid), 1)
    assert.lengthOf(
      await db.from('whatsapp_cart_events').where({ jid: f.jid, action: 'checkout_accepted' }),
      1
    )
  })

  test('persisted consent survives a later turn/restart and sufficient credit, without accepting a new recap', async ({
    assert,
  }) => {
    const f = await checkoutFixture(700000)
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version))
    const event = await db
      .from('whatsapp_cart_events')
      .where({ jid: f.jid, action: 'checkout_accepted' })
      .firstOrFail()
    assert.equal(JSON.parse(event.summary_json).confirmationMessageId, f.confirmationId)
    await chat(f.jid, 'Kapan dikirim bos?')
    await db.table('whatsapp_customer_balance_entries').insert({
      jid: f.jid,
      order_id: 999999,
      payment_id: null,
      amount: 238000,
      reason: 'overpayment',
      created_at: new Date(),
    })
    const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    assert.equal(result!.settledOrder.balanceApplied, 714000)
    assert.equal(result!.paymentQuote.availableBalance, 224000)
  })

  test('follow-ups never authorize changes or replacement of an accepted cart', async ({
    assert,
  }) => {
    for (const body of [
      'Batal dulu bos',
      'Ganti ukuran XL',
      'Alamatnya ganti ya',
      'Tambah celana 2 pcs',
      'Kapan dikirim? tapi ganti warna hitam',
      'Jangan diproses dulu',
      'Ada model lainnya?',
    ]) {
      const f = await checkoutFixture()
      await chat(f.jid, body)
      assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version), body)
      assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
    }
    const f = await checkoutFixture(700000)
    await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    const changed = await saveCart(
      f.jid,
      f.cart.version,
      { ...f.cart, recipient: { ...f.cart.recipient, address: 'New address' } },
      'fixture'
    )
    await db.table('whatsapp_customer_balance_entries').insert({
      jid: f.jid,
      order_id: 999999,
      payment_id: null,
      amount: 238000,
      reason: 'overpayment',
      created_at: new Date(),
    })
    assert.isNull(await tryConfirmedBalanceCheckout(f.jid, changed.version))
  })

  test('payment explanation alone or an unrelated Oke siap cannot authorize an order', async ({
    assert,
  }) => {
    for (const missing of ['recap', 'context']) {
      const f = await checkoutFixture()
      await db
        .from('whatsapp_messages')
        .where('message_id', f.confirmationId)
        .update({ body: 'Oke siap', reply_to_message_id: null })
      await db
        .from('whatsapp_messages')
        .where('message_id', f.recapId)
        .update({
          body:
            missing === 'recap'
              ? 'Tidak perlu transfer lagi, saldo yang dipakai Rp714.000 dan sisa tagihannya Rp0.'
              : 'Bisa dibantu hal lain bos?',
        })
      assert.isNull(await tryConfirmedBalanceCheckout(f.jid, f.cart.version))
      assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
    }
  })
  test('wrong AI evidence falls back to verified customer consent and records the actual IDs', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    const intent: CartIntent = {
      ...f.intent,
      action: 'checkout_balance',
      bundlePrice: null,
      confirmationMessageId: randomUUID(),
      recapMessageId: randomUUID(),
    }
    const result = await applyAiCartIntent(f.jid, f.cart.version, intent, f.evidence)
    assert.exists(result.settledOrder)
    assert.equal(result.settledOrder!.cart.checkoutEvidence.confirmationMessageId, f.confirmationId)
    assert.equal(result.settledOrder!.cart.checkoutEvidence.recapMessageId, f.recapId)
    const retry = await checkoutFromBalance(f.jid, f.cart.version, f.confirmationId, f.recapId)
    assert.equal(retry.id, result.settledOrder!.id)
    assert.lengthOf(await db.from('whatsapp_orders').where('jid', f.jid), 1)
  })

  test('failed consent gives specific stage, reason and blocking message without spending', async ({
    assert,
  }) => {
    const f = await checkoutFixture()
    const blocker = await chat(f.jid, 'Ganti ukuran XL')
    try {
      await checkoutFromBalance(f.jid, f.cart.version, f.confirmationId, f.recapId)
      assert.fail('Must pause checkout')
    } catch (error) {
      assert.instanceOf(error, CheckoutConsentError)
      const detail = (error as CheckoutConsentError).detail
      assert.equal(detail.stage, 'checkout')
      assert.equal(detail.code, 'CHECKOUT_CONFIRMATION_REQUIRED')
      assert.isFalse(detail.balanceSpent)
      assert.equal(detail.issues[0].code, 'CUSTOMER_MESSAGE_NEEDS_REVIEW')
      assert.equal(detail.issues[0].blockingMessageId, blocker)
      assert.notInclude(JSON.stringify(detail), 'Ganti ukuran XL')
    }
    assert.isEmpty(await db.from('whatsapp_orders').where('jid', f.jid))
    assert.equal((await readCart(f.jid)).paymentQuote.availableBalance, 938000)
  })

  async function configureGroup(groupJid: string) {
    await cacheOrderGroups([{ id: groupJid, subject: 'Fixture production' }])
    const routing = await orderRouting()
    await saveOrderRouting({ ...routing, groupJid, paymentTrigger: 'fully_paid' })
  }

  test('balance-paid order queues production summary and images once, without recipient address or phone', async ({
    assert,
  }) => {
    const groupJid = '120363111222333@g.us'
    await configureGroup(groupJid)
    const f = await checkoutFixture()
    const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    const orderId = result!.settledOrder.id
    assert.isEmpty(await db.from('whatsapp_order_payments').where('order_id', orderId))
    const job = await db.from('whatsapp_order_group_jobs').where('order_id', orderId).firstOrFail()
    assert.equal(job.group_jid, groupJid)
    assert.equal(job.status, 'queued')
    const parts = await db
      .from('whatsapp_order_group_parts')
      .where('order_id', orderId)
      .orderBy('part_index')
    assert.lengthOf(parts, 3)
    const payload = parts.map((part) => JSON.parse(part.content_json))
    assert.include(payload[0].text, f.cart.recipient.name)
    assert.include(payload[0].text, 'Lunas terverifikasi')
    assert.include(payload[0].text, 'Size: S')
    assert.include(payload[0].text, 'Kancing: 2')
    assert.notInclude(JSON.stringify(payload), f.cart.recipient.address)
    assert.notInclude(JSON.stringify(payload), f.cart.recipient.phone)
    const sent: string[] = []
    for (let i = 0; i < parts.length; i++) {
      assert.isTrue(
        await deliverNextOrderGroup(
          {
            validateGroup: async (jid) => {
              assert.equal(jid, groupJid)
            },
            send: async (_jid, _payload, id) => {
              sent.push(id)
              return id
            },
          },
          async () => Buffer.from('fixture')
        )
      )
    }
    assert.lengthOf(sent, 3)
    assert.equal(new Set(sent).size, 3)
    assert.equal(
      (await db.from('whatsapp_order_group_jobs').where('order_id', orderId).firstOrFail()).status,
      'sent'
    )
    await recoverOrderGroupQueue()
    assert.isFalse(
      await deliverNextOrderGroup({
        validateGroup: async () => {},
        send: async () => {
          throw new Error('Must not resend')
        },
      })
    )
  })

  test('previously missed group job is recovered once; paid field without evidence cannot enqueue', async ({
    assert,
  }) => {
    const groupJid = '120363111222334@g.us'
    await configureGroup(groupJid)
    await db.from('whatsapp_order_groups').where('jid', groupJid).update({ available: false })
    const f = await checkoutFixture()
    const result = await tryConfirmedBalanceCheckout(f.jid, f.cart.version)
    const id = result!.settledOrder.id
    assert.isNull(await db.from('whatsapp_order_group_jobs').where('order_id', id).first())
    assert.equal(await recoverOrderGroupQueue(), 0)
    await cacheOrderGroups([{ id: groupJid, subject: 'Fixture production' }])
    const recovered = await Promise.all([recoverOrderGroupQueue(), recoverOrderGroupQueue()])
    assert.equal(
      recovered.reduce((sum, count) => sum + count, 0),
      1
    )
    assert.lengthOf(await db.from('whatsapp_order_group_jobs').where('order_id', id), 1)
    const source = await db.from('whatsapp_orders').where('id', id).firstOrFail()
    const operations = await db
      .from('whatsapp_order_operations')
      .where('order_id', id)
      .firstOrFail()
    const { id: _id, ...fields } = source
    const [fakeId] = await db
      .table('whatsapp_orders')
      .insert({ ...fields, order_number: `TEST-${randomUUID().slice(0, 8)}` })
    await db.table('whatsapp_order_operations').insert({ ...operations, order_id: fakeId })
    await recoverOrderGroupQueue()
    assert.isNull(await db.from('whatsapp_order_group_jobs').where('order_id', fakeId).first())
    // Uncertain sends remain operator-reviewed, never blindly repeated by recovery.
    await db.from('whatsapp_order_group_jobs').where('order_id', id).update({ status: 'uncertain' })
    assert.equal(await recoverOrderGroupQueue(), 0)
    assert.equal(
      (await db.from('whatsapp_order_group_jobs').where('order_id', id).firstOrFail()).status,
      'uncertain'
    )
  })
  test('mixed balance and cash queues the final paid snapshot, not an intermediate DP', async ({
    assert,
  }) => {
    const groupJid = '120363111222335@g.us'
    await configureGroup(groupJid)
    const routing = await orderRouting()
    await saveOrderRouting({ ...routing, groupJid, paymentTrigger: 'first_payment' })
    const f = await checkoutFixture(100000)
    const cart = await reportPayment(f.jid, f.cart.version, undefined, 'owner')
    const [methodId] = await db.table('whatsapp_payment_methods').insert({
      name: 'Fixture bank',
      destination: '000000',
      account_name: 'Fixture',
      enabled: true,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const order = await confirmPayment(
      f.jid,
      {
        version: cart.version,
        requestKey: randomUUID(),
        reference: randomUUID(),
        amount: 614000,
        methodId,
        verified: true,
      },
      'fixture-human'
    )
    assert.equal(order.paid, 714000)
    assert.equal(order.balanceApplied, 100000)
    const job = await db.from('whatsapp_order_group_jobs').where('order_id', order.id).firstOrFail()
    assert.equal(JSON.parse(job.snapshot_json).payment, 'Lunas terverifikasi')
    assert.lengthOf(await db.from('whatsapp_order_group_jobs').where('order_id', order.id), 1)
  })
})
