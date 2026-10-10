import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import db from '#services/workspace_database'
import { resetJevCache, saveJevConfig, setJevFetcher } from '#beta3/jev'
import { checkReply, photoCaptions, relevantFacts, revisionNote } from '#beta3/reply_check'
import { deterministicIssues, isSimJid, loadScenarios, transcript, type SimTurn } from '#beta3/simulator'
import { allowedPrices } from '#beta3/quality_service'
import { listLeanOrders, countLeanOrders } from '#beta3/order_service'
import type { LeanCatalogRow } from '#beta3/catalog_service'

const row = (product: string, color: string, extra: Partial<LeanCatalogRow> = {}): LeanCatalogRow => ({
  id: 0,
  product,
  color,
  category: 'Suits',
  price: 485000,
  sizesReady: '',
  sizesAll: 'S M L XL',
  photoUrl: `https://example.test/${product}-${color}.jpg`.replace(/\s+/g, '-'),
  materialAvailable: true,
  features: '',
  featuresAi: '',
  material: 'Maximotion',
  sizeGroup: 'S-4XL',
  fit: '',
  note: 'XXL-3XL 585.000',
  active: true,
  updatedAt: new Date().toISOString(),
  ...extra,
})
const catalog = [
  row('Basic Suit', 'Navy', { sizesReady: 'S L XL' }),
  row('Basic Suit', 'Maroon', { sizesReady: 'S M L XL XXL' }),
  row('Basic Suit', 'Gray', { photoUrl: null }),
  row('Tuxedo', 'Black'),
  row('Beskap Premium', 'Sage Green', { price: 685000, photoUrl: null }),
]

const jevReply = (answers: Record<string, unknown>) =>
  (async () =>
    new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
const choice = (value: string, confidence = 0.92) => ({ type: 'choice', choice: value, probabilities: {}, confidence })

test.group('pemeriksa balasan (Jev) sebelum kirim (v3.6.78)', (group) => {
  group.each.setup(async () => {
    const clean = () => db.from('whatsapp_beta3_state').whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error']).delete().catch(() => {})
    await clean()
    return async () => {
      setJevFetcher(null)
      await clean()
      resetJevCache()
    }
  })

  test('foto yang tidak ada di katalog ditandai tanpa Jev; caption = "Produk - Warna"', async ({ assert }) => {
    const { sent, missing } = photoCaptions(catalog, ['Basic Suit - Navy', 'Basic Suit - Gray', 'Kemeja Batik'])
    assert.deepEqual(sent, ['Basic Suit - Navy'])
    assert.deepEqual(missing, ['Basic Suit - Gray', 'Kemeja Batik'])
    const result = await checkReply({
      jid: 'cek@s.whatsapp.net',
      customerText: 'liat yg abu dong',
      history: [],
      decision: { pesan: ['Ini fotonya bos'], foto: ['Basic Suit - Gray'], serah_cs: false },
      rows: catalog,
    })
    assert.equal(result.jev, false)
    assert.deepEqual(result.issues.map((issue) => issue.code), ['foto_tidak_ada'])
  })

  test('fakta yang relevan: produk yang disebut saja, warna bertanda foto & size ready', ({ assert }) => {
    const facts = relevantFacts(catalog, ['ada beskap premium ijo?', 'Ada bos'])
    assert.lengthOf(facts, 1)
    assert.include(facts[0], 'Beskap Premium')
    assert.include(facts[0], '685.000')
    const basic = relevantFacts(catalog, ['basic suit navy'])[0]
    assert.include(basic, 'Navy ✓ [S L XL]')
    assert.include(basic, 'Gray')
    assert.notInclude(basic, 'Gray ✓')
    assert.include(basic, 'XXL+ 585.000')
  })

  test('Jev yakin foto kurang + maksud terlewat → dua masalah; ragu → tidak dipakai', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    let sent: any = null
    setJevFetcher((async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return (
        jevReply({
          foto: choice('kurang'),
          jawab: { type: 'score', score: 1, confidence: 0.9 },
          fakta: choice('bertentangan', 0.5),
          ulang: { type: 'noul', noul: 0.1 },
        }) as any
      )()
    }) as unknown as typeof fetch)
    const result = await checkReply({
      jid: 'cek@s.whatsapp.net',
      customerText: 'kirimin fotonya basic suit yg navy sm yg maroon, sama size L ada?',
      history: [{ direction: 'out', body: 'Halo bos', createdAt: new Date() }],
      decision: { pesan: ['Ini fotonya bos'], foto: ['Basic Suit - Navy'], serah_cs: false },
      rows: catalog,
    })
    assert.isTrue(result.jev)
    assert.deepEqual(result.issues.map((issue) => issue.code).sort(), ['foto_kurang', 'tidak_menjawab'])
    // Jev menilai maksud dari pesan, balasan, foto yang benar-benar terkirim, dan fakta katalog.
    assert.deepEqual(sent.state.foto_dikirim, ['Basic Suit - Navy'])
    assert.include(sent.state.fakta_katalog[0], 'Basic Suit')
    assert.includeMembers(Object.keys(sent.questions), ['foto', 'jawab', 'fakta', 'ulang'])
    const note = revisionNote({ pesan: ['Ini fotonya bos'], foto: ['Basic Suit - Navy'] }, result.issues)
    assert.include(note, 'PEMERIKSA BALASAN')
    assert.include(note, 'Basic Suit - Navy')
  })

  test('pemeriksa dimatikan di pengaturan Jev → hanya pemeriksaan pasti', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true, off: ['cek_balasan'] })
    let called = false
    setJevFetcher((async () => {
      called = true
      return (jevReply({}) as any)()
    }) as unknown as typeof fetch)
    const result = await checkReply({
      jid: 'cek@s.whatsapp.net',
      customerText: 'navy ada?',
      history: [],
      decision: { pesan: ['Ada bos'], foto: [], serah_cs: false },
      rows: catalog,
    })
    assert.isFalse(called)
    assert.deepEqual(result, { issues: [], jev: false })
  })

  test('reply_service: aturan grosir selalu ikut; draf diperiksa lalu ditulis ulang sekali', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, 'const store = [storeProfile, wholesale, renderPromoRule(promoState, now, digest.rows)]')
    assert.include(source, "'beta3-revise'")
    assert.include(source, 'revisionNote(decision, check.issues)')
  })
})

test.group('uji percakapan (simulasi) (v3.6.78)', () => {
  const turn = (balasan: string[], extra: Partial<SimTurn> = {}): SimTurn => ({
    pelanggan: 'x',
    balasan,
    foto: [],
    serah_cs: false,
    alasan: '',
    jejak: [],
    ms: 1,
    ...extra,
  })

  test('skenario: id unik, ada giliran, pola harap valid, bahasa beragam', async ({ assert }) => {
    const scenarios = await loadScenarios()
    assert.isAtLeast(scenarios.length, 35)
    assert.equal(new Set(scenarios.map((item) => item.id)).size, scenarios.length)
    for (const item of scenarios) {
      assert.isAbove(item.maksud.length, 20, item.id)
      for (const pattern of [...(item.harap?.sebut || []), ...(item.harap?.tidak_sebut || [])]) new RegExp(pattern, 'i')
    }
    const all = scenarios.flatMap((item) => item.giliran).join('\n')
    for (const sample of ['isih ono ra', 'aya jas', 'awak mau', 'do u have', '👔', 'setengah lusin', 'kurng'])
      assert.include(all, sample)
  })

  test('pemeriksaan pasti: harga asing, tidak membalas, serah CS tanpa perlu, kata wajib, foto', ({ assert }) => {
    const allowed = allowedPrices([row('Basic Suit', 'Navy')], [])
    const issues = deterministicIssues(
      { harap: { serah_cs: false, sebut: ['15\\.000'], foto: true } },
      [turn(['Basic Suit 485.000 bos, diskon jadi 455.000']), turn([]), turn(['Saya tanyakan ke tim ya'], { serah_cs: true, alasan: 'grosir' })],
      allowed
    )
    assert.isTrue(issues.some((item) => item.includes('455.000')))
    assert.isTrue(issues.some((item) => item.startsWith('Giliran 2: tidak membalas')))
    assert.isTrue(issues.some((item) => item.startsWith('Diserahkan ke CS padahal bisa dijawab')))
    assert.isTrue(issues.some((item) => item.includes('15\\.000')))
    assert.isTrue(issues.some((item) => item === 'Seharusnya mengirim foto.'))
    assert.isFalse(issues.some((item) => item.includes('485.000')))
    const text = transcript([turn(['Ini fotonya bos'], { foto: ['Basic Suit - Navy'], pelanggan: 'navy?' })])
    assert.equal(text, 'Pelanggan: navy?\nAI: Ini fotonya bos\nAI: [foto] Basic Suit - Navy')
  })

  test('jid uji tidak pernah tampil di daftar order & tidak bisa dikirimi pesan', async ({ assert }) => {
    assert.isTrue(isSimJid('uji-a-1@sim'))
    assert.isFalse(isSimJid('6281200000000@s.whatsapp.net'))
    const jid = 'uji-test-0@sim'
    await listLeanOrders()
    await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    const before = (await countLeanOrders()) as Record<string, number>
    await db.table('whatsapp_beta3_orders').insert({ jid, status: 'pending', items: 'Basic Suit - Navy', created_at: new Date(), updated_at: new Date() })
    try {
      const orders = await listLeanOrders()
      assert.isFalse(orders.some((order: Record<string, any>) => order.jid === jid))
      const after = (await countLeanOrders()) as Record<string, number>
      assert.equal(after.all, before.all)
    } finally {
      await db.from('whatsapp_beta3_orders').where('jid', jid).delete()
    }
    const { queueOutgoingMessage } = await import('#services/message_service')
    await assert.rejects(() => queueOutgoingMessage({ jid, body: 'tes' }))
  })
})

test.group('uji percakapan · ujung ke ujung dengan AI tiruan (v3.6.78)', (group) => {
  group.each.setup(async () => {
    const clean = async () => {
      await db.from('whatsapp_beta3_state').whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error']).delete().catch(() => {})
      await db.from('whatsapp_beta3_catalog').where('product', 'Jas Uji').delete().catch(() => {})
    }
    await clean()
    return async () => {
      setJevFetcher(null)
      const { setLeanProviderOverride } = await import('#beta3/provider')
      setLeanProviderOverride(null)
      await clean()
      resetJevCache()
    }
  })

  test('draf foto kurang → Jev menandai → AI menulis ulang → foto sesuai; data uji terhapus', async ({ assert }) => {
    const { importLeanCatalog, catalogDigest } = await import('#beta3/catalog_service')
    const { setLeanProviderOverride } = await import('#beta3/provider')
    const { readSettings } = await import('#services/settings_service')
    const { runScenario } = await import('#beta3/simulator')
    await importLeanCatalog([
      { product: 'Jas Uji', color: 'Navy', price: 485000, category: 'Suits', photoUrl: 'https://example.test/navy.jpg', sizesReady: 'S M L' },
      { product: 'Jas Uji', color: 'Maroon', price: 485000, category: 'Suits', photoUrl: 'https://example.test/maroon.jpg', sizesReady: 'M L' },
    ])
    await catalogDigest(true)
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    const checked: string[][] = []
    setJevFetcher((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      if (!body.questions.foto) return (jevReply({}) as any)()
      checked.push(body.state.foto_dikirim)
      return (jevReply({ foto: choice('kurang'), jawab: { type: 'score', score: 2, confidence: 0.9 }, fakta: choice('sesuai'), ulang: { type: 'noul', noul: 0.05 } }) as any)()
    }) as unknown as typeof fetch)
    const decision = (foto: string[]) =>
      JSON.stringify({ pesan: ['Ini fotonya bos, 485.000'], foto, catatan: 'produk: Jas Uji', tahap: 'tanya_size', serah_cs: false, alasan: '', susulan: '', spesifikasi: '' })
    const phases: string[] = []
    setLeanProviderOverride(async ({ phase, prompt }) => {
      phases.push(phase)
      if (phase === 'beta3-sim-judge') return JSON.stringify({ nilai: 5, lulus: true, masalah: [] })
      if (phase === 'beta3-revise') {
        assert.include(prompt.user, 'PEMERIKSA BALASAN')
        return decision(['Jas Uji - Navy', 'Jas Uji - Maroon'])
      }
      if (phase === 'beta3-reply') return decision(['Jas Uji - Navy'])
      return '{}'
    })
    const settings = await readSettings(true)
    const result = await runScenario(
      {
        id: 'e2e',
        judul: 'Foto dua warna',
        maksud: 'Kirim foto Jas Uji Navy dan Maroon.',
        giliran: ['kirimin fotonya jas uji yg navy sm yg maroon dong'],
        harap: { serah_cs: false, foto: true, sebut: ['485\\.000'] },
      },
      { ...settings, aiProvider: 'chatgpt' } as any,
      { facts: 'Jas Uji 485.000' }
    )
    assert.deepEqual(result.masalah, [])
    assert.isTrue(result.lulus)
    assert.deepEqual(result.giliran[0].foto, ['Jas Uji - Navy', 'Jas Uji - Maroon'])
    assert.deepEqual(checked, [['Jas Uji - Navy']])
    assert.includeMembers(phases, ['beta3-reply', 'beta3-revise', 'beta3-sim-judge'])
    assert.isTrue(result.giliran[0].jejak.some((step) => step.includes('Pemeriksa balasan')))
    assert.isTrue(result.giliran[0].jejak.some((step) => step.includes('ditulis ulang')))
    const leftovers = await db.from('whatsapp_beta3_chats').where('jid', 'like', 'uji-e2e-%@sim')
    assert.lengthOf(leftovers, 0)
  })

  test('ruang simulasi: pesan diproses di latar, balasan + foto tersimpan, reset membersihkan', async ({ assert }) => {
    const { importLeanCatalog, catalogDigest } = await import('#beta3/catalog_service')
    const { setLeanProviderOverride } = await import('#beta3/provider')
    const { readSettings } = await import('#services/settings_service')
    const { sendSimRoom, simRoom, resetSimRoom } = await import('#beta3/simulator')
    await importLeanCatalog([{ product: 'Jas Uji', color: 'Navy', price: 485000, category: 'Suits', photoUrl: 'https://example.test/navy.jpg', sizesReady: 'S M L' }])
    await catalogDigest(true)
    setLeanProviderOverride(async ({ phase }) =>
      phase === 'beta3-reply'
        ? JSON.stringify({ pesan: ['Jas Uji Navy 485.000 bos'], foto: ['Jas Uji - Navy'], catatan: 'produk: Jas Uji', tahap: 'tanya_size', serah_cs: false, alasan: '', susulan: '', spesifikasi: '' })
        : '{}'
    )
    const settings = { ...(await readSettings(true)), aiProvider: 'chatgpt' } as any
    await resetSimRoom()
    assert.deepEqual(await sendSimRoom(settings, { teks: 'jas uji navy brp' }), { started: true })
    assert.equal((await sendSimRoom(settings, { teks: 'lagi' })).started, false)
    let room = await simRoom()
    for (let i = 0; i < 50 && room.busy; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      room = await simRoom()
    }
    assert.isFalse(room.busy)
    assert.lengthOf(room.turns, 1)
    assert.deepEqual(room.turns[0].balasan, ['Jas Uji Navy 485.000 bos'])
    assert.deepEqual(room.turns[0].foto, ['Jas Uji - Navy'])
    assert.deepEqual(room.turns[0].fotoUrl, ['https://example.test/navy.jpg'])
    await resetSimRoom()
    assert.lengthOf((await simRoom()).turns, 0)
  })
})

test.group('uji acak, foto selaras, grosir lolos pemeriksa harga (v3.6.79)', () => {
  test('pembuat skenario: seed sama → sama; semua jenis ada; bahasa diacak; jawaban dari katalog', async ({ assert }) => {
    const { generateScenarios, GENERATOR_KINDS, roughen, rng } = await import('#beta3/sim_generator')
    const rows = [
      row('Basic Suit', 'Black 2.0', { sizesReady: 'S M L XL' }),
      row('Basic Suit', 'Navy', { sizesReady: 'S L' }),
      row('Basic Suit', 'Maroon'),
      row('Tuxedo', 'Black', { sizesReady: 'S M' }),
      row('Tuxedo', 'White'),
    ]
    const a = generateScenarios(rows, 40, 7)
    const b = generateScenarios(rows, 40, 7)
    assert.deepEqual(a, b)
    assert.lengthOf(a, 40)
    for (const kind of GENERATOR_KINDS) assert.isTrue(a.some((item) => item.id.startsWith(`gen-${kind === 'lanjutfoto' ? 'lanjut' : kind}-`)), kind)
    const harga = a.find((item) => item.id.startsWith('gen-harga-'))!
    assert.deepEqual(harga.harap?.sebut, ['485\\.000'])
    const foto = a.find((item) => item.id.startsWith('gen-foto-'))!
    assert.isAbove(foto.harap?.foto_persis?.length || 0, 0)
    const grosir = a.filter((item) => item.id.startsWith('gen-grosir-'))
    assert.isTrue(grosir.every((item) => /≥|</.test(item.maksud)))
    const gambar = a.find((item) => item.id.startsWith('gen-gambar-'))!
    assert.match(String((gambar.giliran[0] as any).gambar), / - /)
    const variants = new Set(Array.from({ length: 30 }, (_, index) => roughen(rng(index), 'yang warna hitam harga berapa kalau ukuran L')))
    assert.isAbove(variants.size, 20)
  })

  test('foto diselaraskan: warna yang disebut ikut, yang tidak disebut tidak ditambah', async ({ assert }) => {
    const reply = await import('#beta3/reply_check')
    const { alignPhotos } = reply
    const rows = [row('Tux', 'Army'), row('Tux', 'Black'), row('Tux', 'Brown'), row('Tux', 'Navy'), row('Tux', 'White'), row('Tux', 'Gray', { photoUrl: null })]
    const one = alignPhotos(['Ini fotonya bos, ada Navy dan Putih juga'], ['Tux - Black'], rows)
    assert.deepEqual(one.added, ['Tux - Navy', 'Tux - White'])
    // Tanpa menyebut warna lain → tidak ditambah (daftar warna di teks menentukan, bukan jumlah foto).
    const many = alignPhotos(['Ini warnanya bos'], ['Tux - Army', 'Tux - Black', 'Tux - Brown'], rows)
    assert.deepEqual(many.added, [])
    assert.deepEqual(alignPhotos(['Ini fotonya'], ['Tux - Black'], rows).added, [])
  })

  test('pemeriksa harga: potongan grosir & harga sesudah potongan sah', async ({ assert }) => {
    const { unknownPrices } = await import('#beta3/quality_service')
    const allowed = allowedPrices([row('Basic Suit', 'Navy')], [], { jas: 15000, setelan: 25000 })
    assert.deepEqual(unknownPrices(['Mulai 6 jas dapat potongan 15.000 per jas, jadi 470.000 bos'], allowed), [])
    assert.deepEqual(unknownPrices(['potongan 99.000'], allowed), [99000])
  })
})

test.group('Hati: acara orang lain tanpa ucapan selamat (v3.6.79)', () => {
  test('acara_lain → saran sesuai acara, tidak "selamat"; nikah sendiri tetap selamat', async ({ assert }) => {
    const { heartNote } = await import('#beta3/hati')
    assert.notInclude(heartNote({ form: 'bertanya', feeling: 'netral', moment: 'acara_lain' } as any), 'selamat ya')
    assert.include(heartNote({ form: 'bertanya', feeling: 'netral', moment: 'nikah' } as any), 'selamat')
    const source = await readFile('app/beta3/jev_decisions.ts', 'utf8')
    assert.include(source, 'MILIKNYA SENDIRI')
  })
})

test.group('ongkir: cari tujuan bertahap (v3.6.79)', () => {
  test('"tambun selatan bekasi" kosong → "tambun selatan" disaring kota Bekasi', async ({ assert }) => {
    const { searchDestinations } = await import('#beta3/reply_service')
    const calls: string[] = []
    const data: Record<string, Array<{ district: string; city: string }>> = {
      'tambun selatan': [
        { district: 'TAMBUN SELATAN', city: 'KAB. BEKASI' },
        { district: 'TAMBUN SELATAN', city: 'BEKASI' },
      ],
    }
    const found = await searchDestinations('tambun selatan bekasi', async (query) => {
      calls.push(query)
      return data[query] || []
    })
    assert.deepEqual(calls, ['tambun selatan bekasi', 'tambun selatan'])
    assert.lengthOf(found, 2)
    assert.deepEqual(await searchDestinations('zzz qqq', async () => []), [])
  })
})

test.group('tautan karangan tidak dikirim (v3.6.79)', () => {
  test('link maps yang tidak ada di data dibuang; link sah tetap', async ({ assert }) => {
    const { stripUnknownLinks } = await import('#beta3/reply_check')
    const made = stripUnknownLinks(['Lokasi di Cilacap bos, ini maps-nya https://maps.app.goo.gl/cilacap', 'Buka Senin-Jumat'], ['TOKO: Patimuan, Cilacap'])
    assert.deepEqual(made.removed, ['https://maps.app.goo.gl/cilacap'])
    assert.deepEqual(made.pesan, ['Lokasi di Cilacap bos', 'Buka Senin-Jumat'])
    const ok = stripUnknownLinks(['Peta: https://maps.app.goo.gl/AbC123'], ['map_url https://maps.app.goo.gl/AbC123'])
    assert.deepEqual(ok.removed, [])
  })
})

test.group('foto selaras: daftar warna bukan janji foto (v3.6.79)', () => {
  test('menyebut >3 warna (daftar) → foto tidak ditambah', async ({ assert }) => {
    const { alignPhotos } = await import('#beta3/reply_check')
    const rows = [row('Tux', 'Army'), row('Tux', 'Black'), row('Tux', 'Brown'), row('Tux', 'Navy'), row('Tux', 'White')]
    const list = alignPhotos(['Warnanya ada Army, Black, Brown, Navy, Putih bos'], ['Tux - Black'], rows)
    assert.deepEqual(list.added, [])
  })
})

test.group('chat nyata → skenario; jawaban "kab" untuk pilihan tujuan (v3.6.80)', () => {
  test('realSegments: pesan pelanggan beruntun → balasan CS manusia; dijawab AI tidak dipakai', async ({ assert }) => {
    const { realSegments } = await import('#beta3/simulator')
    const at = (m: number) => new Date(Date.UTC(2026, 9, 1, 8, m))
    const base = { jid: 'x@s.whatsapp.net', media_type: null, media_url: null }
    const segments = realSegments([
      { ...base, direction: 'in', sender_type: 'customer', body: 'min', created_at: at(0) },
      { ...base, direction: 'in', sender_type: 'customer', body: 'tuxedo item brp', created_at: at(1) },
      { ...base, direction: 'out', sender_type: 'cs', body: '485.000 bos', created_at: at(2) },
      { ...base, direction: 'in', sender_type: 'customer', body: '', media_type: 'image', media_url: '/media/w2_a.jpg', created_at: at(3) },
      { ...base, direction: 'in', sender_type: 'customer', body: 'yg ini ada?', created_at: at(4) },
      { ...base, direction: 'out', sender_type: 'owner', body: 'ada bos', created_at: at(5) },
      { ...base, direction: 'in', sender_type: 'customer', body: 'ok', created_at: at(6) },
      { ...base, direction: 'out', sender_type: 'ai', body: 'siap', created_at: at(7) },
    ])
    assert.deepEqual(segments, [
      { teks: 'min\ntuxedo item brp', gambar: undefined, jawaban: ['485.000 bos'], mulai: 0 },
      { teks: 'yg ini ada?', gambar: '/media/w2_a.jpg', jawaban: ['ada bos'], mulai: 3 },
    ])
  })

  test('pembuat skenario punya pesan dua maksud', async ({ assert }) => {
    const { generateScenarios } = await import('#beta3/sim_generator')
    const rows = [row('Basic Suit', 'Black 2.0', { sizesReady: 'S M L XL' }), row('Basic Suit', 'Navy'), row('Tuxedo', 'Black'), row('Tuxedo', 'White')]
    const gabung = generateScenarios(rows, 60, 3).filter((item) => item.id.startsWith('gen-gabung-'))
    assert.isAbove(gabung.length, 0)
    assert.include(gabung[0].maksud, 'DUA maksud')
  })

  test('pickArea: "kab" / "kota" memilih Kabupaten atau Kota', async ({ assert }) => {
    const { pickArea } = await import('#beta3/mcp')
    const areas = [
      { code: 'A', district: 'TAMBUN SELATAN', city: 'KAB. BEKASI', label: 'Tambun Selatan, Kab. Bekasi', terms: '' },
      { code: 'B', district: 'TAMBUN SELATAN', city: 'BEKASI', label: 'Tambun Selatan, Bekasi', terms: '' },
    ]
    assert.equal(pickArea('kab', areas)?.code, 'A')
    assert.equal(pickArea('yg kota', areas)?.code, 'B')
  })
})

test.group('uji acak putaran 3 (v3.6.80)', () => {
  test('"Ini bos" tanpa foto → menunjuk foto di atas; fit jas tidak menebak nomor celana; grosir sebut besarnya', async ({ assert }) => {
    const { pointToSentPhotos } = await import('#beta3/reply_polish')
    assert.deepEqual(pointToSentPhotos(['Ini bos']), ['Fotonya sudah saya kirim di atas bos'])
    assert.deepEqual(pointToSentPhotos(['Ini ya kak']), ['Fotonya sudah saya kirim di atas kak'])
    const { renderFitResult } = await import('#beta3/mcp')
    assert.include(renderFitResult({ recommended_size: 'L' }, { height: 171, weight: 68 }, 'jacket'), 'jangan ditebak')
    assert.notInclude(renderFitResult({ recommended_size: '32' }, { height: 171, weight: 68 }, 'pants'), 'jangan ditebak')
    const { renderWholesaleRule } = await import('#beta3/wholesale')
    assert.include(renderWholesaleRule({ jas: 15000 }), 'sebut besarnya per pcs')
  })
})

test.group('warna: salah ketik & baby blue (v3.6.80)', () => {
  test('fuzzyColorWords & alias baby blue → blue ice', async ({ assert }) => {
    const { fuzzyColorWords } = await import('#beta3/token_saver')
    assert.includeMembers(fuzzyColorWords('baby bllue yg jas'), ['blue'])
    assert.includeMembers(fuzzyColorWords('yg nevy ada'), ['navy'])
    assert.deepEqual(fuzzyColorWords('harga jas brp'), [])
    const { catalogColorSearchHints } = await import('#services/color_semantics')
    assert.equal(catalogColorSearchHints(['baby blue'])[0].catalogColor, 'blue ice')
    assert.equal(catalogColorSearchHints(['Blue Ice'])[0].catalogColor, 'blue ice')
  })
})

test.group('susulan dinilai: perlu tidaknya & rasa bahasa (v3.6.82)', (group) => {
  group.each.setup(async () => {
    const clean = () => db.from('whatsapp_beta3_state').whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error']).delete().catch(() => {})
    await clean()
    return async () => {
      setJevFetcher(null)
      const { setLeanProviderOverride } = await import('#beta3/provider')
      setLeanProviderOverride(null)
      await clean()
      resetJevCache()
    }
  })

  test('AI: jangan → tidak dikirim; ubah → teks baru; Jev yakin "jangan" → tidak dikirim', async ({ assert }) => {
    const { reviewNudge } = await import('#beta3/reply_check')
    const { setLeanProviderOverride } = await import('#beta3/provider')
    const { readSettings } = await import('#services/settings_service')
    const settings = { ...(await readSettings(true)), aiProvider: 'chatgpt' } as any
    const history = [
      { direction: 'in' as const, body: 'oke nanti dulu ya min, gajian dulu', createdAt: new Date() },
      { direction: 'out' as const, body: 'Siap bos, ditunggu kabarnya', createdAt: new Date() },
    ]
    let answer = { keputusan: 'jangan', susulan: '', alasan: 'Pelanggan menunda sampai gajian' }
    setLeanProviderOverride(async ({ phase }) => (phase === 'beta3-nudge-check' ? JSON.stringify(answer) : '{}'))
    const no = await reviewNudge({ jid: 'n@s.whatsapp.net', settings, susulan: 'Jadi gimana bos, mau order?', history })
    assert.isFalse(no.kirim)
    answer = { keputusan: 'ubah', susulan: 'Kalau mau lihat warna lain kabari aja ya bos', alasan: 'Lebih santai' }
    const changed = await reviewNudge({ jid: 'n@s.whatsapp.net', settings, susulan: 'Apakah Anda ingin melanjutkan pemesanan?', history })
    assert.deepEqual([changed.kirim, changed.teks], [true, 'Kalau mau lihat warna lain kabari aja ya bos'])
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher((async () =>
      new Response(JSON.stringify({ model: 'jev-test', answers: { susulan: choice('jangan', 0.95) } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch)
    answer = { keputusan: 'kirim', susulan: '', alasan: 'ok' }
    const jevNo = await reviewNudge({ jid: 'n@s.whatsapp.net', settings, susulan: 'Mau dibantu cek size bos?', history })
    assert.isFalse(jevNo.kirim)
    const listener = await readFile('commands/whatsapp_listen.ts', 'utf8')
    assert.include(listener, 'vetLeanNudge(jid, nudge.text')
  })
})

test.group('janji total: tidak mengulang format data pengiriman (v3.6.82)', () => {
  test('sudah diminta → pengingat singkat; reply_service menulis ulang dulu', async ({ assert }) => {
    const { guardTotalPromise } = await import('#beta3/reply_service')
    const again = guardTotalPromise(['Siap bos, totalnya menyusul ya'], { address: 'bos', hasAddress: false, asked: true })
    assert.deepEqual(again.pesan, ['Siap bos', 'Ditunggu data pengirimannya ya bos'])
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, "'beta3-total-rewrite'")
  })
})

test.group('jawaban CS chat nyata = kebenaran (v3.6.83)', () => {
  test('bertentangan → pertanyaan + jawaban CS asli jadi contoh (sekali saja); rekening resmi saat diminta', async ({ assert }) => {
    const { learnFromRealChat } = await import('#beta3/simulator')
    const asal = [{ teks: 'Setelan jas utk anak 8 tahun ada? (uji)', jawaban: ['Mohon maaf kak, untuk anak belum bisa ya'] }]
    await db.from('whatsapp_beta3_examples').where('customer_text', asal[0].teks).delete()
    try {
      assert.equal(await learnFromRealChat(asal), 1)
      assert.equal(await learnFromRealChat(asal), 0)
      const row = await db.from('whatsapp_beta3_examples').where('customer_text', asal[0].teks).first()
      assert.equal(row.source, 'chat-nyata')
      assert.equal(row.cs_text, 'Mohon maaf kak, untuk anak belum bisa ya')
    } finally {
      await db.from('whatsapp_beta3_examples').where('customer_text', asal[0].teks).delete()
    }
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, "key: 'beta3-account'")
    const sim = await readFile('app/beta3/simulator.ts', 'utf8')
    assert.include(sim, 'tidak bisa = tidak bisa')
  })
})

test.group('Beta3 · sapaan per chat & pembuka ganda (v3.6.84)', () => {
  test('sapaan mengikuti CS manusia di chat itu', async ({ assert }) => {
    const { chatAddress, styleForChat, normalizeStyle } = await import('#beta3/style_service')
    const cs = (body: string) => ({ direction: 'out', senderType: 'cs', body })
    assert.equal(chatAddress([cs('siap mbak'), cs('ditunggu ya mbak')], 'bos'), 'mbak')
    assert.equal(chatAddress([cs('siap mbak')], 'bos'), 'bos')
    assert.equal(chatAddress([{ direction: 'out', senderType: 'ai', body: 'siap kak, oke kak' }], 'bos'), 'bos')
    assert.equal(chatAddress([cs('siap bos'), cs('oke bos'), cs('ya kak')], 'bos'), 'bos')
    const profile = { address: 'bos', emoji: false, length: 60, samples: 20 }
    const mine = styleForChat(profile, [cs('siap mbak'), cs('makasih mbak')])
    assert.equal(mine.address, 'mbak')
    assert.equal(profile.address, 'bos')
    assert.deepEqual(normalizeStyle(['Siap bos, kami cek dulu ya'], mine), ['Siap mbak, kami cek dulu ya'])
  })

  test('dua bubble berpembuka sama tidak diulang', async ({ assert }) => {
    const { normalizeStyle } = await import('#beta3/style_service')
    const profile = { address: 'bos', emoji: false, length: 60, samples: 20 }
    assert.deepEqual(normalizeStyle(['siap bos, ditunggu ya pelunasannya', 'Siap sama sama bos'], profile), [
      'siap bos, ditunggu ya pelunasannya',
      'Sama sama bos',
    ])
    assert.deepEqual(normalizeStyle(['Siap bos, saya cek', 'Oke bos'], profile), ['Siap bos, saya cek'])
    assert.deepEqual(normalizeStyle(['Harganya 250rb bos', 'Siap dikirim hari ini'], profile).length, 2)
  })
})

test.group('Beta3 · ukuran baju vs badan (v3.6.84)', () => {
  test('lebar dada/panjang badan → tanya dulu; fit advisor sebut size terdekat', async ({ assert }) => {
    const { compareWithSizeChart } = await import('#beta3/context_service')
    const { renderFitResult } = await import('#beta3/mcp')
    const chart = 'Jas (cm): S dada 96; M dada 100; L dada 104; XL dada 110'
    const inRow = (body: string) => ({ direction: 'in' as const, body, createdAt: new Date() })
    const garment = compareWithSizeChart([inRow('Lebar Dada = 105 Panjang Badan = 86 TB 154 BB 45')], chart)
    assert.include(garment, 'ukuran baju')
    const body = compareWithSizeChart([inRow('lingkar dada 100')], chart)
    assert.include(body, 'Paling dekat: M')
    assert.notInclude(body, 'ukuran baju')
    const note = renderFitResult({ recommended_size: 'XS' }, { height: 154, weight: 45 }, 'jacket')
    assert.include(note, 'XS → S')
  })

  test('v3.6.128: "pinggang 34" = nomor size celana, bukan 34 cm', async ({ assert }) => {
    const { compareWithSizeChart } = await import('#beta3/context_service')
    const chart = 'Pants 28-40 (cm): 28 lingkar pinggang 72; 33 lingkar pinggang 86; 34 lingkar pinggang 89; 35 lingkar pinggang 91'
    const inRow = (body: string) => ({ direction: 'in' as const, body, createdAt: new Date() })
    const label = compareWithSizeChart([inRow('celana yg pinggang 34 warna coklat ready?')], chart)
    assert.include(label, 'nomor size celana 34')
    assert.notInclude(label, 'Paling dekat: 28')
    const cm = compareWithSizeChart([inRow('lingkar pinggang 88 cm')], chart)
    assert.include(cm, 'Paling dekat: 34')
  })
})

test.group('Beta3 · balasan singkat & pemeriksa (v3.6.85)', () => {
  test('"Yaa 🤔" sesudah tawaran bantuan → dipersilakan; oke 😁 boleh diam di uji', async ({ assert }) => {
    const { quickReply, ACK } = await import('#beta3/token_saver')
    const rows = [
      { direction: 'in' as const, body: 'Assalamualaikum kak', createdAt: new Date() },
      { direction: 'out' as const, senderType: 'ai', body: 'Ada yang bisa kami bantu', createdAt: new Date() },
    ]
    assert.deepEqual(quickReply({ text: 'Yaa 🤔', imageCount: 0, stage: '', rows }), ['Silakan bos, mau tanya apa?'])
    assert.isNull(quickReply({ text: 'ya yang hitam', imageCount: 0, stage: '', rows }))
    assert.isTrue(ACK.test('oke 😁'))
    assert.isTrue(ACK.test('Yaa 🤔'))
    assert.isFalse(ACK.test('oke kirim ke medan'))
    const turn = (pelanggan: string): SimTurn => ({ pelanggan, balasan: [], foto: [], serah_cs: false, alasan: '', jejak: [], ms: 0 })
    const allowed = allowedPrices([], [])
    assert.lengthOf(deterministicIssues({}, [turn('oke 😁')], allowed), 0)
    assert.lengthOf(deterministicIssues({}, [turn('berapa harganya')], allowed), 1)
  })

  test('pemeriksa AI: karangan & topik bukan produk', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_check.ts', 'utf8')
    assert.include(source, 'setelan hanya untuk produk berlabel Setelan')
    assert.include(source, 'keluhan website')
  })
})

test.group('Beta3 · tawaran bisnis, bot lain, pesanan lama (v3.6.85)', () => {
  test('tawaran jasa dikenali; pertanyaan pelanggan biasa tidak', async ({ assert }) => {
    const { isBusinessPitch, isOtherBot } = await import('#beta3/token_saver')
    const pitch =
      'Halo Selamat Siang, salam kenal Owner/Tim Toko Contoh. Perkenalkan saya Rina, Business Consultant dari Contoh AI. ' +
      'Kami membantu perusahaan meningkatkan pelayanan pelanggan 24/7 dan meningkatkan penjualan. Sekiranya untuk menjelaskan ' +
      'beberapa benefit dan credentials lainnya, apakah available untuk berdiskusi lebih lanjut dengan teamnya kak?'
    assert.isTrue(isBusinessPitch(pitch))
    const agency =
      'Hi Kak, saya Budi dari Contoh Marketing Agency. Saya sempat check social media toko, kontennya sudah bagus. ' +
      'Masih ada potential yang bisa di-push lagi dari content angle, engagement & reach. Kebetulan saya ada quick concept. ' +
      'Boleh saya langsung kirim quick concept-nya, Kak? Siap untuk kerja sama juga.'
    assert.isTrue(isBusinessPitch(agency))
    assert.isFalse(
      isBusinessPitch(
        'Kak saya mau pesan 20 setelan untuk seragam kantor, kami perusahaan kecil di Bandung. Kira-kira ada potongan harga? ' +
          'Ukurannya campur S sampai XXL, warnanya navy semua. Bisa dikirim sebelum akhir bulan? Terima kasih banyak kak.'
      )
    )
    assert.isTrue(isOtherBot('TERIMA KASIH TELAH MENGHUBUNGI TOKO CONTOH. KETIK 1 UNTUK PRICELIST WEDDING'))
    assert.isFalse(isOtherBot('terima kasih kak, saya pilih yang hitam'))
  })

  test('tidak menyangkal pesanan lama', async ({ assert }) => {
    const { deniesOrder } = await import('#beta3/reply_service')
    assert.isTrue(deniesOrder(['Maaf ya bos, pesanan jas dan celananya belum ada yang tercatat di chat ini']))
    assert.isTrue(deniesOrder(['Di sini tidak ada pesanan atas nama itu bos']))
    assert.isFalse(deniesOrder(['Pesanannya sedang finishing ya bos']))
    assert.isFalse(deniesOrder(['Ukuran 109 cm saya catat ya bos']))
  })

  test('transkrip uji: foto sesudah bubble pertama', async ({ assert }) => {
    const text = transcript([
      { pelanggan: 'ada jas hitam?', balasan: ['Ada bos, ini fotonya', 'Pakai size apa bos?'], foto: ['Jas - Black'], serah_cs: false, alasan: '', jejak: [], ms: 0 },
    ])
    const lines = text.split('\n')
    assert.deepEqual(lines.slice(1), ['AI: Ada bos, ini fotonya', 'AI: [foto] Jas - Black', 'AI: Pakai size apa bos?'])
  })
})

test.group('Beta3 · uji chat nyata memakai konteks lengkap (v3.6.86)', () => {
  test('kutipan & catatan gambar ikut; penilai melihat konteks sebelumnya', async ({ assert }) => {
    const { realSegments, priorContext } = await import('#beta3/simulator')
    const at = new Date()
    const segments = realSegments([
      { jid: 'x', message_id: 'm1', direction: 'out', sender_type: 'cs', body: 'Tuxedo - Black', media_type: 'image', media_url: '/media/a.jpg', created_at: at },
      { jid: 'x', message_id: 'm2', reply_to_message_id: 'm1', direction: 'in', sender_type: 'customer', body: 'yang ini berapa', media_type: null, media_url: null, created_at: at },
      { jid: 'x', message_id: 'm3', direction: 'out', sender_type: 'cs', body: '485 bos', media_type: null, media_url: null, created_at: at },
    ])
    assert.equal(segments[0].kutip, 'Tuxedo - Black')
    const context = priorContext({ riwayat: [{ arah: 'in', teks: 'ini ada?', gambar: true, catatan: 'jas abu-abu' }] })
    assert.include(context, '[gambar: jas abu-abu] ini ada?')
    assert.include(context, 'BUKAN karangan')
    assert.equal(priorContext({}), '')
    const text = transcript([{ pelanggan: 'yang ini berapa', kutip: 'Tuxedo - Black', balasan: ['485.000 bos'], foto: [], serah_cs: false, alasan: '', jejak: [], ms: 0 }])
    assert.include(text, '(membalas pesan: "Tuxedo - Black")')
  })
})

test.group('Beta3 · rasa manusia & harga per warna (v3.6.86)', () => {
  test('pilihan pendek ditulis satu kalimat; rincian berangka tetap per baris', async ({ assert }) => {
    const { inlineChoices, tidyReply } = await import('#beta3/reply_tidy')
    assert.equal(
      inlineChoices('Mau model yang mana bos:\n- Basic Suit\n- Peak Suit\n- Tuxedo\n- Bescap Cross Placket'),
      'Mau model yang mana bos, Basic Suit, Peak Suit, Tuxedo, atau Bescap Cross Placket?'
    )
    assert.equal(inlineChoices('Mau warna apa bos?\n- Black\n- Navy'), 'Mau warna apa bos, Black atau Navy?')
    const prices = 'Harganya:\n- Basic Suit 485.000\n- Premium 955.000'
    assert.equal(inlineChoices(prices), prices)
    const [tidy] = tidyReply(['Mau model yang mana bos:\n- Basic Suit\n- Tuxedo\n- Peak Suit'], { address: 'bos' })
    assert.notInclude(tidy, '\n- ')
  })

  test('harga di bawah harga termurah warna itu → fakta salah', async ({ assert }) => {
    const { colorPriceIssues } = await import('#beta3/reply_check')
    const rows = [
      row('Setelan Premium Basic Suit', 'Sage Green', { price: 955000 }),
      row('Setelan Basic Suit', 'Black 2.0', { price: 705000 }),
      row('Premium Basic Suit', 'Sage Green', { price: 685000 }),
    ]
    const wrong = colorPriceIssues(['Untuk setelan jas sama celana warna Sage Green harganya mulai 705.000 bos'], rows)
    assert.lengthOf(wrong, 1)
    assert.include(wrong[0].detail, '955.000')
    assert.lengthOf(colorPriceIssues(['Setelan Sage Green 955.000 bos'], rows), 0)
    assert.lengthOf(colorPriceIssues(['Jas Sage Green 685.000 bos'], rows), 0)
    assert.lengthOf(colorPriceIssues(['Setelan Sage Green ongkirnya 25.000 bos'], rows), 0)
    assert.lengthOf(colorPriceIssues(['Setelan Black 705.000, Sage Green juga ada'], rows), 0)
  })
})

test.group('Beta3 · tebakan & balasan custom (v3.6.86)', () => {
  test('nomor celana tebakan dibuang; yang disebut pelanggan tetap', async ({ assert }) => {
    const { dropGuessedPantsNumber, keepCustomInChat } = await import('#beta3/reply_guards')
    const guess = dropGuessedPantsNumber(['Rekomendasi size L bos. Untuk celananya rekomendasi no 35 bos, cocok pakai no 35 ya?'], 'tinggi 170 bb 73')
    assert.isTrue(guess.changed)
    assert.deepEqual(guess.pesan, ['Rekomendasi size L bos.', 'Celananya biasa pakai nomor berapa bos?'])
    assert.isFalse(dropGuessedPantsNumber(['Celana no 32 ready bos'], 'celana saya 32').changed)
    assert.isFalse(dropGuessedPantsNumber(['Jas size L ready bos'], '').changed)
    const handoff = { serah_cs: true, alasan: 'Pelanggan minta ukuran custom untuk jas Step', pesan: ['saya cek dulu ya bos'] }
    assert.isNull(keepCustomInChat(handoff, 'Besok siang saya tf pelunasan yah bos'))
    assert.isNull(keepCustomInChat(handoff, 'Perkenalkan saya dari agency, kami membuat solusi AI custom untuk bisnis anda dan ingin berdiskusi lebih lanjut dengan tim anda minggu ini'))
  })
})

test.group('Beta3 · belajar semua chat CS & chat uji terpisah (v3.6.87)', () => {
  test('holdout ±20%, pasangan layak, contoh riwayat butuh kemiripan', async ({ assert }) => {
    const { isHoldout, learnablePair } = await import('#beta3/simulator')
    const { pickExamples } = await import('#beta3/examples_service')
    const { foreignLink } = await import('#beta3/reply_service')
    const ids = Array.from({ length: 1000 }, (_, index) => `62812${String(index).padStart(6, '0')}@s.whatsapp.net`)
    const share = ids.filter(isHoldout).length / ids.length
    assert.isAbove(share, 0.14)
    assert.isBelow(share, 0.26)
    assert.equal(isHoldout(ids[3]), isHoldout(ids[3]))
    assert.isTrue(learnablePair('bisa buat blazer cewek?', 'untuk cewek maaf gak bisa bos'))
    assert.isFalse(learnablePair('ok', 'siap bos makasih'))
    assert.isFalse(learnablePair('tf kemana kak', 'BRI 1234567890 an Contoh'))
    assert.isFalse(learnablePair('Nama : Budi\nAlamat lengkap : Jl. Contoh', 'siap bos sudah dicatat'))
    const examples = [
      { id: 1, situation: '', customerText: 'Halo', csText: 'Halo bos', tags: 'lain', source: 'seed' },
      { id: 2, situation: '', customerText: 'bisa buat blazer cewek', csText: 'untuk cewek maaf gak bisa bos', tags: 'riwayat', source: 'riwayat' },
      { id: 3, situation: '', customerText: 'blazer hitam ready', csText: 'ready bos', tags: 'riwayat', source: 'riwayat' },
    ]
    const picked = pickExamples(examples, 'mas bisa bikin blazer buat cewek ga', '')
    assert.include(picked.map((item) => item.id), 2)
    assert.notInclude(picked.map((item) => item.id), 3)
    assert.isTrue(foreignLink('ini kak https://www.instagram.com/reel/abc'))
    assert.isFalse(foreignLink('order di https://chameleoncloth.com ya'))
    assert.isFalse(foreignLink('tanpa link'))
  })

  test('learnAllRealChats: jawaban CS manusia jadi contoh; chat uji & jawaban AI tidak', async ({ assert }) => {
    const { learnAllRealChats, isHoldout } = await import('#beta3/simulator')
    let learn = ''
    let hold = ''
    for (let index = 0; (!learn || !hold) && index < 200; index++) {
      const jid = `62899${String(index).padStart(6, '0')}@s.whatsapp.net`
      if (isHoldout(jid)) hold ||= jid
      else learn ||= jid
    }
    const now = Date.now()
    const message = (jid: string, n: number, direction: string, sender: string, body: string) => ({
      jid,
      message_id: `t87-${jid}-${n}`,
      direction,
      sender_type: sender,
      body,
      status: 'sent',
      created_at: new Date(now - (10 - n) * 60_000),
    })
    const rows = [
      message(learn, 1, 'in', 'customer', 'bisa bikin blazer buat cewek ga kak uji87'),
      message(learn, 2, 'out', 'cs', 'untuk cewek maaf gak bisa bos'),
      message(learn, 3, 'in', 'customer', 'kalau jas anak bisa uji87'),
      message(learn, 4, 'out', 'ai', 'bisa bos untuk anak'),
      message(hold, 1, 'in', 'customer', 'rute ke toko lewat mana uji87'),
      message(hold, 2, 'out', 'cs', 'lewat kalipucang aja bos dekat'),
    ]
    try {
      await db.table('whatsapp_messages').multiInsert(rows)
      const result = await learnAllRealChats(30)
      assert.isAtLeast(result.added, 1)
      const learned = await db.from('whatsapp_beta3_examples').where('customer_text', 'like', '%uji87%').select('customer_text', 'source')
      assert.deepEqual(learned.map((row: any) => row.customer_text), ['bisa bikin blazer buat cewek ga kak uji87'])
      assert.equal(learned[0].source, 'riwayat')
    } finally {
      await db.from('whatsapp_messages').whereIn('jid', [learn, hold]).delete()
      await db.from('whatsapp_beta3_examples').where('customer_text', 'like', '%uji87%').delete()
    }
  })
})

test.group('Beta3 · temuan putaran 9 (v3.6.89)', () => {
  test('tujuan ditanya toko → jawaban nama tempat dicek; terima kasih + emoji dibalas cepat', async ({ assert }) => {
    const { asksDestination } = await import('#beta3/reply_service')
    const { quickReply, ACK } = await import('#beta3/token_saver')
    const at = new Date()
    const rows = (out: string) => [
      { direction: 'in' as const, body: 'ada pengiriman sehari ke sukabumi?', createdAt: at },
      { direction: 'out' as const, senderType: 'ai', body: out, createdAt: at },
      { direction: 'in' as const, body: 'warudoyong sukabumi', createdAt: at, current: true },
    ]
    assert.isTrue(asksDestination(rows('ke kecamatan apa ya bos, saya cekin dulu ongkirnya')))
    assert.isTrue(asksDestination(rows('dikirim ke mana bos?')))
    assert.isFalse(asksDestination(rows('mau model apa bos?')))
    const before = [{ direction: 'out' as const, senderType: 'ai', body: 'Masih proses ya bos', createdAt: at }]
    assert.deepEqual(quickReply({ text: 'Makasih\nBos\n🙏', imageCount: 0, stage: '', rows: before }), ['Siap sama sama bos'])
    assert.isTrue(ACK.test('I seeeee'))
    assert.isTrue(ACK.test('Okay'))
    assert.isFalse(ACK.test('Okay\nSudah Co'))
  })

  test('custom + pertanyaan lain, "harga sama", progres karangan', async ({ assert }) => {
    const { keepCustomInChat, qualifySamePrice, inventsProgress } = await import('#beta3/reply_guards')
    const handoff = { serah_cs: true, alasan: 'cek status kirim', pesan: ['saya cek dulu ya bos'] }
    assert.isNull(keepCustomInChat(handoff, 'size nya bsa di custom kan ya ? cuy\nKak orederan saya blm dkiirim ya ?'))
    assert.isNotNull(keepCustomInChat(handoff, 'bisa custom ga kak?'))
    const same = qualifySamePrice(['Kalau cuma ukurannya yang disesuaikan harganya sama bos, mulai dari 485.000'])
    assert.isTrue(same.changed)
    assert.include(same.pesan[0], 'kecuali size XXL ke atas')
    assert.isFalse(qualifySamePrice(['harganya sama bos, XXL ke atas 585.000']).changed)
    assert.isTrue(inventsProgress('Bos gimana progres jasnya ya', ['Masih proses bos, estimasi selesai minggu depan ya'], ''))
    assert.isFalse(inventsProgress('Bos gimana progres jasnya ya', ['Saya cek dulu ya bos'], ''))
    assert.isFalse(inventsProgress('harga jas berapa', ['besok bisa dikirim bos'], ''))
  })
})

test.group('Beta3 · rekening, stok ready, bot lain (v3.6.89)', () => {
  test('pola minta rekening; klaim kosong padahal ready', async ({ assert }) => {
    const { asksAccountText } = await import('#beta3/reply_service')
    const { readyClaimIssues } = await import('#beta3/reply_check')
    for (const text of ['kirim Ke rek Mana yah?', 'No rek nya', 'pembayaran transfre kemana ya kak ?', 'tf kemana kak', 'norek dong'])
      assert.isTrue(asksAccountText(text), text)
    for (const text of ['sudah transfer ya kak', 'kirim ke jakarta berapa', 'rekomendasi size dong']) assert.isFalse(asksAccountText(text), text)
    const rows = [
      row('Basic Suit', 'Maroon', { sizesReady: 'S M L XL XXL' }),
      row('Premium Basic Suit', 'Black', { sizesReady: 'M' }),
      row('Basic Suit', 'Black 2.0', { sizesReady: 'L' }),
    ]
    assert.lengthOf(readyClaimIssues(['warna maroonnya, jas size L 485.000, nanti pre order ya karena stoknya lagi kosong'], rows), 1)
    assert.lengthOf(readyClaimIssues(['Premium Basic Suit hitam size L belum ready bos'], rows), 0)
    assert.lengthOf(readyClaimIssues(['Basic Suit Maroon size L ready bos'], rows), 0)
  })
})

test.group('Beta3 · sapaan bu/pak (v3.6.90)', () => {
  test('CS memanggil "bu" di chat itu → AI ikut', async ({ assert }) => {
    const { chatAddress, styleForChat, normalizeStyle } = await import('#beta3/style_service')
    const cs = (body: string) => ({ direction: 'out', senderType: 'cs', body })
    assert.equal(chatAddress([cs('siap bu'), cs('ditunggu ya bu')], 'bos'), 'bu')
    const mine = styleForChat({ address: 'bos', emoji: false, length: 60, samples: 20 }, [cs('siap bu'), cs('makasih bu')])
    assert.deepEqual(normalizeStyle(['Siap sama sama bos'], mine), ['Siap sama sama bu'])
  })
})

test.group('Beta3 · temuan putaran 10 (v3.6.90)', () => {
  test('estimasi resmi, size Fit Advisor, progres, custom', async ({ assert }) => {
    const { fixWeekEstimate, alignFitSize, inventsProgress, CUSTOM_REPLY } = await import('#beta3/reply_guards')
    const { productionRanges } = await import('#beta3/reply_service')
    const ranges = productionRanges({
      rules: {
        preorder: { enabled: true, minDays: 5, maxDays: 10, estimateDays: null, dayType: 'working', startsAfter: 'payment' },
        custom: { enabled: true, minDays: 7, maxDays: 14, estimateDays: null, dayType: 'working', startsAfter: 'payment' },
      },
    } as any)
    assert.deepEqual(ranges, { preorder: '5-10 hari kerja', custom: '7-14 hari kerja' })
    assert.deepEqual(fixWeekEstimate(['Proses pembuatannya kurang lebih 1 minggu bos'], ranges).pesan, ['Proses pembuatannya sekitar 5-10 hari kerja bos'])
    assert.include(fixWeekEstimate(['custom jadi 2 minggu bos'], ranges).pesan[0], '7-14 hari kerja')
    assert.isFalse(fixWeekEstimate(['siap kirim 5-10 hari kerja'], ranges).changed)
    const note = 'REKOMENDASI SIZE (Fit Advisor, TB 183 / BB 87, jas): XL (XL 60%, XXL 40%). Sampaikan sebagai rekomendasi.'
    assert.deepEqual(alignFitSize(['Untuk tinggi 183 berat 87 rekomendasi size XXL bos. Mau pakai XXL ya?'], note).pesan, [
      'Untuk tinggi 183 berat 87 rekomendasi size XL bos. Mau pakai XL ya?',
    ])
    assert.isFalse(alignFitSize(['rekomendasi XL bos, kalau mau longgar XXL'], note).changed)
    assert.isTrue(inventsProgress('Kaaa ud jadi belum?', ['Belum bos, pesanan baru diproses setelah DP masuk'], ''))
    assert.isTrue(inventsProgress('sudah selesai atau belum jas yang saya pesan?', ['belum selesai bos, masih dalam proses pembuatan'], ''))
    assert.lengthOf(CUSTOM_REPLY, 1)
  })
})

test.group('Beta3 · temuan putaran 11 (v3.6.91)', () => {
  test('foto warna lain dibuang; status karangan; salam + siap; alamat masih sama', async ({ assert }) => {
    const { offColorPhotos } = await import('#beta3/reply_check')
    const { inventsProgress } = await import('#beta3/reply_guards')
    const { quickReply } = await import('#beta3/token_saver')
    const { extractShippingQuery } = await import('#beta3/mcp')
    const rows = [
      row('Setelan Basic Suit', 'Black 2.0', { photoUrl: 'https://x/1.jpg' }),
      row('Basic Suit', 'Army', { photoUrl: 'https://x/2.jpg' }),
      row('Basic Suit', 'Dark Gray', { photoUrl: 'https://x/3.jpg' }),
    ]
    assert.deepEqual(offColorPhotos(['Setelan Basic Suit - Black 2.0', 'Basic Suit - Army'], ['Ukuran L ada ka? setelan hitam', 'Ada bos, ini fotonya'], rows), ['Basic Suit - Army'])
    assert.deepEqual(offColorPhotos(['Basic Suit - Dark Gray'], ['warna abu gelap', 'ini fotonya'], rows), [])
    assert.deepEqual(offColorPhotos(['Basic Suit - Army'], ['ini fotonya bos'], rows), [])
    assert.isTrue(inventsProgress('Gimana Kak? Sudah jadi belum?', ['Belum bos, soalnya belum ada pembayaran yang masuk'], ''))
    const at = new Date()
    const before = [{ direction: 'out' as const, senderType: 'cs', body: 'siap bos', createdAt: at }]
    assert.deepEqual(quickReply({ text: 'Siap boskuu\nSelamat siang boskuu', imageCount: 0, stage: '', rows: before }), ['Siang bos, ada yang bisa kami bantu'])
    assert.isNull(quickReply({ text: 'siap', imageCount: 0, stage: '', rows: before }))
    assert.isNull(extractShippingQuery('Alamat masih sama Ka...', true))
  })
})

test.group('Beta3 · cari lokasi di peta (v3.6.92)', () => {
  test('nama tempat → OpenStreetMap → tujuan ekspedisi; link share.google → alamat panel', async ({ assert }) => {
    // Hasil pencarian lokasi disimpan 30 hari di basis data: mulai bersih supaya uji tidak memakai sisa uji lain.
    await db.from('whatsapp_beta3_state').where('name', 'like', 'geo:%').delete().catch(() => 0)
    const { lookupPlace, parseAddress, placeQueries, setGeoFetcher, mapLink, parseMapUrl } = await import('#beta3/place_lookup')
    const asked: string[] = []
    setGeoFetcher(async (url) => {
      asked.push(String(url))
      if (String(url).includes('share.google'))
        return {
          ok: true,
          url: 'https://www.google.com/search?q=CV.+CONTOH+JAYA',
          text: async () => '<title>CV. CONTOH JAYA - Penelusuran Google</title><span>Alamat: 5G6P+VRJ, Jagong, Kec. Pangkajene, Kabupaten Pangkajene Dan Kepulauan, Sulawesi Selatan 90612</span>',
          json: async () => ({}),
        } as any
      const ice = [{ display_name: 'Indonesia Convention Exhibition, Pagedangan, Tangerang Regency, Banten, 15339, Indonesia', address: { village: 'Pagedangan', municipality: 'Pagedangan', county: 'Tangerang Regency', postcode: '15339' }, lat: '-6.3', lon: '106.6' }]
      return { ok: true, url: String(url), json: async () => (String(url).includes('ice') ? ice : []), text: async () => '' } as any
    })
    const rows = {
      pagedangan: [
        { code: 'KRJ1', subdistrict: 'PAGEDANGAN ILIR', district: 'KRONJO', city: 'TANGERANG', zip_code: '15550' },
        { code: 'TGR1', subdistrict: 'CIJANTRA', district: 'PAGEDANGAN', city: 'TANGERANG', zip_code: '15336' },
      ],
      pangkajene: [
        { code: 'MKS9', subdistrict: 'JAGONG', district: 'PANGKAJENE', city: 'PANGKAJENE KEPULAUAN', zip_code: '90612' },
        { code: 'SDR1', subdistrict: 'X', district: 'PANGKAJENE', city: 'SIDENRENG RAPPANG', zip_code: '91611' },
      ],
    } as Record<string, any[]>
    const find = async (q: string) => rows[q.toLowerCase()] || []
    try {
      const bsd = await lookupPlace({ text: 'Tangerang ice bsd', place: 'tangerang ice bsd' }, find)
      assert.deepEqual(bsd?.rows.map((row) => row.code), ['TGR1'])
      const link = await lookupPlace({ text: 'CV. CONTOH JAYA https://share.google/AbCdEf' }, find)
      assert.equal(link?.source, 'link')
      assert.deepEqual(link?.rows.map((row) => row.code), ['MKS9'])
      assert.isNull(await lookupPlace({ text: 'halo', place: 'zzz qqq' }, find))
    } finally {
      setGeoFetcher(null)
    }
    assert.deepEqual(placeQueries('kabupaten pangkep jln pelelangan'), ['kabupaten pangkajene jalan pelelangan', 'kabupaten pangkep jln pelelangan'])
    const typed = parseAddress('Jl. BSD Grand Boulevard No.1, Pagedangan, Kec. Pagedangan, Kabupaten Tangerang, Banten 15339')
    assert.deepEqual([typed?.names, typed?.city, typed?.postcode], [['Pagedangan'], 'Tangerang', '15339'])
    assert.equal(mapLink('lokasinya https://maps.app.goo.gl/abc123 ya'), 'https://maps.app.goo.gl/abc123')
    assert.deepEqual(parseMapUrl('https://www.google.com/maps/place/Toko+X/@-6.3006,106.6365,17z'), { lat: -6.3006, lon: 106.6365, name: 'Toko X' })
  })
})

test.group('Beta3 · uji tidak menghabiskan kuota (v3.6.94)', () => {
  test('berhenti bila akun terbaik sudah ≥ 60%; Gemini & akun jeda tidak dihitung', async ({ assert }) => {
    const { quotaHeadroom, stopSimRun } = await import('#beta3/simulator')
    const account = (provider: string, used: number, extra: Record<string, unknown> = {}) => ({
      provider,
      enabled: true,
      limitedUntil: 0,
      windows: [{ usedPercent: used, expired: false }],
      ...extra,
    })
    assert.isFalse(quotaHeadroom([account('chatgpt', 100), account('claude', 61)]).ok)
    assert.isTrue(quotaHeadroom([account('chatgpt', 100), account('claude', 47)]).ok)
    assert.isFalse(quotaHeadroom([account('gemini', 0), account('claude', 10, { limitedUntil: Date.now() + 60_000 })]).ok)
    assert.isTrue(quotaHeadroom([account('claude', 90, { windows: [{ usedPercent: 90, expired: true }] })]).ok)
    assert.deepEqual(stopSimRun(), { stopped: false })
  })
})

test.group('Beta3 · jalur kilat (v3.6.95)', () => {
  test('pertanyaan umum satu maksud dikenali; yang spesifik/berkonteks ke AI', async ({ assert }) => {
    const { fastIntent } = await import('#beta3/fast_reply')
    const yes: Array<[string, string]> = [
      ['Cek harga jas formal kk', 'harga_umum'],
      ['kak harga jas berapa ya', 'harga_umum'],
      ['pricelist dong min', 'harga_umum'],
      ['Lokasi dmn ya ka ??', 'lokasi'],
      ['tutup jam berapa kak', 'jam_buka'],
      ['Ada link shoppe kak?', 'marketplace'],
      ['tokonya ada di tokped gak?', 'marketplace'],
      ['Brp lama ya ka', 'lama_pengerjaan'],
      ['Siaapp mas\nEstimasi brp lama yaa', 'lama_pengerjaan'],
      ['kirim Ke rek Mana yah?', 'rekening'],
      ['Assalamualaikum kak, no rek nya?', 'rekening'],
    ]
    for (const [text, intent] of yes) assert.equal(fastIntent(text), intent, text)
    const no = [
      'Ini brapa ?',
      'harga jas hitam size L berapa',
      'Beskap ini di shopee ready atau PO?',
      'cara pesan custom gimana min ?',
      'berapa lama sampai ke makassar',
      'Kak orederan saya blm dikirim ya ?',
      'harga brp',
      'Lokasi dmn? sama harga jas berapa?',
      'Kalau dari Kota Banjar baiknya ambil arah mana ... Kalau dikirim kapan sampai ka perlu buat tgl 18',
      'alamat saya di jl. merdeka no 5 bekasi',
      'Hallo kak, mau tanya jasnya',
      // v3.6.102 — dari audit chat asli: maksud lebih dari satu, menunjuk barang, cerita, atau perlu konteks.
      'Lunas\nBerapa lama proses nya',
      'Estimasi pengerjaan brp lama\nSama DP ke mana',
      'harga berapa kak? ada shopee?',
      'Ni stelan brp bg?',
      'Mas jas brp harganya\nYg tdk resmi mas',
      'Sdh sy order d shopee kak td akhirnya',
      'Tp aku dpt nmr nya dr shopee deh ky nya',
      'Mahal juga y..\nKlo d shoppe ga da y..',
      'berapa lama bikin celananya',
      'Mas toko buka?',
      'Share loc aja pak',
      'cara ordernya bagaimana kak?',
    ]
    for (const text of no) assert.isNull(fastIntent(text), text)
  })

  test('jawaban dari data toko', async ({ assert }) => {
    const { fastAnswer, storeParts } = await import('#beta3/fast_reply')
    const store =
      'TOKO: CHAMELEON CLOTH — CHAMELEON CLOTH Jl. Contoh No 1, Cinyawang, Patimuan, Cilacap, Central Java, 53264.\nOrder lewat chat/website bisa 24 jam. Toko fisik buka Sen-Jum 09:00-17:00, Sab 09:00-15:00, Min tutup WIB (untuk yang mau datang).'
    assert.deepEqual(storeParts(store), {
      address: 'Jl. Contoh No 1, Cinyawang, Patimuan, Cilacap, Jawa Tengah, 53264',
      hours: 'Senin-Jumat 09.00-17.00, Sabtu 09.00-15.00, Minggu tutup',
    })
    const facts = {
      store,
      rows: [
        row('Basic Suit', 'Black', { category: 'Suits', price: 485000 }),
        row('Bescap Cross Placket', 'Black', { category: 'Suits', price: 485000 }),
        row('Setelan Basic Suit', 'Black', { category: 'Setelan', price: 705000 }),
        row('Pants', 'Black', { category: 'Pants', price: 220000 }),
      ],
      ranges: { preorder: '5-10 hari kerja', custom: '7-14 hari kerja' },
      payment: 'Untuk pembayaran tf ke rek BANK 000 an TOKO agar pesanan langsung kami proses',
      address: 'bos',
    }
    const harga = fastAnswer('harga_umum', 'Cek harga jas formal kk', facts)!
    assert.include(harga[0], '485.000')
    assert.include(harga[0], '705.000')
    assert.include(fastAnswer('harga_umum', 'harga celana berapa', facts)![0], '220.000')
    const lokasi = fastAnswer('lokasi', 'Assalamualaikum, lokasi dimana', facts)!
    assert.match(lokasi[0], /^Waalaikumsalam bos, .*Jl\. Contoh No 1/)
    // Bukan template: kalimat berbeda antar pesan, dan kalimat toko terakhir tidak diulang persis.
    const variants = new Set(['harga jas berapa', 'harga jas brp kak', 'pricelist dong', 'kak harga jas', 'harga jas mulai berapa'].map((text) => fastAnswer('harga_umum', text, facts)![0].replace(/^\w+ \w+, /, '')))
    assert.isAbove(variants.size, 1)
    const once = fastAnswer('marketplace', 'ada di shopee?', facts)!
    const again = fastAnswer('marketplace', 'ada di shopee?', { ...facts, avoid: once })!
    assert.notEqual(again[0], once[0])
    const lama = fastAnswer('lama_pengerjaan', 'brp lama', facts)!
    assert.include(lama[0], '5-10 hari kerja')
    // Seperti CS asli: tanpa tambahan ready/custom yang tidak ditanya.
    assert.notMatch(lama.join(' '), /ready|custom|pre-order/i)
    assert.lengthOf(lama, 1)
    assert.isNull(fastAnswer('rekening', 'norek', { ...facts, payment: '' }))
  })
})

test.group('Beta3 · ongkir kilat (v3.6.96)', () => {
  test('hanya soal ongkir → dijawab dari data ekspedisi; ada maksud lain → AI', async ({ assert }) => {
    const { pureShippingAsk, fastShipping } = await import('#beta3/fast_reply')
    assert.isTrue(pureShippingAsk('kak ongkir ke ice bsd tangerang berapa ya', false))
    assert.isTrue(pureShippingAsk('kirim ke medan kena berapa', false))
    assert.isTrue(pureShippingAsk('warudoyong sukabumi', true))
    assert.isFalse(pureShippingAsk('warudoyong sukabumi', false))
    assert.isFalse(pureShippingAsk('harga jas sama ongkir ke medan berapa', false))
    assert.isFalse(pureShippingAsk('berapa lama sampai ke makassar? sudah dikirim?', false))
    const many = fastShipping({ block: 'Ongkir ke Pagedangan, Tangerang:\nREG 19.000 (2-3 hari)\nYES 25.000 (1 hari)', many: true, geo: 'Indonesia Convention Exhibition, 1, Jalan BSD Grand Boulevard', address: 'bos', seed: 'x' })
    assert.lengthOf(many, 3)
    assert.include(many[0], 'Indonesia Convention Exhibition')
    assert.include(many[1], 'REG 19.000')
    const one = fastShipping({ block: 'Untuk pengiriman ke Patimuan, Cilacap ongkirnya 10.000, estimasi 1 hari', many: false, geo: '', address: 'bos', seed: 'y' })
    assert.deepEqual(one, ['Untuk pengiriman ke Patimuan, Cilacap ongkirnya 10.000, estimasi 1 hari bos'])
  })
})

test.group('Beta3 · ingatan pelanggan dari chat lama (v3.6.96)', () => {
  test('form terakhir, size, tinggi/berat; data order tidak ditimpa', async ({ assert }) => {
    const { memoryFromChat, mergeChatMemory } = await import('#beta3/customer_service')
    const rows = [
      { direction: 'in', body: 'tinggi 170 berat 65, biasa pakai M' },
      { direction: 'out', body: 'siap bos' },
      { direction: 'in', body: 'celana no 32 ya' },
      { direction: 'in', body: 'Nama : Budi Contoh\nAlamat lengkap : Jl. Contoh No 1\nKecamatan : Pagedangan\nKabupaten : Tangerang\nKode Pos : 15339\nNo telp : 0800' },
    ]
    const facts = memoryFromChat(rows)
    assert.equal(facts['Nama'], 'Budi Contoh')
    assert.include(facts['Alamat'], 'Pagedangan')
    assert.equal(facts['Size jas'], 'M')
    assert.equal(facts['Celana'], 'no 32')
    assert.equal(facts['Tinggi/berat'], '170 cm / 65 kg')
    const merged = mergeChatMemory('Alamat: Jl. Order Resmi, Cilacap\nOrder terakhir: #1', facts)
    assert.include(merged, 'Alamat: Jl. Order Resmi, Cilacap')
    assert.notInclude(merged, 'Jl. Contoh No 1')
    assert.include(merged, 'Size jas: M')
  })
})

test.group('Beta3 · cari alamat di internet (v3.6.97)', () => {
  test('link nama usaha tidak ada di peta → pencarian internet → tujuan ekspedisi', async ({ assert }) => {
    // Hasil pencarian lokasi disimpan 30 hari di basis data: mulai bersih supaya uji tidak memakai sisa uji lain.
    await db.from('whatsapp_beta3_state').where('name', 'like', 'geo:%').delete().catch(() => 0)
    const { lookupPlace, setGeoFetcher } = await import('#beta3/place_lookup')
    setGeoFetcher(async (url) =>
      ({ ok: true, url: String(url).includes('share.google') ? 'https://www.google.com/search?q=CV.+USAHA+UJI97' : String(url), json: async () => [], text: async () => '' }) as any
    )
    const asked: string[] = []
    try {
      const found = await lookupPlace(
        { text: 'kirim ke sini kak CV. USAHA UJI97 https://share.google/uji97' },
        async (q) => (q.toLowerCase() === 'pangkajene' ? [{ code: 'PKJ1', district: 'PANGKAJENE', city: 'PANGKAJENE KEPULAUAN', zip_code: '90612' }] : []),
        [],
        async (query) => {
          asked.push(query)
          return { alamat: 'Jagong, Kec. Pangkajene, Kab. Pangkajene dan Kepulauan 90612', kecamatan: 'Pangkajene', kabupaten: 'Pangkajene dan Kepulauan', kode_pos: '90612' }
        }
      )
      assert.deepEqual(found?.rows.map((row) => row.code), ['PKJ1'])
      assert.equal(found?.source, 'link')
      assert.include(asked[0], 'CV. USAHA UJI97')
    } finally {
      setGeoFetcher(null)
    }
    const { WEB_PHASES } = await import('#beta3/provider')
    assert.isTrue(WEB_PHASES.has('beta3-web-place'))
    assert.isFalse(WEB_PHASES.has('beta3-reply'))
  })
})

test.group('Beta3 · Google Maps (v3.6.98)', () => {
  test('Places Text Search → kecamatan/kab/kode pos → tujuan; tanpa kunci tidak dipakai', async ({ assert }) => {
    // Hasil pencarian lokasi disimpan 30 hari di basis data: mulai bersih supaya uji tidak memakai sisa uji lain.
    await db.from('whatsapp_beta3_state').where('name', 'like', 'geo:%').delete().catch(() => 0)
    const { setMapsFetcher, setMapsKeyForTest, googleSearch, placeFromComponents } = await import('#beta3/google_maps')
    const { lookupPlace, setGeoFetcher } = await import('#beta3/place_lookup')
    const calls: string[] = []
    setMapsFetcher(async (url) => {
      calls.push(String(url))
      return {
        ok: true,
        json: async () => ({
          places: [
            {
              displayName: { text: 'CV. Usaha Uji98' },
              formattedAddress: 'Jagong, Kec. Pangkajene, Kabupaten Pangkajene Dan Kepulauan, Sulawesi Selatan 90612',
              addressComponents: [
                { longText: 'Jagong', types: ['administrative_area_level_4', 'political'] },
                { longText: 'Kecamatan Pangkajene', types: ['administrative_area_level_3', 'political'] },
                { longText: 'Kabupaten Pangkajene Dan Kepulauan', types: ['administrative_area_level_2', 'political'] },
                { longText: '90612', types: ['postal_code'] },
              ],
              location: { latitude: -4.8, longitude: 119.5 },
            },
          ],
        }),
      } as any
    })
    setGeoFetcher(async () => ({ ok: true, url: 'https://www.google.com/search?q=CV.+Usaha+Uji98', json: async () => [], text: async () => '' }) as any)
    try {
      setMapsKeyForTest('')
      assert.isNull(await googleSearch('apa saja'))
      setMapsKeyForTest('uji-key')
      const place = await googleSearch('CV. Usaha Uji98')
      assert.deepEqual([place?.names, place?.city, place?.postcode], [['Pangkajene', 'Jagong'], 'Pangkajene Dan Kepulauan', '90612'])
      const found = await lookupPlace(
        { text: 'kirim ke sini https://share.google/uji98' },
        async (q) => (q === 'Pangkajene' ? [{ code: 'PKJ1', district: 'PANGKAJENE', city: 'PANGKAJENE KEPULAUAN', zip_code: '90612' }] : [])
      )
      assert.deepEqual(found?.rows.map((row) => row.code), ['PKJ1'])
      assert.isTrue(calls.some((url) => url.includes('places.googleapis.com')))
    } finally {
      setMapsFetcher(null)
      setGeoFetcher(null)
      setMapsKeyForTest(null)
    }
    assert.isNull(placeFromComponents('x', []))
  })
})

test.group('v3.6.99 balas salam', () => {
  test('salam pelanggan dibalas di bubble pertama', async ({ assert }) => {
    const { answerSalam } = await import('#beta3/reply_polish')
    assert.deepEqual(answerSalam(['Siap bos, dicatat ya'], 'Assalamualaikum, mau pesan celana'), ['Waalaikumsalam bos, dicatat ya'])
    assert.deepEqual(answerSalam(['Panjang ankle pants sekitar 90 cm bos'], "assalamu'alaikum min"), ['Waalaikumsalam bos, panjang ankle pants sekitar 90 cm bos'])
    assert.deepEqual(answerSalam(['Halo kak, Peak Suit ready kak'], 'Asslm kak', 'kak'), ['Waalaikumsalam kak, Peak Suit ready kak'])
    assert.deepEqual(answerSalam(['Siang bos kami buka jam 9'], 'assalamualaikum'), ['Waalaikumsalam bos, Siang bos kami buka jam 9'])
  })
  test('tidak dobel & tidak tanpa salam', async ({ assert }) => {
    const { answerSalam } = await import('#beta3/reply_polish')
    assert.deepEqual(answerSalam(['Waalaikumsalam bos, ada'], 'Assalamualaikum'), ['Waalaikumsalam bos, ada'])
    assert.deepEqual(answerSalam(['Ada bos'], 'ada jas hitam?'), ['Ada bos'])
    assert.deepEqual(answerSalam(['Siap bos'], 'salam kenal'), ['Siap bos'])
    assert.deepEqual(answerSalam(['Siap bos', 'Ini fotonya'], 'Assalamualaikum'), ['Waalaikumsalam bos', 'Ini fotonya'])
  })
})

test.group('v3.6.100 audit jalur kilat', () => {
  test('pertanyaan kilat di chat nyata dibandingkan dengan jawaban CS manusia', async ({ assert }) => {
    const { fastAudit } = await import('#beta3/simulator')
    const { writeLeanState, ensureLeanTables } = await import('#beta3/tables')
    const { fastAnswer } = await import('#beta3/fast_reply')
    await ensureLeanTables()
    const jid = '6280000000777@s.whatsapp.net'
    await db.from('whatsapp_messages').where('jid', jid).delete()
    const at = (minute: number) => new Date(Date.now() - 3600_000 + minute * 60_000)
    await db.table('whatsapp_messages').insert([
      { jid, message_id: 'fa-1', direction: 'in', sender_type: 'customer', body: 'lokasi tokonya dimana min?', status: 'received', created_at: at(1) },
      { jid, message_id: 'fa-2', direction: 'out', sender_type: 'cs', body: 'Di Cilacap bos', status: 'sent', created_at: at(2) },
      { jid, message_id: 'fa-3', direction: 'in', sender_type: 'customer', body: 'jas hitam size L ready?', status: 'received', created_at: at(3) },
      { jid, message_id: 'fa-4', direction: 'out', sender_type: 'cs', body: 'Ready bos', status: 'sent', created_at: at(4) },
    ])
    await writeLeanState('store_profile', 'TOKO: CHAMELEON CLOTH — Jl. Contoh No 1, Cilacap.\nToko fisik buka Sen-Sab 09:00-17:00, Min tutup WIB.')
    const result = await fastAudit({ paymentMethods: [], skills: [] } as any, 30)
    const hit = result.samples.find((item) => item.cs.includes('Di Cilacap bos'))
    assert.exists(hit)
    assert.equal(hit!.intent, 'lokasi')
    assert.notInclude(hit!.kilat.join(' '), 'buka')
    assert.isFalse(result.samples.some((item) => item.tanya.includes('jas hitam')))
    await db.from('whatsapp_messages').where('jid', jid).delete()
    // Lokasi + jam ditanya bersama → jam ikut.
    const both = fastAnswer('lokasi', 'lokasi dimana, buka jam berapa?', { store: 'TOKO: X — Jl. Contoh No 1, Cilacap.\nbuka Sen-Sab 09:00-17:00, Min tutup WIB', rows: [], ranges: {}, payment: '', address: 'bos' })
    assert.match(both!.join(' '), /buka/i)
  })
})

test.group('v3.6.101 keadaan chat & perbaikan bagian yang salah', () => {
  const at = (day: number, hour = 10) => new Date(Date.UTC(2026, 9, day, hour))
  test('keadaan chat: resi, kirim, bayar, total, harga, foto, data pelanggan', async ({ assert }) => {
    const { chatStateLines, renderChatState } = await import('#beta3/chat_state')
    const rows: any[] = [
      { direction: 'in', body: 'Nama: Budi\nAlamat: Jl. Contoh 1\nKec: Patimuan\nKab: Cilacap\nKode pos: 53264\nNo HP: 08xx', createdAt: at(1) },
      { direction: 'out', senderType: 'cs', body: 'Basic Suit hitam 485.000 bos, setelannya 705.000', createdAt: at(1, 11) },
      { direction: 'out', senderType: 'ai', mediaType: 'image', body: 'Basic Suit - Black', createdAt: at(1, 11) },
      { direction: 'in', body: 'tinggi 170 berat 65, celana no 32', createdAt: at(2) },
      { direction: 'out', senderType: 'cs', body: 'Total 727.000 ya bos, ongkir 22.000', createdAt: at(2, 11) },
      { direction: 'out', senderType: 'cs', body: 'Pembayaran sudah kami terima ya bos, prosess', createdAt: at(3) },
      { direction: 'out', senderType: 'cs', body: 'Pesanan masih proses dijahit bos', createdAt: at(5) },
      { direction: 'out', senderType: 'cs', body: 'Sudah dikirim bos, resi JNE 1234567890123', createdAt: at(8) },
      { direction: 'in', body: 'kak orderan saya udah dikirim?', createdAt: at(9), current: true },
    ]
    const lines = chatStateLines(rows)
    const text = lines.join('\n')
    assert.include(text, 'Resi sudah dikirim toko')
    assert.include(text, '1234567890123')
    assert.include(text, 'Pembayaran sudah dikonfirmasi')
    assert.include(text, 'Total terakhir yang dikirim toko')
    assert.include(text, '727.000')
    assert.include(text, '705.000')
    assert.include(text, 'Basic Suit - Black')
    assert.include(text, 'Tinggi/berat 170 cm / 65 kg')
    assert.include(text, 'Celana no 32')
    // Progres "masih dijahit" sudah lewat (sesudahnya dikirim) → tidak ditampilkan.
    assert.notInclude(text, 'masih proses dijahit')
    assert.include(renderChatState(rows), 'KEADAAN CHAT')
    assert.equal(renderChatState([{ direction: 'in', body: 'halo', createdAt: at(1) } as any]), '')
  })
  test('"sudah dikirim fotonya" bukan pengiriman pesanan; progres terakhir tampil bila belum dikirim', async ({ assert }) => {
    const { chatStateLines } = await import('#beta3/chat_state')
    const lines = chatStateLines([
      { direction: 'out', senderType: 'cs', body: 'Sudah saya kirim fotonya ya bos', createdAt: at(1) },
      { direction: 'out', senderType: 'cs', body: 'Pesanannya tahap finishing bos, besok siap kirim', createdAt: at(2) },
    ] as any)
    assert.isFalse(lines.some((line) => line.includes('pesanan dikirim')))
    assert.isTrue(lines.some((line) => line.startsWith('Progres pesanan terakhir')))
  })
  test('perbaikan: bahan kecil + konteks lengkap; hasil hanya pesan & foto', async ({ assert }) => {
    const { fixPrompt, parseFix, FIX_SCHEMA } = await import('#beta3/reply_check')
    const prompt = fixPrompt({
      rules: 'ATURAN TOKO: x',
      customerText: 'orderan saya udah dikirim?',
      history: [
        { direction: 'out', body: 'Sudah dikirim bos, resi JNE 1234567890123', createdAt: at(8) },
        { direction: 'in', body: 'orderan saya udah dikirim?', createdAt: at(9), current: true },
      ],
      chatState: 'KEADAAN CHAT:\n- Resi sudah dikirim toko: 1234567890123',
      notes: ['CATATAN CHAT:\ntahap: selesai'],
      facts: ['DASAR TOKO: JNE'],
      draft: { pesan: ['Saya cek dulu progres pesanannya ya bos'], foto: [] },
      issues: [{ code: 'mengulang', detail: 'Resi sudah dikirim, jangan bilang cek dulu' }],
    })
    assert.include(prompt.user, 'PEMERIKSA BALASAN')
    assert.include(prompt.user, 'KEADAAN CHAT')
    assert.include(prompt.user, '>> Pelanggan: orderan saya udah dikirim?')
    assert.include(prompt.user, 'CATATAN CHAT')
    assert.include(prompt.system, 'ATURAN TOKO')
    assert.isBelow(prompt.system.length + prompt.user.length, 4000)
    assert.deepEqual(FIX_SCHEMA.required, ['pesan', 'foto'])
    assert.deepEqual(parseFix('{"pesan":["Sudah dikirim bos, resinya 1234567890123"],"foto":[]}'), { pesan: ['Sudah dikirim bos, resinya 1234567890123'], foto: [] })
    assert.isNull(parseFix('{"pesan":[],"foto":[]}'))
    assert.isNull(parseFix('bukan json'))
  })
  test('reply_service: perbaikan dulu, tulis ulang penuh hanya cadangan; keadaan chat ikut ke AI & pemeriksa', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    // v3.6.106: perbaikan sebagian dimatikan → tulis ulang penuh seperti semula.
    assert.notInclude(source, 'fixPrompt({')
    assert.include(source, 'revisionNote(decision, check.issues)')
    assert.include(source, 'renderChatState([...olderRows, ...rows])')
    assert.match(source, /chatState,\n\s+history: rows,/)
    assert.match(source, /settings,\n\s+chatState,\n\s+promos,\n\s+\}\)\.catch/)
  })
})

test.group('v3.6.101 keadaan chat: status dari AI tidak dianggap fakta', () => {
  test('progres/kirim yang ditulis AI tidak masuk keadaan chat', async ({ assert }) => {
    const { chatStateLines } = await import('#beta3/chat_state')
    const lines = chatStateLines([
      { direction: 'out', senderType: 'ai', body: 'Pesanan masih proses dijahit bos', createdAt: new Date() },
      { direction: 'out', senderType: 'ai', body: 'Sudah dikirim ya bos', createdAt: new Date() },
    ] as any)
    assert.deepEqual(lines, [])
  })
})

test.group('v3.6.103 uji dengan izin kuota pemilik', () => {
  test('batas 60% bawaan; izin pemilik sampai 95%', async ({ assert }) => {
    const { quotaHeadroom, SIM_QUOTA_LIMIT, SIM_QUOTA_LIMIT_OWNER } = await import('#beta3/simulator')
    const claude = [{ provider: 'claude', enabled: true, limitedUntil: 0, windows: [{ usedPercent: 63 }] }]
    assert.isFalse(quotaHeadroom(claude, SIM_QUOTA_LIMIT).ok)
    assert.isTrue(quotaHeadroom(claude, SIM_QUOTA_LIMIT_OWNER).ok)
    assert.isFalse(quotaHeadroom([{ ...claude[0], windows: [{ usedPercent: 96 }] }], SIM_QUOTA_LIMIT_OWNER).ok)
    const source = await readFile('app/controllers/beta3_controller.ts', 'utf8')
    assert.include(source, "ownerQuota: request.input('ownerQuota')")
  })
})

test.group('v3.6.104 kemeja di katalog fokus; susulan batal tidak dinilai', () => {
  test('"kemeja" membuka baris Shirt di katalog fokus', async ({ assert }) => {
    const { focusCatalog } = await import('#beta3/token_saver')
    const rows: any[] = []
    for (let i = 0; i < 30; i++) rows.push({ product: `Basic Suit ${i}`, color: 'Black', category: 'Suits', price: 485000, active: true, sizesReady: '', photoUrl: null, materialAvailable: true, features: '', featuresAi: '', material: '', sizeGroup: '', fit: '', note: '', sizesAll: '' })
    rows.push({ ...rows[0], product: 'Shirt', color: 'White', category: 'Shirt', price: 175000 })
    const focus = focusCatalog(rows, { text: 'saya butuh komplit sama kemeja', history: [], spec: '', chatNote: '', imageCount: 0 })
    assert.exists(focus)
    assert.isTrue(focus!.rows.some((row: any) => row.product === 'Shirt'))
  })
  test('transkrip penilai: susulan dibatalkan tidak ikut', async ({ assert }) => {
    const { transcript } = await import('#beta3/simulator')
    const text = transcript([
      { pelanggan: 'halo', balasan: ['Halo bos'], foto: [], fotoUrl: [], serah_cs: false, alasan: '', jejak: [], ms: 1, susulan: { asli: 'jadi gimana bos?', kirim: false, teks: '', alasan: 'menagih' } },
    ] as any)
    assert.notInclude(text, 'jadi gimana bos?')
  })
})

test.group('v3.6.105 perbaikan memakai katalog yang sama', () => {
  test('katalog AI penyusun dari catalogText', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, 'catalog: catalogText,')
  })
})

test.group('v3.6.106 jalur kilat dimatikan (semua lewat AI)', () => {
  test('tanya umum & ongkir tidak lagi dijawab tanpa AI', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, 'const FAST_LANE = false')
    assert.include(source, 'FAST_LANE && !input.imagePaths?.length')
    assert.include(source, 'if (FAST_LANE && shipFast')
  })
})

test.group('v3.6.107 kutipan foto (Instagram: caption terpisah)', () => {
  test('pelanggan membalas foto tanpa teks → foto katalog / caption sesudahnya', async ({ assert }) => {
    const { importLeanCatalog, catalogDigest } = await import('#beta3/catalog_service')
    const { createLeanReply } = await import('#beta3/reply_service')
    const { setLeanProviderOverride } = await import('#beta3/provider')
    await importLeanCatalog([
      { product: 'Peak Suit', color: 'Black', price: 485000, category: 'Suits', photoUrl: 'https://cdn.example.test/uploads/peak-black.jpg', sizesReady: 'M L' },
      { product: 'Premium Basic Suit', color: 'Green Emerald', price: 685000, category: 'Suits', photoUrl: 'https://cdn.example.test/uploads/pbs-green.jpg', sizesReady: '' },
    ] as any)
    await catalogDigest(true)
    const jid = '7700000000001@ig'
    await db.from('whatsapp_messages').where('jid', jid).delete()
    const t = (s: number) => new Date(Date.now() - 600_000 + s * 1000)
    await db.table('whatsapp_messages').insert([
      { jid, message_id: 'q-img-1', direction: 'out', sender_type: 'ai', body: '', media_type: 'image', media_url: 'https://cdn.example.test/uploads/peak-black.jpg?x=1', status: 'sent', created_at: t(1) },
      { jid, message_id: 'q-cap-1', direction: 'out', sender_type: 'ai', body: 'Peak Suit - Black', status: 'sent', created_at: t(2) },
      { jid, message_id: 'q-img-2', direction: 'out', sender_type: 'ai', body: '', media_type: 'image', media_url: 'https://other.test/x.jpg', status: 'sent', created_at: t(3) },
      { jid, message_id: 'q-cap-2', direction: 'out', sender_type: 'ai', body: 'Jas Lain - Navy', status: 'sent', created_at: t(4) },
      { jid, message_id: 'q-in-1', direction: 'in', sender_type: 'customer', body: 'Model seperti ini, satu stel berapa?', reply_to_message_id: 'q-img-1', status: 'received', created_at: t(10) },
      { jid, message_id: 'q-in-2', direction: 'in', sender_type: 'customer', body: 'kalau yang ini?', reply_to_message_id: 'q-img-2', status: 'received', created_at: t(11) },
    ])
    let seen = ''
    setLeanProviderOverride(async ({ phase, prompt }) => {
      if (phase === 'beta3-reply' && !seen) seen = prompt.user
      return JSON.stringify({ pesan: ['Siap bos'], foto: [], catatan: '', tahap: 'lain', serah_cs: false, alasan: '', susulan: '', spesifikasi: '', referensi: [], bukti: [], pembayaran: null, order: null })
    })
    const { readSettings } = await import('#services/settings_service')
    const settings = await readSettings(true)
    await createLeanReply({ jid, messageIds: ['q-in-1', 'q-in-2'], text: 'Model seperti ini, satu stel berapa?\nkalau yang ini?', settings: { ...settings, aiProvider: 'chatgpt' } as any, simulate: true }).catch(() => null)
    setLeanProviderOverride(null)
    await db.from('whatsapp_messages').where('jid', jid).delete()
    assert.include(seen, 'foto katalog: Peak Suit - Black')
    assert.include(seen, 'foto: Jas Lain - Navy')
    assert.notInclude(seen, 'membalas "[image]"')
  })
})

test.group('v3.6.108 postingan Instagram yang dibagikan', () => {
  test('keterangan postingan ikut; pratinjau gagal diunduh → tautan di teks, tanpa media rusak', async ({ assert }) => {
    const { ingestInstagramWebhook } = await import('#services/instagram_inbox')
    const mid = `mid-share-${Date.now()}`
    await ingestInstagramWebhook({
      entry: [{ messaging: [{ sender: { id: '7712345' }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid, attachments: [{ type: 'ig_post', payload: { url: 'http://127.0.0.1:9/post.jpg', title: 'Peak Suit Black siap kondangan' } }] } }] }],
    })
    const row = await db.from('whatsapp_messages').where('message_id', mid).first()
    assert.exists(row)
    assert.include(row.body, '[membagikan postingan] "Peak Suit Black siap kondangan"')
    assert.include(row.body, 'http://127.0.0.1:9/post.jpg')
    assert.isNull(row.media_type)
    await db.from('whatsapp_messages').where('message_id', mid).delete()
    await db.from('whatsapp_ig_turns').where('jid', '7712345@ig').delete()
  })
  test('tinggi ruang chat mengikuti jendela (--app-h)', async ({ assert }) => {
    const theme = await readFile('public/assets/theme.js', 'utf8')
    assert.include(theme, "setProperty('--app-h'")
    const css = await readFile('public/assets/app.css', 'utf8')
    assert.include(css, 'height: var(--app-h, 100dvh);')
  })
})

test.group('v3.6.109 antrian AI & uji beban', () => {
  test('maksimal N proses bersamaan; pelanggan asli didahulukan dari uji', async ({ assert }) => {
    const { withAiSlot, setAiSlotLimit, aiSlotStats, resetAiSlotStats, slotPriority, DEFAULT_AI_SLOTS, setFreeMemProbe } = await import('#beta3/ai_slots')
    setFreeMemProbe(() => 64 * 1024 ** 3)
    setAiSlotLimit(2)
    resetAiSlotStats()
    let running = 0
    let peak = 0
    const order: string[] = []
    const task = (name: string, priority: number) =>
      withAiSlot(priority, async () => {
        running++
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 20))
        order.push(name)
        running--
        return name
      })
    const jobs = [task('sim1', 1), task('sim2', 1), task('sim3', 1), task('cust', 0), task('sim4', 1)]
    await Promise.all(jobs)
    assert.equal(peak, 2)
    // Dua pertama langsung jalan; sesudahnya pelanggan asli mendahului sim3/sim4.
    assert.isBelow(order.indexOf('cust'), order.indexOf('sim3'))
    const stats = aiSlotStats()
    assert.equal(stats.maxActive, 2)
    assert.isAtLeast(stats.maxQueued, 3)
    assert.equal(slotPriority('uji-1@sim'), 1)
    assert.equal(slotPriority('6281@s.whatsapp.net'), 0)
    // Dibatalkan saat menunggu → keluar dari antrian.
    setAiSlotLimit(1)
    const hold = withAiSlot(0, () => new Promise((resolve) => setTimeout(resolve, 30)))
    const controller = new AbortController()
    const waiting = withAiSlot(1, async () => 'jalan', controller.signal)
    controller.abort()
    await assert.rejects(() => waiting)
    await hold
    // v3.6.110: memori di bawah cadangan → hanya satu proses jalan, sisanya menunggu.
    setAiSlotLimit(4)
    setFreeMemProbe(() => 100 * 1024 ** 2)
    let now = 0
    let most = 0
    await Promise.all(
      [1, 2, 3].map(() =>
        withAiSlot(0, async () => {
          now++
          most = Math.max(most, now)
          await new Promise((resolve) => setTimeout(resolve, 15))
          now--
        })
      )
    )
    assert.equal(most, 1)
    setFreeMemProbe(null)
    setAiSlotLimit(DEFAULT_AI_SLOTS)
  })
  test('ringkasan uji: waktu balas, gagal, timeout, nilai manusia', async ({ assert }) => {
    const { simMetrics } = await import('#beta3/simulator')
    const turn = (ms: number, error?: string) => ({ pelanggan: 'x', balasan: [], foto: [], fotoUrl: [], serah_cs: false, alasan: '', jejak: [], ms, ...(error ? { error } : {}) })
    const m = simMetrics(
      [
        { id: 'a', judul: 'a', lulus: true, nilai: 5, manusia: 4, masalah: [], giliran: [turn(10_000), turn(30_000)] },
        { id: 'b', judul: 'b', lulus: false, nilai: 2, manusia: 3, masalah: [], giliran: [turn(90_000, 'Claude terlalu lama merespons.')] },
      ] as any,
      { limit: 8 } as any,
      120_000
    )
    assert.equal(m.passed, 1)
    assert.equal(m.errors, 1)
    assert.equal(m.timeouts, 1)
    assert.equal(m.humanAvg, 3.5)
    assert.equal(m.maxSec, 30)
  })
  test('simulator & pembelajaran memakai chat Instagram juga; paralel sampai 25', async ({ assert }) => {
    const source = await readFile('app/beta3/simulator.ts', 'utf8')
    assert.equal(source.split(".orWhere('jid', 'like', '%@ig')").length - 1, 3)
    assert.include(source, 'Math.min(25, Math.max(1, input.parallel || 1))')
  })
})

test.group('v3.6.109 Instagram: balasan story, pesan tidak didukung, reel', () => {
  const send = async (message: Record<string, unknown>) => {
    const { ingestInstagramWebhook } = await import('#services/instagram_inbox')
    const mid = `mid-${Math.random().toString(36).slice(2)}`
    await ingestInstagramWebhook({ entry: [{ messaging: [{ sender: { id: '7712346' }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid, ...message } }] }] })
    const row = await db.from('whatsapp_messages').where('message_id', mid).first()
    await db.from('whatsapp_messages').where('message_id', mid).delete()
    await db.from('whatsapp_ig_turns').where('jid', '7712346@ig').delete()
    return row
  }
  test('membalas story toko → dicatat + tautan story', async ({ assert }) => {
    const row = await send({ text: 'ini ready kak?', reply_to: { story: { url: 'http://127.0.0.1:9/story.jpg', id: 's1' } } })
    assert.include(row.body, '[membalas story toko]')
    assert.include(row.body, 'ini ready kak?')
    assert.include(row.body, 'http://127.0.0.1:9/story.jpg')
  })
  test('pesan tidak didukung tetap masuk (tidak didiamkan)', async ({ assert }) => {
    const row = await send({ is_unsupported: true })
    assert.exists(row)
    assert.include(row.body, 'tidak bisa dibuka')
  })
  test('reel: keterangan + tautan; lampiran baru tetap tercatat', async ({ assert }) => {
    const reel = await send({ attachments: [{ type: 'ig_reel', payload: { url: 'https://cdn.example.test/reel.mp4', title: 'Tuxedo hitam' } }] })
    assert.include(reel.body, '[membagikan reel] "Tuxedo hitam"')
    assert.include(reel.body, 'https://cdn.example.test/reel.mp4')
    const other = await send({ attachments: [{ type: 'sticker_baru', payload: {} }] })
    assert.include(other.body, '[lampiran sticker_baru]')
  })
})

test.group('v3.6.111 hasil uji beban 88 chat', () => {
  test('terima kasih / maaf / mengiyakan tidak didiamkan', async ({ assert }) => {
    const { socialClosing } = await import('#beta3/reply_service')
    assert.equal(socialClosing('Terimakasih bnyak boskuu 🙏\nMohon maaf kemarin yah bos'), 'Sama-sama bos, santai aja 🙏')
    assert.equal(socialClosing('makasih kak', 'kak'), 'Sama-sama kak 🙏')
    assert.equal(socialClosing('Iya betul kak'), 'Siap bos 🙏')
    assert.equal(socialClosing('📷'), '')
  })
  test('uji chat nyata memakai waktu asli chat; nomor celana dari alat jas tidak dianggap diketahui', async ({ assert }) => {
    const sim = await readFile('app/beta3/simulator.ts', 'utf8')
    assert.include(sim, 'const start = scenario.waktu ? new Date(scenario.waktu).getTime()')
    assert.include(sim, '...(fixedNow ? { now: at } : {}),')
    assert.include(sim, "kanal: chat.jid.endsWith('@ig')")
    const reply = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(reply, 'const now = input.now || new Date()')
    assert.include(reply, "filter((line) => /celana|pants|pinggang/i.test(line))")
    const { dropGuessedPantsNumber } = await import('#beta3/reply_guards')
    const known = ['165/70', 'Fit advisor: size L (chart LD 34 cm)'.split('\n').filter((line) => /celana|pants|pinggang/i.test(line))].flat().join('\n')
    const out = dropGuessedPantsNumber(['Kalau dari tinggi 165 dan berat 70, rekomendasi celananya no 34 bos.'], known)
    assert.isTrue(out.changed)
  })
})

test.group('v3.6.112 masalah berulang dari uji beban', () => {
  const r = (product: string, price: number, extra: Record<string, unknown> = {}) =>
    ({ product, color: 'Black', category: 'Suits', price, active: true, sizesReady: '', photoUrl: null, note: '', ...extra }) as any
  const rows = [
    r('Basic Suit', 485000, { note: 'XXL 635.000' }),
    r('Setelan Basic Suit', 705000, { note: 'XXL 855.000' }),
    r('Premium Basic Suit', 685000),
    r('Setelan Premium Basic Suit', 955000),
  ]
  test('harga produk: setelan Premium bukan 705.000; jas aja bukan harga setelan', async ({ assert }) => {
    const { productPriceIssues } = await import('#beta3/reply_check')
    assert.lengthOf(productPriceIssues(['Premium Basic Suit satu set jas dan celana 705.000 bos'], rows), 1)
    assert.include(productPriceIssues(['Premium Basic Suit satu set jas dan celana 705.000 bos'], rows)[0].detail, '955.000')
    assert.lengthOf(productPriceIssues(['Kalau Basic Suit jas aja harganya 705.000 bos'], rows), 1)
    // Benar / ragu → tidak dipermasalahkan.
    assert.lengthOf(productPriceIssues(['Basic Suit mulai 485.000 bos'], rows), 0)
    assert.lengthOf(productPriceIssues(['Setelan Basic Suit 705.000, XXL 855.000 bos'], rows), 0)
    assert.lengthOf(productPriceIssues(['Basic Suit size XXL 635.000 bos'], rows), 0)
    assert.lengthOf(productPriceIssues(['Basic Suit premium 685.000 bos'], rows), 0)
    assert.lengthOf(productPriceIssues(['Total Basic Suit 485.000 + ongkir 15.000 = 500.000'], rows), 0)
  })
  test('mengulang daftar yang sama dengan pesan toko sebelumnya', async ({ assert }) => {
    const { repeatIssues } = await import('#beta3/reply_check')
    const list = 'Model jas yang ada: Basic Suit, Peak Suit, Tuxedo, Bescap Cross Placket, Beskap Clean Look, Casual Suit, Double Breasted, Premium Basic Suit'
    const history = [{ direction: 'out', body: list, createdAt: new Date() }, { direction: 'in', body: 'yang paling laris?', createdAt: new Date(), current: true }] as any
    assert.lengthOf(repeatIssues([list.replace('Model jas yang ada', 'Pilihan modelnya')], history), 1)
    assert.lengthOf(repeatIssues(['Yang paling sering dipesan Basic Suit Black bos, simpel dan cocok buat kondangan maupun kerja'], history), 0)
  })
  test('foto sebelumnya ikut dilihat AI saat pesan merujuk "ini/foto"; aturan DP ikut ke AI', async ({ assert }) => {
    const source = await readFile('app/beta3/reply_service.ts', 'utf8')
    assert.include(source, 'PHOTO_REF.test(input.text) ? await recentCustomerImage(jid, input.messageIds)')
    assert.include(source, 'DP minimal 50% dari total, pelunasan setelah pesanan jadi')
  })
})

test.group('v3.6.112 mengulang: rekening/total/format boleh diulang', () => {
  test('rekening diminta lagi tidak dianggap mengulang', async ({ assert }) => {
    const { repeatIssues } = await import('#beta3/reply_check')
    const rek = 'Untuk pembayaran tf ke rek BANK 000 an TOKO agar pesanan langsung kami proses ya bos, terima kasih banyak'
    assert.lengthOf(repeatIssues([rek], [{ direction: 'out', body: rek, createdAt: new Date() }] as any), 0)
  })
})

test.group('v3.6.113 ruang chat desktop dikunci ke layar', () => {
  test('shell chat fixed & halaman tidak tergulir', async ({ assert }) => {
    const css = await readFile('public/assets/fullscreen.css', 'utf8')
    assert.include(css, 'html body.workspace-ui > .shell.wa-shell-chat {\n    position: fixed;')
    assert.include(css, 'body.workspace-ui:has(> .wa-shell-chat)')
  })
})

test.group('v3.6.113 postingan lama dibagikan: isi diambil ulang dari Instagram', () => {
  test('URL gambar / tautan / media id dari detail pesan', async ({ assert }) => {
    const { sharedUrlFromDetail } = await import('#services/instagram_inbox')
    assert.equal(sharedUrlFromDetail({ attachments: { data: [{ image_data: { url: 'https://scontent.cdninstagram.com/v/x.jpg?a=1', preview_url: 'https://x.test/p' } }] } }).url, 'https://scontent.cdninstagram.com/v/x.jpg?a=1')
    assert.equal(sharedUrlFromDetail({ shares: { data: [{ link: 'https://www.instagram.com/p/abc/' }] } }).url, 'https://www.instagram.com/p/abc/')
    assert.equal(sharedUrlFromDetail({ attachments: { data: [{ generic_template: { media_id: '1789' } }] } }).mediaId, '1789')
    assert.deepEqual(sharedUrlFromDetail({}), { url: '', mediaId: '' })
  })
})

test.group('v3.6.114 video / pesan suara / file Instagram disimpan sebagai media', () => {
  test('video gagal diunduh → tautan di teks; jenis media tidak tertinggal "downloading"', async ({ assert }) => {
    const { ingestInstagramWebhook } = await import('#services/instagram_inbox')
    const mid = `mid-vid-${Date.now()}`
    await ingestInstagramWebhook({ entry: [{ messaging: [{ sender: { id: '7712347' }, recipient: { id: '999' }, timestamp: Date.now(), message: { mid, attachments: [{ type: 'video', payload: { url: 'http://127.0.0.1:9/v.mp4' } }] } }] }] })
    const row = await db.from('whatsapp_messages').where('message_id', mid).first()
    assert.include(row.body, '[video]')
    assert.include(row.body, 'http://127.0.0.1:9/v.mp4')
    assert.isNull(row.media_status)
    await db.from('whatsapp_messages').where('message_id', mid).delete()
    await db.from('whatsapp_ig_turns').where('jid', '7712347@ig').delete()
  })
})

test.group('v3.6.115 postingan Instagram dibagikan: kartu & petunjuk AI', () => {
  test('AI diberi tahu apakah gambar postingan ada', async ({ assert }) => {
    const { igShareHint, renderHistory } = await import('#beta3/prompt')
    assert.include(igShareHint({ direction: 'in', body: '[membagikan postingan]', mediaType: null }), 'tidak terbaca')
    assert.include(igShareHint({ direction: 'in', body: '[membagikan postingan] "Jas Navy"', mediaType: 'image' }), 'terlampir')
    assert.equal(igShareHint({ direction: 'in', body: 'cek harga', mediaType: null }), '')
    assert.equal(igShareHint({ direction: 'out', body: '[membagikan postingan]', mediaType: null }), '')
    const text = renderHistory([{ direction: 'in', body: '[membagikan postingan]', createdAt: new Date(), current: true }])
    assert.include(text, 'jangan menebak modelnya')
  })
  test('kartu di room: label, keterangan, tautan; teks lain tetap', async ({ assert }) => {
    const source = await readFile('public/assets/app.js', 'utf8')
    const start = source.indexOf('  const IG_SHARE_LABEL')
    const end = source.indexOf('  window.waIgShare = igShare')
    const igShare = new Function(`${source.slice(start, end)}; return igShare`)()
    const card = igShare({ jid: '1@ig', body: '[membagikan postingan] "Jas Navy Slimfit"\nhttps://www.instagram.com/p/abc/\nini ready kak?' })
    assert.deepEqual(card, { label: 'Postingan dibagikan', caption: 'Jas Navy Slimfit', link: 'https://www.instagram.com/p/abc/', text: 'ini ready kak?' })
    assert.equal(igShare({ jid: '1@ig', body: '[membalas story toko]\nmasih ada?' }).text, 'masih ada?')
    assert.isNull(igShare({ jid: '62812@s.whatsapp.net', body: '[membagikan postingan]' }))
    assert.isNull(igShare({ jid: '1@ig', body: 'halo' }))
  })
  test('detail pesan dicoba beberapa susunan bidang, hasil digabung', async ({ assert }) => {
    const source = await readFile('app/services/instagram_api.ts', 'utf8')
    assert.include(source, 'attachments{image_data')
    assert.include(source, 'shares{link')
    assert.include(source, 'export async function conversationMessages')
  })
})

test.group('v3.6.117 foto bahan pelanggan di cart, halaman order & grup', () => {
  test('foto bahan/warna diberi caption bahan, bukan "Model warna"', async ({ assert }) => {
    const { refCaption, mainModelRef } = await import('#beta3/refs_service')
    const spec = 'Setelan Tuxedo - Cream 2.0\nJas, Celana, Rompi\nSize XL/37\nBahan no 2\nTanpa merek'
    assert.equal(refCaption({ part: 'warna' }, spec), 'Bahan no 2 seperti ini')
    assert.equal(refCaption({ part: 'bahan' }, 'Jas bahan nomor 3'), 'Bahan no 3 seperti ini')
    assert.equal(refCaption({ part: 'warna' }), 'Bahan & warna seperti ini')
    assert.equal(refCaption({ part: 'model' }, spec), 'Model seperti ini')
    assert.equal(refCaption({ part: 'kerah' }, spec), 'Model kerah seperti ini')
    // Gambar utama untuk penjahit = foto model, bukan foto bahan yang dikirim lebih dulu.
    assert.equal(mainModelRef([{ part: 'warna' }, { part: 'model' }])!.part, 'model')
    assert.equal(mainModelRef([{ part: 'bahan' }])!.part, 'bahan')
    assert.isNull(mainModelRef([]))
  })
})

test.group('v3.6.118 stiker tidak ikut jadi referensi pesanan', () => {
  test('stiker diabaikan; foto model pelanggan jadi cadangan bila hanya ada foto bahan', async ({ assert }) => {
    const { saveAiRefs, refsForOrder, withModelFallback } = await import('#beta3/refs_service')
    const { ensureLeanTables } = await import('#beta3/tables')
    await ensureLeanTables()
    const jid = `tmpref${Date.now()}@s.whatsapp.net`
    const at = (min: number) => new Date(Date.now() - min * 60_000)
    await db.table('whatsapp_messages').insert([
      { message_id: `${jid}-bahan`, jid, direction: 'in', body: 'bahan no 2', media_type: 'image', media_url: '/media/bahan.jpg', status: 'received', created_at: at(30) },
      { message_id: `${jid}-model`, jid, direction: 'in', body: '', media_type: 'image', media_url: '/media/model.jpg', status: 'received', created_at: at(28) },
      { message_id: `${jid}-stiker`, jid, direction: 'in', body: '', media_type: 'sticker', media_url: '/media/stiker.webp', status: 'received', created_at: at(26) },
    ])
    await db.table('whatsapp_beta3_proofs').insert([
      { message_id: `${jid}-bahan`, jid, kind: 'model', note: '', created_at: new Date() },
      { message_id: `${jid}-model`, jid, kind: 'model', note: '', created_at: new Date() },
    ])
    // AI menunjuk stiker sebagai "model" → tidak disimpan; foto bahan disimpan.
    assert.equal(await saveAiRefs(jid, [{ gambar: 1, bagian: 'model' }], [`${jid}-stiker`]), 0)
    assert.equal(await saveAiRefs(jid, [{ gambar: 1, bagian: 'warna' }], [`${jid}-bahan`]), 1)
    // Data lama: stiker sudah terlanjur tercatat → tidak tampil.
    await db.table('whatsapp_beta3_refs').insert({ jid, message_id: `${jid}-stiker`, image_url: '/media/stiker.webp', part: 'model', note: '', created_at: new Date(), updated_at: new Date() })
    await db.from('whatsapp_beta3_refs').where('jid', jid).update({ order_id: 999001 })
    const refs = await refsForOrder(999001)
    assert.deepEqual(refs.map((ref) => ref.image_url), ['/media/bahan.jpg'])
    const order = { id: 999001, jid, spec: 'Setelan Tuxedo - Cream 2.0\nModel sesuai gambar\nBahan no 2', created_at: new Date() }
    const full = await withModelFallback(order, refs)
    assert.deepEqual(full.map((ref) => ref.image_url), ['/media/bahan.jpg', '/media/model.jpg'])
    // Tanpa "sesuai gambar" tidak ada tambahan.
    assert.lengthOf(await withModelFallback({ ...order, spec: 'Setelan Tuxedo - Cream 2.0' }, refs), 1)
    await db.from('whatsapp_beta3_refs').where('jid', jid).delete()
    await db.from('whatsapp_beta3_proofs').where('jid', jid).delete()
    await db.from('whatsapp_messages').where('jid', jid).delete()
  })
})

test.group('v3.6.119 reaksi tampil (WhatsApp & Instagram)', () => {
  test('reaksi Instagram pelanggan tersimpan ke pesan yang dituju; unreact menghapus', async ({ assert }) => {
    const { ingestIgReaction } = await import('#services/instagram_inbox')
    const mid = `mid-react-${Date.now()}`
    const config = { userId: '999' } as any
    await ingestIgReaction({ sender: { id: '7712350' }, recipient: { id: '999' }, reaction: { mid, action: 'react', reaction: 'love', emoji: '❤️' } }, config)
    let row = await db.from('whatsapp_reactions').where('target_message_id', mid).first()
    assert.equal(row.emoji, '❤️')
    assert.equal(row.jid, '7712350@ig')
    assert.equal(Number(row.from_me), 0)
    // Pemilik mereaksi dari aplikasi Instagram → from_me.
    await ingestIgReaction({ sender: { id: '999' }, recipient: { id: '7712350' }, reaction: { mid, action: 'react', reaction: 'like' } }, config)
    row = await db.from('whatsapp_reactions').where('target_message_id', mid).where('sender', 'me').first()
    assert.equal(row.emoji, '👍')
    await ingestIgReaction({ sender: { id: '7712350' }, recipient: { id: '999' }, reaction: { mid, action: 'unreact' } }, config)
    assert.lengthOf(await db.from('whatsapp_reactions').where('target_message_id', mid).where('sender', '7712350@ig'), 0)
    await db.from('whatsapp_reactions').where('target_message_id', mid).delete()
  })
  test('reaksi WhatsApp: kunci pesan yang dituju = key, pengirim dari reaction.key', async ({ assert }) => {
    const source = await readFile('commands/whatsapp_listen.ts', 'utf8')
    assert.include(source, 'const targetId = key?.id')
    assert.include(source, "const sender = fromMe ? 'me' : by?.participant || by?.remoteJid || jid")
  })
})
