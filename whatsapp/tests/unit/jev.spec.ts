import { test } from '@japa/runner'
import db from '#services/workspace_database'
import {
  accuracySummary,
  askJev,
  confident,
  jevOn,
  listDecisions,
  markDecision,
  maskPii,
  readJevConfig,
  resetJevCache,
  saveJevConfig,
  setJevFetcher,
} from '#beta3/jev'
import {
  chooseImageColor,
  isNewDestination,
  promisesTotal,
  storeConfirmedPayment,
  storeSentTotal,
  understandTurn,
} from '#beta3/jev_decisions'
import { guardTotalPromise, offeredServices } from '#beta3/reply_service'
import { matchAutoTotal } from '#beta3/order_service'

const reply = (answers: Record<string, unknown>) =>
  (async () =>
    new Response(
      JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    )) as unknown as typeof fetch

test.group('Jev · kunci, panggilan, cadangan', (group) => {
  group.each.setup(async () => {
    await db
      .from('whatsapp_beta3_state')
      .whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error'])
      .delete()
      .catch(() => {})
    return async () => {
      setJevFetcher(null)
      // Jangan tinggalkan kunci uji: tes lain tidak boleh memanggil Jev sungguhan.
      await db.from('whatsapp_beta3_state').whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error']).delete().catch(() => {})
      resetJevCache()
    }
  })

  test('tanpa kunci: Jev tidak dipanggil sama sekali', async ({ assert }) => {
    let called = false
    setJevFetcher((async () => {
      called = true
      return new Response('{}')
    }) as unknown as typeof fetch)
    assert.isFalse(await jevOn('layanan'))
    assert.isNull(await askJev('uji', 'halo', { a: { type: 'noul', instructions: 'x' } }))
    assert.isFalse(called)
  })

  test('kunci tersimpan terenkripsi; keputusan bisa dimatikan satu per satu', async ({
    assert,
  }) => {
    await saveJevConfig({ apiKey: 'ts_rahasia', enabled: true, off: ['varian'] })
    const raw = await db.from('whatsapp_beta3_state').where('name', 'jev_key').first()
    assert.notInclude(String(raw?.value || ''), 'ts_rahasia')
    assert.equal((await readJevConfig()).apiKey, 'ts_rahasia')
    assert.isTrue(await jevOn('layanan'))
    assert.isFalse(await jevOn('varian'))
  })

  test('jawaban diparse; gagal/timeout = null (cara lama)', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher(
      reply({
        q: { type: 'choice', choice: 'reg', probabilities: { reg: 0.95 }, confidence: 0.95 },
      })
    )
    const answers = await askJev('uji', 'pakai reg', {
      q: { type: 'choice', instructions: 'x', criteria: { reg: 'a', yes: 'b' } },
    })
    assert.equal(answers?.q?.type === 'choice' ? answers.q.choice : '', 'reg')
    assert.isTrue(confident('layanan', answers?.q))
    setJevFetcher((async () => new Response('{}', { status: 529 })) as unknown as typeof fetch)
    assert.isNull(await askJev('uji', 'x', { q: { type: 'noul', instructions: 'x' } }))
  })

  test('nomor HP, rekening, dan email disamarkan sebelum dikirim', ({ assert }) => {
    const masked = maskPii(
      'kirim ke 085286476035, rek BRI 677901015573536, email a.b@c.id, total 800.000'
    )
    assert.notInclude(masked, '085286476035')
    assert.notInclude(masked, '677901015573536')
    assert.notInclude(masked, 'a.b@c.id')
    assert.include(masked, '800.000')
  })

  test('warna gambar: Jev memilih warna katalog dari hasil ukur piksel; ragu → tidak dipakai', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    const input = {
      jid: 'jevtest@s.whatsapp.net',
      image: 1,
      measured: 'putih kekuningan tipis (broken white / off white / gading)',
      candidates: [
        { color: 'Broken White', distance: 2.1, products: ['Tuxedo Signature'] },
        { color: 'White', distance: 9.4, products: ['Tuxedo'] },
      ],
      text: 'yang ini ada?',
      history: [],
    }
    setJevFetcher(reply({ warna_gambar: { type: 'choice', choice: 'Broken White', probabilities: {}, confidence: 0.93 } }))
    assert.equal(await chooseImageColor(input), 'Broken White')
    setJevFetcher(reply({ warna_gambar: { type: 'choice', choice: 'White', probabilities: {}, confidence: 0.55 } }))
    assert.isUndefined(await chooseImageColor(input))
    setJevFetcher(reply({ warna_gambar: { type: 'choice', choice: 'lain', probabilities: {}, confidence: 0.9 } }))
    assert.isNull(await chooseImageColor(input))
  })

  test('keputusan tambahan v3.5.11: tanda terima, topik, kesulitan, sudah tf, tunda, prioritas', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher(
      reply({
        tanggapan: { type: 'choice', choice: 'terima', probabilities: {}, confidence: 0.95 },
        topik_ongkir: { type: 'noul', noul: 0.04 },
        topik_ukuran: { type: 'noul', noul: 0.97 },
        topik_bayar: { type: 'noul', noul: 0.5 },
        kesulitan: { type: 'score', score: 1.1, confidence: 0.9 },
        sudah_tf: { type: 'noul', noul: 0.96 },
        lanjut: { type: 'choice', choice: 'tunda', probabilities: {}, confidence: 0.95 },
        urgensi: { type: 'score', score: 4.6, confidence: 0.8 },
      })
    )
    const result = await understandTurn({
      jid: 'jevtest@s.whatsapp.net',
      text: 'oke kak',
      history: [{ direction: 'out', body: 'Ukuran size L seperti ini bos' }],
      services: [],
      offerPending: false,
      awaitingPayment: true,
    })
    assert.equal(result.reaction, 'terima')
    assert.deepEqual(result.topics, { ongkir: false, ukuran: true })
    assert.equal(result.difficulty, 1)
    assert.isTrue(result.paidClaim)
    assert.equal(result.follow, 'tunda')
    assert.equal(result.urgency, 5)
  })

  test('tujuan baru & dana masuk: Jev yakin dipakai, ragu = tidak tahu', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher(reply({ tujuan_baru: { type: 'noul', noul: 0.03 } }))
    assert.isFalse(await isNewDestination('jevtest@s.whatsapp.net', 'reg aja', 'reg', 'Patimuan, Cilacap'))
    setJevFetcher(reply({ tujuan_baru: { type: 'noul', noul: 0.6 } }))
    assert.isUndefined(await isNewDestination('jevtest@s.whatsapp.net', 'kalo cilacap', 'cilacap', 'Patimuan, Cilacap'))
    setJevFetcher(reply({ dana_masuk: { type: 'noul', noul: 0.02 } }))
    assert.isFalse(await storeConfirmedPayment('jevtest@s.whatsapp.net', ['Totalnya 705.000 bos, transfer ke BCA 1234567890']))
    setJevFetcher(reply({ dana_masuk: { type: 'noul', noul: 0.97 } }))
    assert.isTrue(await storeConfirmedPayment('jevtest@s.whatsapp.net', ['Sudah masuk ya bos, terimakasih prosess ya']))
  })

  test('pemahaman giliran: layanan dari Jev dipakai bila yakin, belum memilih = null', async ({
    assert,
  }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher(
      reply({ layanan: { type: 'choice', choice: 'yes', probabilities: {}, confidence: 0.96 } })
    )
    const sure = await understandTurn({
      jid: 'jevtest@s.whatsapp.net',
      text: 'yang cepet aja kak',
      history: [],
      services: ['reg', 'yes'],
      offerPending: false,
    })
    assert.equal(sure.service, 'yes')
    setJevFetcher(
      reply({ layanan: { type: 'choice', choice: 'belum', probabilities: {}, confidence: 0.95 } })
    )
    const none = await understandTurn({
      jid: 'jevtest@s.whatsapp.net',
      text: 'ongkirnya berapa',
      history: [],
      services: ['reg', 'yes'],
      offerPending: false,
    })
    assert.isNull(none.service)
    setJevFetcher(
      reply({ layanan: { type: 'choice', choice: 'reg', probabilities: {}, confidence: 0.5 } })
    )
    const unsure = await understandTurn({
      jid: 'jevtest@s.whatsapp.net',
      text: 'hmm',
      history: [],
      services: ['reg', 'yes'],
      offerPending: false,
    })
    assert.isUndefined(unsure.service)
  })

  test('janji total & total toko: Jev yakin menang atas pola kata', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    setJevFetcher(reply({ janji_total: { type: 'noul', noul: 0.97 } }))
    assert.isTrue(
      await promisesTotal('jevtest@s.whatsapp.net', ['Siap bos, rinciannya saya rangkum dulu'])
    )
    setJevFetcher(
      reply({ pesan_0: { type: 'noul', noul: 0.98 }, pesan_1: { type: 'noul', noul: 0.02 } })
    )
    assert.isTrue(
      await storeSentTotal('jevtest@s.whatsapp.net', [
        'Beskap 705.000 + ongkir 95.000 = 800.000',
        'siap bos',
      ])
    )
  })

  test('catatan keputusan: tandai salah → akurasi turun', async ({ assert }) => {
    const before = await listDecisions(200)
    const ours = before.filter((row: any) => row.jid === 'jevtest@s.whatsapp.net')
    assert.isAbove(ours.length, 0)
    await markDecision(Number(ours[0].id), true)
    const summary = await accuracySummary()
    assert.isAbove(
      summary.reduce((sum, row) => sum + row.wrong, 0),
      0
    )
    await db.from('whatsapp_beta3_decisions').where('jid', 'jevtest@s.whatsapp.net').delete()
  })
})

test.group('Jev · aturan tanpa jaringan', () => {
  test('layanan pilihan Jev dipakai menghitung total; belum memilih menahan total', ({
    assert,
  }) => {
    const catalog = [
      { product: 'Peak Suit', color: 'Black', price: 485000, note: '', active: true },
    ]
    const prices = [
      { service: 'CTC23', price: 6000 },
      { service: 'CTCYES23', price: 8000 },
    ]
    const draft = { rincian: 'Peak Suit - Black 485.000', subtotal: 485000, layanan: '' }
    const yes = matchAutoTotal(draft, catalog, prices, ['terserah kak'], [], 'yes')
    assert.isTrue(yes.ok)
    if (yes.ok) assert.equal(yes.shippingCost, 8000)
    assert.isFalse(
      matchAutoTotal({ ...draft, layanan: 'CTC' }, catalog, prices, ['reg aja'], [], null).ok
    )
  })

  test('janji total: Jev "bukan janji" membatalkan pola kata; "janji" menangkap kalimat yang lolos pola', ({
    assert,
  }) => {
    assert.isFalse(
      guardTotalPromise(['Ini totalnya saya kirimkan'], {
        address: 'bos',
        hasAddress: false,
        jev: false,
      }).changed
    )
    const caught = guardTotalPromise(['Siap bos', 'Rincian total segera saya infokan.'], {
      address: 'bos',
      hasAddress: true,
      jev: true,
    })
    assert.isTrue(caught.changed)
    assert.deepEqual(caught.pesan, ['Siap bos', 'Totalnya saya cek dulu ya bos'])
  })

  test('layanan yang ditawarkan dibaca dari order (tanpa JTR)', ({ assert }) => {
    const raw = JSON.stringify({
      prices: [
        { service: 'REG23', price: 95000 },
        { service: 'CTCYES23', price: 0 },
        { service: 'JTR23', price: 65000 },
        { service: 'YES23', price: 120000 },
      ],
    })
    assert.deepEqual(offeredServices(raw), ['reg', 'yes'])
  })
})
