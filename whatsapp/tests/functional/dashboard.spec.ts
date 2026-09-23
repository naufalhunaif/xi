import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { parseDecision } from '#services/ai_service'
import {
  createMcpConnection,
  deleteMcpConnection,
  deleteSkill,
  ensureDefaults,
  saveSettings,
} from '#services/settings_service'
import {
  isDirectContactJid,
  queueOutgoingMessage,
  setHandlingMode,
} from '#services/message_service'

test.group('WhatsApp dashboard', (group) => {
  let originalAiEnabled = false
  let originalMcpConnections: Array<{ slug: string; enabled: boolean }> = []
  const accountSession = {
    account: {
      sub: 'a'.repeat(64),
      sessionToken: 'b'.repeat(43),
      checkedAt: Date.now(),
      name: 'Pemilik',
      username: 'owner',
    },
  }

  group.setup(async () => {
    await ensureDefaults()
    const settings = await db.from('whatsapp_settings').where('id', 1).firstOrFail()
    originalAiEnabled = Boolean(settings.ai_enabled)
    originalMcpConnections = await db.from('whatsapp_mcp_connections').select('slug', 'enabled')
  })

  group.teardown(async () => {
    await db
      .from('whatsapp_settings')
      .where('id', 1)
      .update({ ai_enabled: originalAiEnabled, updated_at: new Date() })
    for (const connection of originalMcpConnections) {
      await db
        .from('whatsapp_mcp_connections')
        .where('slug', connection.slug)
        .update({ enabled: connection.enabled, updated_at: new Date() })
    }
  })

  test('redirects guests to Account login', async ({ client }) => {
    const response = await client.get('/').redirects(0)
    response.assertStatus(302)
    response.assertHeader('location', 'http://localhost/alogaritm--app/whatsapp/login')
  })

  test('accepts phone and LID WhatsApp contacts', ({ assert }) => {
    assert.isTrue(isDirectContactJid('628111111111@s.whatsapp.net'))
    assert.isTrue(isDirectContactJid('123456789012345@lid'))
    assert.isFalse(isDirectContactJid('status@broadcast'))
  })

  test('renders contacts and chat room on the authenticated dashboard', async ({
    client,
    assert,
  }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    const response = await client.get('/').withSession(accountSession)

    response.assertStatus(200)
    response.assertTextIncludes('Hubungkan')
    response.assertTextIncludes('Kontak')
    response.assertTextIncludes('id="messages"')
    response.assertTextIncludes('data-jid=""')
    response.assertTextIncludes('id="messageForm"')
    assert.notInclude(response.text(), 'Import skill')
    response.assertTextIncludes(
      'href="http://localhost/alogaritm--app/store/assets/css/workspace.css?v=4"'
    )
    response.assertTextIncludes(
      'href="http://localhost/alogaritm--app/whatsapp/assets/app.css?v=30"'
    )
    assert.notInclude(response.text(), 'undefined/assets')
    assert.notInclude(response.text(), '[object Object]')
  })

  test('keeps AI and skill controls on the settings page', async ({ client, assert }) => {
    await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
    const response = await client.get('/settings').withSession(accountSession)

    response.assertStatus(200)
    assert.notInclude(response.text(), 'API key')
    assert.notInclude(response.text(), 'System prompt')
    response.assertTextIncludes('ChatGPT OAuth')
    response.assertTextIncludes('Claude OAuth')
    response.assertTextIncludes('name="aiProvider"')
    response.assertTextIncludes('name="chatgptModel"')
    response.assertTextIncludes('name="chatgptSpeed"')
    response.assertTextIncludes('name="chatgptReasoning"')
    response.assertTextIncludes('name="claudeModel"')
    response.assertTextIncludes('name="claudeSpeed"')
    response.assertTextIncludes('name="claudeReasoning"')
    response.assertTextIncludes('Import skill')
    response.assertTextIncludes('multiple')
    response.assertTextIncludes('id="skillList"')
    response.assertTextIncludes('Balas otomatis')
    response.assertTextIncludes('name="aiEnabled"')
    response.assertTextIncludes('Data bisnis')
    response.assertTextIncludes('id="mcpName"')
    response.assertTextIncludes('id="mcpUrl"')
    response.assertTextIncludes('id="mcpAddButton"')
    response.assertTextIncludes('wa-shell-settings')
    response.assertTextIncludes('data-mcp-enabled="store"')
    response.assertTextIncludes('data-mcp-enabled="material"')
    response.assertTextIncludes('data-mcp-enabled="invoice"')
    response.assertTextIncludes('data-mcp-enabled="fit"')
    response.assertTextIncludes('data-mcp-connect="store"')
    assert.notMatch(response.text(), /name="aiEnabled"[\s\S]{0,100}checked/)
  })

  test('saves AI provider, model, and speed independently', async ({ assert }) => {
    const before = await db.from('whatsapp_settings').where('id', 1).firstOrFail()
    try {
      const settings = await saveSettings({
        aiEnabled: false,
        aiProvider: 'claude',
        chatgptModel: 'gpt-5.6-sol',
        chatgptSpeed: 'low',
        claudeModel: 'sonnet',
        claudeSpeed: 'high',
      })
      assert.equal(settings.aiProvider, 'claude')
      assert.equal(settings.chatgptModel, 'gpt-5.6-sol')
      assert.equal(settings.chatgptSpeed, 'standard')
      assert.equal(settings.chatgptReasoning, 'low')
      assert.equal(settings.claudeModel, 'sonnet')
      assert.equal(settings.claudeSpeed, 'standard')
      assert.equal(settings.claudeReasoning, 'high')
    } finally {
      await db.from('whatsapp_settings').where('id', 1).update({
        ai_provider: before.ai_provider,
        chatgpt_model: before.chatgpt_model,
        chatgpt_speed: before.chatgpt_speed,
        chatgpt_reasoning: before.chatgpt_reasoning,
        claude_model: before.claude_model,
        claude_speed: before.claude_speed,
        claude_reasoning: before.claude_reasoning,
        updated_at: new Date(),
      })
    }
  })

  test('saves the business MCP sources independently', async ({ assert }) => {
    const settings = await saveSettings({
      aiEnabled: false,
      mcpConnections: { store: true, material: false, invoice: true, fit: false },
    })
    const connections = new Map(
      settings.mcpConnections.map((connection) => [connection.slug, connection.enabled])
    )
    assert.isTrue(connections.get('store'))
    assert.isFalse(connections.get('material'))
    assert.isTrue(connections.get('invoice'))
    assert.isFalse(connections.get('fit'))
  })

  test('adds and deletes a custom business MCP connection', async ({ assert }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
    let slug = ''
    try {
      const settings = await createMcpConnection({
        name: `Data Gudang ${suffix}`,
        url: `https://example.com/mcp/${suffix}`,
      })
      const connection = settings.mcpConnections.find((item) => item.name.startsWith('Data Gudang'))
      assert.exists(connection)
      slug = connection!.slug
      assert.equal(connection!.url, `https://example.com/mcp/${suffix}`)
      assert.isFalse(connection!.enabled)
    } finally {
      if (slug) await deleteMcpConnection(slug)
    }
    const deleted = await db.from('whatsapp_mcp_connections').where('slug', slug).first()
    assert.isNull(deleted)
  })

  test('imports a skill without requiring frontmatter metadata', async ({ assert }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
    let importedId = 0
    try {
      const settings = await saveSettings({
        aiEnabled: false,
        skills: [{ fileName: `layanan-${suffix}.md`, content: 'Jawab pelanggan dengan ringkas.' }],
      })
      const skill = settings.skills.find((item) => item.name === `layanan-${suffix}`)
      assert.exists(skill)
      importedId = skill!.id
      const stored = await db.from('whatsapp_skills').where('id', importedId).firstOrFail()
      assert.include(stored.content, 'name: layanan-')
      assert.include(stored.content, 'Jawab pelanggan dengan ringkas.')
    } finally {
      if (importedId) await deleteSkill(importedId)
    }
  })

  test('parses AI reply and handoff decisions', ({ assert }) => {
    assert.deepEqual(
      parseDecision(
        JSON.stringify({
          decision: 'handoff',
          message: 'Saya hubungkan ke CS ya.',
          reason: 'Perlu verifikasi pembayaran',
        })
      ),
      {
        decision: 'handoff',
        message: '',
        reason: 'Perlu verifikasi pembayaran',
        note: '',
      }
    )
    assert.deepEqual(parseDecision('Balasan biasa'), {
      decision: 'reply',
      message: 'Balasan biasa',
      reason: '',
      note: '',
    })
  })

  test('imports multiple skills and deletes them independently', async ({ assert }) => {
    const suffix = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`
    const firstName = `test-first-${suffix}`
    const secondName = `test-second-${suffix}`
    const content = (name: string) =>
      `---\nname: ${name}\ndescription: Skill test ${name}\n---\n\nGunakan skill ini.`
    let importedIds: number[] = []
    try {
      const settings = await saveSettings({
        aiEnabled: false,
        skills: [{ content: content(firstName) }, { content: content(secondName) }],
      })
      const imported = settings.skills.filter((skill) =>
        [firstName, secondName].includes(skill.name)
      )
      importedIds = imported.map((skill) => skill.id)
      assert.deepEqual(
        imported.map((skill) => skill.name),
        [firstName, secondName]
      )

      const afterDelete = await deleteSkill(importedIds[0])
      importedIds.shift()
      assert.notInclude(
        afterDelete.skills.map((skill) => skill.name),
        firstName
      )
      assert.include(
        afterDelete.skills.map((skill) => skill.name),
        secondName
      )
    } finally {
      for (const id of importedIds) await deleteSkill(id)
    }
  })

  test('filters room messages by selected contact', async ({ client, assert }) => {
    const suffix = `${Date.now()}-${Math.random()}`
    const firstJid = `628111-${suffix}@s.whatsapp.net`
    const secondJid = `628222-${suffix}@s.whatsapp.net`
    await db.table('whatsapp_messages').multiInsert([
      {
        message_id: `first-${suffix}`,
        jid: firstJid,
        contact_name: 'Kontak Satu',
        direction: 'in',
        sender_type: 'customer',
        body: 'Pesan kontak satu',
        media_type: 'image',
        media_url: '/media/test.jpg',
        media_mime: 'image/jpeg',
        status: 'received',
        created_at: new Date(),
      },
      {
        message_id: `second-${suffix}`,
        jid: secondJid,
        contact_name: 'Kontak Dua',
        direction: 'in',
        sender_type: 'customer',
        body: 'Pesan kontak dua',
        status: 'received',
        created_at: new Date(),
      },
    ])
    await db.table('whatsapp_messages').insert({
      message_id: `reply-${suffix}`,
      jid: firstJid,
      contact_name: 'Kontak Satu',
      direction: 'out',
      sender_type: 'ai',
      body: 'Balasan kontak satu',
      reply_to_message_id: `first-${suffix}`,
      status: 'read',
      created_at: new Date(),
    })
    await db.table('whatsapp_messages').insert({
      message_id: `video-${suffix}`,
      jid: firstJid,
      contact_name: 'Kontak Satu',
      direction: 'in',
      sender_type: 'customer',
      body: '',
      media_type: 'video',
      media_url: null,
      thumbnail_url: '/media/test-thumb.jpg',
      media_mime: 'video/mp4',
      media_status: 'downloading',
      status: 'received',
      created_at: new Date(),
    })
    await db.table('whatsapp_reactions').insert({
      target_message_id: `first-${suffix}`,
      jid: firstJid,
      sender: 'me',
      emoji: '👍',
      from_me: true,
      status: 'sent',
      created_at: new Date(),
    })

    try {
      const response = await client
        .get(`/api/messages?jid=${encodeURIComponent(firstJid)}&after=0`)
        .withSession(accountSession)

      response.assertStatus(200)
      assert.lengthOf(response.body().messages, 3)
      const first = response
        .body()
        .messages.find((message: any) => message.message_id === `first-${suffix}`)
      const reply = response
        .body()
        .messages.find((message: any) => message.message_id === `reply-${suffix}`)
      const video = response
        .body()
        .messages.find((message: any) => message.message_id === `video-${suffix}`)
      assert.equal(first.media_type, 'image')
      assert.equal(first.reactions[0].emoji, '👍')
      assert.equal(reply.reply.body, 'Pesan kontak satu')
      assert.equal(video.media_type, 'video')
      assert.equal(video.media_status, 'downloading')
      assert.equal(video.thumbnail_url, '/media/test-thumb.jpg')

      const room = await client
        .get(`/?jid=${encodeURIComponent(firstJid)}`)
        .withSession(accountSession)
      room.assertTextIncludes('message-media')
      room.assertTextIncludes('src="/media/test-thumb.jpg"')
      room.assertTextIncludes('Mengunduh…')
      room.assertTextIncludes('message-reply-preview')
      room.assertTextIncludes('message-actions')
      room.assertTextIncludes('source-ai')
      room.assertTextIncludes('message-source-badge')
      room.assertTextIncludes('id="roomModeButton"')
      room.assertTextIncludes('href="http://localhost/alogaritm--app/whatsapp/"')

      await db
        .from('whatsapp_messages')
        .where('message_id', `video-${suffix}`)
        .update({ media_url: '/media/test.mp4', media_status: 'ready' })
      const readyRoom = await client
        .get(`/?jid=${encodeURIComponent(firstJid)}`)
        .withSession(accountSession)
      readyRoom.assertTextIncludes('preload="metadata"')
      readyRoom.assertTextIncludes('poster="/media/test-thumb.jpg"')

      const videoRow = await db
        .from('whatsapp_messages')
        .where('message_id', `video-${suffix}`)
        .firstOrFail()
      const older = await client
        .get(`/api/messages?jid=${encodeURIComponent(firstJid)}&before=${videoRow.id}`)
        .withSession(accountSession)
      older.assertStatus(200)
      assert.lengthOf(older.body().messages, 2)
      assert.isBelow(older.body().messages[0].id, older.body().messages[1].id)

      const target = await db
        .from('whatsapp_messages')
        .where('message_id', `first-${suffix}`)
        .firstOrFail()
      await queueOutgoingMessage({
        jid: firstJid,
        body: 'Reply melalui ID stabil',
        replyToId: target.id,
        replyToMessageId: 'id-whatsapp-lama',
      })
      const queued = await db
        .from('whatsapp_messages')
        .where('jid', firstJid)
        .where('body', 'Reply melalui ID stabil')
        .firstOrFail()
      assert.equal(queued.reply_to_message_id, `first-${suffix}`)
      assert.equal(queued.sender_type, 'cs')
      const contactAfterReply = await db
        .from('whatsapp_contacts')
        .where('jid', firstJid)
        .firstOrFail()
      assert.equal(contactAfterReply.handling_mode, 'cs')

      await setHandlingMode(firstJid, 'ai')
      const contacts = await client.get('/api/contacts').withSession(accountSession)
      contacts.assertStatus(200)
      const resumed = contacts.body().contacts.find((contact: any) => contact.jid === firstJid)
      assert.equal(resumed.handling_mode, 'ai')
    } finally {
      await db.from('whatsapp_reactions').where('target_message_id', `first-${suffix}`).delete()
      await db.from('whatsapp_messages').whereIn('jid', [firstJid, secondJid]).delete()
      await db.from('whatsapp_contacts').whereIn('jid', [firstJid, secondJid]).delete()
    }
  })
})
