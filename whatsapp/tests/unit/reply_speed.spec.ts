import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { leanTuning, type LeanProviderSettings } from '#beta3/provider'
import { LEAN_OUTPUT_SCHEMA } from '#beta3/prompt'

const settings: LeanProviderSettings = {
  aiProvider: 'claude',
  chatgptModel: '',
  chatgptSpeed: 'standard',
  chatgptReasoning: 'auto',
  codexBin: '',
  claudeModel: '',
  claudeSpeed: 'standard',
  claudeReasoning: 'auto',
  claudeBin: '',
}

// v3.6.42: balasan lebih cepat tanpa mengganti model.
test.group('kecepatan balasan', () => {
  test('balasan chat: penalaran rendah bila Otomatis, batas tunggu 50 dtk kecuali akun terakhir', ({ assert }) => {
    const heavy = leanTuning(settings, { phase: 'beta3-reply', tier: 'heavy', last: false })
    assert.equal(heavy.claudeReasoning, 'low')
    assert.equal(heavy.chatgptReasoning, 'low')
    assert.equal(heavy.timeoutMs, 50_000)
    assert.equal(leanTuning(settings, { phase: 'beta3-reply', tier: 'heavy', last: true }).timeoutMs, 120_000)
    // Pilihan pemilik dihormati.
    assert.equal(leanTuning({ ...settings, claudeReasoning: 'high' }, { phase: 'beta3-reply', tier: 'standard', last: false }).claudeReasoning, 'high')
    // Haiku (ringan) tidak diberi effort; tugas lain (rekap, digest) tidak diubah.
    assert.equal(leanTuning(settings, { phase: 'beta3-reply', tier: 'light', last: false }).claudeReasoning, 'auto')
    const recap = leanTuning(settings, { phase: 'beta3-recap', tier: 'standard', last: false })
    assert.equal(recap.claudeReasoning, 'auto')
    assert.isUndefined(recap.timeoutMs)
  })

  test('spesifikasi & catatan boleh "=" bila tidak berubah (skema, skill, digest)', async ({ assert }) => {
    const props = (LEAN_OUTPUT_SCHEMA as any).properties
    assert.include(props.spesifikasi.description, '"="')
    assert.include(props.catatan.description, '"="')
    const skill = await readFile(new URL('../../skills-beta3/beta3-cs-inti/SKILL.md', import.meta.url), 'utf8')
    const digest = await readFile(new URL('../../skills-beta3/beta3-cs-inti/DIGEST.md', import.meta.url), 'utf8')
    assert.include(skill, 'tidak ada yang berubah → isi `=` saja')
    assert.include(digest, '`=` saja')
  })
})
