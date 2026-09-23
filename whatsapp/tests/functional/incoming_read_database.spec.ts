import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import env from '#start/env'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { markRoomRead, latestInboxMessages } from '#services/contact_inbox_service'
import { readIncomingThrough, flushWorkspaceReads } from '#services/incoming_read_service'

test.group('Cumulative incoming read receipts', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Disposable database required.')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Unsafe test database')
    await initializeDatabase()
  })
  const room = () => `${randomUUID()}@lid`
  async function message(jid: string, direction = 'in', time = new Date()) {
    const messageId = randomUUID()
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: messageId,
      direction,
      body: 'Fixture',
      status: direction === 'in' ? 'received' : 'sent',
      created_at: time,
    })
    return db.from('whatsapp_messages').where('message_id', messageId).firstOrFail()
  }
  async function status(row: any) {
    return (await db.from('whatsapp_messages').where('id', row.id).firstOrFail()).status
  }
  function socket() {
    const batches: string[][] = []
    return {
      batches,
      readMessages: async (keys: any[]) => {
        batches.push(keys.map((key) => key.id))
      },
    }
  }

  test('reads all earlier incoming messages, not outgoing, other rooms or later arrivals', async ({
    assert,
  }) => {
    const jid = room()
    const old = await message(jid)
    const outgoing = await message(jid, 'out')
    const other = await message(room())
    const anchor = await message(jid)
    const newer = await message(jid)
    const transport = socket()
    await readIncomingThrough(transport, jid, Number(anchor.id))
    assert.deepEqual(transport.batches.flat(), [old.message_id, anchor.message_id])
    assert.equal(await status(old), 'read')
    assert.equal(await status(anchor), 'read')
    assert.equal(await status(newer), 'received')
    assert.equal(await status(other), 'received')
    assert.equal(await status(outgoing), 'sent')
    await readIncomingThrough(transport, jid, Number(anchor.id))
    assert.equal(transport.batches.length, 1)
  })

  test('does not mark read on transport failure; a retry finishes the same snapshot', async ({
    assert,
  }) => {
    const jid = room()
    const old = await message(jid)
    const anchor = await message(jid)
    await assert.rejects(
      () =>
        readIncomingThrough(
          {
            readMessages: async () => {
              throw new Error('offline')
            },
          },
          jid,
          Number(anchor.id)
        ),
      /offline/
    )
    assert.equal(await status(old), 'received')
    assert.equal(await status(anchor), 'received')
    const transport = socket()
    await readIncomingThrough(transport, jid, Number(anchor.id))
    assert.lengthOf(transport.batches.flat(), 2)
  })

  test('batches a long room without consuming messages arriving during acknowledgement', async ({
    assert,
  }) => {
    const jid = room()
    let anchor: any
    for (let index = 0; index < 205; index++) anchor = await message(jid)
    const sizes: number[] = []
    let later: any
    await readIncomingThrough(
      {
        readMessages: async (keys) => {
          sizes.push(keys.length)
          if (!later) later = await message(jid)
        },
      },
      jid,
      Number(anchor.id)
    )
    assert.deepEqual(sizes, [100, 100, 5])
    assert.equal(await status(later), 'received')
  })

  test('invalid cross-room anchor and revoked permission cannot acknowledge messages', async ({
    assert,
  }) => {
    const jid = room()
    const anchor = await message(jid)
    const other = await message(room())
    const transport = socket()
    await readIncomingThrough(transport, jid, Number(other.id))
    await readIncomingThrough(transport, jid, Number(anchor.id), async () => false)
    assert.lengthOf(transport.batches, 0)
    assert.equal(await status(anchor), 'received')
  })

  test('manual read watermark delivers older receipts and keeps later unread count', async ({
    assert,
  }) => {
    const jid = room()
    const old = await message(jid)
    const anchor = await message(jid)
    await markRoomRead(jid, Number(anchor.id))
    const later = await message(jid)
    const transport = socket()
    await flushWorkspaceReads(transport)
    assert.includeMembers(transport.batches.flat(), [old.message_id, anchor.message_id])
    assert.notInclude(transport.batches.flat(), later.message_id)
    assert.equal(await status(old), 'read')
    assert.equal((await latestInboxMessages()).find((row) => row.jid === jid)!.unread_count, 1)
  })
})
