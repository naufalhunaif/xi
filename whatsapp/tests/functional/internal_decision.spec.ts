import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { initializeDatabase } from '#services/init_model'
import { parseDecision } from '#services/ai_service'
import { handleInternalDecision } from '#services/internal_decision_service'

test.group('Internal-only handoff', () => {
  test('discards handoff text, accepts an empty handoff, and preserves internal notes', ({
    assert,
  }) => {
    for (const message of ['', 'Saya teruskan ke CS ya.', 'Admin akan membantu ongkirnya.']) {
      const decision = parseDecision(
        JSON.stringify({
          decision: 'handoff',
          message,
          reason: 'Perlu kewenangan manusia',
          note: 'Catatan internal',
        })
      )
      assert.equal(decision.message, '')
      assert.equal(decision.decision, 'handoff')
      assert.equal(decision.note, 'Catatan internal')
    }
  })
  test('hands room to CS without sending or storing an outgoing message; silent does not hand off', async ({
    assert,
  }) => {
    await initializeDatabase()
    await db.beginGlobalTransaction()
    const jid = '10000000987654@lid'
    try {
      const decision = {
        decision: 'silent' as const,
        message: '',
        reason: 'Selesai',
        note: 'Catatan internal',
      }
      assert.isTrue(await handleInternalDecision(jid, decision))
      const silentContact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(silentContact.handling_mode, 'ai')
      // Even a non-empty provider message must never reach the sending branch.
      assert.isTrue(
        await handleInternalDecision(jid, {
          ...decision,
          decision: 'handoff',
          message: 'Saya teruskan ke CS ya.',
          reason: 'Perlu otorisasi',
        })
      )
      const contact = await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()
      assert.equal(contact.handling_mode, 'cs')
      assert.equal(contact.handoff_reason, 'Perlu otorisasi')
      assert.equal(contact.chat_note, 'Catatan internal')
      assert.lengthOf(await db.from('whatsapp_messages').where('jid', jid), 0)
      assert.isFalse(
        await handleInternalDecision(jid, {
          ...decision,
          decision: 'reply',
          message: 'Jawaban normal',
        })
      )
    } finally {
      await db.rollbackGlobalTransaction()
    }
  })
})
