import { test } from '@japa/runner'
import {
  trackOutgoingMessage,
  isTrackedOutgoingMessage,
  saveSentAiMessage,
} from '#services/outgoing_delivery_service'
import { inWorkspace } from '#services/workspace_context'

const scope = { id: 2, prefix: 'w2_', phone: null, version: 'test' }
const row = {
  message_id: 'fixture-id',
  jid: 'fixture@lid',
  direction: 'out' as const,
  sender_type: 'ai' as const,
  body: 'Fixture',
  status: 'sent',
}

test('early WhatsApp echo is tracked until persistence, isolated by room and number', async ({
  assert,
}) => {
  await inWorkspace(scope, async () => {
    let trackedId = ''
    await trackOutgoingMessage(row.jid, async (id) => {
      trackedId = id
      assert.isTrue(isTrackedOutgoingMessage(row.jid, id))
      assert.isFalse(isTrackedOutgoingMessage('other@lid', id))
      inWorkspace({ ...scope, id: 3, prefix: 'w3_' }, () =>
        assert.isFalse(isTrackedOutgoingMessage(row.jid, id))
      )
      await Promise.resolve()
      assert.isTrue(isTrackedOutgoingMessage(row.jid, id))
    })
    assert.isFalse(isTrackedOutgoingMessage(row.jid, trackedId))
  })
})

test('tracking cleans up after failed send and does not resend', async ({ assert }) => {
  let attempts = 0
  let id = ''
  await assert.rejects(() =>
    trackOutgoingMessage(row.jid, async (value) => {
      id = value
      attempts++
      throw new Error('fixture failure')
    })
  )
  assert.equal(attempts, 1)
  assert.isFalse(isTrackedOutgoingMessage(row.jid, id))
})

test('duplicate outgoing echo is promoted to AI without inserting a second row', async ({
  assert,
}) => {
  let inserts = 0
  let promotions = 0
  await saveSentAiMessage(row, {
    insert: async () => {
      inserts++
      throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
    },
    find: async () => ({ ...row, sender_type: 'owner', status: 'read' }),
    promote: async (value) => {
      promotions++
      assert.equal(value.sender_type, 'ai')
    },
  })
  assert.equal(inserts, 1)
  assert.equal(promotions, 1)
})

test('colliding IDs in another room or incoming direction are never overwritten', async ({
  assert,
}) => {
  for (const existing of [
    { ...row, jid: 'other@lid' },
    { ...row, direction: 'in' },
  ]) {
    await assert.rejects(
      () =>
        saveSentAiMessage(row, {
          insert: async () => {
            throw Object.assign(new Error('duplicate'), { errno: 1062 })
          },
          find: async () => existing,
          promote: async () => assert.fail('must not overwrite'),
        }),
      /Konflik identitas/
    )
  }
})

test('non-duplicate database failures are not swallowed or retried', async ({ assert }) => {
  let attempts = 0
  await assert.rejects(
    () =>
      saveSentAiMessage(row, {
        insert: async () => {
          attempts++
          throw new Error('database offline')
        },
        find: async () => {
          assert.fail('must not reconcile')
          return undefined
        },
        promote: async () => assert.fail('must not overwrite'),
      }),
    /database offline/
  )
  assert.equal(attempts, 1)
})
