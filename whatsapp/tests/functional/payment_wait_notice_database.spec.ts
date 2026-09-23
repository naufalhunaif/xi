import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import {
  readCart,
  saveCart,
  reportPayment,
  approveCustom,
  approveModel,
  cancelCart,
} from '#services/cart_service'
import {
  ensureWaitNoticeSkill,
  readWaitNoticePolicy,
  WAIT_NOTICE_SKILL,
  WAIT_NOTICE_ONE_MINUTE_REVISION,
} from '#services/wait_notice_skill'
import {
  beginApprovalWait,
  deliverApprovalWaitNotice,
  dueApprovalWaitNotices,
} from '#services/approval_wait_service'
import {
  duePaymentWaitNotices,
  deliverPaymentWaitNotice,
} from '#services/payment_wait_notice_service'

test.group('Isolated one-time payment waiting notices', (group) => {
  group.each.skip(process.env.WAIT_NOTICES_DB_TEST !== '1', 'Disposable fixture database only.')
  group.setup(async () => {
    if (process.env.WAIT_NOTICES_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable fixture database only.')
    await initializeDatabase()
    await ensureWaitNoticeSkill()
    await db.table('whatsapp_settings').insert({ id: 1, ai_enabled: true, updated_at: new Date() })
  })
  async function fixture() {
    const jid = `${randomUUID()}@lid`
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    const empty = await readCart(jid)
    const saved = await saveCart(jid, empty.version, {
      items: [
        {
          productId: 'fixture',
          name: 'Suit',
          image: 'https://example.com/fixture.jpg',
          size: 'M',
          quantity: 1,
          unitPrice: 100,
          measurements: {},
          note: '',
        },
      ],
      recipient: { name: 'Fixture', phone: '628000000001', address: 'Fixture' },
      shipping: { service: 'REG', cost: 10 },
      note: '',
    })
    const proof = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: proof,
      direction: 'in',
      sender_type: 'customer',
      body: 'Sudah transfer',
      status: 'received',
      created_at: new Date(),
    })
    await db
      .table('whatsapp_contacts')
      .insert({ jid, name: 'Fixture', handling_mode: 'cs', updated_at: new Date() })
    const cart = await reportPayment(jid, saved.version, proof, 'ai')
    const notice = await db.from('whatsapp_payment_wait_notices').where('jid', jid).firstOrFail()
    return { jid, cart, notice, proof }
  }
  const due = (id: string) =>
    db
      .from('whatsapp_payment_wait_notices')
      .where('id', id)
      .update({ due_at: new Date(Date.now() - 1000) })
  test('waits 1 minute, repeated reports do not restart it, only one concurrent worker can send', async ({
    assert,
  }) => {
    const f = await fixture()
    const policy = await readWaitNoticePolicy()
    assert.equal(policy?.delay_seconds, 60)
    assert.equal(
      new Date(f.notice.due_at).getTime() - new Date(f.notice.created_at).getTime(),
      60000
    )
    let calls = 0
    const send = async (
      _notice: any,
      allowed: () => Promise<boolean>,
      reserve: (id: string) => Promise<boolean>
    ) => {
      assert.isTrue(await allowed())
      assert.equal(_notice.text, policy?.payment.text)
      if (!(await reserve('fixture-outgoing'))) return null
      calls++
      return 'fixture-outgoing'
    }
    assert.isFalse(await deliverPaymentWaitNotice(f.notice.id, send))
    await reportPayment(f.jid, f.cart.version, f.proof, 'ai')
    const all = await db.from('whatsapp_payment_wait_notices').where('jid', f.jid)
    assert.lengthOf(all, 1)
    await due(f.notice.id)
    await Promise.all([
      deliverPaymentWaitNotice(f.notice.id, send),
      deliverPaymentWaitNotice(f.notice.id, send),
    ])
    assert.equal(calls, 1)
    assert.isFalse(await deliverPaymentWaitNotice(f.notice.id, send))
    const contact = await db.from('whatsapp_contacts').where('jid', f.jid).firstOrFail()
    const cart = await readCart(f.jid)
    assert.equal(contact.handling_mode, 'cs')
    assert.equal(cart.paymentStatus, 'reported')
  })
  test('does not interrupt human/AI replies, new input, completed payment, excluded contacts or AI off', async ({
    assert,
  }) => {
    for (const change of ['cs', 'ai', 'in', 'paid', 'excluded', 'off', 'handled', 'expired']) {
      const f = await fixture()
      await due(f.notice.id)
      if (['cs', 'ai', 'in'].includes(change))
        await db.table('whatsapp_messages').insert({
          jid: f.jid,
          message_id: randomUUID(),
          direction: change === 'in' ? 'in' : 'out',
          sender_type: change === 'in' ? 'customer' : change,
          status: change === 'cs' ? 'queued' : 'sent',
          body: 'Fixture',
          created_at: new Date(),
        })
      if (change === 'paid')
        await db.from('whatsapp_carts').where('jid', f.jid).update({ payment_status: 'none' })
      if (change === 'excluded')
        await db.from('whatsapp_contacts').where('jid', f.jid).update({ ai_excluded: true })
      if (change === 'handled')
        await db.from('whatsapp_contacts').where('jid', f.jid).update({ handling_mode: 'ai' })
      if (change === 'off')
        await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
      if (change === 'expired')
        await db
          .from('whatsapp_payment_wait_notices')
          .where('id', f.notice.id)
          .update({ due_at: new Date(Date.now() - 20 * 60_000) })
      let calls = 0
      assert.isFalse(
        await deliverPaymentWaitNotice(f.notice.id, async () => {
          calls++
          return 'unexpected'
        })
      )
      assert.equal(calls, 0, change)
    }
  })
  test('rechecks after preparation and never retries an uncertain transport after restart', async ({
    assert,
  }) => {
    const changed = await fixture()
    await due(changed.notice.id)
    assert.isFalse(
      await deliverPaymentWaitNotice(changed.notice.id, async (_notice, _allowed, reserve) => {
        await db.from('whatsapp_carts').where('jid', changed.jid).update({ payment_status: 'none' })
        assert.isFalse(await reserve('cancelled'))
        return null
      })
    )
    const f = await fixture()
    await due(f.notice.id)
    let attempts = 0
    const send = async (_notice: any, _allowed: any, reserve: (id: string) => Promise<boolean>) => {
      if (await reserve('uncertain')) attempts++
      throw new Error('network disconnected after send')
    }
    await deliverPaymentWaitNotice(f.notice.id, send)
    await deliverPaymentWaitNotice(f.notice.id, send)
    assert.equal(attempts, 1)
    const stored = await db
      .from('whatsapp_payment_wait_notices')
      .where('id', f.notice.id)
      .firstOrFail()
    assert.equal(stored.status, 'uncertain')
    const candidates = await duePaymentWaitNotices()
    assert.isFalse(candidates.some((n) => n.id === f.notice.id))
  })
  test('manual payment review cancels waiting; offline and interrupted workers never cause a duplicate', async ({
    assert,
  }) => {
    const f = await fixture()
    await due(f.notice.id)
    let calls = 0
    const send = async () => {
      calls++
      return 'unexpected'
    }
    assert.isFalse(await deliverPaymentWaitNotice(f.notice.id, send, () => false))
    const untouched = await db
      .from('whatsapp_payment_wait_notices')
      .where('id', f.notice.id)
      .firstOrFail()
    assert.equal(untouched.status, 'pending')
    await db.table('whatsapp_payment_reviews').insert({
      id: randomUUID(),
      jid: f.jid,
      cart_version: f.cart.version,
      proof_message_id: f.proof,
      proof_hash: 'a'.repeat(64),
      methods_signature: 'fixture',
      reading_json: '{}',
      created_at: new Date(),
    })
    assert.isFalse(await deliverPaymentWaitNotice(f.notice.id, send))
    const crashed = await fixture()
    await due(crashed.notice.id)
    await db
      .from('whatsapp_payment_wait_notices')
      .where('id', crashed.notice.id)
      .update({ status: 'sending', updated_at: new Date(Date.now() - 6 * 60_000) })
    await duePaymentWaitNotices()
    assert.isFalse(await deliverPaymentWaitNotice(crashed.notice.id, send))
    assert.equal(calls, 0)
  })

  async function approvalFixture() {
    const f = await fixture()
    let cart = await readCart(f.jid)
    cart = await saveCart(f.jid, cart.version, {
      ...cart,
      items: cart.items.map((item) => ({
        ...item,
        modelType: 'custom',
        referenceMessageId: 'fixture-image',
      })),
    })
    return { ...f, cart }
  }
  const dueApproval = (id: string) =>
    db
      .from('whatsapp_approval_wait_episodes')
      .where('id', id)
      .update({ due_at: new Date(Date.now() - 1000) })
  async function incoming(jid: string) {
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: randomUUID(),
      direction: 'in',
      sender_type: 'customer',
      body: 'Ukuran custom juga ya',
      status: 'received',
      created_at: new Date(),
    })
  }
  test('separate model and size discussions share one episode, including after CS replies', async ({
    assert,
  }) => {
    const f = await approvalFixture()
    const first = (await beginApprovalWait(f.jid, 'model'))!
    await dueApproval(first)
    let sends = 0
    const send = async (notice: any, _allowed: any, reserve: (id: string) => Promise<boolean>) => {
      if (!(await reserve(randomUUID()))) return null
      sends++
      assert.include(notice.text, 'tim produksi')
      return randomUUID()
    }
    assert.isTrue(await deliverApprovalWaitNotice(first, send))
    await db.table('whatsapp_messages').insert({
      jid: f.jid,
      message_id: randomUUID(),
      direction: 'out',
      sender_type: 'cs',
      body: 'Sedang diperiksa',
      status: 'sent',
      created_at: new Date(),
    })
    await incoming(f.jid)
    let cart = await saveCart(f.jid, f.cart.version, {
      ...f.cart,
      items: f.cart.items.map((item) => ({
        ...item,
        size: 'custom',
        requestedSize: '38',
        measurements: { waist: 96 },
      })),
    })
    const same = await beginApprovalWait(f.jid, 'size')
    assert.equal(same, first)
    assert.isFalse(await deliverApprovalWaitNotice(first, send))
    assert.equal(sends, 1)
    cart = await approveModel(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
    let episode = await db.from('whatsapp_approval_wait_episodes').where('id', first).firstOrFail()
    assert.equal(Number(episode.is_open), 1)
    cart = await approveCustom(f.jid, cart.version, cart.items[0].id, true, '', 'fixture-cs')
    episode = await db.from('whatsapp_approval_wait_episodes').where('id', first).firstOrFail()
    assert.equal(Number(episode.is_open), 0)
    // Only after the whole previous approval is resolved can a genuinely new request notify again.
    cart.items[0].measurements.waist = 98
    await saveCart(f.jid, cart.version, cart)
    assert.isNull(await beginApprovalWait(f.jid, 'size'))
    await incoming(f.jid)
    const next = (await beginApprovalWait(f.jid, 'size'))!
    assert.notEqual(next, first)
    await dueApproval(next)
    assert.isTrue(await deliverApprovalWaitNotice(next, send))
    assert.equal(sends, 2)
  })
  test('model and size pending before the first notice are combined; concurrent workers send once', async ({
    assert,
  }) => {
    const f = await approvalFixture()
    const id = (await beginApprovalWait(f.jid, 'model'))!
    await incoming(f.jid)
    await saveCart(f.jid, f.cart.version, {
      ...f.cart,
      items: f.cart.items.map((item) => ({
        ...item,
        size: 'custom',
        requestedSize: '38',
        measurements: { waist: 96 },
      })),
    })
    assert.equal(await beginApprovalWait(f.jid, 'size'), id)
    await dueApproval(id)
    let sends = 0
    const send = async (notice: any, _allowed: any, reserve: (id: string) => Promise<boolean>) => {
      if (!(await reserve(randomUUID()))) return null
      assert.include(notice.text, 'model dan ukurannya')
      sends++
      return randomUUID()
    }
    await Promise.all([deliverApprovalWaitNotice(id, send), deliverApprovalWaitNotice(id, send)])
    assert.equal(sends, 1)
  })
  test('ordinary sizing/price cases do not open episodes; cancelling a cart closes pending approval', async ({
    assert,
  }) => {
    const normal = await fixture()
    assert.isNull(await beginApprovalWait(normal.jid, 'size'))
    assert.isNull(await beginApprovalWait(normal.jid, 'model'))
    const f = await approvalFixture()
    const id = (await beginApprovalWait(f.jid, 'model'))!
    await cancelCart(f.jid, f.cart.version, 'fixture-cs')
    await dueApproval(id)
    assert.isFalse(
      await deliverApprovalWaitNotice(id, async () => {
        throw new Error('Must not send')
      })
    )
    const candidates = await dueApprovalWaitNotices()
    assert.isFalse(candidates.some((row) => row.id === id))
  })
  test('upgrades stored three-minute policy and pending episodes once, preserving sent state and later edits', async ({ assert }) => {
    const original = await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).firstOrFail()
    const payment = await fixture()
    const sent = await fixture()
    const approval = await approvalFixture()
    const approvalId = (await beginApprovalWait(approval.jid, 'model'))!
    const old = original.content.replace('"delay_seconds": 60', '"delay_seconds": 180')
    try {
      await db.from('whatsapp_skill_defaults').where('name', WAIT_NOTICE_ONE_MINUTE_REVISION).delete()
      await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).update({ content: old })
      await db.from('whatsapp_payment_wait_notices').where('id', sent.notice.id).update({ status: 'sent' })
      for (const [table, id] of [
        ['whatsapp_payment_wait_notices', payment.notice.id],
        ['whatsapp_payment_wait_notices', sent.notice.id],
        ['whatsapp_approval_wait_episodes', approvalId],
      ]) {
        await db.rawQuery(`UPDATE ${table} SET due_at = DATE_ADD(created_at, INTERVAL 180 SECOND) WHERE id = ?`, [id])
      }
      await ensureWaitNoticeSkill()
      assert.equal((await readWaitNoticePolicy())?.delay_seconds, 60)
      for (const [table, id, seconds] of [
        ['whatsapp_payment_wait_notices', payment.notice.id, 60],
        ['whatsapp_approval_wait_episodes', approvalId, 60],
        ['whatsapp_payment_wait_notices', sent.notice.id, 180],
      ] as const) {
        const row = await db.from(table).where('id', id).firstOrFail()
        assert.equal(new Date(row.due_at).getTime() - new Date(row.created_at).getTime(), seconds * 1000)
      }
      assert.equal((await db.from('whatsapp_payment_wait_notices').where('id', sent.notice.id).firstOrFail()).status, 'sent')
      // A deliberate future edit must not be overridden on every restart.
      await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).update({ content: old })
      await ensureWaitNoticeSkill()
      assert.equal((await readWaitNoticePolicy())?.delay_seconds, 180)
    } finally {
      await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).update({ content: original.content })
    }
  })
  test('skill edits control delivery text; deleting the skill disables notices and does not reseed', async ({
    assert,
  }) => {
    const f = await approvalFixture()
    const id = (await beginApprovalWait(f.jid, 'model'))!
    const original = await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).firstOrFail()
    const updated = original.content.replace(
      'Sebentar ya, modelnya kami cek dengan tim produksi dulu.',
      'Mohon tunggu sebentar, modelnya kami cek ke tim produksi.'
    )
    await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).update({ content: updated })
    await ensureWaitNoticeSkill()
    await dueApproval(id)
    assert.isTrue(
      await deliverApprovalWaitNotice(id, async (notice, _allowed, reserve) => {
        assert.equal(notice.text, 'Mohon tunggu sebentar, modelnya kami cek ke tim produksi.')
        return (await reserve(randomUUID())) ? randomUUID() : null
      })
    )
    const other = await approvalFixture()
    const pending = (await beginApprovalWait(other.jid, 'model'))!
    await dueApproval(pending)
    await db.from('whatsapp_skills').where('name', WAIT_NOTICE_SKILL).delete()
    await db.from('whatsapp_skill_defaults').where('name', WAIT_NOTICE_ONE_MINUTE_REVISION).delete()
    await ensureWaitNoticeSkill()
    assert.isNull(await readWaitNoticePolicy())
    assert.isFalse(
      await deliverApprovalWaitNotice(pending, async () => {
        throw new Error('Must not send')
      })
    )
    const cancelled = await db
      .from('whatsapp_approval_wait_episodes')
      .where('id', pending)
      .firstOrFail()
    assert.equal(cancelled.status, 'cancelled')
    await db.table('whatsapp_skills').insert(original)
  })
})
