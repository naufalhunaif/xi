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
    assert.include(source, 'const store = [storeProfile, wholesale]')
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
