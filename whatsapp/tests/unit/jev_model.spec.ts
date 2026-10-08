import { test } from '@japa/runner'
import db from '#services/workspace_database'
import { writeLeanState } from '#beta3/tables'
import { askJev, isPinnedJevModel, jevModelOrder, jevStatus, resetJevCache, saveJevConfig, setJevFetcher } from '#beta3/jev'

// v3.6.64 — 8 Okt: Jev sering gagal (HTTP 503 dari penyedia, langsung 0 dtk) dan baris gagal tercatat
// "jev-latest". Sekarang: versi pasti yang dilaporkan penyedia (jev-1.13.0) yang dipakai, alias hanya
// untuk cek versi baru sekali sehari; gangguan sementara (429/5xx/529) dicoba ulang sebentar.
const names = ['jev_key', 'jev_settings', 'jev_last_error', 'jev_model_resolved']
const ok = (model = 'jev-1.13.0') =>
  new Response(JSON.stringify({ model, answers: { q: { type: 'noul', noul: 0.97 } }, usage: { input_tokens: 5, output_tokens: 1 } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
const question = { q: { type: 'noul' as const, instructions: 'Apakah ini pertanyaan harga?' } }

test.group('Jev · versi model dari penyedia & coba ulang (v3.6.64)', (group) => {
  group.each.setup(async () => {
    const clean = () => db.from('whatsapp_beta3_state').whereIn('name', names).delete().catch(() => {})
    await clean()
    resetJevCache()
    return async () => {
      setJevFetcher(null)
      await clean()
      resetJevCache()
    }
  })

  test('urutan model: alias → versi pasti dari penyedia; > 24 jam → alias dulu (cek versi baru); model pasti pemilik apa adanya', ({ assert }) => {
    const now = Date.parse('2026-10-08T05:00:00Z')
    assert.isTrue(isPinnedJevModel('jev-1.13.0'))
    assert.isFalse(isPinnedJevModel('jev-latest'))
    assert.isFalse(isPinnedJevModel('jev-preview'))
    assert.deepEqual(jevModelOrder('jev-latest', null, now), ['jev-latest'])
    assert.deepEqual(jevModelOrder('jev-latest', { model: 'jev-1.13.0', at: now - 60_000 }, now), ['jev-1.13.0', 'jev-latest'])
    assert.deepEqual(jevModelOrder('', { model: 'jev-1.13.0', at: now - 25 * 3600_000 }, now), ['jev-latest', 'jev-1.13.0'])
    assert.deepEqual(jevModelOrder('jev-1.12.0', { model: 'jev-1.13.0', at: now }, now), ['jev-1.12.0'])
  })

  test('503 sesaat → dicoba ulang dan berhasil; versi dari penyedia dipakai di panggilan berikutnya', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    const sent: string[] = []
    let calls = 0
    setJevFetcher((async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).model)
      calls++
      return calls === 1 ? new Response('busy', { status: 503 }) : ok()
    }) as unknown as typeof fetch)
    const first = await askJev('uji', { pesan: 'harga jas berapa' }, question)
    assert.isNotNull(first)
    assert.deepEqual(sent, ['jev-latest', 'jev-latest'])
    await askJev('uji', { pesan: 'harga celana' }, question)
    assert.equal(sent[2], 'jev-1.13.0')
    assert.equal((await jevStatus()).activeModel, 'jev-1.13.0')
  })

  test('terus 503 → percobaan terakhir memakai model cadangan; tetap gagal → null (cara lama)', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    await writeLeanState('jev_model_resolved', JSON.stringify({ model: 'jev-1.13.0', at: Date.now() }))
    resetJevCache()
    const sent: string[] = []
    setJevFetcher((async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).model)
      return new Response('busy', { status: 503 })
    }) as unknown as typeof fetch)
    assert.isNull(await askJev('uji', { pesan: 'x' }, question))
    assert.deepEqual(sent, ['jev-1.13.0', 'jev-1.13.0', 'jev-latest'])
    assert.include((await jevStatus()).lastError, 'Jev HTTP 503')
  })

  test('kunci salah (401) dan validasi (422) tidak dicoba ulang', async ({ assert }) => {
    await saveJevConfig({ apiKey: 'ts_x', enabled: true })
    for (const status of [401, 422]) {
      let calls = 0
      setJevFetcher((async () => (calls++, new Response('no', { status }))) as unknown as typeof fetch)
      assert.isNull(await askJev('uji', { pesan: 'x' }, question))
      assert.equal(calls, 1, String(status))
    }
  })
})
