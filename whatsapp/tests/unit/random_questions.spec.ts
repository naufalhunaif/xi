import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { buildLeanPrompt } from '#beta3/prompt'
import { bubblesToSend, dropRepeatedQuestions, ensureHandoffReply, HANDOFF_REPLY } from '#beta3/reply_service'
import { cancelsOrder, prependMissing } from '#beta3/reply_guards'
import { tidyLists } from '#beta3/list_tidy'
import { DEFAULT_EXCHANGE_POLICY, renderExchangePolicy } from '#beta3/store_policy'
import { providerTimeout, REPLY_TIMEOUT_MS } from '#beta3/provider'

// v3.6.55 — cs-pelajaran #26: uji pemilik dengan pertanyaan acak. 8 pertanyaan diserahkan ke CS
// tanpa balasan (pelanggan didiamkan), 3 pertanyaan hilang karena giliran batal, "ga jadi" dibaca
// batal pesanan, alamat toko pecah jadi daftar, teks tukar size disalin persis.
const decision = (over: Record<string, unknown>) =>
  ({ serah_cs: false, pesan: [] as string[], ...over }) as { serah_cs: boolean; pesan: string[]; aman?: string[] }

test.group('pertanyaan acak: tidak ada pelanggan yang didiamkan (v3.6.55)', () => {
  test('serah CS tetap mengirim balasan singkat AI; ditahan pemeriksa harga → hanya bubble aman', ({ assert }) => {
    const handoff = decision({ serah_cs: true, pesan: ['Untuk diskon pesanan banyak saya tanyakan ke tim dulu ya bos'] })
    assert.deepEqual(bubblesToSend(handoff), ['Untuk diskon pesanan banyak saya tanyakan ke tim dulu ya bos'])
    const held = decision({ serah_cs: true, pesan: ['Totalnya 999.000 bos', 'Saya cek dulu ya bos'], aman: ['Saya cek dulu ya bos'] })
    assert.deepEqual(bubblesToSend(held), ['Saya cek dulu ya bos'])
    assert.deepEqual(bubblesToSend(decision({ pesan: ['Bisa bos'] })), ['Bisa bos'])
  })

  test('serah CS tanpa balasan → balasan cadangan (bukan diam)', ({ assert }) => {
    const empty = decision({ serah_cs: true })
    assert.isTrue(ensureHandoffReply(empty))
    assert.deepEqual(bubblesToSend(empty), [HANDOFF_REPLY])
    const heldAll = decision({ serah_cs: true, pesan: ['Totalnya 999.000 bos'], aman: [] })
    assert.isTrue(ensureHandoffReply(heldAll))
    assert.deepEqual(bubblesToSend(heldAll), [HANDOFF_REPLY])
    // Balasan biasa (bukan serah CS) tidak disentuh.
    assert.isFalse(ensureHandoffReply(decision({ pesan: [] })))
  })

  test('pesan giliran yang batal ikut ke giliran berikutnya, tanpa dobel', ({ assert }) => {
    const queue = [{ id: 'B' }]
    prependMissing(queue, [{ id: 'A' }, { id: 'B' }])
    assert.deepEqual(queue.map((item) => item.id), ['A', 'B'])
  })
})

test.group('pertanyaan acak: "gak jadi" & pengulangan (v3.6.55)', () => {
  const row = (direction: 'in' | 'out', body: string, current = false) => ({ direction, body, current, createdAt: '' })

  test('"ga jadi" sesudah pertanyaan = pertanyaannya yang batal, bukan pesanan', ({ assert }) => {
    // Cek resi belum dijawab, lalu "Ga jadi".
    assert.isFalse(cancelsOrder('Ga jadi', [row('in', 'Cek resi ini sudah sampe mana (JNE)'), row('in', 'Ga jadi', true)]))
    // Dalam satu giliran: pertanyaan diskon lalu "Gak jadi".
    assert.isFalse(cancelsOrder('Misal pesen banyak dapet diskon gak nih\nGak jadi', []))
    // Sesudah toko menjawab pertanyaan info (bukan langkah order).
    assert.isFalse(cancelsOrder('ga jadi', [row('out', 'Untuk diskon saya tanyakan ke tim dulu ya bos'), row('in', 'ga jadi', true)]))
  })

  test('pesanan batal bila jelas menyebut pesanan, atau menjawab total/rekening', ({ assert }) => {
    assert.isTrue(cancelsOrder('batal pesan jasnya ya mas', []))
    assert.isTrue(cancelsOrder('gak jadi beli dulu deh', []))
    assert.isTrue(cancelsOrder('gak jadi deh', [row('out', 'Totalnya 927.000 bos, transfer ke rekening berikut'), row('in', 'gak jadi deh', true)]))
  })

  test('pertanyaan order tidak ditagih ulang sesudah beberapa selingan topik lain', ({ assert }) => {
    const rows = [
      row('out', 'Celananya menyesuaikan aja atau pakai No. berapa ya bos?'),
      row('out', 'Maaf bos, itu di luar urusan toko ya'),
      row('out', 'Lokasi toko di Cilacap bos'),
      row('out', 'Bisa bos, toko buka Senin-Jumat jam 9 pagi'),
      row('out', 'Siap bos, gak jadi ya'),
      row('in', 'Kenapa filsafat ibu ilmu?', true),
    ]
    assert.deepEqual(
      dropRepeatedQuestions(['Pertanyaan itu di luar urusan toko bos', 'Celananya menyesuaikan aja atau pakai No. berapa ya bos?'], rows),
      ['Pertanyaan itu di luar urusan toko bos']
    )
  })
})

test.group('pertanyaan acak: format & aturan prompt (v3.6.55)', () => {
  test('alamat toko tidak dipecah jadi daftar; daftar nama biasa tetap dirapikan', ({ assert }) => {
    const address = 'Lokasi toko di Jl. Patimuan - Kedungreja, Cinyawang, Patimuan, Cilacap bos'
    assert.equal(tidyLists(address), address)
    assert.include(tidyLists('Ada model Basic Suit, Tuxedo, Peak Suit, dan Premium Basic Suit bos'), '\n')
  })

  test('kebijakan tukar size ditulis ulang gaya CS (tidak disalin persis); refund & custom dijelaskan', ({ assert }) => {
    const section = renderExchangePolicy(DEFAULT_EXCHANGE_POLICY)
    assert.notInclude(section, 'persis sebagai satu bubble')
    assert.include(section, 'gaya bicaramu sendiri')
    assert.include(section, 'custom tidak bisa tukar size')
    assert.include(section, 'refund')
  })

  test('prompt: tidak diam saat serah CS, identitas, data internal, pertanyaan umum, "gak jadi", tanpa klaim', ({ assert }) => {
    const prompt = buildLeanPrompt({
      skill: 'x',
      catalog: '',
      examples: [],
      customerNote: '',
      chatNote: '',
      history: [],
      message: 'Kalau 1 + 1 berapa',
      paymentMethods: [],
    })
    for (const rule of [
      'Tanpa janji "saya cek dulu" kecuali serah_cs',
      'tanpa klaim di luar data',
      '"1 + 1" → "2 bos 😄"',
      'hanya pertanyaan itu batal',
    ])
      assert.include(prompt.user, rule)
  })

  test('skill: serah CS hanya keputusan bisnis dan tetap dibalas', async ({ assert }) => {
    const skill = await readFile(new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url), 'utf8')
    assert.include(skill, '## Batas wewenang → serah_cs = true, tetap dibalas singkat')
    assert.include(skill, '`pesan` tetap satu kalimat')
    assert.include(skill, 'saya CS Chameleon Cloth bos')
    assert.include(skill, 'itu tidak bisa lewat chat ya')
    assert.include(skill, 'posisi paket → LACAK RESI')
    assert.notInclude(skill, 'resi yang belum ada datanya')
    assert.notInclude(skill, 'apa pun di luar urusan jual-beli')
  })
})

test.group('pertanyaan acak: kecepatan (v3.6.55)', () => {
  test('balasan chat tanpa gambar dibatasi 75 dtk; bergambar & tugas lain tetap 120 dtk', ({ assert }) => {
    assert.equal(providerTimeout('beta3-reply', 0), REPLY_TIMEOUT_MS)
    assert.equal(REPLY_TIMEOUT_MS, 75_000)
    assert.equal(providerTimeout('beta3-reply', 1), 120_000)
    assert.equal(providerTimeout('beta3-recap', 0), 120_000)
  })
})
