import { test } from '@japa/runner'
import {
  EMPTY_WORKSPACE,
  LEGACY_WORKSPACE,
  inWorkspace,
  workspaceIdentifier,
  workspaceSql,
  workspaceFileName,
  ownsWorkspaceMedia,
} from '#services/workspace_context'
import { setTimeout as wait } from 'node:timers/promises'

const second = { id: 2, prefix: 'w2_', phone: '62800000002', version: 'b' }
test.group('Per-number workspace context', () => {
  test('scopes tables but not shared connection/auth/identity', ({ assert }) =>
    inWorkspace(second, () => {
      assert.equal(workspaceIdentifier('whatsapp_messages'), 'w2_whatsapp_messages')
      for (const name of [
        'whatsapp_connection',
        'whatsapp_workspaces',
        'whatsapp_workspace_state',
        'baileys_auth',
        'account_identity',
        'jid',
      ])
        assert.equal(workspaceIdentifier(name), name)
    }))
  test('raw SQL preserves values, quoted strings and comments', ({ assert }) =>
    inWorkspace(second, () => {
      const query =
        "SELECT `whatsapp_messages`.`body` FROM whatsapp_messages WHERE body = 'whatsapp_messages' AND jid = ? /* whatsapp_orders */ -- whatsapp_settings\n"
      assert.equal(
        workspaceSql(query),
        "SELECT `w2_whatsapp_messages`.`body` FROM w2_whatsapp_messages WHERE body = 'whatsapp_messages' AND jid = ? /* whatsapp_orders */ -- whatsapp_settings\n"
      )
      assert.equal(
        workspaceSql('SELECT * FROM w2_whatsapp_messages'),
        'SELECT * FROM w2_whatsapp_messages'
      )
    }))
  test('keeps async concurrent work and nested contexts isolated', async ({ assert }) => {
    const names = await Promise.all([
      inWorkspace(second, async () => {
        await wait(15)
        return workspaceIdentifier('whatsapp_skills')
      }),
      inWorkspace(LEGACY_WORKSPACE, async () => {
        await wait(3)
        return workspaceIdentifier('whatsapp_skills')
      }),
      inWorkspace(EMPTY_WORKSPACE, async () => {
        await wait(5)
        return workspaceIdentifier('whatsapp_skills')
      }),
    ])
    assert.deepEqual(names, ['w2_whatsapp_skills', 'whatsapp_skills', 'w0_whatsapp_skills'])
  })
  test('rejects invalid/mismatched namespace IDs', ({ assert }) => {
    for (const scope of [
      { ...second, prefix: '' },
      { ...second, prefix: 'w3_' },
      { ...second, id: -1 },
    ])
      assert.throws(() => inWorkspace(scope, () => {}))
  })
  test('media names do not collide and archived media is inaccessible', ({ assert }) => {
    inWorkspace(second, () => {
      assert.equal(workspaceFileName('photo.jpg'), 'w2_photo.jpg')
      assert.isTrue(ownsWorkspaceMedia('profiles/w2_6280000000.jpg'))
      for (const name of [
        'photo.jpg',
        'w3_photo.jpg',
        '../w2_photo.jpg',
        'profiles/../w2_photo.jpg',
      ])
        assert.isFalse(ownsWorkspaceMedia(name))
    })
    inWorkspace(LEGACY_WORKSPACE, () => {
      assert.isTrue(ownsWorkspaceMedia('photo.jpg'))
      assert.isFalse(ownsWorkspaceMedia('w2_photo.jpg'))
    })
    inWorkspace(EMPTY_WORKSPACE, () => assert.isFalse(ownsWorkspaceMedia('w0_photo.jpg')))
  })
})
