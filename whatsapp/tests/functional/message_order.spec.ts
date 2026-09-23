import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { ensureDefaults } from '#services/settings_service'
import { randomUUID } from 'node:crypto'

const jid = '10000000990112@lid'
const session = {
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Test',
    username: 'test',
  },
}

test('room opens at chronological latest; background pages include later-ingested history without gaps', async ({
  client,
  assert,
}) => {
  await ensureDefaults()
  await db.beginGlobalTransaction()
  try {
    // The latest 60 messages arrive first. Older history is inserted afterwards,
    // including equal timestamps spanning a pagination boundary.
    const base = Date.UTC(2030, 0, 1)
    const inserted: any[] = []
    for (const sequence of [
      ...Array.from({ length: 60 }, (_, i) => i + 70),
      ...Array.from({ length: 70 }, (_, i) => i),
    ]) {
      const [id] = await db.table('whatsapp_messages').insert({
        message_id: randomUUID(),
        jid,
        contact_name: 'Timeline Fixture',
        direction: 'in',
        sender_type: 'customer',
        body: `Timeline-${sequence}`,
        status: 'received',
        created_at: new Date(base + Math.floor(sequence / 3) * 1000),
      })
      inserted.push({ id: Number(id), sequence, time: Math.floor(sequence / 3) })
    }
    const expected = [...inserted].sort((a, b) => a.time - b.time || a.id - b.id)
    const latest = await client.get(`/api/messages?jid=${jid}&latest=1`).withSession(session)
    latest.assertStatus(200)
    assert.deepEqual(
      latest.body().messages.map((row: any) => row.id),
      expected.slice(-50).map((row) => row.id)
    )
    assert.equal(latest.body().syncCursor, inserted.at(-1).id)
    const room = await client.get(`/?jid=${jid}`).withSession(session)
    room.assertTextIncludes('Timeline-129')
    const messageHtml = room.text().split('id="messageList"')[1].split('id="aiProgress"')[0]
    const rendered = [...messageHtml.matchAll(/data-id="(\d+)"/g)].map((match) => Number(match[1]))
    assert.deepEqual(
      rendered,
      expected.slice(-50).map((row) => row.id)
    )
    let page = latest.body()
    let all = [...page.messages]
    while (page.hasMore) {
      const result = await client
        .get(`/api/messages?jid=${jid}&before=${page.messages[0].id}`)
        .withSession(session)
      page = result.body()
      all = [...page.messages, ...all]
    }
    assert.deepEqual(
      all.map((row: any) => row.id),
      expected.map((row) => row.id)
    )
    assert.equal(new Set(all.map((row: any) => row.id)).size, 130)
    // Polling remains an ingestion cursor, so both late history and fresh replies sync.
    const [late] = await db.table('whatsapp_messages').insert({
      message_id: randomUUID(),
      jid,
      direction: 'in',
      body: 'Late history',
      status: 'received',
      created_at: new Date(base - 1000),
    })
    const delta = await client
      .get(`/api/messages?jid=${jid}&after=${latest.body().syncCursor}`)
      .withSession(session)
    assert.deepEqual(
      delta.body().messages.map((row: any) => row.id),
      [Number(late)]
    )
    const foreign = await client
      .get(`/api/messages?jid=10000000990113@lid&before=${late}`)
      .withSession(session)
    assert.deepEqual(foreign.body().messages, [])
  } finally {
    await db.rollbackGlobalTransaction()
  }
})
