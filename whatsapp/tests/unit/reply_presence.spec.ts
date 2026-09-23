import { test } from '@japa/runner'
import type { WAMessageKey } from '@whiskeysockets/baileys'
import { sendPreparedReply } from '#services/reply_presence_service'

const jid = '628111111111@s.whatsapp.net'
const keys = [{ remoteJid: jid, id: 'incoming-1', fromMe: false }]
const allow = async () => true
const noWait = async () => {}

function fixture() {
  const calls: string[] = []
  return {
    calls,
    socket: {
      readMessages: async (messages: WAMessageKey[]) => {
        calls.push(`read:${messages.map((item) => item.id).join(',')}`)
      },
      sendPresenceUpdate: async (status: string, target?: string) => {
        calls.push(`${status}${target ? ':' + target : ''}`)
      },
    },
  }
}

test.group('Reply presence lifecycle', () => {
  test('cumulative reader replaces single-message receipt before typing', async ({ assert }) => {
    const { calls, socket } = fixture()
    await sendPreparedReply(
      socket,
      jid,
      keys,
      async () => {
        calls.push('send')
      },
      {
        canSend: allow,
        wait: noWait,
        read: async () => {
          calls.push('read-through-anchor')
        },
      }
    )
    assert.equal(calls[0], 'read-through-anchor')
    assert.notInclude(calls, 'read:incoming-1')
    assert.isBelow(calls.indexOf('read-through-anchor'), calls.indexOf(`composing:${jid}`))
  })
  test('marks read before online and typing, then sends and clears presence', async ({
    assert,
  }) => {
    const { calls, socket } = fixture()
    const result = await sendPreparedReply(
      socket,
      jid,
      keys,
      async () => {
        calls.push('send')
        return 'message-id'
      },
      {
        canSend: allow,
        onRead: async () => {
          calls.push('read-recorded')
        },
        onTyping: async () => {
          calls.push('typing-ui')
        },
        wait: async (ms) => {
          calls.push(`prepare:${ms}`)
        },
        onDone: async () => {
          calls.push('clear-ui')
        },
      }
    )
    assert.equal(result, 'message-id')
    assert.deepEqual(calls, [
      'read:incoming-1',
      'read-recorded',
      'available',
      `composing:${jid}`,
      'typing-ui',
      'prepare:800',
      'send',
      `paused:${jid}`,
      'clear-ui',
      'unavailable',
    ])
  })

  test('does not type or send if marking the message read fails', async ({ assert }) => {
    const { calls, socket } = fixture()
    socket.readMessages = async () => {
      throw new Error('read failed')
    }
    await assert.rejects(
      () =>
        sendPreparedReply(
          socket,
          jid,
          keys,
          async () => {
            calls.push('send')
          },
          { canSend: allow, wait: noWait }
        ),
      /read failed/
    )
    assert.deepEqual(calls, [])
  })

  test('cleans typing and online state even when sending fails', async ({ assert }) => {
    const { calls, socket } = fixture()
    await assert.rejects(
      () =>
        sendPreparedReply(
          socket,
          jid,
          keys,
          async () => {
            throw new Error('send failed')
          },
          { canSend: allow, wait: noWait }
        ),
      /send failed/
    )
    assert.deepEqual(calls.slice(-2), [`paused:${jid}`, 'unavailable'])
  })

  test('rechecks permission after preparation and never sends after CS takeover', async ({
    assert,
  }) => {
    const { calls, socket } = fixture()
    let checks = 0
    const result = await sendPreparedReply(
      socket,
      jid,
      keys,
      async () => {
        calls.push('send')
      },
      { canSend: async () => ++checks === 1, wait: noWait }
    )
    assert.isNull(result)
    assert.notInclude(calls, 'send')
    assert.deepEqual(calls.slice(-2), [`paused:${jid}`, 'unavailable'])
    calls.length = 0
    await sendPreparedReply(
      socket,
      jid,
      keys,
      async () => {
        calls.push('send')
      },
      { canSend: async () => false, wait: noWait }
    )
    assert.deepEqual(calls, [])
  })

  test('keeps the account online until concurrent replies finish', async ({ assert }) => {
    const { calls, socket } = fixture()
    let release!: () => void
    let signalReady!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const ready = new Promise<void>((resolve) => {
      signalReady = resolve
    })
    const first = sendPreparedReply(
      socket,
      jid,
      keys,
      async () => {
        signalReady()
        await held
        calls.push('first sent')
      },
      { canSend: allow, wait: noWait }
    )
    await ready
    await sendPreparedReply(
      socket,
      '628222222222@s.whatsapp.net',
      [],
      async () => {
        calls.push('second sent')
      },
      { canSend: allow, wait: noWait }
    )
    assert.notInclude(calls, 'unavailable')
    release()
    await first
    assert.equal(calls.at(-1), 'unavailable')
    assert.equal(calls.filter((call) => call === 'unavailable').length, 1)
  })
})
