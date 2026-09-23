import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { initializeDatabase } from '#services/init_model'
import { contactDirectory, contactCsvRows } from '#services/contact_directory_service'
import { saveCustomerMemory } from '#services/conversation_memory'
import { inWorkspace } from '#services/workspace_context'
import { ensureWorkspaceRegistry } from '#services/workspace_service'

test.group('Contact directory isolated database', (group) => {
  group.setup(async () => {
    if (
      process.env.DISCOUNT_DB_TEST !== '1' ||
      !/^wa_discount_test_[a-f0-9]{16}$/.test(process.env.DB_DATABASE || '')
    )
      throw new Error('Disposable database required')
    await initializeDatabase()
    for (const [jid, name, phone] of [
      ['100000000@lid', 'Alice', '628000000001@s.whatsapp.net'],
      ['200000000@lid', 'Bob', null],
      ['628000000002@s.whatsapp.net', 'Carol', null],
      ['300000@g.us', 'Group', null],
    ])
      await db
        .table('whatsapp_contacts')
        .insert({ jid, name, phone_jid: phone, updated_at: new Date() })
    await db.table('whatsapp_carts').insert({
      jid: '100000000@lid',
      version: 'fixture',
      items_json: '[]',
      shipping_json: '{}',
      note: '',
      recipient_json: JSON.stringify({
        name: 'Receiver',
        phone: '08123456789',
        address: 'New street',
      }),
      updated_at: new Date(),
    })
    for (const address of ['Old street', 'Old street', 'New street'])
      await db.table('whatsapp_orders').insert({
        jid: '100000000@lid',
        snapshot_json: JSON.stringify({
          recipient: { name: 'Receiver', phone: '08123456789', address },
        }),
        total: 0,
        paid: 0,
        status: 'active',
        created_at: new Date(),
        updated_at: new Date(),
      })
    const [id] = await db.table('whatsapp_messages').insert({
      jid: '200000000@lid',
      message_id: 'address-fixture',
      body: 'Jl. Example 10',
      direction: 'in',
      status: 'received',
      created_at: new Date(),
    })
    await saveCustomerMemory('200000000@lid', Number(id), [
      {
        key: 'recipient_address',
        topic: 'recipient',
        value: 'Jl. Example 10',
        messageIds: ['address-fixture'],
      },
    ])
  })
  test('joins cart, previous orders and sourced memory; phones never derive from LIDs or recipients', async ({
    assert,
  }) => {
    const result = await contactDirectory({})
    assert.equal(result.total, 3)
    const alice = result.contacts.find((contact) => contact.name === 'Alice')!
    assert.equal(alice.phone, '628000000001')
    assert.lengthOf(alice.addresses, 2)
    assert.equal(alice.addresses[0].address, 'New street')
    assert.equal(alice.addresses[0].phone, '08123456789')
    const bob = result.contacts.find((contact) => contact.name === 'Bob')!
    assert.equal(bob.phone, '')
    assert.equal(bob.addresses[0].source, 'conversation')
    assert.equal(result.contacts.find((contact) => contact.name === 'Carol')!.phone, '628000000002')
  })
  test('search, pagination and export cursor include every matching row, not only first page', async ({
    assert,
  }) => {
    assert.equal((await contactDirectory({ query: 'Old street' })).total, 1)
    assert.equal((await contactDirectory({ query: 'Example' })).total, 1)
    assert.equal((await contactDirectory({ query: '628000000001' })).total, 1)
    assert.equal((await contactDirectory({ query: "' OR 1=1 --" })).total, 0)
    const first = await contactDirectory({ limit: 1, after: '' })
    const second = await contactDirectory({ limit: 1, after: first.next! })
    assert.notEqual(first.contacts[0].jid, second.contacts[0].jid)
    assert.equal(
      (await contactDirectory({ page: 2, limit: 1 })).contacts[0].jid,
      second.contacts[0].jid
    )
    assert.include(contactCsvRows(first.contacts), 'Old street')
    assert.include(contactCsvRows(first.contacts), 'New street')
  })
  test('another WhatsApp workspace cannot read or export these contacts', async ({ assert }) => {
    await inWorkspace({ id: 2, prefix: 'w2_', phone: null, version: 'test' }, async () => {
      await initializeDatabase()
      const result = await contactDirectory({})
      assert.equal(result.total, 0)
      assert.equal(contactCsvRows(result.contacts), '')
    })
  })
  test('stale or deleted source messages cannot become an address', async ({ assert }) => {
    await db
      .from('whatsapp_messages')
      .where('message_id', 'address-fixture')
      .update({ body: 'Corrected message' })
    assert.lengthOf((await contactDirectory({ query: 'Bob' })).contacts[0].addresses, 0)
  })
  test('authenticated page and streamed export retain the selected workspace and search', async ({
    client,
    assert,
  }) => {
    await ensureWorkspaceRegistry()
    await db.from('whatsapp_workspace_state').where('id', 1).update({ active_id: 1 })
    const session = {
      account: {
        sub: 'a'.repeat(64),
        sessionToken: 'b'.repeat(43),
        checkedAt: Date.now(),
        name: 'Test',
        username: 'test',
      },
    }
    const view = await client.get('/contacts').withSession(session).redirects(0)
    view.assertStatus(200)
    assert.include(view.text(), 'id="contactDirectory"')
    const result = await client
      .get('/api/contact-directory/export?query=Alice&language=id')
      .withSession(session)
      .redirects(0)
    result.assertStatus(200)
    result.assertHeader('content-type', 'text/csv; charset=utf-8')
    result.assertHeader('cache-control', 'no-store')
    assert.include(result.text(), '"Kontak","Nomor WhatsApp"')
    assert.include(result.text(), 'Old street')
    assert.notInclude(result.text(), 'Carol')
  })
})
