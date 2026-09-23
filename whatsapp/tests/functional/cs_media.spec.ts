/* eslint-disable @unicorn/no-await-expression-member -- Isolated database snapshots. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { access, readdir } from 'node:fs/promises'
import sharp from 'sharp'
import app from '@adonisjs/core/services/app'
import { initializeDatabase } from '#services/init_model'
import {
  storeCsMedia,
  csMediaPath,
  csOutgoingPayload,
  removeCsMedia,
  CS_MEDIA_LIMIT,
} from '#services/cs_media_service'
import { queueOutgoingMessage } from '#services/message_service'
import WhatsappListen from '../../commands/whatsapp_listen.js'

const jid = '10000000339955@lid'
const session = () => ({
  account: {
    sub: 'a'.repeat(64),
    sessionToken: 'b'.repeat(43),
    checkedAt: Date.now(),
    name: 'Test CS',
    username: 'test',
  },
})
const artifacts = new Set<string>()
let png: Buffer
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')

test.group('CS media attachments', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    png = await sharp({ create: { width: 24, height: 20, channels: 3, background: '#559988' } })
      .png()
      .toBuffer()
    return async () => {
      const rows = await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .whereNotNull('media_upload_id')
      rows.forEach((row) => artifacts.add(row.media_upload_id))
      await db.rollbackGlobalTransaction()
      for (const id of artifacts) await removeCsMedia(id).catch(() => {})
      artifacts.clear()
    }
  })

  test('validates content, size and path; stores outside public and preserves a safe filename', async ({
    assert,
  }) => {
    const media = await storeCsMedia(png, '../gambar.png')
    artifacts.add(media.id)
    assert.equal(media.name, 'gambar.png')
    assert.equal(media.type, 'image')
    assert.notInclude(csMediaPath(media.id), '/public/')
    await access(csMediaPath(media.id))
    assert.throws(() => csMediaPath('../../.env'), /tidak valid/)
    await assert.rejects(() => storeCsMedia(png, 'palsu.pdf'), /tidak cocok/)
    await assert.rejects(
      () => storeCsMedia(Buffer.from('<svg><script>alert(1)</script></svg>'), 'x.svg'),
      /belum didukung/
    )
    await assert.rejects(() => storeCsMedia(Buffer.alloc(0), 'x.txt'), /Ukuran/)
    await assert.rejects(() => storeCsMedia(Buffer.alloc(CS_MEDIA_LIMIT + 1), 'x.txt'), /Ukuran/)
    const doc = await storeCsMedia(pdf, 'penawaran.pdf')
    artifacts.add(doc.id)
    const payload = (await csOutgoingPayload({
      media_upload_id: doc.id,
      media_type: doc.type,
      media_mime: doc.mime,
      media_name: doc.name,
      body: 'Penawaran',
    })) as any
    assert.deepEqual(payload.document, pdf)
    assert.equal(payload.fileName, 'penawaran.pdf')
    assert.equal(payload.caption, 'Penawaran')
  })

  test('multipart upload allows a photo without caption and protects its download behind login', async ({
    client,
    assert,
  }) => {
    const response = await client
      .post('/api/messages/send')
      .withSession(session())
      .withCsrfToken()
      .fields({ jid, body: '', replyToId: '', replyToMessageId: '' })
      .file('media', png, { filename: 'contoh.png', contentType: 'image/png' })
    response.assertStatus(200)
    const row = await db.from('whatsapp_messages').where('jid', jid).firstOrFail()
    assert.equal(row.media_type, 'image')
    assert.equal(row.media_name, 'contoh.png')
    assert.equal(row.body, '')
    assert.equal(row.status, 'queued')
    assert.equal(row.sender_type, 'cs')
    const file = await client.get(`/api/media/${row.media_upload_id}`).withSession(session())
    file.assertStatus(200)
    assert.include(file.header('content-type'), 'image/png')
    assert.include(file.header('content-disposition'), 'inline')
    file.assertHeader('x-content-type-options', 'nosniff')
    const partial = await client
      .get(`/api/media/${row.media_upload_id}`)
      .withSession(session())
      .header('range', 'bytes=0-7')
    partial.assertStatus(206)
    partial.assertHeader('content-range', `bytes 0-7/${png.length}`)
    const invalidRange = await client
      .get(`/api/media/${row.media_upload_id}`)
      .withSession(session())
      .header('range', 'bytes=999999-')
    invalidRange.assertStatus(416)
    const denied = await client.get(`/api/media/${row.media_upload_id}`).redirects(0)
    denied.assertStatus(302)
  })

  test('queues PDF + caption + reply and the worker sends bytes before returning to AI', async ({
    client,
    assert,
  }) => {
    assert.isNull(await db.from('whatsapp_messages').where('status', 'queued').first())
    await db.table('whatsapp_messages').insert({
      message_id: 'cs-upload-target',
      jid,
      direction: 'in',
      body: 'Minta dokumen',
      status: 'received',
      created_at: new Date(),
    })
    const target = await db
      .from('whatsapp_messages')
      .where('message_id', 'cs-upload-target')
      .firstOrFail()
    const response = await client
      .post('/api/messages/send')
      .withSession(session())
      .withCsrfToken()
      .fields({ jid, body: 'Dokumennya', replyToId: target.id })
      .file('media', pdf, 'penawaran.pdf')
    response.assertStatus(200)
    let sent = 0
    const worker = Object.create(WhatsappListen.prototype) as any
    worker.socket = {
      sendMessage: async (to: string, payload: any, options: any) => {
        assert.equal(to, jid)
        assert.deepEqual(payload.document, pdf)
        assert.equal(payload.fileName, 'penawaran.pdf')
        assert.equal(payload.caption, 'Dokumennya')
        assert.equal(options.quoted.key.id, target.message_id)
        sent++
        return { key: { id: randomUUID() } }
      },
    }
    await worker.flushOutbox()
    assert.equal(sent, 1)
    const row = await db
      .from('whatsapp_messages')
      .where('jid', jid)
      .where('direction', 'out')
      .firstOrFail()
    assert.equal(row.status, 'sent')
    assert.equal(
      (await db.from('whatsapp_contacts').where('jid', jid).firstOrFail()).handling_mode,
      'ai'
    )
    const file = await client.get(`/api/media/${row.media_upload_id}`).withSession(session())
    assert.include(file.header('content-disposition'), 'attachment')
    assert.include(file.header('content-disposition'), 'penawaran.pdf')
  })

  test('invalid room/reply and oversized captions do not leave files or queued bubbles', async ({
    client,
    assert,
  }) => {
    const before = await readdir(app.makePath('storage', 'cs-media')).catch(() => [])
    const response = await client
      .post('/api/messages/send')
      .withSession(session())
      .withCsrfToken()
      .fields({ jid: 'invalid', body: '' })
      .file('media', png, 'photo.png')
    response.assertStatus(422)
    const otherJid = '10000000339956@lid'
    await db.table('whatsapp_messages').insert({
      message_id: 'other-upload-room',
      jid: otherJid,
      direction: 'in',
      body: 'Other room',
      status: 'received',
      created_at: new Date(),
    })
    await assert.rejects(
      () => queueOutgoingMessage({ jid, body: 'x', replyToMessageId: 'other-upload-room' }),
      /room ini/
    )
    const tooLong = await client
      .post('/api/messages/send')
      .withSession(session())
      .withCsrfToken()
      .fields({ jid, body: 'a'.repeat(1025) })
      .file('media', pdf, 'x.pdf')
    tooLong.assertStatus(422)
    assert.deepEqual((await readdir(app.makePath('storage', 'cs-media'))).sort(), before.sort())
    assert.isNull(await db.from('whatsapp_messages').where('jid', jid).first())
  })
})
