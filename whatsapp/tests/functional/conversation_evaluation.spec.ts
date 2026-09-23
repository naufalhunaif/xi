import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { evaluateConversationWithAi, replayLearningWithAi } from '#services/ai_service'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { readSettings } from '#services/settings_service'
import {
  evaluateConversation,
  evaluationContext,
  evaluationOverview,
  nextEvaluationRoom,
  EVALUATION_QUIET_MS,
  EVALUATION_INTERVAL_MS,
} from '#services/conversation_evaluation_service'
import type { ConversationEvaluation } from '#services/evaluation_contract'

const jid = '10000000771122@lid'
async function incoming() {
  const id = randomUUID()
  await db.table('whatsapp_messages').insert({
    message_id: id,
    jid,
    direction: 'in',
    sender_type: 'customer',
    body: 'Ukuran S tersedia?',
    status: 'received',
    created_at: new Date(Date.now() - 60_000),
  })
  return id
}
function result(id: string): ConversationEvaluation {
  return {
    summary: 'Pelanggan menanyakan ukuran.',
    stage: 'selection',
    missedNeeds: ['Ketersediaan ukuran'],
    nextAction: 'Periksa data produk sesuai skill.',
    evidenceMessageIds: [id],
    limitations: ['Satu percakapan bukan bukti peningkatan konversi.'],
  }
}
test.group('Conversation evaluation', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
    await db.table('whatsapp_skills').insert({
      name: 'local-test-eval',
      content: 'Evaluasi berdasarkan bukti. Jangan ubah panduan.',
      created_at: new Date(),
      updated_at: new Date(),
    })
    return () => db.rollbackGlobalTransaction()
  })
  test('stores evidence and skill versions once per change, without editing skills or sending messages', async ({
    assert,
  }) => {
    const id = await incoming()
    const settings = await readSettings(true)
    const before = await db.from('whatsapp_skills').select('*')
    let calls = 0
    const evaluator = async () => {
      calls++
      return result(id)
    }
    assert.isTrue(await evaluateConversation(jid, settings, evaluator))
    assert.isFalse(await evaluateConversation(jid, settings, evaluator))
    assert.equal(calls, 1)
    const history = await db.from('whatsapp_evaluation_history').where('jid', jid)
    assert.lengthOf(history, 1)
    assert.include(history[0].skills_json, 'updatedAt')
    assert.include(await evaluationContext(jid), 'Periksa data produk')
    assert.equal(await evaluationContext('10000000771123@lid'), '')
    assert.deepEqual(await db.from('whatsapp_skills').select('*'), before)
    assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 1)
    const next = await incoming()
    assert.isTrue(await evaluateConversation(jid, settings, async () => result(next)))
    assert.lengthOf(await db.from('whatsapp_evaluation_history').where('jid', jid), 2)
  })
  test('discards an evaluation if a new message arrives while evaluating', async ({ assert }) => {
    const id = await incoming()
    assert.isFalse(
      await evaluateConversation(jid, await readSettings(true), async () => {
        await incoming()
        return result(id)
      })
    )
    const row = await db.from('whatsapp_conversation_evaluations').where('jid', jid).firstOrFail()
    assert.equal(row.status, 'pending')
    assert.equal(await evaluationContext(jid), '')
    assert.lengthOf(await db.from('whatsapp_evaluation_history').where('jid', jid), 0)
  })
  test('rejects invented evidence and does not loop on unchanged failures', async ({ assert }) => {
    await incoming()
    const settings = await readSettings(true)
    let calls = 0
    const evaluator = async () => {
      calls++
      return result('nonexistent')
    }
    assert.isFalse(await evaluateConversation(jid, settings, evaluator))
    assert.isFalse(await evaluateConversation(jid, settings, evaluator))
    assert.equal(calls, 1)
    assert.equal(await evaluationContext(jid), '')
  })
  test('pauses when AI is off and invalidates advice after skill changes', async ({ assert }) => {
    const id = await incoming()
    const settings = await readSettings(true)
    assert.isFalse(
      await evaluateConversation(jid, { ...settings, aiEnabled: false }, async () => {
        throw new Error('Must not run')
      })
    )
    assert.isTrue(await evaluateConversation(jid, settings, async () => result(id)))
    await db
      .from('whatsapp_skills')
      .where('name', 'local-test-eval')
      .update({ content: 'Panduan berubah' })
    assert.equal(await evaluationContext(jid), '')
  })
  test('order metric does not treat chat promises as confirmed orders', async ({ assert }) => {
    const before = await evaluationOverview()
    await incoming()
    const after = await evaluationOverview()
    assert.equal(after.customers, before.customers + 1)
    assert.equal(after.ordered, before.ordered)
  })
  test('automatic evaluation coalesces messages and cart changes while manual evaluation stays immediate', async ({
    assert,
  }) => {
    const id = await incoming()
    const settings = await readSettings(true)
    const otherMessages = await db.from('whatsapp_messages').whereNot('jid', jid).distinct('jid')
    const otherRooms = otherMessages.map((row) => row.jid)
    const next = () => nextEvaluationRoom(settings, otherRooms)
    assert.isNull(await next(), 'A one-minute-old message is still active')
    await db
      .from('whatsapp_messages')
      .where('message_id', id)
      .update({ created_at: new Date(Date.now() - EVALUATION_QUIET_MS - 60_000) })
    assert.equal(await next(), jid)
    assert.isTrue(await evaluateConversation(jid, settings, async () => result(id)))
    const newer = await incoming()
    await db
      .from('whatsapp_messages')
      .where('message_id', newer)
      .update({ created_at: new Date(Date.now() - EVALUATION_QUIET_MS - 60_000) })
    assert.isNull(await next(), 'Changed evidence must still respect the automatic cooldown')
    await db
      .from('whatsapp_conversation_evaluations')
      .where('jid', jid)
      .update({ updated_at: new Date(Date.now() - EVALUATION_INTERVAL_MS - 60_000) })
    assert.equal(await next(), jid)
    await db
      .table('whatsapp_cart_events')
      .insert({ jid, action: 'sync', actor: 'test', summary_json: '{}', created_at: new Date() })
    assert.isNull(await next(), 'Recent cart activity also delays background work')
    assert.isTrue(
      await evaluateConversation(jid, settings, async () => result(newer)),
      'An explicit evaluation is immediate'
    )
    assert.isFalse(
      await evaluateConversation(jid, settings, async () => {
        throw new Error('Unchanged snapshot must not rerun')
      })
    )
  })
  test('evaluation and replay providers receive active policy without retired bundles or business tools', async ({
    assert,
  }) => {
    const settings = await readSettings(true)
    const scoped = {
      ...settings,
      aiProvider: 'chatgpt',
      aiFailover: false,
      codexBin: fileURLToPath(new URL('../fixtures/evaluation_provider.mjs', import.meta.url)),
      skills: [
        {
          name: 'chameleon-cs-gabungan-2',
          content:
            'RETIRED_MUST_NOT_RETURN\n# STATUS DAN PRIORITAS SKILL\nBerkas ini bukan acuan aktif bila skill modular tersedia. Jangan muat atau terapkan berkas ini bersamaan dengan skill modular. Gunakan skill modular yang sesuai kebutuhan.',
        },
        ...[
          'cs-chameleon-cloth',
          'cs-chameleon-media',
          'cs-chameleon-batas',
          'cs-chameleon-konteks',
        ].map((name) => ({ name, content: `ORIGINAL_${name}` })),
        {
          name: 'cs-chameleon-eval',
          content:
            '# EVALUASI & PEMBELAJARAN CS CHAMELEON CLOTH\n## Kapan dijalankan\nPakai setiap kali skill CS diubah, saat evaluasi bulanan, atau saat konversi turun.\nRUBRIC_ORIGINAL',
        },
        { name: 'conversation-learning', content: 'LEARNING_ORIGINAL' },
        { name: 'owner-specific', content: 'OWNER_ORIGINAL' },
      ],
    }
    const evaluated = await evaluateConversationWithAi(scoped, { message: 'EVIDENCE_ORIGINAL' })
    assert.equal(evaluated.summary, 'Fixture evaluation')
    await replayLearningWithAi(scoped)
    const usage = await db.from('whatsapp_ai_usage').orderBy('id', 'desc').limit(2)
    assert.deepEqual(
      usage.map((row) => row.phase),
      ['learning-replay', 'evaluation']
    )
    assert.isTrue(usage.every((row) => row.status === 'completed'))
  })
})
