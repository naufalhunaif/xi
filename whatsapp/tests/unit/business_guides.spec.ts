import { test } from '@japa/runner'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'
import sharp from 'sharp'
import {
  extractBusinessGuides,
  guideMediaUrl,
  parseBusinessMedia,
} from '#services/business_guide_contract'
import {
  downloadGuideMedia,
  selectedBusinessGuides,
  prepareBusinessGuideMedia,
} from '#services/business_guide_media_service'
import { outgoingMessagePayload } from '#services/outgoing_image_service'
import { parseDecision, type AiDecision } from '#services/ai_service'
import { sendAiMessageSequence } from '#services/ai_message_sequence'
import { inWorkspace } from '#services/workspace_context'
import { mcpMediaFetch } from '#services/mcp_oauth_fetch'

const connections = [
  { slug: 'store', url: 'https://catalog.example/mcp', enabled: true, authenticated: true },
]
const record = {
  id: 'waist',
  title: 'Waist tutorial',
  media: { url: 'https://files.example/waist.mp4', mime_type: 'video/mp4' },
}
const call = (result: any, tool = 'get_tutorial') => ({ server: 'business_store', tool, result })
const evidence = () => extractBusinessGuides([call({ structuredContent: record })], connections)
const decision = (): AiDecision => ({
  decision: 'reply',
  message: '',
  reason: '',
  note: '',
  businessMedia: [{ server: 'business_store', id: 'waist', caption: '' }],
  guideEvidence: evidence(),
})
// ISO BMFF header fixture; transport tests do not play a video or contact WhatsApp.
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex')
const response =
  (bytes = mp4, mime = 'video/mp4'): typeof fetch =>
  async () =>
    new Response(new Uint8Array(bytes), { headers: { 'content-type': mime } })

test.group('MCP business guide interoperability', () => {
  test('normalizes Codex/Claude envelopes and generic records without trusting prose', ({
    assert,
  }) => {
    for (const result of [
      { structuredContent: { data: { records: [record] } } },
      { structured_content: record },
      { content: [{ type: 'text', text: JSON.stringify({ result: { tutorial: record } }) }] },
    ])
      assert.lengthOf(extractBusinessGuides([call(result)], connections), 1)
    const generic = {
      ...call({ structuredContent: [record] }, 'list_records'),
      arguments: { table: 'tutorials' },
    }
    assert.lengthOf(extractBusinessGuides([generic], connections), 1)
    assert.lengthOf(
      extractBusinessGuides([{ ...generic, arguments: { table: 'customers' } }], connections),
      0
    )
    for (const result of [
      { isError: true, structuredContent: record },
      { structuredContent: { success: false, data: record } },
      { structuredContent: { ...record, status: 'draft' } },
      { content: [{ type: 'text', text: record.media.url }] },
    ])
      assert.lengthOf(extractBusinessGuides([call(result)], connections), 0)
    assert.lengthOf(
      extractBusinessGuides(
        [call({ structuredContent: record })],
        [{ ...connections[0], authenticated: false }]
      ),
      0
    )
    assert.lengthOf(
      extractBusinessGuides(
        [
          call({ structuredContent: record }),
          call({ structuredContent: { ...record, enabled: false } }),
        ],
        connections
      ),
      0
    )
    const chart = {
      ...record,
      kind: 'size_chart',
      media: { url: '/sizes.jpg', mime_type: 'image/jpeg' },
    }
    const charts = extractBusinessGuides(
      [call({ structuredContent: { size_chart: chart } }, 'get_size_chart')],
      connections
    )
    assert.equal(charts[0].kind, 'size_chart')
    assert.equal(charts[0].url, 'https://catalog.example/sizes.jpg')
  })
  test('URL constraints reject credentials, fragments, external HTTP and local-address downloads', async ({
    assert,
  }) => {
    assert.equal(
      guideMediaUrl('/chart.png', connections[0].url),
      'https://catalog.example/chart.png'
    )
    for (const url of [
      'file:///etc/passwd',
      'http://files.example/file.mp4',
      'https://user:pass@files.example/file',
      'https://files.example/file#token',
    ])
      assert.isNull(guideMediaUrl(url, connections[0].url))
    assert.equal(
      guideMediaUrl('/video.mp4', 'http://localhost:3333/mcp'),
      'http://localhost:3333/video.mp4'
    )
    await assert.rejects(() => mcpMediaFetch(connections[0].url)('https://127.0.0.1/private'))
  })
  test('media-only replies parse; handoff/silent suppress media; invalid IDs do not resolve', ({
    assert,
  }) => {
    const parsed = parseDecision(JSON.stringify(decision()))
    assert.lengthOf(parsed.businessMedia!, 1)
    assert.notProperty(parsed, 'guideEvidence') // Model cannot manufacture trusted evidence.
    for (const mode of ['handoff', 'silent'])
      assert.deepEqual(
        parseDecision(JSON.stringify({ ...decision(), decision: mode })).businessMedia,
        []
      )
    assert.throws(() =>
      parseBusinessMedia([{ server: 'https://evil.example', id: '1', caption: '' }])
    )
    assert.throws(() => selectedBusinessGuides({ ...decision(), guideEvidence: [] }, connections))
    assert.throws(() => selectedBusinessGuides(decision(), [{ ...connections[0], enabled: false }]))
    assert.throws(() =>
      selectedBusinessGuides(decision(), [{ ...connections[0], url: 'https://other.example/mcp' }])
    )
  })
  test('validates binary media; rejects HTML, fake MIME, expired URLs, wrong kind and oversized files', async ({
    assert,
  }) => {
    const guide = evidence()[0]
    const video = await downloadGuideMedia(guide, response())
    assert.equal(video.type, 'video')
    for (const fetcher of [
      response(Buffer.from('<html>login</html>'), 'text/html'),
      response(Buffer.from('<html>login</html>')),
      async () =>
        new Response(null, { status: 302, headers: { location: 'https://other.example/' } }),
      async () => new Response(null, { status: 403 }),
      async () =>
        new Response('x', {
          headers: { 'content-type': 'video/mp4', 'content-length': String(17 * 1024 * 1024) },
        }),
    ])
      await assert.rejects(() => downloadGuideMedia(guide, fetcher as typeof fetch))
    await assert.rejects(() => downloadGuideMedia({ ...guide, kind: 'size_chart' }, response()))
    const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#fff' } })
      .png()
      .toBuffer()
    const chart = await downloadGuideMedia(
      { ...guide, kind: 'size_chart', mime: 'image/png' },
      response(png, 'image/png')
    )
    assert.equal(chart.type, 'image')
    assert.equal(chart.mime, 'image/jpeg')
    const pdf = await downloadGuideMedia(
      { ...guide, kind: 'size_chart', mime: 'application/pdf' },
      response(Buffer.from('%PDF-1.7\nfixture\n%%EOF'), 'application/pdf')
    )
    assert.equal(pdf.type, 'document')
  })
  test('sends MP4 bytes rather than links; room changes stop the next bubble; cache is per number', async ({
    assert,
  }) => {
    await inWorkspace({ id: 987, prefix: 'w987_', phone: null, version: 'fixture' }, async () => {
      const input = { ...decision(), message: `Panduan ${record.media.url}` }
      await assert.rejects(() =>
        prepareBusinessGuideMedia(
          'fixture@lid',
          { ...input, businessMedia: [] },
          connections,
          response()
        )
      )
      const prepared = await prepareBusinessGuideMedia(
        randomUUID() + '@lid',
        input,
        connections,
        response()
      )
      const media = prepared.media[0]
      try {
        assert.include(media.mediaUrl, '/w987_guide-')
        assert.notInclude(prepared.decision.message, record.media.url)
        const payload = outgoingMessagePayload('', media)
        assert.property(payload, 'video')
        assert.notProperty(payload, 'text')
        assert.deepEqual((payload as any).video, mp4)
        let sends = 0
        const done = await sendAiMessageSequence(
          prepared.decision,
          false,
          async () => sends === 0,
          async () => {
            sends++
            return true
          },
          prepared.media
        )
        assert.isFalse(done)
        assert.equal(sends, 1)
        let videos = 0
        await sendAiMessageSequence(
          { ...prepared.decision, message: '' },
          false,
          async () => true,
          async (_body, _kind, attachment) => {
            videos++
            assert.equal(attachment?.mediaType, 'video')
            return true
          },
          prepared.media
        )
        assert.equal(videos, 1)
      } finally {
        await unlink(app.makePath('public', 'media', media.mediaUrl.split('/').pop()!))
      }
    })
  })
})
