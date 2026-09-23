/* eslint-disable @unicorn/no-await-expression-member -- Assertions inspect isolated snapshots. */
import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import env from '#start/env'
import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { initializeDatabase } from '#services/init_model'
import {
  parseDecision,
  extractCatalogProducts,
  catalogImageUrls,
  type AiDecision,
} from '#services/ai_service'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import WhatsappListen from '../../commands/whatsapp_listen.js'
import { readSettings } from '#services/settings_service'
import { beginGoalTurn, readConversationGoal } from '#services/conversation_goal_service'
import { setHandlingMode } from '#services/message_service'
import { startTrace, readTrace } from '#services/trace_service'
import {
  prepareOutgoingImages,
  outgoingMessagePayload,
  downloadOutgoingImage,
  stripImageLinks,
  type OutgoingImage,
} from '#services/outgoing_image_service'

const jid = '10000000776655@lid'
const url = 'https://catalog.example/products/photo.png'
const connections = [{ url: 'https://catalog.example/mcp', enabled: true, authenticated: true }]
const base: AiDecision = {
  decision: 'reply',
  message: '',
  reason: '',
  note: '',
  images: [{ url, caption: 'Jas pilihan' }],
  cartEvidence: { products: [{ id: 'product-1', img: url, imageUrls: [url] }], shipping: [] },
}
let png: Buffer
const artifacts = new Set<string>()
const remember = (images: OutgoingImage[]) =>
  images.forEach((image) =>
    artifacts.add(app.makePath('public', 'media', image.mediaUrl.split('/').pop()!))
  )
const fetchImage: typeof fetch = async () =>
  new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } })

test.group('Verified images sent as WhatsApp photos', (group) => {
  group.setup(() => initializeDatabase())
  group.each.setup(async () => {
    await db.beginGlobalTransaction()
    png = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#123456' } })
      .png()
      .toBuffer()
    return async () => {
      await db.rollbackGlobalTransaction()
      for (const path of artifacts) await unlink(path)
      artifacts.clear()
    }
  })

  for (const change of ['echo', 'customer', 'cs', 'disconnect', 'ai-off'] as const) {
    test(`worker handles ${change} between text and photo without unsafe or duplicate sends`, async ({
      assert,
    }) => {
      await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: true })
      const prepared = await prepareOutgoingImages(jid, base, connections, false, fetchImage)
      remember(prepared.images)
      const incomingId = randomUUID()
      await db.table('whatsapp_messages').insert({
        message_id: incomingId,
        jid,
        direction: 'in',
        sender_type: 'customer',
        body: 'Kirim foto pilihan',
        media_type: 'image',
        media_url: prepared.images[0].mediaUrl,
        status: 'received',
        created_at: new Date(),
      })
      const worker = Object.create(WhatsappListen.prototype) as any
      Object.assign(worker, {
        socketOpen: true,
        receivedPending: true,
        syncReadyAt: 0,
        ingesting: 0,
        ingestion: Promise.resolve(),
        stopping: false,
      })
      const sent: any[] = []
      const socket = {
        readMessages: async () => {},
        sendPresenceUpdate: async () => {},
        sendMessage: async (_jid: string, payload: any) => {
          sent.push(payload)
          if (sent.length === 1) {
            // Baileys append/replay events also contain already-persisted messages.
            // Even a no-op replay temporarily holds readyForAi for two seconds.
            await worker.ingestMessages([{ key: { id: incomingId, remoteJid: jid } }], true)
            if (change === 'customer')
              await db.table('whatsapp_messages').insert({
                message_id: randomUUID(),
                jid,
                direction: 'in',
                sender_type: 'customer',
                body: 'Bukan yang itu',
                status: 'received',
                created_at: new Date(),
              })
            if (change === 'cs') await setHandlingMode(jid, 'cs')
            if (change === 'disconnect') worker.socketOpen = false
            if (change === 'ai-off')
              await db.from('whatsapp_settings').where('id', 1).update({ ai_enabled: false })
          }
          return { key: { id: randomUUID() } }
        },
      }
      worker.socket = socket
      const trace = await startTrace(jid, { text: 'Foto pilihan' })
      const run = (await beginGoalTurn(jid, incomingId))!
      await worker.deliverAiDecision(
        run,
        socket,
        await readSettings(true),
        {
          ...base,
          message: 'Ini foto pilihannya',
          images: [{ url: prepared.images[0].mediaUrl, caption: 'Foto pilihan' }],
        },
        [],
        false,
        trace
      )
      const stored = await db
        .from('whatsapp_messages')
        .where('jid', jid)
        .where('sender_type', 'ai')
        .orderBy('id')
      assert.equal(sent.length, change === 'echo' ? 2 : 1)
      assert.lengthOf(stored, sent.length)
      if (change === 'echo') {
        assert.isTrue(Buffer.isBuffer(sent[1].image))
        assert.equal(stored[1].media_type, 'image')
        assert.equal(stored[1].status, 'sent')
        assert.equal((await readTrace(jid, trace.id))!.status, 'completed')
        const savedTrace = (await readTrace(jid, trace.id))!
        assert.equal(savedTrace.steps.find((step: any) => step.key === 'send').status, 'completed')
        assert.equal(
          savedTrace.steps.find((step: any) => step.key === 'send-image-1').label,
          'Gambar terkirim'
        )
        assert.notInclude(
          String((await readConversationGoal(jid)).last_error || ''),
          'konteks atau status berubah'
        )
      } else {
        assert.equal((await readTrace(jid, trace.id))!.status, 'cancelled')
      }
    }).timeout(15_000)
  }

  test('photo-only replies use image bytes and keep a local room preview', async ({ assert }) => {
    const decision = parseDecision(JSON.stringify(base))
    assert.lengthOf(decision.images!, 1)
    const prepared = await prepareOutgoingImages(jid, base, connections, false, fetchImage)
    remember(prepared.images)
    assert.lengthOf(prepared.images, 1)
    assert.equal((await sharp(prepared.images[0].bytes).metadata()).format, 'jpeg')
    assert.deepEqual(await readFile([...artifacts][0]), prepared.images[0].bytes)
    const sent: unknown[] = []
    await sendAiMessageSequence(
      prepared.decision,
      false,
      async () => true,
      async (body, _kind, image) => {
        sent.push(outgoingMessagePayload(body, image))
        return true
      },
      prepared.images
    )
    assert.lengthOf(sent, 1)
    assert.isTrue(Buffer.isBuffer((sent[0] as any).image))
    assert.equal((sent[0] as any).caption, 'Jas pilihan')
    assert.notProperty(sent[0], 'text')
  })

  test('known image URLs and markdown become photos, while ordinary product links stay text', async ({
    assert,
  }) => {
    const page = 'https://catalog.example/products/jas'
    const prepared = await prepareOutgoingImages(
      jid,
      { ...base, images: [], message: `Pilihan jas\n![Foto](${url})\n${page}`, initiative: url },
      connections,
      false,
      fetchImage
    )
    remember(prepared.images)
    assert.lengthOf(prepared.images, 1)
    assert.equal(prepared.decision.message, `Pilihan jas\n\n${page}`)
    assert.equal(prepared.decision.initiative, '')
    assert.equal(stripImageLinks(`<${url}>`, [url]), '')
  })

  test('direct CDN photos for the seventh verified MCP product remain sendable without trusting other paths', async ({
    assert,
  }) => {
    const mcpUrl = 'https://chameleoncloth.com/mcp'
    const verified = extractCatalogProducts(
      Array.from({ length: 7 }, (_, index) => ({
        server: 'business_chameleon-cloth',
        tool: 'get_product',
        arguments: { id: `product-${index}` },
        result: {
          structured_content: {
            id: `product-${index}`,
            name: `Jas ${index}`,
            img: `uploads/products/photo-${index}.png`,
          },
        },
      }))
    )
    assert.lengthOf(verified, 7)
    const products = verified.map((product) => ({
      ...product,
      imageUrls: catalogImageUrls(String(product.img), mcpUrl),
    }))
    const direct = 'https://cdn.chameleoncloth.com/uploads/products/photo-6.png'
    const decision = {
      ...base,
      images: [{ url: direct, caption: 'Pilihan jas' }],
      cartEvidence: { products, shipping: [] },
    }
    const active = [{ url: mcpUrl, enabled: true, authenticated: true }]
    const fetched: string[] = []
    const prepared = await prepareOutgoingImages(jid, decision, active, false, async (input) => {
      fetched.push(String(input))
      return fetchImage(input)
    })
    remember(prepared.images)
    assert.lengthOf(prepared.images, 1)
    assert.isNotEmpty(fetched)
    assert.include(fetched[0], 'photo-6.png')
    assert.isTrue(Buffer.isBuffer(outgoingMessagePayload('', prepared.images[0]).image))
    for (const bad of [
      'https://cdn.chameleoncloth.com/uploads/products/not-read.png',
      'https://cdn.chameleoncloth.com.evil.example/uploads/products/photo-6.png',
      'https://user:secret@cdn.chameleoncloth.com/uploads/products/photo-6.png',
      'https://cdn.chameleoncloth.com:444/uploads/products/photo-6.png',
    ]) {
      const count = fetched.length
      await assert.rejects(
        () =>
          prepareOutgoingImages(
            jid,
            { ...decision, images: [{ url: bad, caption: '' }] },
            active,
            false,
            async (input) => {
              fetched.push(String(input))
              return fetchImage(input)
            }
          ),
        /belum terverifikasi/
      )
      assert.equal(fetched.length, count)
    }
    await assert.rejects(
      () =>
        prepareOutgoingImages(
          jid,
          decision,
          [{ ...active[0], authenticated: false }],
          false,
          fetchImage
        ),
      /belum terverifikasi/
    )
  })

  test('rejects unverified URLs and failed downloads instead of sending links', async ({
    assert,
  }) => {
    let calls = 0
    const neverFetch: typeof fetch = async () => {
      calls++
      throw new Error('not allowed')
    }
    await assert.rejects(
      () =>
        prepareOutgoingImages(
          jid,
          { ...base, images: [{ url: 'https://other.example/secret.jpg', caption: '' }] },
          connections,
          false,
          neverFetch
        ),
      /belum terverifikasi/
    )
    assert.equal(calls, 0)
    await assert.rejects(
      () => prepareOutgoingImages(jid, base, connections, false, neverFetch),
      /belum berhasil dimuat/
    )
    await assert.rejects(
      () =>
        downloadOutgoingImage(url, async (_url, options) => {
          assert.equal(options?.redirect, 'error')
          return new Response('Not an image', { headers: { 'content-type': 'text/html' } })
        }),
      /tidak tersedia/
    )
    await assert.rejects(
      () =>
        downloadOutgoingImage(
          url,
          async () =>
            new Response('x', {
              headers: { 'content-type': 'image/png', 'content-length': '8000001' },
            })
        ),
      /terlalu besar/
    )
  })

  test('local media is restricted to the same room and remains a photo', async ({ assert }) => {
    const filename = `test-outgoing-${randomUUID()}.png`
    const path = app.makePath('public', 'media', filename)
    await sharp(png).toFile(path)
    artifacts.add(path)
    const mediaUrl = `${env.get('APP_BASE_PATH')}/media/${filename}`
    await db.table('whatsapp_messages').insert({
      jid,
      message_id: randomUUID(),
      direction: 'in',
      body: '',
      status: 'received',
      media_type: 'image',
      media_url: mediaUrl,
      created_at: new Date(),
    })
    const decision = { ...base, images: [{ url: mediaUrl, caption: '' }], cartEvidence: undefined }
    const prepared = await prepareOutgoingImages(jid, decision, [])
    remember(prepared.images)
    assert.lengthOf(prepared.images, 1)
    await assert.rejects(
      () => prepareOutgoingImages('10000000776656@lid', decision, []),
      /belum terverifikasi/
    )
  })

  test('handoff, silent and a changed conversation never send unwanted images', async ({
    assert,
  }) => {
    const prepared = await prepareOutgoingImages(jid, base, connections, false, fetchImage)
    remember(prepared.images)
    const sent: string[] = []
    let current = true
    assert.isFalse(
      await sendAiMessageSequence(
        { ...prepared.decision, message: 'Pilihan jas' },
        false,
        async () => current,
        async (body) => {
          sent.push(body)
          current = false
          return true
        },
        prepared.images
      )
    )
    assert.deepEqual(sent, ['Pilihan jas'])
    for (const decision of ['silent', 'handoff'] as const) {
      const parsed = parseDecision(JSON.stringify({ ...base, decision }))
      assert.deepEqual(parsed.images, [])
      assert.lengthOf((await prepareOutgoingImages(jid, parsed, connections)).images, 0)
    }
    const scheduled = await prepareOutgoingImages(
      jid,
      { ...base, message: 'Susulan', images: [], initiative: url },
      connections,
      true,
      fetchImage
    )
    assert.lengthOf(scheduled.images, 0)
  })
})
