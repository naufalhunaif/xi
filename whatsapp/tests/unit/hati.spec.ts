import { test } from '@japa/runner'
import { readFile } from 'node:fs/promises'
import { mergeDigest } from '#beta3/skill_digest'
import { trimSkill } from '#beta3/token_saver'

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
