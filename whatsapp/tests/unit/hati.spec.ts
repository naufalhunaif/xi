import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { mergeDigest } from '#beta3/skill_digest'
import { trimSkill } from '#beta3/token_saver'
import db from '#services/workspace_database'
import { resetJevCache, saveJevConfig, setJevFetcher } from '#beta3/jev'
import { understandTurn } from '#beta3/jev_decisions'
import { explainDecision } from '#beta3/jev_explain'
import { GREETED, calmForFeeling, dropRepeatedGreeting, dropRepeatedSentences, heartLabel, heartNote, notedInsteadOfAnswer } from '#beta3/hati'

// v3.6.59 "Rasa" → v3.6.61 "Hati CS" (permintaan pemilik: lebih manusiawi, bukan sekadar mirip
// manusia). Satu skill inti; tiap balasan lewat 4 lapis: pikiran (mind) → rasa (emotion) →
// jiwa (spirit) → tindakan (action). Asal kasus: chat Agus & Nofita 7 Okt.
const root = new URL('../../skills-beta3/beta3-cs-inti/', import.meta.url)
const HEADING = '## Hati CS — pikiran, rasa, jiwa, tindakan'
const none = { size: false, spec: false, catalog: false, shipping: false, paid: false, photo: false, instagram: false }

test.group('skill Hati CS (v3.6.61)', () => {
  test('empat lapis ada berurutan, menggantikan bagian Rasa', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    assert.notInclude(skill, '## Rasa — baca maksud')
    const at = (text: string) => skill.indexOf(text)
    const layers = [HEADING, '**1. Pikiran — pahami maksudnya**', '**2. Rasa — tanggapi perasaannya dulu, baru data**', '**3. Jiwa — tulus membantu**', '**4. Tindakan — satu langkah nyata**']
    for (const layer of layers) assert.isAbove(at(layer), -1, layer)
    for (let index = 1; index < layers.length; index++) assert.isAbove(at(layers[index]), at(layers[index - 1]))
    // Hati CS sesudah "Cara bicara", sebelum "Urutan tahap".
    assert.isAbove(at(HEADING), at('## Cara bicara'))
    assert.isBelow(at(HEADING), at('## Urutan tahap'))
  })

  test('isi tiap lapis: maksud apa adanya, rasa, niat tulus, satu langkah', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    for (const text of [
      // Pikiran
      'jangan menafsir terlalu jauh atau menebak alasan yang tidak ia sebut',
      '**Bertanya ≠ meminta**',
      '("iya bos, kancingnya 1")',
      '"takut kebesaran" = ingin pas di badan',
      '"bisa disesuaikan ukurannya bos, biar pas"',
      'Satu pertanyaan per giliran',
      // Rasa
      'Keberatan harga',
      'Nego harga: "Sudah harga pas bos"',
      '"maaf ya bos" dulu',
      '"siap bos, gak apa-apa, kalau nanti mau lihat lagi kabari saya ya"',
      '"wah selamat ya bos"',
      // Jiwa
      'Sarankan yang cocok, bukan yang termahal',
      '"untuk gaya gen z biasanya slimfit warna gelap seperti Basic Suit bos, simpel dan rapi"',
      '("dicatat ya", "cocok ya?")',
      // Tindakan
      '**Tawaran = janji**',
      'Tutup dengan pintu terbuka, bukan desakan',
      'Terima kasih ("siap terimakasih", "makasih") → "Siap sama sama bos" saja',
    ])
      assert.include(skill, text)
    // "takut kebesaran" bukan soal uang (koreksi pemilik).
    assert.notInclude(skill, 'takut rugi')
    // Aturan yang dipindah ke Hati CS tidak dobel di "Cara bicara".
    const talk = skill.slice(skill.indexOf('## Cara bicara'), skill.indexOf(HEADING))
    for (const moved of ['Tawaran = janji', 'Nego harga', 'Satu pertanyaan per giliran', 'siap sama sama bos'])
      assert.notInclude(talk, moved)
  })

  test('ringkasan (DIGEST) lengkap dan bagian Hati CS selalu dimuat (tidak ikut dipangkas)', async ({ assert }) => {
    const skill = await readFile(new URL('SKILL.md', root), 'utf8')
    const digest = await readFile(new URL('DIGEST.md', root), 'utf8')
    const merged = mergeDigest(skill, digest)!
    assert.include(merged.text, HEADING)
    assert.deepEqual(merged.fallback, [])
    const trimmed = trimSkill(merged.text, none)
    assert.include(trimmed.text, '**4. Tindakan — satu langkah nyata**')
    assert.notInclude(trimmed.skipped, 'Hati CS')
  })
})

// v3.6.62 — Jev membaca bentuk kalimat, rasa, dan momen pelanggan; AI menerima CATATAN HATI singkat.
const jevReply = (answers: Record<string, unknown>) =>
  (async () =>
    new Response(JSON.stringify({ model: 'jev-test', answers, usage: { input_tokens: 10, output_tokens: 1 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
const choice = (value: string, confidence = 0.92) => ({ type: 'choice', choice: value, probabilities: {}, confidence })

test.group('Hati CS · Jev membaca maksud, rasa, momen (v3.6.62)', (group) => {
  group.each.setup(async () => {
    const clean = () => db.from('whatsapp_beta3_state').whereIn('name', ['jev_key', 'jev_settings', 'jev_last_error']).delete().catch(() => {})
    await clean()
    return async () => {
      setJevFetcher(null)
      await clean()
      resetJevCache()
    }
  })

  test('jawaban yakin → heart; ragu (< 0.8) tidak dipakai', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    let sent: any = null
    const answers = { hati_bentuk: choice('bertanya'), hati_rasa: choice('ragu'), hati_momen: choice('wisuda', 0.6) }
    setJevFetcher((async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return (jevReply(answers) as any)()
    }) as unknown as typeof fetch)
    const result = await understandTurn({
      jid: 'hatitest@s.whatsapp.net',
      text: 'Kancing 1 ..ya, takut kebesaran buat wisuda',
      history: [{ direction: 'out', body: 'Basic Suit hitam 485.000 bos' }],
      services: [],
      offerPending: false,
    })
    assert.deepEqual(result.heart, { form: 'bertanya', feeling: 'ragu' })
    // Ketiga pertanyaan Hati ikut dalam satu panggilan Jev yang sama.
    assert.includeMembers(Object.keys(sent.questions), ['hati_bentuk', 'hati_rasa', 'hati_momen'])
    assert.include(sent.questions.hati_rasa.criteria.ragu, 'takut kebesaran')
  })

  test('Hati dimatikan di pengaturan Jev → tidak ditanyakan', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true, off: ['hati'] })
    let sent: any = null
    setJevFetcher((async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return (jevReply({}) as any)()
    }) as unknown as typeof fetch)
    const result = await understandTurn({ jid: 'hatitest@s.whatsapp.net', text: 'kok mahal ya', history: [], services: [], offerPending: false })
    assert.isUndefined(result.heart)
    assert.notProperty(sent?.questions || {}, 'hati_rasa')
  })

  test('CATATAN HATI: hanya yang tidak netral; ucapan momen tidak diulang', ({ assert }) => {
    assert.equal(heartNote(undefined), '')
    assert.equal(heartNote({ form: 'lain', feeling: 'netral', moment: 'tidak_ada' }), '')
    const note = heartNote({ form: 'bertanya', feeling: 'ragu', moment: 'wisuda' })
    assert.include(note, 'CATATAN HATI: pelanggan BERTANYA')
    assert.include(note, 'rasa: ragu/cemas')
    assert.include(note, 'momen: wisuda → "wah selamat ya bos" sekali')
    assert.include(heartNote({ moment: 'wisuda' }, true), 'jangan diulang')
    assert.include(heartNote({ feeling: 'pamit' }), 'tanpa susulan')
    assert.equal(heartLabel({ form: 'bertanya', feeling: 'keberatan_harga', moment: 'tidak_ada' }), 'Hati · bertanya · keberatan harga')
    assert.isTrue(GREETED.test('wah selamat ya bos, semoga lancar wisudanya'))
    assert.isFalse(GREETED.test('Selamat pagi bos'))
  })

  test('keputusan Hati dijelaskan di Usage → Jev accuracy', ({ assert }) => {
    const row = explainDecision({ decision: 'hati', answer: 'keberatan_harga', detail: 'rasa', used: 1 })
    assert.equal(row.says, 'Customer feeling: finds it expensive.')
    assert.include(row.effect, 'HATI')
    assert.include(explainDecision({ decision: 'hati', answer: 'nikah', detail: 'momen', used: 1 }).question, 'occasion')
  })
})

// v3.6.63 — penjaga sistem Hati CS.
test.group('Hati CS · penjaga sistem (v3.6.63)', () => {
  const out = (body: string) => ({ direction: 'out', body })
  const inn = (body: string, current = false) => ({ direction: 'in', body, current })

  test('kalimat yang sama tidak diulang (kasus Agus); angka, salam, daftar, dan balasan yang seluruhnya ulangan tetap', ({ assert }) => {
    const rows = [inn('Lapisnya warna hitam'), out('Siap bos, dicatat ya. Cocok ya bos?'), inn('Kancing 1 ..ya', true)]
    const result = dropRepeatedSentences(['Iya bos, kancingnya 1. Siap bos, dicatat ya.'], rows)
    assert.deepEqual(result.pesan, ['Iya bos, kancingnya 1.'])
    assert.deepEqual(result.removed, ['Siap bos, dicatat ya.'])
    // Seluruhnya ulangan → dibiarkan (lebih baik daripada diam).
    assert.deepEqual(dropRepeatedSentences(['Siap bos, dicatat ya.'], rows).pesan, ['Siap bos, dicatat ya.'])
    // Kalimat berangka (harga/total) & salam tidak dijaga.
    const priced = [out('Harganya 485.000 bos. Halo bos, ada yang bisa kami bantu')]
    assert.deepEqual(dropRepeatedSentences(['Harganya 485.000 bos. Halo bos, ada yang bisa kami bantu'], priced).removed, [])
    // Bubble daftar (baris baru) tidak diubah.
    const list = 'Modelnya:\n- Basic Suit\n- Tuxedo'
    assert.deepEqual(dropRepeatedSentences([list, 'Mau yang mana bos?'], [out(list)]).pesan, [list, 'Mau yang mana bos?'])
    // Lebih dari 10 pesan keluar yang lalu → boleh dipakai lagi.
    const old = [out('Siap bos, dicatat ya.'), ...Array.from({ length: 10 }, (_, index) => out(`pesan lain nomor ${'x'.repeat(index + 1)}`))]
    assert.deepEqual(dropRepeatedSentences(['Oke bos. Siap bos, dicatat ya.'], old).removed, [])
  })

  test('kesal / pamit: tanpa susulan & tanpa tawaran tambahan; keberatan harga: tanpa susulan saja', ({ assert }) => {
    const pamit = calmForFeeling(['Siap bos, gak apa-apa, kalau nanti mau lihat lagi kabari saya ya. Sekalian celananya juga bisa bos.'], 'pamit')
    assert.isTrue(pamit.stopSusulan)
    assert.deepEqual(pamit.pesan, ['Siap bos, gak apa-apa, kalau nanti mau lihat lagi kabari saya ya.'])
    const price = calmForFeeling(['Kalau mau ambil yang lebih hemat ada Basic Suit 485.000 bos'], 'keberatan_harga')
    assert.isTrue(price.stopSusulan)
    assert.isFalse(price.changed)
    assert.isFalse(calmForFeeling(['Jadi ambil yang mana bos?'], 'senang').stopSusulan)
    assert.isFalse(calmForFeeling(['x'], undefined).stopSusulan)
  })

  test('ucapan selamat momen hanya sekali; bertanya dijawab "dicatat" ditandai', ({ assert }) => {
    const rows = [out('Wah selamat ya bos, semoga lancar wisudanya'), inn('size M ready?', true)]
    assert.deepEqual(dropRepeatedGreeting(['Selamat ya bos untuk wisudanya. Size M ready bos.'], rows).pesan, ['Size M ready bos.'])
    assert.isFalse(dropRepeatedGreeting(['Wah selamat ya bos'], [out('Selamat pagi bos')]).changed)
    assert.isTrue(notedInsteadOfAnswer(['Siap bos, dicatat ya'], 'bertanya'))
    assert.isFalse(notedInsteadOfAnswer(['Iya bos, kancingnya 1, dicatat ya'], 'bertanya'))
    assert.isFalse(notedInsteadOfAnswer(['Siap bos, dicatat ya'], 'meminta'))
  })
})
