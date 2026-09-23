import { test } from '@japa/runner'
import { parseDecision, DECISION_SCHEMA } from '#services/ai_service'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import {
  nextFollowUpAt,
  parseGoal,
  validPolicy,
  withinSendingHours,
  GOAL_RUNTIME_INSTRUCTIONS,
  type FollowUpPolicy,
} from '#services/goal_contract'

const policy: FollowUpPolicy = {
  skill_name: 'bisnis',
  reason: 'Ukuran sudah diminta; susulan diizinkan skill.',
  first_delay_hours: 12,
  repeat_delay_hours: 72,
  max_attempts: 2,
  send_start_hour: 8,
  send_end_hour: 20,
  time_zone: 'Asia/Jakarta',
}
const decision = {
  decision: 'reply' as const,
  message: 'Total: Rp713.000',
  initiative: 'Di tunggu alamat lengkapnya ya bos',
  reason: '',
  note: '',
}

test.group('Conversation goal and separate initiative contract', () => {
  test('photo subtask cannot complete a discovery/selection journey or start a timer', ({ assert }) => {
    for (const stage of ['discovery', 'selection'] as const) {
      const goal = parseGoal({
        objective: 'Membantu memilih beskap sampai keputusan pemesanan',
        current_task: 'Mengirim foto beskap Brown yang ready',
        stage,
        status: 'completed',
        waiting_for: '', next_action: '', follow_up: policy,
      })!
      assert.equal(goal.status, 'waiting_answer')
      assert.equal(goal.stage, stage)
      assert.isNotEmpty(goal.waiting_for)
      assert.isNotEmpty(goal.next_action)
      assert.isNull(goal.follow_up)
      assert.deepEqual(parseGoal(goal), goal)
    }
  })
  test('the Brown photo is followed by one separate skill-written question and stays waiting', async ({ assert }) => {
    const result = parseDecision(JSON.stringify({
      ...decision, message: '', initiative: 'Biasanya pakai ukuran apa bos?',
      images: [{ url: 'https://catalog.example.test/brown.jpg', caption: 'Beskap Brown' }],
      goal: { objective: 'Membantu pelanggan memilih beskap yang sesuai hingga keputusan pemesanan',
        stage: 'selection', current_task: 'Mengirim foto Brown', status: 'completed',
        waiting_for: 'Ukuran pelanggan', next_action: 'Bantu ukuran sesuai skill setelah pelanggan menjawab', follow_up: null },
    }))
    const sent: Array<{ body: string; kind: string; image: boolean }> = []
    await sendAiMessageSequence(result, false, async () => true, async (body, kind, image) => {
      sent.push({ body, kind, image: Boolean(image) })
      return true
    }, [{ caption: 'Beskap Brown', kind: 'answer', bytes: Buffer.from('fixture'), mediaUrl: '/fixture.jpg' }])
    assert.deepEqual(sent, [
      { body: 'Beskap Brown', kind: 'answer', image: true },
      { body: 'Biasanya pakai ukuran apa bos?', kind: 'initiative', image: false },
    ])
    assert.equal(result.goal?.status, 'waiting_answer')
    assert.equal(result.goal?.waiting_for, 'Ukuran pelanggan')
    assert.isNull(result.goal?.follow_up)
  })
  test('photo-only request can wait without inventing a question; closed requests stay closed', ({ assert }) => {
    const base = { ...decision, message: 'Beskap Brown', initiative: '',
      goal: { objective: 'Memilih beskap', current_task: 'Foto Brown', stage: 'selection',
        status: 'waiting_answer', waiting_for: 'Tanggapan pelanggan', next_action: 'Tunggu respons', follow_up: null } }
    const waiting = parseDecision(JSON.stringify(base))
    assert.equal(waiting.initiative, '')
    assert.equal(waiting.goal?.status, 'waiting_answer')
    for (const objective of ['Pelanggan memutuskan tidak lanjut', 'Permintaan informasi selesai; pelanggan menutup percakapan']) {
      const closed = parseGoal({ ...base.goal, objective, stage: 'closed', status: 'completed', waiting_for: '', next_action: '' })!
      assert.equal(closed.status, 'completed')
      assert.isNull(closed.follow_up)
    }
  })
  test('open operational stages cannot complete, but payment/approval waits are not downgraded', ({ assert }) => {
    for (const stage of ['checkout', 'fulfillment', 'service']) {
      const base = { objective: 'Memenuhi kebutuhan pelanggan', stage, current_task: 'Periksa state', waiting_for: 'Hasil verifikasi', next_action: 'Tunggu hasil terverifikasi', follow_up: null }
      assert.equal(parseGoal({ ...base, status: 'completed' })?.status, 'waiting')
      for (const status of ['waiting_payment', 'waiting_approval'])
        assert.equal(parseGoal({ ...base, status })?.status, status)
    }
    assert.throws(() => parseGoal({ objective: '', waiting_for: '', next_action: '', status: 'completed', stage: 'photo_sent' }))
    assert.throws(() => parseGoal({ objective: '', waiting_for: '', next_action: '', status: 'completed', current_task: {} }))
  })
  test('goal contract distinguishes task completion and respects skill, existing answers and silent reviews', ({ assert }) => {
    assert.include(DECISION_SCHEMA.properties.goal.required, 'stage')
    assert.include(DECISION_SCHEMA.properties.goal.required, 'current_task')
    for (const rule of ['ukuran sudah diketahui', 'paling banyak SATU', 'goal.next_action', 'Review internal tanpa perubahan', 'Tanpa izin/syarat tersebut: follow_up null'])
      assert.include(GOAL_RUNTIME_INSTRUCTIONS, rule)
  })
  test('failed photo delivery prevents the initiative and does not report sequence completion', async ({ assert }) => {
    const sent: string[] = []
    const complete = await sendAiMessageSequence({ ...decision, message: '' }, false, async () => true, async (_body, kind, image) => {
      sent.push(image ? 'photo' : kind)
      return false
    }, [{ caption: 'Brown', kind: 'answer', bytes: Buffer.from('fixture'), mediaUrl: '/fixture.jpg' }])
    assert.isFalse(complete)
    assert.deepEqual(sent, ['photo'])
  })
  test('sends the answer and initiative as distinct ordered messages with newlines preserved', async ({
    assert,
  }) => {
    const sent: string[] = []
    const result = await sendAiMessageSequence(
      { ...decision, message: 'Jas: Rp705.000\nOngkir: Rp8.000\nTotal: Rp713.000' },
      false,
      async () => true,
      async (body, kind) => {
        sent.push(`${kind}:${body}`)
        return true
      }
    )
    assert.isTrue(result)
    assert.deepEqual(sent, [
      'answer:Jas: Rp705.000\nOngkir: Rp8.000\nTotal: Rp713.000',
      `initiative:${decision.initiative}`,
    ])
  })
  test('cancels initiative after a new customer message or human takeover between bubbles', async ({
    assert,
  }) => {
    const sent: string[] = []
    let current = true
    assert.isFalse(
      await sendAiMessageSequence(
        decision,
        false,
        async () => current,
        async (body) => {
          sent.push(body)
          current = false
          return true
        }
      )
    )
    assert.deepEqual(sent, [decision.message])
  })
  test('keeps a useful answer and the next-step question in two bubbles, but sends an initiative-only turn once', async ({ assert }) => {
    const answer = 'Harga jasnya Rp400.000, belum termasuk ongkir.'
    const next = 'Pengirimannya ke kecamatan mana?'
    for (const message of [answer, '']) {
      const parsed = parseDecision(JSON.stringify({ ...decision, message, initiative: next }))
      const sent: Array<{ body: string; kind: string }> = []
      await sendAiMessageSequence(parsed, false, async () => true, async (body, kind) => {
        sent.push({ body, kind })
        return true
      })
      assert.deepEqual(sent, [
        ...(message ? [{ body: answer, kind: 'answer' }] : []),
        { body: next, kind: 'initiative' },
      ])
    }
  })
  test('does not send a next-step question when the main answer was not sent', async ({ assert }) => {
    const sent: string[] = []
    const complete = await sendAiMessageSequence(decision, false, async () => true, async (body) => {
      sent.push(body)
      return false
    })
    assert.isFalse(complete)
    assert.deepEqual(sent, [decision.message])
  })
  test('schema tells the provider to use natural wording and separate a relevant next step', ({ assert }) => {
    assert.include(DECISION_SCHEMA.properties.message.description, 'bukan template wajib disalin')
    assert.include(DECISION_SCHEMA.properties.message.description, 'chat terpisah')
    assert.include(DECISION_SCHEMA.properties.initiative.description, 'prasyaratnya sudah terpenuhi')
    assert.include(DECISION_SCHEMA.properties.initiative.description, 'masih perlu menunggu jawaban')
  })
  test('handoff and silent discard both fields; scheduled follow-up is one message only', async ({
    assert,
  }) => {
    for (const kind of ['handoff', 'silent'] as const) {
      const parsed = parseDecision(JSON.stringify({ ...decision, decision: kind }))
      assert.equal(parsed.message, '')
      assert.equal(parsed.initiative, '')
      const sent: string[] = []
      await sendAiMessageSequence(
        { ...decision, decision: kind },
        false,
        async () => true,
        async (body) => {
          sent.push(body)
          return true
        }
      )
      assert.lengthOf(sent, 0)
    }
    const sent: string[] = []
    await sendAiMessageSequence(
      decision,
      true,
      async () => true,
      async (body) => {
        sent.push(body)
        return true
      }
    )
    assert.deepEqual(sent, [decision.message])
  })
  test('does not invent initiatives, duplicate equal fields, or split paragraphs', async ({
    assert,
  }) => {
    for (const initiative of ['', decision.message]) {
      const sent: string[] = []
      await sendAiMessageSequence(
        { ...decision, initiative },
        false,
        async () => true,
        async (body) => {
          sent.push(body)
          return true
        }
      )
      assert.deepEqual(sent, [decision.message])
    }
    assert.include(DECISION_SCHEMA.required, 'goal')
    assert.include(DECISION_SCHEMA.required, 'initiative')
    assert.isNull(
      parseGoal({
        objective: 'Order',
        status: 'waiting',
        waiting_for: 'alamat',
        next_action: 'tunggu',
        follow_up: { ...policy, max_attempts: 100 },
      })?.follow_up
    )
  })
  test('schedules first and second follow-ups using the skill delays, stops at its cap', ({
    assert,
  }) => {
    const last = new Date('2026-09-13T10:00:00+07:00')
    const first = nextFollowUpAt(policy, 0, last, null, last)!
    // +12h is outside sending hours; defer to next 08:00 WIB.
    assert.equal(first.toISOString(), '2026-09-14T01:00:00.000Z')
    assert.equal(
      nextFollowUpAt(policy, 1, last, first, first)?.toISOString(),
      '2026-09-17T01:00:00.000Z'
    )
    assert.isNull(nextFollowUpAt(policy, 2, last, first, first))
    assert.isFalse(withinSendingHours(policy, new Date('2026-09-13T20:00:00+07:00')))
    assert.isTrue(withinSendingHours(policy, new Date('2026-09-13T08:00:00+07:00')))
  })
  test('uses the supplied skill policy rather than hardcoded shipping/business timing', ({
    assert,
  }) => {
    const other = { ...policy, first_delay_hours: 24, repeat_delay_hours: 96, max_attempts: 1 }
    const last = new Date('2026-09-13T10:00:00+07:00')
    assert.equal(
      nextFollowUpAt(other, 0, last, null, last)?.toISOString(),
      '2026-09-14T03:00:00.000Z'
    )
    assert.isNull(nextFollowUpAt(other, 1, last, last, last))
    assert.isFalse(validPolicy({ ...policy, time_zone: 'not-a-zone' }))
    assert.isFalse(validPolicy({ ...policy, send_start_hour: 20, send_end_hour: 8 }))
  })
})
