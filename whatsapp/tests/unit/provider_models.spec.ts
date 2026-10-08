import { test } from '@japa/runner'
import {
  knownModels,
  parseCodexCatalog,
  parseGeminiCatalog,
  pickCodexModel,
  pickGeminiModels,
  resetModelCatalogs,
  settleModelCatalogs,
} from '#beta3/provider_models'

// v3.6.65 — permintaan pemilik 8 Okt: model AI "sesuai penyedia", bukan alias "latest" / nama tebakan.
// Gemini: daftar model API key (ListModels). ChatGPT: katalog akun (`codex debug models`).
test.group('model AI sesuai penyedia (v3.6.65)', (group) => {
  group.each.setup(() => resetModelCatalogs())

  test('Gemini: hanya model yang bisa generateContent; utama = Flash stabil terbaru, cadangan dari daftar', ({ assert }) => {
    const names = parseGeminiCatalog({
      models: [
        { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/gemini-3.1-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.6-flash-preview-10-2026', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-005', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
      ],
    })
    assert.notInclude(names, 'gemini-embedding-001')
    assert.deepEqual(pickGeminiModels(names), { main: 'gemini-3.5-flash', fallbacks: ['gemini-3.5-flash-lite', 'gemini-3.1-flash'] })
    // Model akun dipakai bila ada di daftar; nama yang tidak ada di daftar diganti Flash terbaru.
    assert.equal(pickGeminiModels(names, 'gemini-3.1-flash').main, 'gemini-3.1-flash')
    assert.equal(pickGeminiModels(names, 'gemini-3.0-pro-salah').main, 'gemini-3.5-flash')
    // Preview & alias "latest" tidak dipilih selama ada versi stabil.
    assert.notInclude(pickGeminiModels(names).fallbacks, 'gemini-3.6-flash-preview-10-2026')
    assert.notInclude(pickGeminiModels(names).fallbacks, 'gemini-flash-latest')
  })

  test('ChatGPT: katalog akun urut prioritas; model tier yang tidak ada di katalog → bawaan penyedia', ({ assert }) => {
    const catalog = parseCodexCatalog(
      JSON.stringify({
        models: [
          { slug: 'gpt-5.6-terra', priority: 7, visibility: 'list' },
          { slug: 'gpt-6-astra', priority: 1, visibility: 'list' },
          { slug: 'gpt-5.4-mini', priority: 23, visibility: 'hide' },
        ],
      })
    )
    assert.deepEqual(catalog, ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-5.4-mini'])
    assert.equal(pickCodexModel('gpt-5.6-terra', catalog), 'gpt-5.6-terra')
    assert.equal(pickCodexModel('gpt-5.6-luna', catalog), '')
    assert.equal(pickCodexModel('gpt-5.6-luna', null), 'gpt-5.6-luna')
    assert.deepEqual(parseCodexCatalog('bukan json'), [])
  })

  test('daftar diambil di latar (tidak menunggu), disimpan 24 jam; gagal → dicoba lagi nanti', async ({ assert }) => {
    let loads = 0
    const load = async () => (loads++, ['gemini-3.5-flash'])
    assert.isNull(knownModels('k', load))
    await settleModelCatalogs()
    assert.deepEqual(knownModels('k', load), ['gemini-3.5-flash'])
    assert.equal(loads, 1)
    // > 24 jam → diperbarui di latar, daftar lama tetap dipakai.
    assert.deepEqual(knownModels('k', load, Date.now() + 25 * 3600_000), ['gemini-3.5-flash'])
    await settleModelCatalogs()
    assert.equal(loads, 2)
    // Gagal → tetap null, tidak dicoba ulang langsung.
    let fails = 0
    const broken = async () => {
      fails++
      throw new Error('HTTP 503')
    }
    assert.isNull(knownModels('x', broken))
    await settleModelCatalogs()
    assert.isNull(knownModels('x', broken))
    await settleModelCatalogs()
    assert.equal(fails, 1)
  })
})
