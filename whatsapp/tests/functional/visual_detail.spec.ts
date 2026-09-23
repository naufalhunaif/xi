import { test } from '@japa/runner'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { createReply } from '#services/ai_service'
import { readSettings } from '#services/settings_service'
import db from '#services/workspace_database'
import env from '#start/env'
import { initializeDatabase } from '#services/init_model'

async function detailSkill() {
  return {
    name: 'cs-detail-visual',
    content: await readFile('skills/cs-detail-visual/SKILL.md', 'utf8'),
  }
}

function suit(doubled: boolean) {
  const buttons = doubled
    ? [
        [285, 350],
        [365, 350],
        [285, 410],
        [365, 410],
        [285, 470],
        [365, 470],
      ]
    : [
        [325, 365],
        [325, 425],
      ]
  const lapel = doubled
    ? '270,110 205,150 280,240 240,225 365,345 300,190'
    : '270,110 245,180 275,195 250,220 325,335 300,190'
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="650" height="740" viewBox="0 0 650 740">
  <rect width="650" height="740" fill="white"/>
  <path d="M270 110 L190 150 L125 365 L180 385 L220 260 L210 635 Q325 675 440 635 L430 260 L470 385 L525 365 L460 150 L380 110 Z" fill="#192c46" stroke="#111" stroke-width="4"/>
  <path d="M270 110 L325 335 L380 110" fill="white"/>
  <polygon points="${lapel}" fill="#334b68" stroke="#8296b0" stroke-width="3"/>
  <polygon points="${lapel}" transform="translate(650 0) scale(-1 1)" fill="#334b68" stroke="#8296b0" stroke-width="3"/>
  <path d="M325 340 L325 645" stroke="#8296b0" stroke-width="2"/>
  <rect x="230" y="490" width="62" height="25" fill="#334b68" stroke="#8296b0" stroke-width="3"/>
  <rect x="365" y="490" width="62" height="25" fill="#334b68" stroke="#8296b0" stroke-width="3"/>
  <path d="M370 275 L410 270" stroke="#8296b0" stroke-width="5"/>
  ${buttons.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="12" fill="#c4a25d" stroke="#111" stroke-width="3"/>`).join('')}
  </svg>`)
}

test.group('Detailed visual comparison', (group) => {
  group.each.skip(process.env.DISCOUNT_DB_TEST !== '1', 'Use the isolated --visual-match runner.')
  group.setup(async () => {
    if (process.env.DISCOUNT_DB_TEST !== '1') return
    if (!/^wa_discount_test_[a-f0-9]{16}$/.test(env.get('DB_DATABASE')))
      throw new Error('Disposable database required.')
    await initializeDatabase()
  })
  for (const scenario of [
    '',
    'WRONG_TARGET',
    'NO_MATCH',
    'MIXED_NO_MATCH',
    'OLD_REFERENCE',
    'STUCK_TARGET',
    ...(process.env.COMPACT_SKILL_FIXTURE_DIR
      ? [
          'SPLIT',
          'SPLIT_NO_MATCH',
          'SPLIT_WRONG_TARGET',
          'SPLIT_STUCK_TARGET',
          'SPLIT_COMPACT',
          'SPLIT_COMPACT_NO_MATCH',
        ]
      : []),
  ]) {
    test(`latest-reference comparison with full visual skill ${scenario}`, async ({ assert }) => {
      env.set('AI_COMPACT_REPLY_ENABLED', scenario.includes('COMPACT') as unknown as string)
      const directory = await mkdtemp(join(tmpdir(), 'wa-visual-detail-'))
      const png = await sharp(suit(false)).png().toBuffer()
      const server = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(png)
      })
      try {
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
        const address = server.address() as { port: number }
        await db.from('whatsapp_mcp_connections').where('slug', 'fixture').delete()
        await db.table('whatsapp_mcp_connections').insert({
          slug: 'fixture',
          name: 'Local fixture',
          url: `http://127.0.0.1:${address.port}/mcp`,
          enabled: true,
          updated_at: new Date(),
        })
        const path = join(directory, 'reference.png')
        await sharp(png).toFile(path)
        const events: any[] = []
        const splitSkills = scenario.startsWith('SPLIT')
          ? await Promise.all(
              (await readdir(process.env.COMPACT_SKILL_FIXTURE_DIR!))
                .filter((file) => file.endsWith('.md'))
                .map(async (file) => ({
                  name: file.replace(/\.md$/, ''),
                  content: await readFile(
                    join(process.env.COMPACT_SKILL_FIXTURE_DIR!, file),
                    'utf8'
                  ),
                }))
            )
          : [await detailSkill()]
        const result = await createReply(
          {
            aiProvider: 'chatgpt',
            codexBin: fileURLToPath(new URL('../fixtures/catalog_provider.mjs', import.meta.url)),
            skills: splitSkills,
            mcpConnections: [
              {
                slug: 'fixture',
                url: `http://127.0.0.1:${address.port}/mcp`,
                enabled: true,
                authenticated: true,
              },
            ],
          },
          `Bandingkan model pada foto yang dikutip ${scenario}`,
          undefined,
          scenario === 'OLD_REFERENCE'
            ? { type: 'image', path, messageId: 'latest-image' }
            : undefined,
          undefined,
          [
            {
              path,
              label: scenario === 'OLD_REFERENCE' ? 'OLD_REFERENCE' : 'Foto pelanggan yang dikutip',
              messageId: 'older-image',
            },
          ],
          (event) => {
            events.push(event)
          }
        )
        const prepared = events.find(
          (event) => event.key === 'catalog' && event.status === 'completed'
        )
        assert.equal(prepared.label, 'Referensi katalog dimuat')
        assert.equal(prepared.detail.matchStatus, 'not_evaluated')
        assert.notProperty(prepared.detail, 'products')
        if (scenario.endsWith('STUCK_TARGET')) {
          assert.equal(result.decision, 'handoff')
          assert.equal(result.message, '')
          assert.isNull(result.cartIntent)
          assert.deepEqual(result.images, [])
          return
        }
        assert.equal(result.decision, 'reply')
        if (scenario.endsWith('WRONG_TARGET')) {
          assert.equal(result.visualMatch?.targetImage, 1)
          assert.equal(result.visualMatch?.status, 'uncertain')
        } else if (scenario.endsWith('NO_MATCH')) {
          assert.equal(result.visualMatch?.status, 'no_match')
          assert.deepEqual(result.images, [])
          if (scenario === 'MIXED_NO_MATCH') {
            assert.deepEqual(
              result.cartIntent!.items.map((item) => [item.modelType, item.fulfillment]),
              [
                ['catalog', 'ready'],
                ['catalog', 'preorder'],
                ['custom', 'ready'],
              ]
            )
            assert.equal(result.cartIntent!.items[2].referenceMessageId, 'older-image')
            assert.isNull(result.cartIntent!.items[2].unitPrice)
          }
          assert.notMatch(result.message, /Maaf|custom atau ready/)
          const outcome = events.find(
            (event) => event.key === 'visual-match' && event.status === 'completed'
          )
          assert.equal(outcome.label, 'Tidak ada kandidat yang cocok')
          assert.deepEqual(outcome.detail.matchedProducts, [])
          assert.equal(result.visualMatch?.productId, '')
          assert.include(result.note, '"productId":""')
        } else assert.equal(result.message, 'Compared reference and catalog')
        if (scenario.startsWith('SPLIT')) {
          const observation = events.find(
            (event) => event.key === 'visual-observation' && event.status === 'completed'
          )
          assert.isDefined(observation)
          assert.equal(observation.detail.inputProfile.businessSources, 0)
          assert.equal(observation.detail.inputProfile.images, 2)
          assert.isBelow(observation.detail.inputProfile.estimatedTextTokens, 6000)
          assert.equal(
            events.find((event) => event.key === 'comparison' && event.status === 'completed')
              ?.detail.inputProfile.images,
            0
          )
          console.log(JSON.stringify({ scenario, observation: observation.detail.inputProfile }))
        }
        if (!scenario || scenario === 'SPLIT' || scenario === 'SPLIT_COMPACT') {
          const cachedEvents: any[] = []
          const cached = await createReply(
            {
              aiProvider: 'chatgpt',
              codexBin: fileURLToPath(new URL('../fixtures/catalog_provider.mjs', import.meta.url)),
              skills: splitSkills,
              mcpConnections: [
                {
                  slug: 'fixture',
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  enabled: true,
                  authenticated: true,
                },
              ],
            },
            `Bandingkan model pada foto yang dikutip ${scenario}`,
            undefined,
            { type: 'image', path, messageId: 'latest-image' },
            undefined,
            [],
            (event) => cachedEvents.push(event)
          )
          assert.equal(
            cachedEvents.find((event) => event.key === 'visual-cache')?.detail.source,
            'cache'
          )
          assert.isFalse(cachedEvents.some((event) => event.key === 'visual-observation'))
          assert.deepEqual(cached.visualMatch, result.visualMatch)
          assert.equal(cached.message, 'Compared reference and catalog')
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await rm(directory, { recursive: true, force: true })
      }
    })
  }

  test('quoted follow-up uses one text-only AI pass, but new detail/image or changed catalog requires full vision', async ({
    assert,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-followup-visual-'))
    let png = await sharp(suit(false)).png().toBuffer()
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(png)
    })
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
      await db.from('whatsapp_mcp_connections').where('slug', 'fixture').delete()
      await db.table('whatsapp_mcp_connections').insert({
        slug: 'fixture',
        name: 'Local fixture',
        url,
        enabled: true,
        updated_at: new Date(),
      })
      const path = join(directory, 'reference.png')
      await sharp(png).toFile(path)
      const settings = {
        aiProvider: 'chatgpt',
        codexBin: fileURLToPath(new URL('../fixtures/catalog_provider.mjs', import.meta.url)),
        skills: [await detailSkill()],
        conversationAccess: { jid: 'visual-room', anchorId: 10 },
        mcpConnections: [{ slug: 'fixture', url, enabled: true, authenticated: true }],
      }
      const initialEvents: any[] = []
      await createReply(
        settings,
        'Model ini apa?',
        undefined,
        { type: 'image', path, messageId: 'photo-1' },
        undefined,
        [],
        (event) => initialEvents.push(event)
      )
      assert.isTrue(initialEvents.some((event) => event.key === 'comparison'))
      const quoted = [
        { path, messageId: 'photo-1', label: 'Gambar yang dikutip', previouslyAnalyzed: true },
      ]
      const cachedEvents: any[] = []
      const reply = await createReply(
        settings,
        'Harganya berapa?',
        undefined,
        undefined,
        undefined,
        quoted,
        (event) => cachedEvents.push(event)
      )
      assert.equal(reply.message, 'Fresh follow-up answer from current business data')
      assert.equal(reply.visualMatch?.status, 'matched')
      assert.isFalse(cachedEvents.some((event) => event.key === 'comparison'))
      assert.equal(
        cachedEvents.find((event) => event.key === 'visual-followup')?.detail.source,
        'cache'
      )
      assert.equal(
        cachedEvents.filter((event) => event.key === 'analysis' && event.status === 'running')
          .length,
        1
      )
      assert.isTrue(cachedEvents.some((event) => event.key === 'reply-timing'))
      const newDetail: any[] = []
      await createReply(
        settings,
        'NEW_DETAIL berapa kancing lengan?',
        undefined,
        undefined,
        undefined,
        quoted,
        (event) => newDetail.push(event)
      )
      assert.isTrue(
        newDetail.some(
          (event) => event.key === 'visual-followup' && event.detail?.source === 'analysis'
        )
      )
      assert.isTrue(newDetail.some((event) => event.key === 'comparison'))
      const newPhoto: any[] = []
      await createReply(
        settings,
        'Foto baru',
        undefined,
        { type: 'image', path, messageId: 'photo-2' },
        undefined,
        [],
        (event) => newPhoto.push(event)
      )
      assert.isFalse(
        newPhoto.some(
          (event) => event.key === 'visual-followup' && event.detail?.source === 'cache'
        )
      )
      assert.isTrue(newPhoto.some((event) => event.key === 'comparison'))
      png = await sharp(suit(true)).png().toBuffer()
      const changed: any[] = []
      await createReply(
        settings,
        'Harganya sekarang?',
        undefined,
        undefined,
        undefined,
        quoted,
        (event) => changed.push(event)
      )
      assert.isTrue(
        changed.some(
          (event) =>
            event.key === 'visual-followup' &&
            event.detail?.reason === 'candidate_changed_or_more_detail_needed'
        )
      )
      assert.isTrue(changed.some((event) => event.key === 'comparison'))
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('missing new image never falls back to a readable older picture', async ({ assert }) => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-new-image-missing-'))
    try {
      const old = join(directory, 'older.png')
      await sharp(suit(false)).png().toFile(old)
      const settings = { skills: [], mcpConnections: [] }
      await assert.rejects(
        () =>
          createReply(
            settings,
            'Ini gambar baru',
            undefined,
            { type: 'image', path: join(directory, 'missing.png') },
            undefined,
            [{ path: old, label: 'Gambar lama' }]
          ),
        /Gambar terbaru belum dapat dibaca/
      )
      await assert.rejects(
        () =>
          createReply(settings, 'Ini gambar baru', undefined, undefined, undefined, [
            { path: join(directory, 'missing.png'), label: 'Terbaru' },
            { path: old, label: 'Gambar lama' },
          ]),
        /Gambar referensi utama belum dapat dibaca/
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('live model distinguishes same-color garments using construction and buttons, without inventing a rear view', async ({
    assert,
  }) => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-visual-behavior-'))
    try {
      const first = join(directory, 'customer.png')
      const second = join(directory, 'candidate.png')
      await sharp(suit(false)).png().toFile(first)
      await sharp(suit(true)).png().toFile(second)
      const settings = await readSettings(true)
      const result = await createReply(
        { ...settings, mcpConnections: [], paymentMethods: [] },
        'Apakah model pada dua gambar ini sama? Bandingkan lapel, kancing depan, dan belahan belakangnya.',
        undefined,
        { type: 'image', path: first },
        'Uji terisolasi pemilik: dua ilustrasi pakaian fiktif, bukan produk/pesanan nyata. Gambar pertama referensi, gambar kedua kandidat. Bandingkan bukti visual saja; tidak ada harga/stok terverifikasi. Jangan mengubah data atau mengirim WhatsApp.',
        [{ path: second, label: 'Kandidat untuk uji visual terisolasi' }]
      )
      assert.equal(result.decision, 'reply')
      const evidence = `${result.message}\n${result.reason}\n${result.note}`
      assert.match(evidence, /lapel/i)
      assert.match(evidence, /kancing/i)
      assert.match(evidence, /(?:2|dua)\s*(?:buah\s*)?kancing|kancing[^\n.]{0,40}(?:2|dua)/i)
      assert.match(evidence, /(?:6|enam)\s*(?:buah\s*)?kancing|kancing[^\n.]{0,40}(?:6|enam)/i)
      assert.match(
        evidence,
        /belakang[^\n.]{0,100}(?:tidak|belum)|(?:tidak|belum)[^\n.]{0,100}belakang/i
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
    .skip(process.env.AI_SKILL_LIVE_TEST !== '1')
    .timeout(180_000)
})
