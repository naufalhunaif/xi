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
